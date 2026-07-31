import { createHash } from "node:crypto";
import path from "node:path";
import type {
  AgentGoal,
  GoalResolutionAttemptResult,
  GoalResolutionPort,
  GoalResolutionProposal,
  GoalResolutionStatus,
} from "../../shared/contracts/agent-engine.js";
import {
  TEAM_STAFFING_OUTCOME_SCHEMA,
  TEAM_STAFFING_SCHEMA_REF,
  parseTeamStaffingOutcome,
  type TeamStaffingOutcome,
} from "../../shared/contracts/staffing.js";
import type { AgentProfile, Workspace, WorkspaceAgent, WorkspaceToolName } from "../../shared/types.js";
import { toolsForPolicy } from "../../shared/tool-catalog.js";
import { AgentEngine } from "../agent-engine/agent-engine.js";
import { AgentStore } from "../agent-engine/agent-store.js";
import { AgentContextAssembler } from "../agent-engine/context-assembler.js";
import { PiAgentRuntime } from "../agent-engine/pi-runtime.js";
import type { AgentExecutionRuntime } from "../agent-engine/runtime.js";
import { AgentToolRuntime } from "../agent-engine/tool-runtime.js";
import { AgentTraceStore } from "../agent-engine/trace-store.js";
import type { AgentProfileStore } from "../agents/profile-store.js";
import { resolvePolicy } from "../policy/policy.js";
import type { ProviderRegistry } from "../providers/provider-registry.js";
import { StaffingRequestStore, type StaffingRequestRecord } from "./staffing-request-store.js";

interface StaffingRuntime {
  engine: AgentEngine<TeamStaffingOutcome>;
  loop: AgentExecutionRuntime;
  profile: AgentProfile;
  agent: WorkspaceAgent;
}

export interface StaffingRunResult {
  request: StaffingRequestRecord;
  outcome?: TeamStaffingOutcome;
}

export class StaffingCoordinator {
  private readonly store: StaffingRequestStore;
  private readonly runtimes = new Map<string, StaffingRuntime>();

  constructor(
    private readonly workspace: Workspace,
    private readonly profiles: AgentProfileStore,
    private readonly providers: ProviderRegistry,
    private readonly requiredCapabilities: readonly string[],
    private readonly now: () => Date = () => new Date(),
  ) {
    this.store = new StaffingRequestStore(workspace.rootPath);
  }

  async create(taskId: string, objective: string): Promise<StaffingRequestRecord> {
    const existing = await this.store.getByTask(taskId);
    if (existing) return existing;
    const profiles = await this.profiles.list();
    const profile = selectStaffingProfile(profiles);
    const createdAt = this.now().toISOString();
    const request: StaffingRequestRecord = {
      staffingRequestId: stableId("staffing", this.workspace.id, taskId),
      taskId,
      workspaceId: this.workspace.id,
      objective,
      staffingProfileId: profile.id,
      staffingAgentId: stableId("organization-agent", this.workspace.id, profile.id),
      status: "pending",
      createdAt,
      updatedAt: createdAt,
    };
    await this.store.save(request);
    return request;
  }

  get(taskId: string): Promise<StaffingRequestRecord | undefined> {
    return this.store.getByTask(taskId);
  }

  async runOnce(taskId: string): Promise<StaffingRunResult> {
    let request = await this.requireRequest(taskId);
    if (request.status === "completed" || request.status === "blocked" || request.status === "failed") {
      return { request, outcome: request.proposal };
    }
    if (request.retryAt && Date.parse(request.retryAt) > this.now().getTime()) {
      return { request };
    }
    const runtime = await this.runtime(request);
    const thread = await runtime.engine.ensureThread({
      agentId: request.staffingAgentId,
      scopeId: request.taskId,
      idempotencyKey: stableId("staffing-thread", request.staffingRequestId),
    });
    const goalId = stableId("staffing-goal", request.staffingRequestId);
    const goal = await runtime.engine.getGoal(goalId) ?? await runtime.engine.startGoal({
      agentId: request.staffingAgentId,
      threadId: thread.threadId,
      idempotencyKey: goalId,
      spec: {
        id: goalId,
        threadId: thread.threadId,
        objective: "根据项目目标和组织人才池，组建能够可靠启动并完成该目标的项目团队。",
        successCriteria: [
          "组队方案由当前组织人才池中的真实档案组成，或明确提交无法由现有人才满足的能力缺口",
          "选择理由和项目责任足以让后续 Mission 理解每位成员为何加入",
          "团队满足平台提供的启动能力契约，且不按固定角色流程机械凑人",
        ],
        contextRefs: [
          { kind: "staffing_request", ref: request.staffingRequestId },
          { kind: "workspace", ref: this.workspace.id },
        ],
        outputContract: {
          schemaRef: TEAM_STAFFING_SCHEMA_REF,
          completionOutcomeSchema: TEAM_STAFFING_OUTCOME_SCHEMA,
        },
        createdAt: request.createdAt,
      },
    });
    const contextMessageId = stableId("staffing-context", request.staffingRequestId);
    await runtime.engine.sendMessage({
      messageId: contextMessageId,
      threadId: thread.threadId,
      goalId,
      senderPrincipalId: "mission-control",
      deliveryKind: "context",
      content: await this.contextMessage(request),
      createdAt: request.createdAt,
    });
    request = {
      ...request,
      status: "running",
      threadId: thread.threadId,
      goalId,
      blockReason: undefined,
      retryAt: undefined,
      updatedAt: this.now().toISOString(),
    };
    await this.store.save(request);
    const modelRuntime = await this.providers.modelRuntimeConfig(
      runtime.agent.provider ?? runtime.profile.defaultProvider,
      runtime.agent.model ?? runtime.profile.defaultModel,
    );
    const result = await runtime.loop.runSlice({
      threadId: thread.threadId,
      goalId: goal.spec.id,
      profile: runtime.profile,
      agent: runtime.agent,
      policy: resolvePolicy(this.workspace, runtime.agent, runtime.profile),
      provider: runtime.agent.provider ?? runtime.profile.defaultProvider,
      model: runtime.agent.model ?? runtime.profile.defaultModel,
      contextWindowTokens: modelRuntime.contextWindowTokens,
      supportsReasoning: modelRuntime.supportsReasoning,
      supportsImages: modelRuntime.supportsImages,
      thinkingLevel: modelRuntime.thinkingLevel,
    });
    request = await this.requireRequest(taskId);
    if (request.proposal) return { request, outcome: request.proposal };
    if (result.status === "yielded" && result.providerRetryable) {
      const failures = (request.providerFailures ?? 0) + 1;
      request = {
        ...request,
        status: "pending",
        providerFailures: failures,
        retryAt: new Date(this.now().getTime() + Math.min(60_000, 5_000 * (2 ** Math.min(failures - 1, 4)))).toISOString(),
        blockReason: result.blockedMessage,
        updatedAt: this.now().toISOString(),
      };
      await this.store.save(request);
      return { request };
    }
    if (result.status === "execution_blocked") {
      request = {
        ...request,
        status: "blocked",
        blockReason: result.blockedMessage ?? "组队 Agent 暂停，需要查看其对话与运行记录",
        updatedAt: this.now().toISOString(),
      };
      await this.store.save(request);
    }
    return { request };
  }

  async projection(taskId: string) {
    const request = await this.requireRequest(taskId);
    const runtime = await this.runtime(request);
    return request.threadId
      ? runtime.engine.getProjection(request.threadId, request.goalId, 200)
      : undefined;
  }

  async sendHumanMessage(taskId: string, message: string, messageId: string): Promise<void> {
    let request = await this.requireRequest(taskId);
    const runtime = await this.runtime(request);
    const thread = await runtime.engine.ensureThread({
      agentId: request.staffingAgentId,
      scopeId: request.taskId,
      idempotencyKey: stableId("staffing-thread", request.staffingRequestId),
    });
    const turnId = stableId("turn", thread.threadId, messageId);
    await runtime.engine.sendMessage({
      messageId,
      turnId,
      threadId: thread.threadId,
      goalId: request.goalId,
      senderPrincipalId: "human",
      deliveryKind: "turn",
      content: message,
      createdAt: this.now().toISOString(),
    });
    if (request.goalId) {
      const goal = await runtime.engine.getGoal(request.goalId);
      if (goal && new Set(["blocked", "paused", "usage_limited"]).has(goal.status)) {
        await runtime.engine.controlGoal({
          requestId: stableId("staffing-resume", request.staffingRequestId, messageId),
          goalId: goal.spec.id,
          expectedGoalVersion: goal.version,
          action: "resume",
          reason: "human 提供了新的按时间序消息",
        });
      }
    }
    request = {
      ...request,
      status: "pending",
      blockReason: undefined,
      retryAt: undefined,
      updatedAt: this.now().toISOString(),
    };
    await this.store.save(request);
  }

  async cancel(taskId: string, reason: string): Promise<void> {
    const request = await this.requireRequest(taskId);
    const runtime = await this.runtime(request);
    if (request.goalId) {
      const goal = await runtime.engine.getGoal(request.goalId);
      if (goal && !new Set(["completed", "failed", "cancelled"]).has(goal.status)) {
        await runtime.engine.controlGoal({
          requestId: stableId("staffing-cancel", request.staffingRequestId, String(goal.version)),
          goalId: goal.spec.id,
          expectedGoalVersion: goal.version,
          action: "cancel",
          reason,
        });
      }
    }
    await this.store.save({
      ...request,
      status: "failed",
      blockReason: reason,
      retryAt: undefined,
      updatedAt: this.now().toISOString(),
    });
  }

  async dispose(): Promise<void> {
    await Promise.allSettled([...this.runtimes.values()].map((runtime) => runtime.loop.dispose?.()));
    this.runtimes.clear();
  }

  private async runtime(request: StaffingRequestRecord): Promise<StaffingRuntime> {
    const existing = this.runtimes.get(request.taskId);
    if (existing) return existing;
    const profile = (await this.profiles.list()).find((item) => item.id === request.staffingProfileId);
    if (!profile) throw new Error("负责组队的人才档案已不存在");
    const agent: WorkspaceAgent = {
      id: request.staffingAgentId,
      workspaceId: this.workspace.id,
      profileId: profile.id,
      roleInWorkspace: profile.role,
      agentDir: path.join(this.workspace.rootPath, ".autoagent", "organization-agents", profile.id),
      status: "idle",
      provider: profile.defaultProvider,
      model: profile.defaultModel,
      policyOverride: profile.defaultPolicy,
    };
    const store = new AgentStore(this.workspace.rootPath, agent.id);
    const port = new StaffingResolutionPort(
      request.taskId,
      this.store,
      () => this.profiles.list(),
      this.requiredCapabilities,
      this.now,
    );
    const engine = new AgentEngine<TeamStaffingOutcome>(store, port, { now: this.now });
    const policy = resolvePolicy(this.workspace, agent, profile);
    const enabled = toolsForPolicy(policy).map((tool) => tool.name) as WorkspaceToolName[];
    const runtime = {
      engine,
      profile,
      agent,
      loop: new PiAgentRuntime(
        this.workspace.rootPath,
        engine,
        store,
        new AgentContextAssembler(store),
        this.providers,
        new AgentToolRuntime(policy, enabled),
        new AgentTraceStore(this.workspace.rootPath, agent.id),
        { now: this.now },
      ),
    };
    this.runtimes.set(request.taskId, runtime);
    return runtime;
  }

  private async contextMessage(request: StaffingRequestRecord): Promise<string> {
    const profiles = await this.profiles.list();
    return [
      "你正在以组织负责人的身份组建项目团队。",
      `项目目标：${request.objective}`,
      `项目：${this.workspace.name} (${this.workspace.rootPath})`,
      `启动能力契约：${JSON.stringify(this.requiredCapabilities)}`,
      "当前组织人才池（这是权威事实，只能选择其中的 profileId）：",
      JSON.stringify(profiles.map((profile) => ({
        profileId: profile.id,
        name: profile.name,
        identity: profile.identity,
        capabilities: profile.capabilities,
        defaultSkills: profile.defaultSkills ?? [],
        enabledTools: toolsForPolicy(resolvePolicy(this.workspace, virtualAgent(this.workspace, profile), profile))
          .map((tool) => tool.name),
      }))),
      "请根据目标复杂度自行裁剪团队。不要按固定角色表凑人，也不要把组队责任退给 human。",
      "确定后调用 staff_project；现有人才确实不足时提交 recruitment_required。",
    ].join("\n\n");
  }

  private async requireRequest(taskId: string): Promise<StaffingRequestRecord> {
    const request = await this.store.getByTask(taskId);
    if (!request) throw new Error("Staffing request does not exist");
    return request;
  }
}

class StaffingResolutionPort implements GoalResolutionPort<TeamStaffingOutcome> {
  constructor(
    private readonly taskId: string,
    private readonly store: StaffingRequestStore,
    private readonly profiles: () => Promise<AgentProfile[]>,
    private readonly requiredCapabilities: readonly string[],
    private readonly now: () => Date,
  ) {}

  async resolve<TStatus extends GoalResolutionStatus>(
    _goal: AgentGoal,
    proposal: GoalResolutionProposal<TStatus, TeamStaffingOutcome>,
  ): Promise<GoalResolutionAttemptResult<TStatus>> {
    if (proposal.status !== "completed") {
      return {
        settle: true,
        decision: { accepted: false, disposition: "correctable", reason: "组队请求必须通过 staff_project 提交结构化结论" },
      };
    }
    let outcome: TeamStaffingOutcome;
    try {
      outcome = parseTeamStaffingOutcome(proposal.domainOutcome);
      const profiles = await this.profiles();
      const byId = new Map(profiles.map((profile) => [profile.id, profile]));
      for (const member of outcome.members) {
        if (!byId.has(member.profileId)) throw new Error(`人才档案不存在：${member.profileId}`);
      }
      if (outcome.status === "staffed") {
        const selected = outcome.members.map((member) => byId.get(member.profileId)!);
        const missing = this.requiredCapabilities.filter((capability) =>
          !selected.some((profile) => profile.capabilities.includes(capability)),
        );
        if (missing.length) {
          throw new Error(`当前组队方案不满足已提供的启动能力契约：${missing.join("、")}`);
        }
      }
    } catch (error) {
      return {
        settle: true,
        decision: {
          accepted: false,
          disposition: "correctable",
          reason: error instanceof Error ? error.message : String(error),
        },
      };
    }
    const current = await this.store.getByTask(this.taskId);
    if (!current) {
      return {
        settle: true,
        decision: { accepted: false, disposition: "host_error", reason: "组队请求不存在", incidentId: this.taskId },
      };
    }
    if (current.status === "failed") {
      return {
        settle: true,
        decision: {
          accepted: false,
          disposition: "host_error",
          reason: current.blockReason ?? "Staffing request has ended",
          incidentId: current.staffingRequestId,
        },
      };
    }
    await this.store.save({
      ...current,
      status: outcome.status === "staffed" ? "completed" : "blocked",
      proposal: outcome,
      blockReason: outcome.status === "recruitment_required"
        ? outcome.recruitmentRequests.map((request) => `${request.capabilities.join("、")}：${request.reason}`).join("\n")
        : undefined,
      updatedAt: this.now().toISOString(),
    });
    return {
      settle: true,
      decision: { accepted: true, committedState: proposal.status, domainResult: outcome },
    };
  }
}

export function selectStaffingProfile(profiles: AgentProfile[]): AgentProfile {
  const candidates = profiles.filter((profile) => profile.capabilities.includes("team:staff"));
  if (candidates.length === 1) return candidates[0]!;
  const defaults = candidates.filter((profile) => profile.capabilities.includes("team:staff:default"));
  if (defaults.length === 1) return defaults[0]!;
  if (!candidates.length) throw new Error("组织人才池缺少具备 team:staff 能力的负责人");
  throw new Error("组织存在多个组队负责人，但没有唯一的 team:staff:default");
}

function virtualAgent(workspace: Workspace, profile: AgentProfile): WorkspaceAgent {
  return {
    id: stableId("organization-agent", workspace.id, profile.id),
    workspaceId: workspace.id,
    profileId: profile.id,
    roleInWorkspace: profile.role,
    agentDir: path.join(workspace.rootPath, ".autoagent", "organization-agents", profile.id),
    status: "idle",
    provider: profile.defaultProvider,
    model: profile.defaultModel,
    policyOverride: profile.defaultPolicy,
  };
}

function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 24)}`;
}
