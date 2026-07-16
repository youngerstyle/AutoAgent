import { createHash, randomUUID } from "node:crypto";
import type {
  AgentProfile,
  AgentThreadEvent,
  AutoAgentEvent,
  EntityStatus,
  MissionPhase,
  Ticket,
  Workspace,
  WorkspaceAgent,
  WorkspaceSnapshot,
  WorkspaceToolName,
} from "../../shared/types.js";
import type { ActiveMissionLink } from "../../shared/contracts/mission-control.js";
import type { PlanId, PlanPolicyRef } from "../../shared/contracts/ticket-engine.js";
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
import { LegacyMissionPlanError, MissionStore } from "../mission-process/mission-store.js";
import type { MissionTicketOutcome } from "../mission-process/ticket-agent-adapter.js";
import { createMinimalTeamPlanDefinition } from "../product/plan-template.js";
import { createTeamBinding } from "../product/team-binding.js";
import type { ProviderRegistry } from "../providers/provider-registry.js";
import { resolvePolicy } from "../policy/policy.js";
import { toolsForPolicy } from "../../shared/tool-catalog.js";
import { TicketEngine } from "../tickets/ticket-engine.js";
import { TicketStore } from "../tickets/ticket-store.js";
import type { PlanPolicyStore } from "../tickets/plan-policy-store.js";
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
  private readonly readOnlyTasks = new Map<string, string>();
  private readonly agentRuns = new Map<string, Promise<void>>();
  private timer?: NodeJS.Timeout;
  private tickPromise?: Promise<void>;
  private backgroundTickPromise?: Promise<void>;
  private operationTail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly workspace: Workspace,
    private readonly profiles: AgentProfileStore,
    private readonly providers: ProviderRegistry,
    private readonly policyStore: PlanPolicyStore,
    private readonly policyRef: PlanPolicyRef,
    private readonly options: { intervalMs?: number; maxTokensPerAgentGoalWindow?: number; now?: () => Date } = {},
  ) {
    this.store = new RuntimeHostStore(workspace.rootPath);
  }

  createTask(input: { taskId: string; title: string; objective: string }): Promise<RuntimeTaskRecord> {
    return this.exclusive(() => this.createTaskUnlocked(input));
  }

  recover(): Promise<void> {
    return this.exclusive(() => this.recoverUnlocked());
  }

  tick(): Promise<void> {
    if (this.tickPromise) return this.tickPromise;
    const pending = this.exclusive(() => this.tickUnlocked());
    const tracked = pending.finally(() => {
      if (this.tickPromise === tracked) this.tickPromise = undefined;
    });
    this.tickPromise = tracked;
    return tracked;
  }

  async sendAgentMessage(taskId: string, agentId: string, message: string, messageId: string = randomUUID()): Promise<WorkspaceSnapshot> {
    const result = await this.exclusive(async () => {
      const accepted = await this.appendAgentMessageUnlocked(taskId, agentId, message, messageId);
      return { accepted, snapshot: await this.snapshotUnlocked() };
    });
    if (result.accepted.appended) {
      void this.exclusive(() => this.continueAfterAgentMessageUnlocked(taskId, agentId, result.accepted.turnId, messageId))
        .catch((error) => this.exclusive(() => this.recordAgentTurnErrorUnlocked(taskId, agentId, error, result.accepted.turnId)).catch(() => undefined));
    }
    return result.snapshot;
  }

  pauseTask(taskId: string): Promise<void> {
    return this.exclusive(() => this.pauseTaskUnlocked(taskId));
  }

  resumeTask(taskId: string): Promise<void> {
    return this.exclusive(() => this.resumeTaskUnlocked(taskId));
  }

  cancelTask(taskId: string, reason: string): Promise<void> {
    return this.exclusive(() => this.cancelTaskUnlocked(taskId, reason));
  }

  snapshot(): Promise<WorkspaceSnapshot> {
    return this.snapshotUnlocked();
  }

  async start(): Promise<void> {
    await this.recover();
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.backgroundTick().catch((error) => {
        console.error("RuntimeHost background tick failed", error);
      });
    }, this.options.intervalMs ?? 1_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async createTaskUnlocked(input: { taskId: string; title: string; objective: string }): Promise<RuntimeTaskRecord> {
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
        planDefinition: createMinimalTeamPlanDefinition(this.policyRef, record.objective),
        teamBindingId: "minimal-team",
      },
    });
    return record;
  }

  private async recoverUnlocked(): Promise<void> {
    for (const record of await this.store.list()) {
      if (new Set(["completed", "failed", "cancelled"]).has(record.status)) continue;
      try {
        const context = await this.compose(record);
        this.contexts.set(record.taskId, context);
        await context.manager.startMission({
          missionId: record.missionId,
          objective: record.objective,
          requestedByPrincipalId: "runtime-recovery",
          resolvedStart: {
            planDefinition: createMinimalTeamPlanDefinition(this.policyRef, record.objective),
            teamBindingId: "minimal-team",
          },
        });
        await context.manager.recover();
      } catch (error) {
        this.contexts.delete(record.taskId);
        if (!(error instanceof LegacyMissionPlanError)) throw error;
        this.readOnlyTasks.set(record.taskId, "这是旧版任务，只能查看历史，不能继续调度。请重新描述目标以创建新的 Mission 和 Plan。");
      }
    }
  }

  private backgroundTick(): Promise<void> {
    if (this.backgroundTickPromise) return this.backgroundTickPromise;
    const pending = this.exclusive(() => this.tickUnlocked(false));
    const tracked = pending.finally(() => {
      if (this.backgroundTickPromise === tracked) this.backgroundTickPromise = undefined;
    });
    this.backgroundTickPromise = tracked;
    return tracked;
  }

  private async tickUnlocked(awaitAgentRuns = true): Promise<void> {
    for (const context of this.contexts.values()) await this.tickTask(context, awaitAgentRuns);
  }

  private async appendAgentMessageUnlocked(taskId: string, agentId: string, message: string, messageId: string): Promise<{ appended: boolean; turnId: string }> {
    const context = await this.requireContext(taskId);
    const engine = context.engines.get(agentId);
    if (!engine) throw new Error("Agent does not belong to this team");
    const thread = await engine.getThreadForAgent(agentId, context.record.missionId)
      ?? await engine.ensureThread({ agentId, scopeId: context.record.missionId, idempotencyKey: stableId("thread", context.record.missionId, agentId) });
    const turnId = stableId("turn", thread.threadId, messageId);
    const createdAt = this.now().toISOString();
    const appended = await engine.sendMessage({
      messageId,
      turnId,
      threadId: thread.threadId,
      goalId: (await this.activeLink(context, agentId))?.agentGoalId,
      senderPrincipalId: "human",
      content: message,
      createdAt,
    });
    if (!appended) return { appended: false, turnId };
    const link = await this.activeLink(context, agentId);
    if (link?.agentGoalId) {
      const goal = await engine.getGoal(link.agentGoalId);
      if (goal && (goal.status === "paused" || goal.status === "blocked" || goal.status === "usage_limited")) {
        await engine.controlGoal({
          requestId: stableId("human_resume", taskId, agentId, goal.spec.id, messageId),
          goalId: goal.spec.id,
          expectedGoalVersion: goal.version,
          action: "resume",
          reason: "human sent a new chronological message",
        });
        if (link.status === "blocked") await context.manager.resumeBlockedAgent(agentId);
      }
    }
    return { appended: true, turnId };
  }

  private async continueAfterAgentMessageUnlocked(taskId: string, agentId: string, turnId: string, triggerMessageId: string): Promise<void> {
    const context = await this.requireContext(taskId);
    const thread = await context.engines.get(agentId)?.getThreadForAgent(agentId, context.record.missionId);
    if (!thread) return;
    const resumedLink = await this.activeLink(context, agentId);
    if (resumedLink?.status === "running") {
      await this.runAgentSlice(context, resumedLink, turnId, triggerMessageId);
    } else if (!resumedLink) {
      await context.loops.get(agentId)?.runSlice(await this.sliceInputForAgent(context, agentId, thread.threadId, undefined, turnId, triggerMessageId));
    }
    await context.manager.tick();
  }

  private async recordAgentTurnErrorUnlocked(taskId: string, agentId: string, error: unknown, turnId?: string): Promise<void> {
    const context = await this.requireContext(taskId);
    const engine = context.engines.get(agentId);
    const thread = await engine?.getThreadForAgent(agentId, context.record.missionId);
    if (!engine || !thread) return;
    const createdAt = this.now().toISOString();
    await engine.appendToolItem({
      itemId: stableId("agent_turn_error", taskId, agentId, createdAt),
      turnId,
      threadId: thread.threadId,
      goalId: (await this.activeLink(context, agentId))?.agentGoalId,
      kind: "observation",
      value: { type: "agent_turn_error", error: error instanceof Error ? error.message : String(error) },
      createdAt,
    });
    await engine.appendToolItem({
      itemId: stableId("agent_turn_waiting", taskId, agentId, createdAt),
      turnId,
      threadId: thread.threadId,
      goalId: (await this.activeLink(context, agentId))?.agentGoalId,
      kind: "control",
      value: { status: "waiting", reason: "agent_turn_error" },
      createdAt,
    });
  }

  async listTasks(): Promise<RuntimeTaskRecord[]> {
    return this.store.list();
  }

  private async pauseTaskUnlocked(taskId: string): Promise<void> {
    const context = await this.requireContext(taskId);
    const mission = await context.manager.current();
    const plan = await context.tickets.getPlan(mission.record.planId);
    const result = await context.tickets.applyPlan({
      commandId: stableId("pause", taskId, String(plan.version)),
      planId: plan.planId,
      actorPrincipalId: "minimal-team-planner",
      issuedAt: this.now().toISOString(),
      payload: { type: "pause", expectedPlanVersion: plan.version },
    });
    if (!result.accepted) throw new Error(result.reason);
    for (const link of mission.links.filter((item) => item.status === "running")) {
      const engine = context.engines.get(link.agentId)!;
      const goal = await engine.getGoal(link.agentGoalId!);
      if (goal?.status === "active") await engine.controlGoal({
        requestId: stableId("pause_goal", taskId, goal.spec.id, String(goal.version)),
        goalId: goal.spec.id,
        expectedGoalVersion: goal.version,
        action: "pause",
        reason: "plan paused",
      });
    }
    context.record = { ...context.record, status: "paused", updatedAt: this.now().toISOString() };
    await this.store.save(context.record);
  }

  private async resumeTaskUnlocked(taskId: string): Promise<void> {
    const context = await this.requireContext(taskId);
    const mission = await context.manager.current();
    const plan = await context.tickets.getPlan(mission.record.planId);
    const result = await context.tickets.applyPlan({
      commandId: stableId("resume", taskId, String(plan.version)),
      planId: plan.planId,
      actorPrincipalId: "minimal-team-planner",
      issuedAt: this.now().toISOString(),
      payload: { type: "resume", expectedPlanVersion: plan.version },
    });
    if (!result.accepted) throw new Error(result.reason);
    for (const link of mission.links.filter((item) => item.status === "running" || item.status === "paused")) {
      const engine = context.engines.get(link.agentId)!;
      const goal = await engine.getGoal(link.agentGoalId!);
      if (goal?.status === "paused") await engine.controlGoal({
        requestId: stableId("resume_goal", taskId, goal.spec.id, String(goal.version)),
        goalId: goal.spec.id,
        expectedGoalVersion: goal.version,
        action: "resume",
        reason: "plan resumed",
      });
    }
    context.record = { ...context.record, status: "active", updatedAt: this.now().toISOString() };
    await this.store.save(context.record);
    await this.tickTask(context);
  }

  private async cancelTaskUnlocked(taskId: string, reason: string): Promise<void> {
    const context = await this.requireContext(taskId);
    const mission = await context.manager.current();
    const plan = await context.tickets.getPlan(mission.record.planId);
    const result = await context.tickets.applyPlan({
      commandId: stableId("cancel", taskId, String(plan.version)),
      planId: plan.planId,
      actorPrincipalId: "minimal-team-planner",
      issuedAt: this.now().toISOString(),
      payload: { type: "cancel", expectedPlanVersion: plan.version, reason },
    });
    if (!result.accepted) throw new Error(result.reason);
    for (const link of mission.links.filter((item) => new Set(["running", "blocked", "resolving", "paused"]).has(item.status))) {
      const engine = context.engines.get(link.agentId)!;
      const goal = await engine.getGoal(link.agentGoalId!);
      if (goal && !new Set(["completed", "failed", "cancelled"]).has(goal.status)) await engine.controlGoal({
        requestId: stableId("cancel_goal", taskId, goal.spec.id, String(goal.version)),
        goalId: goal.spec.id,
        expectedGoalVersion: goal.version,
        action: "cancel",
        reason,
      });
    }
    await context.manager.markActiveLinksCancelled();
    context.record = { ...context.record, status: "cancelled", updatedAt: this.now().toISOString() };
    await this.store.save(context.record);
  }

  private async snapshotUnlocked(): Promise<WorkspaceSnapshot> {
    const tasks = await this.store.list();
    const record = [...tasks].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    const agents = await listWorkspaceAgents(this.workspace);
    if (!record) return {
      workspace: this.workspace,
      agents,
      assignments: [],
      tickets: [],
      agentThreads: {},
      recentEvents: [],
      phase: "idle",
      status: "idle",
    };
    const readOnlyReason = this.readOnlyTasks.get(record.taskId);
    if (readOnlyReason) return {
      workspace: this.workspace,
      activeTask: {
        id: record.taskId,
        workspaceId: this.workspace.id,
        title: record.title,
        goal: record.objective,
        status: "interrupted",
        createdBy: "user",
        activeTaskRunId: record.runId,
      },
      activeTaskRun: {
        id: record.runId,
        taskId: record.taskId,
        workspaceId: this.workspace.id,
        status: "interrupted",
        phase: "interrupted",
        startedAt: record.createdAt,
        endedAt: record.updatedAt,
      },
      agents: agents.map((agent) => ({ ...agent, status: "idle" as const })),
      assignments: [],
      tickets: [],
      agentThreads: {},
      recentEvents: [],
      phase: "interrupted",
      status: "interrupted",
      currentStep: readOnlyReason,
      readOnlyReason,
    };
    const context = await this.requireContext(record.taskId);
    const mission = await context.manager.current();
    const plan = await context.tickets.getPlan(mission.record.planId);
    const linksByTicket = new Map(mission.links.map((link) => [String(link.ticketId), link]));
    const tickets: Ticket[] = [];
    for (const ticketId of plan.graph.ticketIds) {
      const work = await context.tickets.getWorkItem(ticketId);
      if (!work) continue;
      const link = linksByTicket.get(String(ticketId));
      tickets.push({
        id: String(ticketId),
        workspaceId: this.workspace.id,
        taskId: record.taskId,
        taskRunId: record.runId,
        type: presentationTicketType(work.definition.outputContract.schemaRef),
        status: legacyTicketStatus(work.ticket.status),
        brief: work.definition.objective,
        expectedArtifact: work.definition.outputContract.schemaRef,
        targetAgentId: link?.agentId,
        capabilityTags: work.definition.assignment.requiredCapabilities,
        priority: 0,
        attempt: Math.max(1, work.ticket.attempts.length),
        parentTicketId: work.ticket.parentTicketId,
        dependsOnTicketIds: plan.graph.dependencyEdges.filter((edge) => edge.toTicketId === ticketId).map((edge) => String(edge.fromTicketId)),
        createdAt: record.createdAt,
        updatedAt: link?.updatedAt ?? record.updatedAt,
      });
    }
    const profiles = await this.profiles.list();
    const agentThreads: Record<string, AgentThreadEvent[]> = {};
    const recentEvents: AutoAgentEvent[] = [];
    const projectedAgents = [] as WorkspaceSnapshot["agents"];
    for (const agent of agents) {
      const engine = context.engines.get(agent.id);
      const link = mission.links.find((item) => item.agentId === agent.id && new Set(["running", "blocked", "resolving", "paused"]).has(item.status));
      const projection = await engine?.getProjection(record.missionId, link?.agentGoalId, 200);
      const thread = projection?.thread;
      const goal = projection?.goal;
      const events = thread ? projectThread(thread, projection.payloads, record) : [];
      agentThreads[agent.id] = events;
      recentEvents.push(...events.map((event) => ({
        id: event.id,
        workspaceId: this.workspace.id,
        taskId: record.taskId,
        taskRunId: record.runId,
        actorId: agent.id,
        type: "agent.status_changed" as const,
        summary: threadEventText(event),
        payload: event.payload,
        timestamp: event.timestamp,
        sequence: event.sequence,
      })));
      const profile = profiles.find((item) => item.id === agent.profileId);
      projectedAgents.push({
        ...agent,
        status: projectedAgentStatus(link?.status, goal?.status, events),
        name: profile?.name,
        role: profile?.role,
        capabilities: profile?.capabilities,
        currentStep: goal?.spec.objective,
      });
    }
    const status = runtimeStatus(record.status);
    return {
      workspace: this.workspace,
      mission: {
        missionId: mission.missionId,
        planId: String(plan.planId),
        planStatus: plan.status,
        planVersion: plan.version,
      },
      activeTask: {
        id: record.taskId,
        workspaceId: this.workspace.id,
        title: record.title,
        goal: record.objective,
        status,
        createdBy: "user",
        activeTaskRunId: record.runId,
      },
      activeTaskRun: {
        id: record.runId,
        taskId: record.taskId,
        workspaceId: this.workspace.id,
        status,
        phase: presentationPhase(plan.status, tickets),
        startedAt: record.createdAt,
        endedAt: new Set(["completed", "failed", "cancelled"]).has(record.status) ? record.updatedAt : undefined,
      },
      agents: projectedAgents,
      assignments: [],
      tickets,
      agentThreads,
      agentMessages: {},
      recentEvents: recentEvents.sort((a, b) => a.timestamp.localeCompare(b.timestamp)).slice(-500),
      phase: presentationPhase(plan.status, tickets),
      status,
      currentStep: tickets.find((ticket) => ticket.status === "running" || ticket.status === "blocked")?.brief,
    };
  }

  context(taskId: string): RuntimeContext | undefined {
    return this.contexts.get(taskId);
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async tickTask(context: RuntimeContext, awaitAgentRuns = true): Promise<void> {
    let mission = await context.manager.tick();
    for (const link of mission.links) {
      if (link.status !== "running") continue;
      if (this.agentRuns.has(this.agentRunKey(context, link.agentId))) continue;
      const engine = context.engines.get(link.agentId);
      const goal = await engine?.getGoal(link.agentGoalId);
      if (goal?.status !== "active") continue;
      const readiness = await engine!.executionReadiness(goal.spec.id);
      if (!readiness.ready) {
        await engine!.controlGoal({
          requestId: stableId("no_progress", context.record.taskId, link.agentId, goal.spec.id, String(goal.version), readiness.reason),
          goalId: goal.spec.id,
          expectedGoalVersion: goal.version,
          action: "pause",
          reason: readiness.reason,
        });
        continue;
      }
      const run = this.runAgentOnce(context, link);
      if (awaitAgentRuns) {
        await run;
      } else {
        void run.catch((error) => {
          console.error(`Agent turn failed for ${context.record.taskId}/${link.agentId}`, error);
          void this.exclusive(() => this.recordAgentTurnErrorUnlocked(context.record.taskId, link.agentId, error)).catch(() => undefined);
        });
      }
    }
    mission = await context.manager.tick();
    const plan = await context.tickets.getPlan(mission.record.planId);
    const status = plan.status === "completed" ? "completed"
      : plan.status === "failed" ? "failed"
        : plan.status === "cancelled" ? "cancelled"
          : plan.status === "paused" ? "paused" : "active";
    if (status !== context.record.status) {
      context.record = { ...context.record, status, updatedAt: this.now().toISOString() };
      await this.store.save(context.record);
    }
  }

  private runAgentOnce(context: RuntimeContext, link: ActiveMissionLink): Promise<void> {
    const key = this.agentRunKey(context, link.agentId);
    const existing = this.agentRuns.get(key);
    if (existing) return existing;
    const pending = this.runAgentSlice(context, link);
    const tracked = pending.finally(() => {
      if (this.agentRuns.get(key) === tracked) this.agentRuns.delete(key);
      if (this.timer) {
        queueMicrotask(() => void this.backgroundTick().catch((error) => {
          console.error("RuntimeHost follow-up tick failed", error);
        }));
      }
    });
    this.agentRuns.set(key, tracked);
    return tracked;
  }

  private agentRunKey(context: RuntimeContext, agentId: string): string {
    return `${context.record.taskId}:${agentId}`;
  }

  private async runAgentSlice(context: RuntimeContext, link: ActiveMissionLink, turnId?: string, triggerMessageId?: string): Promise<void> {
    const result = await context.loops.get(link.agentId)?.runSlice(await this.sliceInput(context, link, turnId, triggerMessageId));
    if (result?.status !== "execution_blocked" || !result.goal || result.goal.status !== "active") return;
    await context.engines.get(link.agentId)?.controlGoal({
      requestId: stableId("execution_blocked", context.record.taskId, link.agentId, result.turnId),
      goalId: result.goal.spec.id,
      expectedGoalVersion: result.goal.version,
      action: result.blockReason === "usage_limit" ? "limit_usage" : "pause",
      reason: result.blockReason === "usage_limit"
        ? "configured token window reached; human confirmation is required"
        : result.blockReason === "no_progress"
          ? "the same tool error repeated without progress; execution is paused and ticket state is unchanged"
          : "provider execution is unavailable; ticket state is unchanged",
    });
  }

  private async compose(record: RuntimeTaskRecord): Promise<RuntimeContext> {
    const workspaceAgents = (await listWorkspaceAgents(this.workspace)).length
      ? await listWorkspaceAgents(this.workspace)
      : await ensureCoreTeam(this.workspace, await this.profiles.list());
    const profiles = await this.profiles.list();
    const team = createTeamBinding(
      workspaceAgents,
      profiles,
      stableId("team", ...workspaceAgents.map((agent) => agent.id)),
    );
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
      const enabled = toolsForPolicy(policy).map((tool) => tool.name) as WorkspaceToolName[];
      engines.set(agent.id, engine);
      loops.set(agent.id, new AgentToolLoop(
        engine,
        new AgentContextAssembler(store),
        new RegistryAgentProviderAdapter(this.providers),
        new AgentToolRuntime(policy, enabled),
        new AgentTraceStore(this.workspace.rootPath, agent.id),
        { maxTokensPerGoalWindow: this.options.maxTokensPerAgentGoalWindow, now: () => this.now() },
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

  private async sliceInput(context: RuntimeContext, link: ActiveMissionLink, turnId?: string, triggerMessageId?: string) {
    return this.sliceInputForAgent(context, link.agentId, link.agentThreadId, link.agentGoalId, turnId, triggerMessageId);
  }

  private async sliceInputForAgent(context: RuntimeContext, agentId: string, threadId: string, goalId?: string, turnId?: string, triggerMessageId?: string) {
    const agent = (await listWorkspaceAgents(this.workspace)).find((item) => item.id === agentId)!;
    const profile = (await this.profiles.list()).find((item) => item.id === agent.profileId)!;
    const provider = agent.provider ?? profile.defaultProvider;
    const model = agent.model ?? profile.defaultModel;
    return {
      threadId,
      turnId,
      triggerMessageId,
      goalId,
      profile,
      agent,
      policy: resolvePolicy(this.workspace, agent),
      provider,
      model,
      contextWindowTokens: await this.providers.contextWindowTokens(provider, model),
    };
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

function projectThread(
  thread: Awaited<ReturnType<AgentEngine<any>["getThread"]>>,
  payloads: Map<string, unknown>,
  record: RuntimeTaskRecord,
): AgentThreadEvent[] {
  const events: AgentThreadEvent[] = [{
    id: `mission-objective:${record.taskId}:${thread.agentId}`,
    taskId: record.taskId,
    taskRunId: record.runId,
    workspaceAgentId: thread.agentId,
    sequence: 0,
    timestamp: record.createdAt,
    source: "human",
    kind: "human_message",
    visibility: "chat",
    payload: { content: record.objective },
  }];
  for (const item of thread.items) {
    const payload = payloads.get(item.payloadRef);
    if (item.kind === "goal") {
      const goal = payload && typeof payload === "object" ? payload as Record<string, unknown> : undefined;
      const outputContract = goal?.outputContract && typeof goal.outputContract === "object"
        ? goal.outputContract as Record<string, unknown>
        : undefined;
      events.push({
        id: item.itemId,
        taskId: record.taskId,
        taskRunId: record.runId,
        workspaceAgentId: thread.agentId,
        sequence: item.sequence,
        timestamp: item.createdAt,
        source: "platform",
        kind: "ticket_received",
        visibility: "chat",
        payload: {
          brief: typeof goal?.objective === "string" ? goal.objective : "收到新的工作目标",
          successCriteria: Array.isArray(goal?.successCriteria) ? goal.successCriteria : [],
          expectedArtifact: typeof outputContract?.schemaRef === "string" ? outputContract.schemaRef : undefined,
        },
      });
      continue;
    }
    const messagePayload = payload && typeof payload === "object" ? payload as Record<string, unknown> : undefined;
    const isHuman = item.kind === "message" && messagePayload?.senderPrincipalId === "human";
    const projectedPayload = projectEventPayload(payload, item.payloadRef);
    events.push({
      id: item.itemId,
      ...(item.turnId ? { turnId: item.turnId } : {}),
      taskId: record.taskId,
      taskRunId: record.runId,
      workspaceAgentId: thread.agentId,
      sequence: item.sequence,
      timestamp: item.createdAt,
      source: item.kind === "message" ? (isHuman ? "human" : "system") : item.kind === "model" ? "agent" : item.kind === "observation" ? "tool" : "system",
      kind: item.kind === "message" ? (isHuman ? "human_message" : "system_note") : item.kind === "model" ? "agent_message" : item.kind === "observation" ? "tool_observation" : "system_note",
      visibility: item.kind === "control" ? "timeline" : "chat",
      payload: projectedPayload,
    });
  }
  return events;
}

function projectedAgentStatus(linkStatus: string | undefined, goalStatus: string | undefined, events: AgentThreadEvent[]): EntityStatus {
  if (linkStatus === "blocked" || goalStatus === "blocked" || goalStatus === "usage_limited") return "blocked";
  if (goalStatus === "paused") return "paused";
  if (goalStatus === "failed") return "failed";
  if (goalStatus === "completed" || goalStatus === "cancelled") return "idle";
  if (linkStatus === "running" && goalStatus === "active") return "running";
  const latestControl = [...events].reverse().find((event) => event.source === "system");
  const activity = (latestControl?.payload as Record<string, unknown> | undefined)?.status;
  if (linkStatus === "running" && (activity === "running" || activity === "yielded")) return "running";
  if (linkStatus === "running" && activity === "waiting") return "waiting";
  return linkStatus === "running" ? "waiting" : "idle";
}

function legacyTicketStatus(status: string): Ticket["status"] {
  if (status === "ready" || status === "pending") return "pending";
  return status as Ticket["status"];
}

function runtimeStatus(status: RuntimeTaskRecord["status"]): EntityStatus {
  if (status === "active") return "running";
  if (status === "cancelled") return "interrupted";
  return status;
}

function presentationTicketType(schemaRef: string): Ticket["type"] {
  if (schemaRef === "boss-intake-v1") return "boss_intake";
  if (schemaRef === "plan-change-set-v3") return "pm_plan";
  if (schemaRef === "delivery-v1") return "implementation";
  if (schemaRef === "qa-report-v1") return "qa";
  if (schemaRef === "acceptance-v1") return "boss_acceptance";
  return "specialist";
}

function presentationPhase(status: string, tickets: Ticket[]): MissionPhase {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "paused") return "paused";
  const current = tickets.find((ticket) => ticket.status === "running")
    ?? tickets.find((ticket) => ticket.status === "blocked")
    ?? tickets.find((ticket) => ticket.status === "pending");
  if (!current) return "idle";
  if (current.type === "boss_intake" || current.type === "pm_plan" || current.type === "architect_plan"
    || current.type === "implementation" || current.type === "qa" || current.type === "boss_acceptance") {
    return current.type;
  }
  if (current.type === "specialist" || current.type === "rework") return "implementation";
  return "idle";
}

function threadEventText(event: AgentThreadEvent): string {
  const payload = event.payload as Record<string, unknown>;
  const text = String(payload.content ?? payload.status ?? event.kind);
  return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}

function projectEventPayload(payload: unknown, payloadRef: string): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { content: truncateDisplayString(String(payload ?? "")), rawPayloadRef: payloadRef };
  }
  const record = { ...(payload as Record<string, unknown>) };
  let truncated = false;
  for (const [key, value] of Object.entries(record)) {
    if (typeof value !== "string" || value.length <= 8_000) continue;
    record[key] = truncateDisplayString(value);
    truncated = true;
    if (key === "content") record.originalChars = value.length;
  }
  if (truncated) {
    record.truncated = true;
    record.rawPayloadRef = payloadRef;
  }
  return record;
}

function truncateDisplayString(value: string): string {
  return value.length > 8_000 ? `${value.slice(0, 8_000)}\n\n[显示已截断，原始内容仍保存在 Agent Thread]` : value;
}

function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash("sha256").update(JSON.stringify(parts)).digest("base64url")}`;
}
