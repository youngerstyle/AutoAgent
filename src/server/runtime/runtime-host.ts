import { createHash, randomUUID } from "node:crypto";
import type {
  AgentProfile,
  AgentThreadEvent,
  AutoAgentEvent,
  EntityStatus,
  MissionPhase,
  Ticket,
  TicketBlocker,
  Workspace,
  WorkspaceAgent,
  WorkspaceSnapshot,
  WorkspaceToolName,
} from "../../shared/types.js";
import type { AgentMessageAttachment } from "../../shared/contracts/agent-engine.js";
import { AttachmentStore } from "../storage/attachment-store.js";
import type { ActiveMissionLink, MissionLink, TeamBinding } from "../../shared/contracts/mission-control.js";
import type { PlanId, PlanPolicyRef, PlannedTicketAssignment, TicketRequiredInput } from "../../shared/contracts/ticket-engine.js";
import { AgentEngine } from "../agent-engine/agent-engine.js";
import { AgentStore } from "../agent-engine/agent-store.js";
import { AgentContextAssembler } from "../agent-engine/context-assembler.js";
import { PiAgentRuntime } from "../agent-engine/pi-runtime.js";
import type { AgentExecutionRuntime, AgentExecutionSliceResult } from "../agent-engine/runtime.js";
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
import { WorkspaceSnapshotStore } from "../tickets/workspace-snapshot-store.js";
import type { PlanPolicyStore } from "../tickets/plan-policy-store.js";
import { RuntimeHostStore, type RuntimeTaskRecord } from "./runtime-host-store.js";

interface RuntimeContext {
  record: RuntimeTaskRecord;
  team: TeamBinding;
  tickets: TicketEngine;
  manager: MissionProcessManager;
  engines: Map<string, AgentEngine<MissionTicketOutcome>>;
  loops: Map<string, AgentExecutionRuntime>;
}

export class RuntimeHost {
  private readonly store: RuntimeHostStore;
  private readonly contexts = new Map<string, RuntimeContext>();
  private readonly readOnlyTasks = new Map<string, string>();
  private readonly agentRuns = new Map<string, Promise<void>>();
  private readonly providerBackoffs = new Map<string, { failures: number; retryAt: number }>();
  private timer?: NodeJS.Timeout;
  private tickPromise?: Promise<void>;
  private backgroundTickPromise?: Promise<void>;
  private backgroundTickRequested = false;
  private startPromise?: Promise<void>;
  private operationTail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly workspace: Workspace,
    private readonly profiles: AgentProfileStore,
    private readonly providers: ProviderRegistry,
    private readonly policyStore: PlanPolicyStore,
    private readonly policyRef: PlanPolicyRef,
    private readonly options: {
      intervalMs?: number;
      now?: () => Date;
      providerRetryBaseMs?: number;
      providerRetryMaxMs?: number;
    } = {},
  ) {
    this.store = new RuntimeHostStore(workspace.rootPath);
  }

  createTask(input: { taskId: string; title: string; objective: string }): Promise<RuntimeTaskRecord> {
    return this.exclusive(() => this.createTaskUnlocked(input));
  }

  recover(): Promise<void> {
    return this.exclusive(() => this.recoverUnlocked());
  }

  hydrate(): Promise<void> {
    return this.exclusive(() => this.hydrateUnlocked());
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

  async sendAgentMessage(taskId: string, agentId: string, message: string, messageId: string = randomUUID(), attachments: AgentMessageAttachment[] = []): Promise<WorkspaceSnapshot> {
    await Promise.all(attachments.map(async (attachment) => {
      const stored = await new AttachmentStore(this.workspace.rootPath).get(attachment.attachmentId);
      if (stored.metadata.mimeType !== attachment.mimeType || stored.metadata.size !== attachment.size) {
        throw new Error("附件元数据与工作区存储不一致");
      }
    }));
    let queuedTurn: Promise<void> | undefined;
    const result = await this.exclusive(async () => {
      const accepted = await this.appendAgentMessageUnlocked(taskId, agentId, message, messageId, attachments);
      if (accepted.appended) {
        queuedTurn = this.enqueueAgentMessageTurn(
          taskId,
          agentId,
          accepted.turnId,
          messageId,
          accepted.goalId,
        );
      }
      return { accepted, snapshot: await this.snapshotUnlocked() };
    });
    if (queuedTurn) {
      void queuedTurn
        .catch((error) => this.exclusive(() => this.recordAgentTurnErrorUnlocked(taskId, agentId, error, result.accepted.turnId)).catch(() => undefined));
    }
    return result.snapshot;
  }

  async sendTaskMessage(taskId: string, message: string, messageId: string = randomUUID()): Promise<WorkspaceSnapshot> {
    const context = await this.requireContext(taskId);
    const mission = await context.manager.current();
    const owner = mission.record.teamBinding.members.find((member) => member.principalId === mission.record.ownerPrincipalId);
    if (!owner) throw new Error("Mission owner is unavailable in the persisted TeamBinding");
    return this.sendAgentMessage(taskId, owner.agentId, message, messageId);
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
    if (this.timer) return;
    if (this.startPromise) return this.startPromise;
    const pending = (async () => {
      await this.recover();
      if (this.timer) return;
      this.timer = setInterval(() => {
        void this.backgroundTick().catch((error) => {
          console.error("RuntimeHost background tick failed", error);
        });
      }, this.options.intervalMs ?? 1_000);
      this.timer.unref();
    })();
    const tracked = pending.finally(() => {
      if (this.startPromise === tracked) this.startPromise = undefined;
    });
    this.startPromise = tracked;
    return tracked;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.providerBackoffs.clear();

    await Promise.allSettled(
      [...this.contexts.values()].flatMap((context) =>
        [...context.loops.values()].map((runtime) => runtime.dispose?.()),
      ),
    );

    const schedulerWork = [this.tickPromise, this.backgroundTickPromise].filter(
      (pending): pending is Promise<void> => pending !== undefined,
    );
    await Promise.allSettled([...schedulerWork, ...this.agentRuns.values()]);
    await this.operationTail.catch(() => undefined);
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
    const context = await this.compose(record);
    const owner = context.team.members.find((member) => member.capabilities.includes("mission:intake"));
    if (!owner) throw new Error("TeamBinding has no Mission owner with mission:intake capability");
    await this.store.save(record);
    this.contexts.set(record.taskId, context);
    await context.manager.startMission({
      missionId: record.missionId,
      objective: record.objective,
      requestedByPrincipalId: "human",
      ownerPrincipalId: owner.principalId,
      teamBinding: context.team,
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
        const persisted = await context.manager.current().catch(() => undefined);
        const ownerPrincipalId = persisted?.record.ownerPrincipalId
          ?? context.team.members.find((member) => member.capabilities.includes("mission:intake"))?.principalId;
        if (!ownerPrincipalId) throw new Error("Persisted Mission has no available owner");
        await context.manager.startMission({
          missionId: record.missionId,
          objective: record.objective,
          requestedByPrincipalId: "runtime-recovery",
          ownerPrincipalId,
          teamBinding: context.team,
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

  private async hydrateUnlocked(): Promise<void> {
    for (const record of await this.store.list()) {
      if (new Set(["completed", "failed", "cancelled"]).has(record.status)) continue;
      if (this.contexts.has(record.taskId)) continue;
      try {
        const context = await this.compose(record);
        this.contexts.set(record.taskId, context);
      } catch (error) {
        this.contexts.delete(record.taskId);
        if (!(error instanceof LegacyMissionPlanError)) throw error;
        this.readOnlyTasks.set(record.taskId, "这是旧版任务，只能查看历史，不能继续调度。请重新描述目标以创建新的 Mission 和 Plan。");
      }
    }
  }

  private backgroundTick(): Promise<void> {
    this.backgroundTickRequested = true;
    if (this.backgroundTickPromise) return this.backgroundTickPromise;
    const pending = (async () => {
      while (this.backgroundTickRequested) {
        this.backgroundTickRequested = false;
        await this.exclusive(() => this.tickUnlocked(false));
      }
    })();
    const tracked = pending.finally(() => {
      if (this.backgroundTickPromise === tracked) this.backgroundTickPromise = undefined;
      if (this.backgroundTickRequested && this.timer) {
        queueMicrotask(() => void this.backgroundTick().catch((error) => {
          console.error("RuntimeHost follow-up tick failed", error);
        }));
      }
    });
    this.backgroundTickPromise = tracked;
    return tracked;
  }

  private async tickUnlocked(awaitAgentRuns = true): Promise<void> {
    for (const context of this.contexts.values()) {
      try {
        await this.tickTask(context, awaitAgentRuns);
      } catch (error) {
        console.error(`RuntimeHost task tick failed for ${context.record.taskId}`, error);
      }
    }
  }

  private async appendAgentMessageUnlocked(
    taskId: string,
    agentId: string,
    message: string,
    messageId: string,
    attachments: AgentMessageAttachment[] = [],
  ): Promise<{ appended: boolean; turnId: string; goalId?: string }> {
    if (attachments.length > 4) throw new Error("单条消息最多附加 4 张图片");
    const context = await this.requireContext(taskId);
    const engine = context.engines.get(agentId);
    if (!engine) throw new Error("Agent does not belong to this team");
    const thread = await engine.getThreadForAgent(agentId, context.record.missionId)
      ?? await engine.ensureThread({ agentId, scopeId: context.record.missionId, idempotencyKey: stableId("thread", context.record.missionId, agentId) });
    const turnId = stableId("turn", thread.threadId, messageId);
    const createdAt = this.now().toISOString();
    const link = await this.activeLink(context, agentId);
    const goalId = link?.agentGoalId;
    const appended = await engine.sendMessage({
      messageId,
      turnId,
      threadId: thread.threadId,
      goalId,
      senderPrincipalId: "human",
      deliveryKind: "turn",
      content: message,
      attachments,
      createdAt,
    });
    if (!appended) return { appended: false, turnId, goalId };
    if (goalId) {
      const goal = await engine.getGoal(goalId);
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
    return { appended: true, turnId, goalId };
  }

  private async continueAfterAgentMessageUnlocked(
    taskId: string,
    agentId: string,
    turnId: string,
    triggerMessageId: string,
    sourceGoalId?: string,
  ): Promise<void> {
    const context = await this.requireContext(taskId);
    const thread = await context.engines.get(agentId)?.getThreadForAgent(agentId, context.record.missionId);
    if (!thread) return;
    const resumedLink = await this.activeLink(context, agentId);
    const route = queuedMessageRoute(sourceGoalId, resumedLink?.agentGoalId);
    if (route === "active_goal" && resumedLink?.status === "running") {
      await this.runAgentSlice(context, resumedLink, turnId, triggerMessageId);
    } else if (route === "idle") {
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
      if (goal?.status === "active") {
        await engine.controlGoal({
          requestId: stableId("pause_goal", taskId, goal.spec.id, String(goal.version)),
          goalId: goal.spec.id,
          expectedGoalVersion: goal.version,
          action: "pause",
          reason: "plan paused",
        });
        await context.loops.get(link.agentId)?.releaseGoalResources?.({
          agentId: link.agentId,
          threadId: goal.spec.threadId,
          goalId: goal.spec.id,
          attemptId: link.attemptId,
        });
      }
    }
    context.record = { ...context.record, status: "paused", updatedAt: this.now().toISOString() };
    await this.store.save(context.record);
  }

  private async resumeTaskUnlocked(taskId: string): Promise<void> {
    const context = await this.requireContext(taskId);
    const mission = await context.manager.current();
    const plan = await context.tickets.getPlan(mission.record.planId);
    // The Plan is the execution gate. Resume Agent Goals first while that gate
    // remains closed so a partial failure cannot expose an active Plan backed by
    // paused workers.
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
    if (plan.status === "paused") {
      const result = await context.tickets.applyPlan({
        commandId: stableId("resume", taskId, String(plan.version)),
        planId: plan.planId,
        actorPrincipalId: "minimal-team-planner",
        issuedAt: this.now().toISOString(),
        payload: { type: "resume", expectedPlanVersion: plan.version },
      });
      if (!result.accepted) throw new Error(result.reason);
    }
    context.record = { ...context.record, status: "active", updatedAt: this.now().toISOString() };
    await this.store.save(context.record);
    await this.tickTask(context, false);
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
    const taskPausedForPresentation = plan.status === "paused";
    const linksByTicket = new Map(mission.links.map((link) => [String(link.ticketId), link]));
    const [workItems, profiles, projections] = await Promise.all([
      Promise.all(plan.graph.ticketIds.map((ticketId) => context.tickets.getWorkItem(ticketId))),
      this.profiles.list(),
      Promise.all(agents.map(async (agent) => {
        const engine = context.engines.get(agent.id);
        const link = mission.links.find((item) => item.agentId === agent.id && new Set(["running", "blocked", "resolving", "paused"]).has(item.status));
        return {
          agent,
          link,
          projection: await engine?.getProjection(record.missionId, link?.agentGoalId, 200),
        };
      })),
    ]);
    const tickets: Ticket[] = [];
    for (let index = 0; index < plan.graph.ticketIds.length; index += 1) {
      const ticketId = plan.graph.ticketIds[index]!;
      const work = workItems[index];
      if (!work) continue;
      const link = linksByTicket.get(String(ticketId));
      const targetAgent = agents.find((agent) => agent.id === link?.agentId);
      const activeAttempt = work.ticket.attempts.find((attempt) => attempt.attemptId === work.ticket.activeAttemptId)
        ?? work.ticket.attempts.at(-1);
      tickets.push({
        id: String(ticketId),
        workspaceId: this.workspace.id,
        taskId: record.taskId,
        taskRunId: record.runId,
        type: "work",
        status: legacyTicketStatus(work.ticket.status),
        brief: work.definition.objective,
        expectedArtifact: work.definition.outputContract.schemaRef,
        targetAgentId: link?.agentId,
        targetRole: targetAgent?.roleInWorkspace,
        capabilityTags: work.definition.assignment.requiredCapabilities,
        priority: 0,
        attempt: Math.max(1, work.ticket.attempts.length),
        parentTicketId: work.ticket.parentTicketId,
        dependsOnTicketIds: plan.graph.dependencyEdges.filter((edge) => edge.toTicketId === ticketId).map((edge) => String(edge.fromTicketId)),
        blocker: work.ticket.status === "blocked" && activeAttempt?.reason && activeAttempt.requiredInput
          ? projectTicketBlocker(activeAttempt.reason, activeAttempt.requiredInput)
          : work.ticket.status === "ready" && !link && !hasEligibleMember(mission.record.teamBinding, work.definition.assignment)
            ? {
                type: "waiting_for_agent_capacity",
                reason: assignmentGapReason(work.definition.assignment),
                details: { assignment: work.definition.assignment },
              }
          : undefined,
        createdAt: record.createdAt,
        updatedAt: link?.updatedAt ?? record.updatedAt,
      });
    }
    const agentThreads: Record<string, AgentThreadEvent[]> = {};
    const recentEvents: AutoAgentEvent[] = [];
    const projectedAgents = [] as WorkspaceSnapshot["agents"];
    for (const { agent, link, projection } of projections) {
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
        status: taskPausedForPresentation
          ? projectedPausedAgentStatus(link?.status, goal?.status)
          : projectedAgentStatus(
            link?.status,
            goal?.status,
            events,
            this.agentRuns.has(this.agentRunKey(context, agent.id)),
          ),
        name: profile?.name,
        role: profile?.role,
        capabilities: profile?.capabilities,
        currentStep: goal?.spec.objective,
      });
    }
    const status = presentationStatus(plan.status, mission.record.status, tickets);
    const phase = presentationPhase(plan.status, mission.record.status, tickets);
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
        phase,
        startedAt: record.createdAt,
        endedAt: new Set(["completed", "failed", "cancelled"]).has(record.status) ? record.updatedAt : undefined,
      },
      agents: projectedAgents,
      assignments: [],
      tickets,
      agentThreads,
      agentMessages: {},
      recentEvents: recentEvents.sort((a, b) => a.timestamp.localeCompare(b.timestamp)).slice(-500),
      phase,
      status,
      currentStep: tickets.find((ticket) => ticket.status === "running" || ticket.status === "blocked")?.brief,
    };
  }

  context(taskId: string): RuntimeContext | undefined {
    return this.contexts.get(taskId);
  }

  providerRetryState(taskId: string, agentId: string): { failures: number; retryAt: number } | undefined {
    void taskId;
    return this.providerBackoffs.get(agentId);
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async tickTask(context: RuntimeContext, awaitAgentRuns = true): Promise<void> {
    let mission = await context.manager.tick();
    const planBeforeRuns = await context.tickets.getPlan(mission.record.planId);
    if (!planAllowsActiveAgentExecution(planBeforeRuns.status)) {
      await this.syncTaskStatus(context, planBeforeRuns.status, mission.record.status);
      return;
    }
    for (const link of mission.links) {
      if (link.status !== "running") continue;
      const runKey = this.agentRunKey(context, link.agentId);
      if (this.agentRuns.has(runKey)) continue;
      const providerBackoff = this.providerBackoffs.get(runKey);
      if (providerBackoff && providerBackoff.retryAt > this.now().getTime()) continue;
      const engine = context.engines.get(link.agentId);
      const goal = await engine?.getGoal(link.agentGoalId);
      if (goal?.status !== "active") continue;
      const readiness = await engine!.executionReadiness(goal.spec.id);
      if (!readiness.ready) {
        if (readiness.reason === "agent_busy") continue;
        await engine!.controlGoal({
          requestId: stableId("no_progress", context.record.taskId, link.agentId, goal.spec.id, String(goal.version), readiness.reason),
          goalId: goal.spec.id,
          expectedGoalVersion: goal.version,
          action: "pause",
          reason: readiness.reason,
        });
        continue;
      }
      const pendingHumanTurn = await context.loops.get(link.agentId)?.pendingHumanTurn(link.agentThreadId);
      const run = pendingHumanTurn
        ? this.trackAgentRun(
            runKey,
            this.runAgentSlice(
              context,
              link,
              pendingHumanTurn.turnId,
              pendingHumanTurn.triggerMessageId,
            ),
          )
        : this.runAgentOnce(context, link);
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
    await this.releaseSettledAgentResources(context, mission.links);
    const activeAgentIds = new Set(mission.links
      .filter((link) => new Set(["running", "blocked", "resolving", "paused"]).has(link.status))
      .map((link) => link.agentId));
    for (const [agentId, runtime] of context.loops) {
      if (activeAgentIds.has(agentId)) continue;
      const key = this.agentRunKey(context, agentId);
      if (this.agentRuns.has(key)) continue;
      const thread = await context.engines.get(agentId)?.getThreadForAgent(agentId, context.record.missionId);
      if (!thread) continue;
      const pendingHumanTurn = await runtime.pendingHumanTurn(thread.threadId);
      if (!pendingHumanTurn) continue;
      const run = this.trackAgentRun(key, this.runIdleAgentTurn(context, agentId, thread.threadId, pendingHumanTurn));
      if (awaitAgentRuns) {
        await run;
      } else {
        void run.catch((error) => {
          console.error(`Idle Agent turn failed for ${context.record.taskId}/${agentId}`, error);
          void this.exclusive(() => this.recordAgentTurnErrorUnlocked(context.record.taskId, agentId, error)).catch(() => undefined);
        });
      }
    }
    mission = await context.manager.tick();
    await this.releaseSettledAgentResources(context, mission.links);
    const plan = await context.tickets.getPlan(mission.record.planId);
    await this.syncTaskStatus(context, plan.status, mission.record.status);
  }

  private async runIdleAgentTurn(
    context: RuntimeContext,
    agentId: string,
    threadId: string,
    pending: { turnId: string; triggerMessageId: string },
  ): Promise<void> {
    await context.loops.get(agentId)?.runSlice(await this.sliceInputForAgent(
      context,
      agentId,
      threadId,
      undefined,
      pending.turnId,
      pending.triggerMessageId,
    ));
    await context.manager.tick();
  }

  private async syncTaskStatus(context: RuntimeContext, planStatus: string, missionStatus: string): Promise<void> {
    const status = missionStatus === "completed" ? "completed"
      : planStatus === "failed" ? "failed"
        : planStatus === "cancelled" ? "cancelled"
          : planStatus === "paused" ? "paused" : "active";
    if (status !== context.record.status) {
      context.record = { ...context.record, status, updatedAt: this.now().toISOString() };
      await this.store.save(context.record);
    }
  }

  private runAgentOnce(context: RuntimeContext, link: ActiveMissionLink): Promise<void> {
    const key = this.agentRunKey(context, link.agentId);
    const existing = this.agentRuns.get(key);
    if (existing) return existing;
    return this.trackAgentRun(key, this.runAgentSlice(context, link));
  }

  private enqueueAgentMessageTurn(
    taskId: string,
    agentId: string,
    turnId: string,
    triggerMessageId: string,
    sourceGoalId?: string,
  ): Promise<void> {
    const key = agentId;
    const active = this.agentRuns.get(key);
    const pending = (active ? active.catch(() => undefined) : Promise.resolve())
      .then(() => this.exclusive(() => this.continueAfterAgentMessageUnlocked(
        taskId,
        agentId,
        turnId,
        triggerMessageId,
        sourceGoalId,
      )));
    return this.trackAgentRun(key, pending);
  }

  private trackAgentRun(key: string, pending: Promise<void>): Promise<void> {
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
    void context;
    return agentId;
  }

  private async releaseSettledAgentResources(context: RuntimeContext, links: MissionLink[]): Promise<void> {
    await Promise.allSettled(links
      .filter((link) => link.status === "settled" || link.status === "cancelled")
      .filter((link) => link.agentThreadId && link.agentGoalId)
      .map((link) => context.loops.get(link.agentId)?.releaseGoalResources?.({
        agentId: link.agentId,
        threadId: link.agentThreadId!,
        goalId: link.agentGoalId!,
        attemptId: link.attemptId,
      })));
  }

  private async runAgentSlice(context: RuntimeContext, link: ActiveMissionLink, turnId?: string, triggerMessageId?: string): Promise<void> {
    const result = await context.loops.get(link.agentId)?.runSlice(await this.sliceInput(context, link, turnId, triggerMessageId));
    const key = this.agentRunKey(context, link.agentId);
    if (result?.status === "yielded" && result.blockReason === "provider_error" && result.providerRetryable) {
      await this.deferProviderRetry(context, link, result);
      return;
    }
    if (result?.status === "execution_blocked"
      && result.goal?.status === "active"
      && (result.blockReason === "no_progress" || result.blockReason === "provider_protocol")) {
      await this.deferExecutionRetry(context, link, result);
      return;
    }
    this.providerBackoffs.delete(key);
    if (result?.status !== "execution_blocked"
      || !result.goal
      || result.goal.status !== "active") return;
    const engine = context.engines.get(link.agentId);
    const currentGoal = await engine?.getGoal(result.goal.spec.id);
    if (!currentGoal || currentGoal.status !== "active") return;
    await engine?.controlGoal({
      requestId: stableId("execution_blocked", context.record.taskId, link.agentId, result.turnId),
      goalId: currentGoal.spec.id,
      expectedGoalVersion: currentGoal.version,
      action: result.blockReason === "usage_limit" ? "limit_usage" : "pause",
      reason: result.blockReason === "usage_limit"
        ? "configured token window reached; human confirmation is required"
        : "the provider rejected the request and cannot be retried automatically; ticket state is unchanged",
    });
  }

  private async deferExecutionRetry(
    context: RuntimeContext,
    link: ActiveMissionLink,
    result: AgentExecutionSliceResult,
  ): Promise<void> {
    const retry = this.scheduleRetry(context, link);
    await context.engines.get(link.agentId)?.appendToolItem({
      itemId: `${result.turnId}:execution-backoff`,
      turnId: result.turnId,
      threadId: link.agentThreadId,
      goalId: link.agentGoalId,
      kind: "control",
      value: {
        turnId: result.turnId,
        status: "execution_retry_wait",
        reason: result.blockReason,
        detail: result.blockedMessage,
        retryAt: new Date(retry.retryAt).toISOString(),
        failures: retry.failures,
      },
      createdAt: this.now().toISOString(),
    });
  }

  private async deferProviderRetry(
    context: RuntimeContext,
    link: ActiveMissionLink,
    result: AgentExecutionSliceResult,
  ): Promise<void> {
    const { failures, retryAt } = this.scheduleRetry(context, link);
    await context.engines.get(link.agentId)?.appendToolItem({
      itemId: `${result.turnId}:provider-backoff`,
      turnId: result.turnId,
      threadId: link.agentThreadId,
      goalId: link.agentGoalId,
      kind: "control",
      value: {
        turnId: result.turnId,
        status: "external_service_waiting",
        retryAt: new Date(retryAt).toISOString(),
        failures,
      },
      createdAt: this.now().toISOString(),
    });
  }

  private scheduleRetry(
    context: RuntimeContext,
    link: ActiveMissionLink,
  ): { failures: number; retryAt: number } {
    const key = this.agentRunKey(context, link.agentId);
    const previous = this.providerBackoffs.get(key);
    const failures = (previous?.failures ?? 0) + 1;
    const baseMs = Math.max(1, this.options.providerRetryBaseMs ?? 5_000);
    const maxMs = Math.max(baseMs, this.options.providerRetryMaxMs ?? 60_000);
    const delayMs = Math.min(maxMs, baseMs * (2 ** Math.min(failures - 1, 10)));
    const retryAt = this.now().getTime() + delayMs;
    this.providerBackoffs.set(key, { failures, retryAt });
    return { failures, retryAt };
  }

  private async compose(record: RuntimeTaskRecord): Promise<RuntimeContext> {
    const workspaceAgents = (await listWorkspaceAgents(this.workspace)).length
      ? await listWorkspaceAgents(this.workspace)
      : await ensureCoreTeam(this.workspace, await this.profiles.list());
    const profiles = await this.profiles.list();
    const missionStore = new MissionStore(this.workspace.rootPath, record.missionId);
    const persistedMission = await missionStore.read();
    const team = persistedMission?.record.teamBinding
      ?? createTeamBinding(this.workspace, workspaceAgents, profiles, "minimal-team");
    const tickets = new TicketEngine(
      new TicketStore(this.workspace.rootPath, record.taskId, record.runId),
      this.policyStore,
      {
        teamBindingIds: [team.teamBindingId],
        now: () => this.now(),
        workspacePort: new WorkspaceSnapshotStore(this.workspace.rootPath, () => this.now()),
      },
    );
    const engines = new Map<string, AgentEngine<MissionTicketOutcome>>();
    const loops = new Map<string, AgentExecutionRuntime>();
    for (const agent of workspaceAgents) {
      const profile = profiles.find((item) => item.id === agent.profileId);
      if (!profile) continue;
      const resolutionPort = new MissionGoalResolutionPort(
        () => {
          if (this.timer) {
            queueMicrotask(() => void this.backgroundTick().catch((error) => {
              console.error("RuntimeHost proposal wake failed", error);
            }));
          }
        },
        agent.id,
        () => this.now(),
        this.workspace.rootPath,
      );
      const store = new AgentStore(this.workspace.rootPath, agent.id);
      const engine = new AgentEngine<MissionTicketOutcome>(store, resolutionPort, { now: () => this.now() });
      const policy = resolvePolicy(this.workspace, agent, profile);
      const enabled = toolsForPolicy(policy).map((tool) => tool.name) as WorkspaceToolName[];
      engines.set(agent.id, engine);
      loops.set(agent.id, new PiAgentRuntime(
        this.workspace.rootPath,
        engine,
        store,
        new AgentContextAssembler(store),
        this.providers,
        new AgentToolRuntime(policy, enabled),
        new AgentTraceStore(this.workspace.rootPath, agent.id),
        { now: () => this.now() },
      ));
    }
    const manager = new MissionProcessManager(
      missionStore,
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
    return { record, team, tickets, manager, engines, loops };
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
    return this.sliceInputForAgent(
      context,
      link.agentId,
      link.agentThreadId,
      link.agentGoalId,
      turnId,
      triggerMessageId,
      link.attemptId,
    );
  }

  private async sliceInputForAgent(
    context: RuntimeContext,
    agentId: string,
    threadId: string,
    goalId?: string,
    turnId?: string,
    triggerMessageId?: string,
    attemptId?: string,
  ) {
    const agent = (await listWorkspaceAgents(this.workspace)).find((item) => item.id === agentId)!;
    const profile = (await this.profiles.list()).find((item) => item.id === agent.profileId)!;
    const provider = agent.provider ?? profile.defaultProvider;
    const model = agent.model ?? profile.defaultModel;
    const modelRuntime = await this.providers.modelRuntimeConfig(provider, model);
    return {
      threadId,
      turnId,
      triggerMessageId,
      goalId,
      attemptId,
      profile,
      agent,
      policy: resolvePolicy(this.workspace, agent, profile),
      provider,
      model,
      ...modelRuntime,
    };
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

export function queuedMessageRoute(
  sourceGoalId: string | undefined,
  currentGoalId: string | undefined,
): "active_goal" | "idle" | "defer" {
  if (!currentGoalId) return "idle";
  return sourceGoalId === currentGoalId ? "active_goal" : "defer";
}

function projectThread(
  thread: Awaited<ReturnType<AgentEngine<any>["getThread"]>>,
  payloads: Map<string, unknown>,
  record: RuntimeTaskRecord,
): AgentThreadEvent[] {
  const events: AgentThreadEvent[] = [];
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

function projectedAgentStatus(
  linkStatus: string | undefined,
  goalStatus: string | undefined,
  events: AgentThreadEvent[],
  executing: boolean,
): EntityStatus {
  if (linkStatus === "blocked" || goalStatus === "blocked" || goalStatus === "usage_limited") return "blocked";
  if (goalStatus === "paused") return "paused";
  if (goalStatus === "failed") return "failed";
  if (goalStatus === "completed" || goalStatus === "cancelled") return "idle";
  if (executing) return "running";
  const latestControl = [...events].reverse().find((event) => event.source === "system");
  const activity = (latestControl?.payload as Record<string, unknown> | undefined)?.status;
  if (linkStatus === "running" && activity === "waiting") return "waiting";
  return linkStatus === "running" ? "waiting" : "idle";
}

function projectedPausedAgentStatus(linkStatus: string | undefined, goalStatus: string | undefined): EntityStatus {
  if (linkStatus === "blocked" || goalStatus === "blocked" || goalStatus === "usage_limited") return "blocked";
  if (linkStatus === "running" || linkStatus === "resolving" || linkStatus === "paused" || goalStatus === "active" || goalStatus === "paused") return "paused";
  if (goalStatus === "failed") return "failed";
  return "idle";
}

function legacyTicketStatus(status: string): Ticket["status"] {
  if (status === "ready" || status === "pending") return "pending";
  return status as Ticket["status"];
}

export function projectTicketBlocker(reason: string, requiredInput: TicketRequiredInput): TicketBlocker {
  const type: TicketBlocker["type"] = requiredInput.kind === "manual_test"
    ? "manual_test_required"
    : requiredInput.kind === "authorization" || requiredInput.kind === "irreversible_confirmation"
      ? "human_authorization_required"
      : requiredInput.kind === "tool_policy"
        ? "tool_policy_blocked"
        : "external_dependency";
  return {
    type,
    reason: requiredInput.description || reason,
    ...(requiredInput.details ? { details: structuredClone(requiredInput.details) } : {}),
  };
}

export function presentationStatus(
  plan: string,
  mission: string,
  tickets: ReadonlyArray<Pick<Ticket, "status" | "blocker">> = [],
): EntityStatus {
  if (mission === "completed") return "completed";
  if (plan === "failed") return "failed";
  if (plan === "cancelled") return "interrupted";
  if (plan === "paused") return "paused";
  if (tickets.some((ticket) => ticket.status === "blocked" || ticket.blocker)) return "blocked";
  if (tickets.some((ticket) => ticket.status === "running" || ticket.status === "pending")) return "running";
  if (plan === "blocked") return "blocked";
  if (plan === "completed") return "blocked";
  return "running";
}

export function planAllowsActiveAgentExecution(planStatus: string): boolean {
  return planStatus === "active" || planStatus === "blocked";
}

function hasEligibleMember(team: TeamBinding, assignment: PlannedTicketAssignment): boolean {
  return team.members.some((member) => {
    if (assignment.principalId && member.principalId !== assignment.principalId) return false;
    return (assignment.requiredCapabilities ?? []).every((capability) => member.capabilities.includes(capability))
      && (assignment.requiredTools ?? []).every((tool) => member.enabledTools.includes(tool));
  });
}

function assignmentGapReason(assignment: PlannedTicketAssignment): string {
  if (assignment.principalId) return `工单指定负责人 ${assignment.principalId} 不在当前 Mission 的 TeamBinding 中或能力、工具不匹配`;
  const required = assignment.requiredCapabilities ?? [];
  const requiredTools = assignment.requiredTools ?? [];
  return required.length || requiredTools.length
    ? `当前 Mission 的 TeamBinding 中没有同时满足分配契约的 Agent：能力 ${required.join("、") || "无"}；工具 ${requiredTools.join("、") || "无"}`
    : "当前 Mission 的 TeamBinding 中没有可领取该工单的 Agent";
}

function presentationPhase(planStatus: string, missionStatus: string, tickets: Ticket[]): MissionPhase {
  if (missionStatus === "completed") return "completed";
  if (planStatus === "failed") return "failed";
  if (planStatus === "paused") return "paused";
  if (planStatus === "completed") return "idle";
  if (tickets.some((ticket) => ticket.status === "blocked" || ticket.blocker)) return "blocked";
  if (tickets.some((ticket) => ticket.status === "running" || ticket.status === "pending")) return "running";
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
