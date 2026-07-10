import { createHash } from "node:crypto";
import type { AgentProfile, Workspace, WorkspaceAgent, WorkspaceToolName } from "../../shared/types.js";
import type { ActiveMissionLink, TeamBinding } from "../../shared/contracts/mission-control.js";
import type { WorkflowId, WorkflowPolicyRef } from "../../shared/contracts/ticket-engine.js";
import { AgentEngine } from "../agent-engine/agent-engine.js";
import { AgentStore } from "../agent-engine/agent-store.js";
import { AgentContextAssembler } from "../agent-engine/context-assembler.js";
import { RegistryAgentProviderAdapter } from "../agent-engine/provider-adapter.js";
import { AgentToolLoop } from "../agent-engine/tool-loop.js";
import { AgentToolRuntime } from "../agent-engine/tool-runtime.js";
import { AgentTraceStore } from "../agent-engine/trace-store.js";
import { ensureCoreTeam, listWorkspaceAgents } from "../agents/roster.js";
import type { AgentProfileStore } from "../agents/profile-store.js";
import { MissionGoalResolutionPort } from "../mission-process/mission-goal-resolution-port.js";
import { MissionProcessManager } from "../mission-process/mission-process-manager.js";
import { MissionStore } from "../mission-process/mission-store.js";
import type { MissionTicketOutcome } from "../mission-process/ticket-agent-adapter.js";
import { createMinimalTeamWorkflowDefinition } from "../product/workflow-template.js";
import type { ProviderRegistry } from "../providers/provider-registry.js";
import { resolvePolicy } from "../policy/policy.js";
import { toolsForPolicy } from "../../shared/tool-catalog.js";
import { TicketEngine } from "../tickets/ticket-engine.js";
import { TicketStore } from "../tickets/ticket-store.js";
import type { WorkflowPolicyStore } from "../tickets/workflow-policy-store.js";
import { RuntimeHostStore, type RuntimeTaskRecord } from "./runtime-host-store.js";

interface RuntimeContext {
  record: RuntimeTaskRecord;
  tickets: TicketEngine;
  manager: MissionProcessManager;
  engines: Map<string, AgentEngine<MissionTicketOutcome>>;
  loops: Map<string, AgentToolLoop>;
}

export class RuntimeHost {
  private readonly store: RuntimeHostStore;
  private readonly contexts = new Map<string, RuntimeContext>();
  private timer?: NodeJS.Timeout;
  private ticking = false;

  constructor(
    private readonly workspace: Workspace,
    private readonly profiles: AgentProfileStore,
    private readonly providers: ProviderRegistry,
    private readonly policyStore: WorkflowPolicyStore,
    private readonly policyRef: WorkflowPolicyRef,
    private readonly options: { intervalMs?: number; now?: () => Date } = {},
  ) {
    this.store = new RuntimeHostStore(workspace.rootPath);
  }

  async start(): Promise<void> {
    await this.recover();
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch(() => undefined), this.options.intervalMs ?? 1_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async createTask(input: { taskId: string; title: string; objective: string }): Promise<RuntimeTaskRecord> {
    if (await this.store.get(input.taskId)) throw new Error("Task already exists");
    const now = this.now().toISOString();
    const record: RuntimeTaskRecord = {
      taskId: input.taskId,
      runId: stableId("run", input.taskId),
      missionId: input.taskId,
      title: input.title,
      objective: input.objective,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    await this.store.save(record);
    const context = await this.compose(record);
    this.contexts.set(record.taskId, context);
    await context.manager.startMission({
      missionId: record.missionId,
      objective: record.objective,
      requestedByPrincipalId: "human",
      resolvedStart: {
        workflowDefinition: createMinimalTeamWorkflowDefinition(this.policyRef),
        teamBindingId: "minimal-team",
      },
    });
    await this.tickTask(context);
    return record;
  }

  async recover(): Promise<void> {
    for (const record of await this.store.list()) {
      if (new Set(["completed", "failed", "cancelled"]).has(record.status)) continue;
      const context = await this.compose(record);
      this.contexts.set(record.taskId, context);
      await context.manager.startMission({
        missionId: record.missionId,
        objective: record.objective,
        requestedByPrincipalId: "runtime-recovery",
        resolvedStart: {
          workflowDefinition: createMinimalTeamWorkflowDefinition(this.policyRef),
          teamBindingId: "minimal-team",
        },
      });
      await context.manager.recover();
    }
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const context of this.contexts.values()) await this.tickTask(context);
    } finally {
      this.ticking = false;
    }
  }

  async sendAgentMessage(taskId: string, agentId: string, message: string): Promise<void> {
    const context = await this.requireContext(taskId);
    const engine = context.engines.get(agentId);
    if (!engine) throw new Error("Agent does not belong to this team");
    const thread = await engine.getThreadForAgent(agentId, context.record.missionId)
      ?? await engine.ensureThread({ agentId, scopeId: context.record.missionId, idempotencyKey: stableId("thread", context.record.missionId, agentId) });
    await engine.sendMessage({
      messageId: stableId("human_message", taskId, agentId, this.now().toISOString(), message),
      threadId: thread.threadId,
      goalId: (await this.activeLink(context, agentId))?.agentGoalId,
      senderPrincipalId: "human",
      content: message,
      createdAt: this.now().toISOString(),
    });
    const link = await this.activeLink(context, agentId);
    if (link?.status === "blocked") {
      const goal = await engine.getGoal(link.agentGoalId);
      if (goal) {
        await engine.controlGoal({
          requestId: stableId("human_resume", taskId, agentId, goal.spec.id, message),
          goalId: goal.spec.id,
          expectedGoalVersion: goal.version,
          action: "resume",
          reason: "human sent a new chronological message",
        });
        await context.manager.resumeBlockedAgent(agentId);
      }
    }
    const resumedLink = await this.activeLink(context, agentId);
    if (resumedLink?.status === "running") {
      await context.loops.get(agentId)?.runSlice(await this.sliceInput(context, resumedLink));
    } else if (!resumedLink) {
      await context.loops.get(agentId)?.runSlice(await this.sliceInputForAgent(context, agentId, thread.threadId));
    }
    await context.manager.tick();
  }

  async listTasks(): Promise<RuntimeTaskRecord[]> {
    return this.store.list();
  }

  context(taskId: string): RuntimeContext | undefined {
    return this.contexts.get(taskId);
  }

  private async tickTask(context: RuntimeContext): Promise<void> {
    let mission = await context.manager.tick();
    for (const link of mission.links) {
      if (link.status !== "running") continue;
      const goal = await context.engines.get(link.agentId)?.getGoal(link.agentGoalId);
      if (goal?.status !== "active") continue;
      await context.loops.get(link.agentId)?.runSlice(await this.sliceInput(context, link));
    }
    mission = await context.manager.tick();
    const workflow = await context.tickets.getWorkflow(mission.record.workflowId);
    const status = workflow.status === "completed" ? "completed"
      : workflow.status === "failed" ? "failed"
        : workflow.status === "cancelled" ? "cancelled"
          : workflow.status === "paused" ? "paused" : "active";
    if (status !== context.record.status) {
      context.record = { ...context.record, status, updatedAt: this.now().toISOString() };
      await this.store.save(context.record);
    }
  }

  private async compose(record: RuntimeTaskRecord): Promise<RuntimeContext> {
    const workspaceAgents = (await listWorkspaceAgents(this.workspace)).length
      ? await listWorkspaceAgents(this.workspace)
      : await ensureCoreTeam(this.workspace, await this.profiles.list());
    const profiles = await this.profiles.list();
    const team = teamBinding(workspaceAgents, profiles);
    const tickets = new TicketEngine(
      new TicketStore(this.workspace.rootPath, record.taskId, record.runId),
      this.policyStore,
      { teamBindingIds: [team.teamBindingId], now: () => this.now() },
    );
    const engines = new Map<string, AgentEngine<MissionTicketOutcome>>();
    const loops = new Map<string, AgentToolLoop>();
    for (const agent of workspaceAgents) {
      const profile = profiles.find((item) => item.id === agent.profileId);
      if (!profile) continue;
      const resolutionPort = new MissionGoalResolutionPort(() => undefined, agent.id, () => this.now());
      const store = new AgentStore(this.workspace.rootPath, agent.id);
      const engine = new AgentEngine<MissionTicketOutcome>(store, resolutionPort, { now: () => this.now() });
      const policy = resolvePolicy(this.workspace, agent);
      const enabled = toolsForPolicy(policy, agent.roleInWorkspace).map((tool) => tool.name) as WorkspaceToolName[];
      engines.set(agent.id, engine);
      loops.set(agent.id, new AgentToolLoop(
        engine,
        new AgentContextAssembler(store),
        new RegistryAgentProviderAdapter(this.providers),
        new AgentToolRuntime(policy, enabled),
        new AgentTraceStore(this.workspace.rootPath, agent.id),
        { now: () => this.now() },
      ));
    }
    const manager = new MissionProcessManager(
      new MissionStore(this.workspace.rootPath, record.missionId),
      tickets,
      { get: (agentId) => {
        const engine = engines.get(agentId);
        if (!engine) throw new Error(`Agent ${agentId} is unavailable`);
        return engine;
      } },
      team,
      "minimal-team-planner",
      () => this.now(),
    );
    return { record, tickets, manager, engines, loops };
  }

  private async requireContext(taskId: string): Promise<RuntimeContext> {
    const existing = this.contexts.get(taskId);
    if (existing) return existing;
    const record = await this.store.get(taskId);
    if (!record) throw new Error("Task does not exist");
    const context = await this.compose(record);
    this.contexts.set(taskId, context);
    return context;
  }

  private async activeLink(context: RuntimeContext, agentId: string) {
    return (await context.manager.tick()).links.find((link) => link.agentId === agentId && new Set(["running", "blocked", "resolving"]).has(link.status));
  }

  private async sliceInput(context: RuntimeContext, link: ActiveMissionLink) {
    return this.sliceInputForAgent(context, link.agentId, link.agentThreadId, link.agentGoalId);
  }

  private async sliceInputForAgent(context: RuntimeContext, agentId: string, threadId: string, goalId?: string) {
    const agent = (await listWorkspaceAgents(this.workspace)).find((item) => item.id === agentId)!;
    const profile = (await this.profiles.list()).find((item) => item.id === agent.profileId)!;
    return {
      threadId,
      goalId,
      profile,
      agent,
      policy: resolvePolicy(this.workspace, agent),
      provider: agent.provider ?? profile.defaultProvider,
      model: agent.model ?? profile.defaultModel,
    };
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

function teamBinding(agents: WorkspaceAgent[], profiles: AgentProfile[]): TeamBinding {
  return {
    teamBindingId: "minimal-team",
    version: 1,
    contentHash: stableId("team", ...agents.map((agent) => agent.id)),
    members: agents.map((agent) => ({
      agentId: agent.id,
      principalId: `principal:${agent.id}`,
      capabilities: [...new Set([
        ...(profiles.find((profile) => profile.id === agent.profileId)?.capabilities ?? []),
        ...productCapabilities(agent.roleInWorkspace),
      ])],
    })),
  };
}

function productCapabilities(role: WorkspaceAgent["roleInWorkspace"]): string[] {
  if (role === "boss") return ["mission:intake", "delivery:accept"];
  if (role === "pm") return ["workflow:plan"];
  if (role === "architect") return ["architecture:design"];
  if (role === "dev") return ["delivery:implement"];
  if (role === "qa") return ["delivery:verify"];
  return ["specialist:execute"];
}

function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash("sha256").update(JSON.stringify(parts)).digest("base64url")}`;
}
