import { createHash } from "node:crypto";
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
import { listWorkspaceAgents, selectProjectOwnerProfile } from "../agents/roster.js";
import { resolvePolicy } from "../policy/policy.js";
import type { ProviderRegistry } from "../providers/provider-registry.js";
import { StaffingRequestStore, type StaffingRequestRecord } from "./staffing-request-store.js";

interface StaffingRuntime {
  engine: AgentEngine<TeamStaffingOutcome>;
  loop: AgentExecutionRuntime;
  profile: AgentProfile;
  agent: WorkspaceAgent;
}

interface ProjectTaskFact {
  taskId: string;
  title: string;
  objective: string;
  status: string;
  createdAt: string;
  updatedAt: string;
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
    private readonly projectHistory: () => Promise<ProjectTaskFact[]> = async () => [],
    private readonly now: () => Date = () => new Date(),
    private readonly retryPolicy: {
      maxProviderFailures: number;
      baseDelayMs: number;
      maxDelayMs: number;
    } = { maxProviderFailures: 3, baseDelayMs: 5_000, maxDelayMs: 60_000 },
  ) {
    this.store = new StaffingRequestStore(workspace.rootPath);
  }

  async create(taskId: string, objective: string): Promise<StaffingRequestRecord> {
    const existing = await this.store.getByTask(taskId);
    if (existing) return existing;
    const profiles = await this.profiles.list();
    const projectAgents = await listWorkspaceAgents(this.workspace);
    const projectProfiles = profiles.filter((profile) =>
      projectAgents.some((agent) => agent.profileId === profile.id),
    );
    const profile = selectProjectOwnerProfile(projectProfiles);
    const agent = projectAgents.find((candidate) => candidate.profileId === profile.id);
    if (!agent) throw new Error("项目负责人实例不存在");
    const createdAt = this.now().toISOString();
    const request: StaffingRequestRecord = {
      staffingRequestId: stableId("staffing", this.workspace.id, taskId),
      taskId,
      workspaceId: this.workspace.id,
      objective,
      staffingProfileId: profile.id,
      staffingAgentId: agent.id,
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
      scopeId: this.workspace.id,
      idempotencyKey: stableId("project-owner-thread", this.workspace.id, request.staffingAgentId),
    });
    const goalId = stableId("staffing-goal", request.staffingRequestId);
    const goal = await runtime.engine.getGoal(goalId) ?? await runtime.engine.startGoal({
      agentId: request.staffingAgentId,
      threadId: thread.threadId,
      idempotencyKey: goalId,
      spec: {
        id: goalId,
        threadId: thread.threadId,
        objective: request.objective,
        successCriteria: [],
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
    await runtime.engine.sendMessage({
      messageId: stableId("human-objective", request.staffingRequestId),
      turnId: stableId("human-objective-turn", request.staffingRequestId),
      threadId: thread.threadId,
      goalId,
      senderPrincipalId: "human",
      deliveryKind: "turn",
      content: request.objective,
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
      if (failures >= this.retryPolicy.maxProviderFailures) {
        request = {
          ...request,
          status: "blocked",
          providerFailures: failures,
          retryAt: undefined,
          blockReason: result.blockedMessage
            ? `模型服务连续失败 ${failures} 次，已停止自动重试：${result.blockedMessage}`
            : `模型服务连续失败 ${failures} 次，已停止自动重试。请检查 Provider 配置或网络连接后重试。`,
          updatedAt: this.now().toISOString(),
        };
        await this.store.save(request);
        return { request };
      }
      request = {
        ...request,
        status: "pending",
        providerFailures: failures,
        retryAt: new Date(this.now().getTime() + Math.min(
          this.retryPolicy.maxDelayMs,
          this.retryPolicy.baseDelayMs * (2 ** Math.min(failures - 1, 4)),
        )).toISOString(),
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
      scopeId: this.workspace.id,
      idempotencyKey: stableId("project-owner-thread", this.workspace.id, request.staffingAgentId),
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
    const agent = (await listWorkspaceAgents(this.workspace))
      .find((candidate) => candidate.id === request.staffingAgentId);
    if (!agent || agent.profileId !== profile.id) throw new Error("项目负责人实例已不存在或身份不匹配");
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
    const projectAgents = await listWorkspaceAgents(this.workspace);
    const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
    const projectTasks = await this.projectHistory();
    return JSON.stringify({
      type: "project_context",
      workspace: {
        id: this.workspace.id,
        name: this.workspace.name,
        rootPath: this.workspace.rootPath,
        policyProfile: this.workspace.policyProfile,
      },
      missionStartContract: {
        requiredCapabilities: [...this.requiredCapabilities],
        staffingDecision: {
          meaning: "staffed 表示所选团队能够对当前 Mission 的完整交付负责，不只是完成需求接收或计划拆解",
          memberCoverage: "每个成员必须声明 capabilityCoverage；平台只验证声明能力属于对应人才档案",
          missingCapability: "如果人才池无法覆盖完整目标，提交 recruitment_required 和能力缺口，不要提交一个只有管理能力的 staffed 团队",
        },
      },
      currentTeam: projectAgents.map((agent) => {
        const profile = profileById.get(agent.profileId);
        return {
          agentId: agent.id,
          profileId: agent.profileId,
          name: profile?.name,
          capabilities: profile?.capabilities ?? [],
          enabledTools: profile
            ? toolsForPolicy(resolvePolicy(this.workspace, agent, profile)).map((tool) => tool.name)
            : [],
        };
      }),
      projectHistory: projectTasks
        .filter((task) => task.taskId !== request.taskId)
        .map((task) => ({
          taskId: task.taskId,
          title: task.title,
          objective: task.objective,
          status: task.status,
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
        })),
      talentPool: profiles.map((profile) => ({
        profileId: profile.id,
        name: profile.name,
        identity: profile.identity,
        capabilities: profile.capabilities,
        defaultSkills: profile.defaultSkills ?? [],
        enabledTools: toolsForPolicy(resolvePolicy(this.workspace, {
          policyOverride: profile.defaultPolicy,
          skillOverrides: profile.defaultSkills,
        }, profile))
          .map((tool) => tool.name),
      })),
    });
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
        const profile = byId.get(member.profileId);
        if (!profile) throw new Error(`人才档案不存在：${member.profileId}`);
        const invalidCoverage = member.capabilityCoverage.filter((capability) =>
          !profile.capabilities.includes(capability),
        );
        if (invalidCoverage.length) {
          throw new Error(`成员 ${member.profileId} 声明了档案未提供的能力：${invalidCoverage.join("、")}`);
        }
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

function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 24)}`;
}
