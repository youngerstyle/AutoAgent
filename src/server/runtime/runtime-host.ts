import { createHash } from "node:crypto";
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
import { createTeamBinding } from "../product/team-binding.js";
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
  private operationTail: Promise<unknown> = Promise.resolve();

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

  createTask(input: { taskId: string; title: string; objective: string }): Promise<RuntimeTaskRecord> {
    return this.exclusive(() => this.createTaskUnlocked(input));
  }

  recover(): Promise<void> {
    return this.exclusive(() => this.recoverUnlocked());
  }

  tick(): Promise<void> {
    return this.exclusive(() => this.tickUnlocked());
  }

  async sendAgentMessage(taskId: string, agentId: string, message: string): Promise<WorkspaceSnapshot> {
    const snapshot = await this.exclusive(async () => {
      await this.appendAgentMessageUnlocked(taskId, agentId, message);
      return this.snapshotUnlocked();
    });
    void this.exclusive(() => this.continueAfterAgentMessageUnlocked(taskId, agentId))
      .catch((error) => this.exclusive(() => this.recordAgentTurnErrorUnlocked(taskId, agentId, error)).catch(() => undefined));
    return snapshot;
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
    return this.exclusive(() => this.snapshotUnlocked());
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
        workflowDefinition: createMinimalTeamWorkflowDefinition(this.policyRef, record.objective),
        teamBindingId: "minimal-team",
      },
    });
    await this.tickTask(context);
    return record;
  }

  private async recoverUnlocked(): Promise<void> {
    for (const record of await this.store.list()) {
      if (new Set(["completed", "failed", "cancelled"]).has(record.status)) continue;
      const context = await this.compose(record);
      this.contexts.set(record.taskId, context);
      await context.manager.startMission({
        missionId: record.missionId,
        objective: record.objective,
        requestedByPrincipalId: "runtime-recovery",
        resolvedStart: {
          workflowDefinition: createMinimalTeamWorkflowDefinition(this.policyRef, record.objective),
          teamBindingId: "minimal-team",
        },
      });
      await context.manager.recover();
    }
  }

  private async tickUnlocked(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const context of this.contexts.values()) await this.tickTask(context);
    } finally {
      this.ticking = false;
    }
  }

  private async appendAgentMessageUnlocked(taskId: string, agentId: string, message: string): Promise<void> {
    const context = await this.requireContext(taskId);
    const engine = context.engines.get(agentId);
    if (!engine) throw new Error("Agent does not belong to this team");
    const thread = await engine.getThreadForAgent(agentId, context.record.missionId)
      ?? await engine.ensureThread({ agentId, scopeId: context.record.missionId, idempotencyKey: stableId("thread", context.record.missionId, agentId) });
    const createdAt = this.now().toISOString();
    await engine.sendMessage({
      messageId: stableId("human_message", taskId, agentId, createdAt, message),
      threadId: thread.threadId,
      goalId: (await this.activeLink(context, agentId))?.agentGoalId,
      senderPrincipalId: "human",
      content: message,
      createdAt,
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
  }

  private async continueAfterAgentMessageUnlocked(taskId: string, agentId: string): Promise<void> {
    const context = await this.requireContext(taskId);
    const thread = await context.engines.get(agentId)?.getThreadForAgent(agentId, context.record.missionId);
    if (!thread) return;
    const resumedLink = await this.activeLink(context, agentId);
    if (resumedLink?.status === "running") {
      await context.loops.get(agentId)?.runSlice(await this.sliceInput(context, resumedLink));
    } else if (!resumedLink) {
      await context.loops.get(agentId)?.runSlice(await this.sliceInputForAgent(context, agentId, thread.threadId));
    }
    await context.manager.tick();
  }

  private async recordAgentTurnErrorUnlocked(taskId: string, agentId: string, error: unknown): Promise<void> {
    const context = await this.requireContext(taskId);
    const engine = context.engines.get(agentId);
    const thread = await engine?.getThreadForAgent(agentId, context.record.missionId);
    if (!engine || !thread) return;
    const createdAt = this.now().toISOString();
    await engine.appendToolItem({
      itemId: stableId("agent_turn_error", taskId, agentId, createdAt),
      threadId: thread.threadId,
      goalId: (await this.activeLink(context, agentId))?.agentGoalId,
      kind: "observation",
      value: { type: "agent_turn_error", error: error instanceof Error ? error.message : String(error) },
      createdAt,
    });
    await engine.appendToolItem({
      itemId: stableId("agent_turn_waiting", taskId, agentId, createdAt),
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
    const workflow = await context.tickets.getWorkflow(mission.record.workflowId);
    const result = await context.tickets.applyWorkflow({
      commandId: stableId("pause", taskId, String(workflow.version)),
      workflowId: workflow.workflowId,
      actorPrincipalId: "minimal-team-planner",
      issuedAt: this.now().toISOString(),
      payload: { type: "pause", expectedWorkflowVersion: workflow.version },
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
        reason: "workflow paused",
      });
    }
    context.record = { ...context.record, status: "paused", updatedAt: this.now().toISOString() };
    await this.store.save(context.record);
  }

  private async resumeTaskUnlocked(taskId: string): Promise<void> {
    const context = await this.requireContext(taskId);
    const mission = await context.manager.current();
    const workflow = await context.tickets.getWorkflow(mission.record.workflowId);
    const result = await context.tickets.applyWorkflow({
      commandId: stableId("resume", taskId, String(workflow.version)),
      workflowId: workflow.workflowId,
      actorPrincipalId: "minimal-team-planner",
      issuedAt: this.now().toISOString(),
      payload: { type: "resume", expectedWorkflowVersion: workflow.version },
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
        reason: "workflow resumed",
      });
    }
    context.record = { ...context.record, status: "active", updatedAt: this.now().toISOString() };
    await this.store.save(context.record);
    await this.tickTask(context);
  }

  private async cancelTaskUnlocked(taskId: string, reason: string): Promise<void> {
    const context = await this.requireContext(taskId);
    const mission = await context.manager.current();
    const workflow = await context.tickets.getWorkflow(mission.record.workflowId);
    const result = await context.tickets.applyWorkflow({
      commandId: stableId("cancel", taskId, String(workflow.version)),
      workflowId: workflow.workflowId,
      actorPrincipalId: "minimal-team-planner",
      issuedAt: this.now().toISOString(),
      payload: { type: "cancel", expectedWorkflowVersion: workflow.version, reason },
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
    const context = await this.requireContext(record.taskId);
    const mission = await context.manager.tick();
    const workflow = await context.tickets.getWorkflow(mission.record.workflowId);
    const linksByTicket = new Map(mission.links.map((link) => [String(link.ticketId), link]));
    const tickets: Ticket[] = [];
    for (const node of workflow.graph.nodes) {
      const work = await context.tickets.getWorkItem(node.ticketId);
      if (!work) continue;
      const link = linksByTicket.get(String(node.ticketId));
      tickets.push({
        id: String(node.ticketId),
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
        attempt: 1,
        parentTicketId: work.ticket.parentTicketId,
        dependsOnTicketIds: workflow.graph.dependencyEdges.filter((edge) => edge.toTicketId === node.ticketId).map((edge) => String(edge.fromTicketId)),
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
      const thread = await engine?.getThreadForAgent(agent.id, record.missionId);
      const link = mission.links.find((item) => item.agentId === agent.id && new Set(["running", "blocked", "resolving", "paused"]).has(item.status));
      const goal = link?.agentGoalId ? await engine?.getGoal(link.agentGoalId) : undefined;
      const events = thread ? await projectThread(engine!, thread, record) : [];
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
        phase: presentationPhase(workflow.status, tickets),
        startedAt: record.createdAt,
        endedAt: new Set(["completed", "failed", "cancelled"]).has(record.status) ? record.updatedAt : undefined,
      },
      agents: projectedAgents,
      assignments: [],
      tickets,
      agentThreads,
      agentMessages: {},
      recentEvents: recentEvents.sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
      phase: presentationPhase(workflow.status, tickets),
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

  private async tickTask(context: RuntimeContext): Promise<void> {
    let mission = await context.manager.tick();
    for (const link of mission.links) {
      if (link.status !== "running") continue;
      const goal = await context.engines.get(link.agentId)?.getGoal(link.agentGoalId);
      if (goal?.status !== "active") continue;
      if (!await this.shouldRunSlice(context, link)) continue;
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

  private async shouldRunSlice(context: RuntimeContext, link: ActiveMissionLink): Promise<boolean> {
    const engine = context.engines.get(link.agentId);
    if (!engine) return false;
    const thread = await engine.getThread(link.agentThreadId);
    const tail = thread.items.at(-1);
    if (!tail || tail.kind !== "control") return true;
    const payload = await engine.getPayload(tail.payloadRef);
    return !isWaitingControl(payload);
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

async function projectThread(engine: AgentEngine<any>, thread: Awaited<ReturnType<AgentEngine<any>["getThread"]>>, record: RuntimeTaskRecord): Promise<AgentThreadEvent[]> {
  const events: AgentThreadEvent[] = [];
  for (const item of thread.items) {
    if (item.kind === "goal") continue;
    const payload = await engine.getPayload(item.payloadRef);
    const messagePayload = payload && typeof payload === "object" ? payload as Record<string, unknown> : undefined;
    const isHuman = item.kind === "message" && messagePayload?.senderPrincipalId === "human";
    events.push({
      id: item.itemId,
      taskId: record.taskId,
      taskRunId: record.runId,
      workspaceAgentId: thread.agentId,
      sequence: item.sequence,
      timestamp: item.createdAt,
      source: item.kind === "message" ? (isHuman ? "human" : "system") : item.kind === "model" ? "agent" : item.kind === "observation" ? "tool" : "system",
      kind: item.kind === "message" ? (isHuman ? "human_message" : "system_note") : item.kind === "model" ? "agent_message" : item.kind === "observation" ? "tool_observation" : "system_note",
      visibility: item.kind === "control" ? "timeline" : "chat",
      payload: (payload && typeof payload === "object" ? payload : { content: payload }) as Record<string, unknown>,
    });
  }
  return events;
}

function projectedAgentStatus(linkStatus: string | undefined, goalStatus: string | undefined, events: AgentThreadEvent[]): EntityStatus {
  if (linkStatus === "blocked" || goalStatus === "blocked") return "blocked";
  if (goalStatus === "completed" || goalStatus === "cancelled") return "idle";
  const latestControl = [...events].reverse().find((event) => event.source === "system");
  const activity = (latestControl?.payload as Record<string, unknown> | undefined)?.status;
  if (linkStatus === "running" && (activity === "running" || activity === "yielded")) return "running";
  if (linkStatus === "running" && activity === "waiting") return "waiting";
  if (goalStatus === "paused") return "paused";
  if (goalStatus === "failed") return "failed";
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
  if (schemaRef === "ticket-graph-v2") return "pm_plan";
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

export function isWaitingControl(value: unknown): boolean {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && (value as Record<string, unknown>).status === "waiting";
}

function threadEventText(event: AgentThreadEvent): string {
  const payload = event.payload as Record<string, unknown>;
  return String(payload.content ?? payload.status ?? event.kind);
}

function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash("sha256").update(JSON.stringify(parts)).digest("base64url")}`;
}
