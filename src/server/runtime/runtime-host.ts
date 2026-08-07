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
import { ensureWorkspaceAgent, listWorkspaceAgents } from "../agents/roster.js";
import type { AgentProfileStore } from "../agents/profile-store.js";
import { MissionGoalResolutionPort } from "../mission-process/mission-goal-resolution-port.js";
import { MissionProcessManager } from "../mission-process/mission-process-manager.js";
import { LegacyMissionPlanError, MissionStore } from "../mission-process/mission-store.js";
import type { MissionTicketOutcome } from "../mission-process/ticket-agent-adapter.js";
import { createMinimalTeamPlanDefinition } from "../product/plan-template.js";
import { createTeamBinding } from "../product/team-binding.js";
import type { ProviderRegistry } from "../providers/provider-registry.js";
import { resolvePolicy } from "../policy/policy.js";
import { configuredToolsInclude, toolsForPolicy } from "../../shared/tool-catalog.js";
import { TicketEngine } from "../tickets/ticket-engine.js";
import { TicketStore } from "../tickets/ticket-store.js";
import { WorkspaceSnapshotStore } from "../tickets/workspace-snapshot-store.js";
import type { PlanPolicyStore } from "../tickets/plan-policy-store.js";
import { RuntimeHostStore, type RuntimeRetryState, type RuntimeTaskError, type RuntimeTaskRecord } from "./runtime-host-store.js";
import { StaffingCoordinator } from "../staffing/staffing-coordinator.js";
import type { TeamStaffingOutcome } from "../../shared/contracts/staffing.js";
import type { RuntimeExecutionGate, RuntimeHostScheduler } from "./runtime-scheduler.js";

interface RuntimeContext {
  record: RuntimeTaskRecord;
  team: TeamBinding;
  tickets: TicketEngine;
  manager: MissionProcessManager;
  engines: Map<string, AgentEngine<MissionTicketOutcome>>;
  loops: Map<string, AgentExecutionRuntime>;
}

const SCHEDULER_TICKET_STATUSES = new Set(["pending", "ready", "running"]);

export function planHasRunnableTickets(tickets: Array<{ status: string }>): boolean {
  return tickets.some((ticket) => SCHEDULER_TICKET_STATUSES.has(ticket.status));
}

export const REQUIRED_TEAM_CAPABILITIES = ["mission:intake", "plan:plan", "delivery:accept"] as const;

export class RuntimeHost {
  private readonly store: RuntimeHostStore;
  private readonly staffing: StaffingCoordinator;
  private readonly contexts = new Map<string, RuntimeContext>();
  private readonly readOnlyTasks = new Map<string, string>();
  private readonly agentRuns = new Map<string, Promise<void>>();
  private readonly providerBackoffs = new Map<string, RuntimeRetryState>();
  private readonly deferredTaskIds = new Set<string>();
  private schedulerRegistered = false;
  private timer?: NodeJS.Timeout;
  private tickPromise?: Promise<void>;
  private backgroundTickPromise?: Promise<void>;
  private backgroundTickRequested = false;
  private startPromise?: Promise<void>;
  private started = false;
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
      initialTeamBinding?: TeamBinding | (() => Promise<TeamBinding>);
      scheduler?: RuntimeHostScheduler;
      schedulerKey?: string;
      executionGate?: RuntimeExecutionGate;
    } = {},
  ) {
    this.store = new RuntimeHostStore(workspace.rootPath);
    this.staffing = new StaffingCoordinator(
      workspace,
      profiles,
      providers,
      REQUIRED_TEAM_CAPABILITIES,
      () => this.store.list(),
      () => this.now(),
    );
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
    if (!this.contexts.has(taskId)) {
      const request = await this.staffing.get(taskId);
      if (request?.staffingAgentId === agentId) {
        if (attachments.length) throw new Error("组队阶段暂不接受图片附件");
        await this.staffing.sendHumanMessage(taskId, message, messageId);
        this.requestSchedulerTick();
        return this.snapshotUnlocked();
      }
    }
    let queuedTurn: Promise<void> | undefined;
    const result = await this.exclusive(async () => {
      const accepted = await this.appendAgentMessageUnlocked(taskId, agentId, message, messageId, attachments);
      if (accepted.appended && !accepted.deferred) {
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
    if (!this.contexts.has(taskId)) {
      const request = await this.staffing.get(taskId);
      if (request) return this.sendAgentMessage(taskId, request.staffingAgentId, message, messageId);
    }
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
    if (this.schedulerRegistered || this.timer) return;
    if (this.startPromise) return this.startPromise;
    const pending = (async () => {
      this.started = true;
      await this.exclusive(() => this.recoverUnlocked({ deferActive: true }));
      if (this.schedulerRegistered || this.timer) return;
      if (await this.hasRunnableWork()) this.startScheduler();
    })();
    const tracked = pending.finally(() => {
      if (this.startPromise === tracked) this.startPromise = undefined;
    });
    this.startPromise = tracked;
    return tracked;
  }

  private startScheduler(): void {
    if (!this.started || this.schedulerRegistered || this.timer) return;
    if (this.options.scheduler) {
      const key = this.options.schedulerKey ?? this.workspace.id;
      this.options.scheduler.register(key, () => this.backgroundTick());
      this.schedulerRegistered = true;
      this.options.scheduler.request(key);
      return;
    }
    this.timer = setInterval(() => {
      void this.backgroundTick().catch((error) => {
        console.error("RuntimeHost background tick failed", error);
      });
    }, this.options.intervalMs ?? 1_000);
    this.timer.unref();
    // Wake once after the caller's current turn has returned. This makes a
    // newly created task responsive without racing the caller's first UI read.
    setTimeout(() => {
      if (this.started && this.timer) this.requestSchedulerTick();
    }, 0);
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.schedulerRegistered && this.options.scheduler) {
      this.schedulerRegistered = false;
      await this.options.scheduler.unregister(this.options.schedulerKey ?? this.workspace.id);
    }
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.providerBackoffs.clear();

    await Promise.allSettled(
      [...this.contexts.values()].flatMap((context) =>
        [...context.loops.values()].map((runtime) => runtime.dispose?.()),
      ),
    );
    await this.staffing.dispose();

    const schedulerWork = [this.tickPromise, this.backgroundTickPromise].filter(
      (pending): pending is Promise<void> => pending !== undefined,
    );
    await Promise.allSettled([...schedulerWork, ...this.agentRuns.values()]);
    await this.operationTail.catch(() => undefined);
  }

  private requestSchedulerTick(): void {
    if (!this.started && !this.schedulerRegistered && !this.timer) return;
    this.backgroundTickRequested = true;
    if (this.options.scheduler) {
      if (this.started && !this.schedulerRegistered) this.startScheduler();
      if (this.schedulerRegistered) {
        this.options.scheduler.request(this.options.schedulerKey ?? this.workspace.id);
      }
      return;
    }
    if (this.timer) {
      queueMicrotask(() => void this.backgroundTick().catch((error) => {
        console.error("RuntimeHost scheduled tick failed", error);
      }));
    }
  }

  private executeWithCapacity<T>(work: () => Promise<T>): Promise<T> {
    return this.options.executionGate?.run(work) ?? work();
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
    if (this.options.initialTeamBinding) {
      await this.store.save(record);
      const team = typeof this.options.initialTeamBinding === "function"
        ? await this.options.initialTeamBinding()
        : this.options.initialTeamBinding;
      await this.initializeMission(record, team);
      this.startScheduler();
      return record;
    }
    await this.staffing.create(record.taskId, record.objective);
    await this.store.save(record);
    this.startScheduler();
    if (this.started) {
      this.requestSchedulerTick();
    }
    return record;
  }

  private async recoverUnlocked(options: { deferActive?: boolean } = {}): Promise<void> {
    for (const record of await this.store.list()) {
      try {
        const persistedMission = await new MissionStore(this.workspace.rootPath, record.missionId).read();
        if (!persistedMission) {
          if (new Set(["completed", "failed", "cancelled"]).has(record.status)) continue;
          const staffing = await this.staffing.get(record.taskId);
          if (staffing?.status === "completed" && staffing.proposal?.status === "staffed") {
            await this.initializeMissionFromStaffing(record, staffing.proposal);
          }
          continue;
        }
        const persisted = persistedMission.record;
        const aggregate = options.deferActive
          ? await new TicketStore(this.workspace.rootPath, record.taskId, record.runId).read(persisted.planId)
          : undefined;
        const plan = aggregate?.plan;
        if (options.deferActive && !plan) {
          throw new Error("Persisted Mission has no matching Plan");
        }
        const recoveredStatus = runtimeTaskStatusFor(
          plan?.status ?? "active",
          persisted.status,
        );
        if (recoveredStatus !== record.status) {
          await this.store.save({ ...record, status: recoveredStatus, updatedAt: this.now().toISOString() });
          record.status = recoveredStatus;
        }
        this.restoreRetryStates(record);
        if (options.deferActive && plan && recoveredStatus === "active") {
          if (planHasRunnableTickets(aggregate?.tickets ?? [])) this.deferredTaskIds.add(record.taskId);
          continue;
        }
        const context = await this.compose(record);
        this.contexts.set(record.taskId, context);
        const restored = await context.manager.current();
        const restoredPlan = await context.tickets.getPlan(restored.record.planId);
        const contextStatus = runtimeTaskStatusFor(restoredPlan.status, restored.record.status);
        if (contextStatus !== context.record.status) {
          context.record = { ...context.record, status: contextStatus, updatedAt: this.now().toISOString() };
          await this.store.save(context.record);
        }
        // Terminal tasks are restored for a truthful read-only snapshot only.
        // They must never re-enter the scheduler or create another Agent turn.
        if (new Set(["completed", "failed", "cancelled", "waiting"]).has(context.record.status)) continue;
        const ownerPrincipalId = restored.record.ownerPrincipalId
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
      if (this.contexts.has(record.taskId)) continue;
      try {
        const persistedMission = await new MissionStore(this.workspace.rootPath, record.missionId).read();
        if (!persistedMission) continue;
        const context = await this.compose(record);
        this.contexts.set(record.taskId, context);
        this.restoreRetryStates(record);
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
      if (this.backgroundTickRequested) this.requestSchedulerTick();
    });
    this.backgroundTickPromise = tracked;
    return tracked;
  }

  private async tickUnlocked(awaitAgentRuns = true): Promise<void> {
    for (const taskId of [...this.deferredTaskIds]) {
      const record = await this.store.get(taskId);
      if (!record || record.status !== "active") {
        this.deferredTaskIds.delete(taskId);
        continue;
      }
      try {
        const context = await this.compose(record);
        this.contexts.set(taskId, context);
        this.deferredTaskIds.delete(taskId);
        await this.restoreActiveContext(context, record);
      } catch (error) {
        this.deferredTaskIds.delete(taskId);
        console.error(`RuntimeHost deferred task restore failed for ${taskId}`, error);
        continue;
      }
    }
    for (const record of await this.store.list()) {
      if (record.status !== "active" || this.contexts.has(record.taskId)) continue;
      const request = await this.staffing.get(record.taskId);
      if (!request || new Set(["blocked", "failed"]).has(request.status)) continue;
      const key = `staffing:${record.taskId}`;
      const run = this.agentRuns.get(key) ?? this.trackAgentRun(key, this.runStaffingOnce(record));
      if (awaitAgentRuns) await run;
    }
    for (const context of this.contexts.values()) {
      try {
        await this.tickTask(context, awaitAgentRuns);
        await this.clearRuntimeError(context);
      } catch (error) {
        console.error(`RuntimeHost task tick failed for ${context.record.taskId}`, error);
        await this.recordRuntimeError(context, {
          source: "scheduler",
          message: error instanceof Error ? error.message : String(error),
          at: this.now().toISOString(),
        }).catch((recordError) => {
          console.error(`RuntimeHost could not persist task tick failure for ${context.record.taskId}`, recordError);
        });
      }
    }
  }

  private async appendAgentMessageUnlocked(
    taskId: string,
    agentId: string,
    message: string,
    messageId: string,
    attachments: AgentMessageAttachment[] = [],
  ): Promise<{ appended: boolean; turnId: string; goalId?: string; deferred: boolean }> {
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
    const deferred = context.record.status === "paused";
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
    if (!appended) return { appended: false, turnId, goalId, deferred };
    if (goalId && !deferred) {
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
    return { appended: true, turnId, goalId, deferred };
  }

  private async continueAfterAgentMessageUnlocked(
    taskId: string,
    agentId: string,
    turnId: string,
    triggerMessageId: string,
    sourceGoalId?: string,
  ): Promise<void> {
    const context = await this.requireContext(taskId);
    if (context.record.status === "paused") return;
    const thread = await context.engines.get(agentId)?.getThreadForAgent(agentId, context.record.missionId);
    if (!thread) return;
    const resumedLink = await this.activeLink(context, agentId);
    const route = queuedMessageRoute(sourceGoalId, resumedLink?.agentGoalId);
    if (route === "active_goal" && resumedLink?.status === "running") {
      await this.runAgentSlice(context, resumedLink, turnId, triggerMessageId);
    } else if (route === "idle") {
      await this.runIdleAgentTurn(context, agentId, thread.threadId, { turnId, triggerMessageId });
      return;
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
    await this.recordRuntimeError(context, {
      source: "agent_turn",
      message: error instanceof Error ? error.message : String(error),
      at: createdAt,
      agentId,
      turnId,
    });
  }

  async listTasks(): Promise<RuntimeTaskRecord[]> {
    return this.store.list();
  }

  private async pauseTaskUnlocked(taskId: string): Promise<void> {
    if (!this.contexts.has(taskId)) {
      const record = await this.requireTaskRecord(taskId);
      await this.store.save({ ...record, status: "paused", updatedAt: this.now().toISOString() });
      return;
    }
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
    if (!this.contexts.has(taskId)) {
      const record = await this.requireTaskRecord(taskId);
      await this.store.save({ ...record, status: "active", updatedAt: this.now().toISOString() });
      this.startScheduler();
      if (this.started) {
        this.requestSchedulerTick();
      }
      return;
    }
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
    this.startScheduler();
    await this.resumeDeferredHumanTurnsUnlocked(context);
    await this.tickTask(context, false);
  }

  private async resumeDeferredHumanTurnsUnlocked(context: RuntimeContext): Promise<void> {
    const mission = await context.manager.current();
    for (const link of mission.links.filter((item) => item.status === "blocked")) {
      if (!link.agentGoalId || !link.agentThreadId) continue;
      const runtime = context.loops.get(link.agentId);
      const pending = await runtime?.pendingHumanTurn(link.agentThreadId);
      if (!pending) continue;
      const engine = context.engines.get(link.agentId);
      const goal = await engine?.getGoal(link.agentGoalId);
      if (goal && (goal.status === "blocked" || goal.status === "paused" || goal.status === "usage_limited")) {
        await engine!.controlGoal({
          requestId: stableId("resume_deferred_human", context.record.taskId, link.agentId, goal.spec.id, pending.triggerMessageId),
          goalId: goal.spec.id,
          expectedGoalVersion: goal.version,
          action: "resume",
          reason: "a chronological human message was queued while the Plan was paused",
        });
      }
      await context.manager.resumeBlockedAgent(link.agentId);
    }
  }

  private async cancelTaskUnlocked(taskId: string, reason: string): Promise<void> {
    if (!this.contexts.has(taskId)) {
      const record = await this.requireTaskRecord(taskId);
      await this.staffing.cancel(taskId, reason);
      await this.store.save({ ...record, status: "cancelled", updatedAt: this.now().toISOString() });
      return;
    }
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
      if (goal && !new Set(["completed", "failed", "cancelled"]).has(goal.status)) {
        await engine.controlGoal({
          requestId: stableId("cancel_goal", taskId, goal.spec.id, String(goal.version)),
          goalId: goal.spec.id,
          expectedGoalVersion: goal.version,
          action: "cancel",
          reason,
        });
        // Cancelling the business link and cancelling the Agent Goal are not
        // enough by themselves: the runtime lease is an Agent Engine resource
        // and must be released explicitly when no scheduler tick will follow.
        await context.loops.get(link.agentId)?.releaseGoalResources?.({
          agentId: link.agentId,
          threadId: link.agentThreadId!,
          goalId: link.agentGoalId!,
          attemptId: link.attemptId,
        });
      }
    }
    await context.manager.markActiveLinksCancelled();
    context.record = { ...context.record, status: "cancelled", updatedAt: this.now().toISOString() };
    await this.store.save(context.record);
  }

  private async snapshotUnlocked(): Promise<WorkspaceSnapshot> {
    const tasks = await this.store.list();
    const record = [...tasks].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    const [agents, profiles] = await Promise.all([
      listWorkspaceAgents(this.workspace),
      this.profiles.list(),
    ]);
    const presentedAgents = agents.map((agent) => {
      const profile = profiles.find((item) => item.id === agent.profileId);
      return {
        ...agent,
        name: profile?.name ?? "档案已缺失",
        role: profile?.role ?? agent.roleInWorkspace,
        capabilities: profile?.capabilities ?? [],
      };
    });
    if (!record) return {
      workspace: this.workspace,
      agents: presentedAgents,
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
      agents: presentedAgents.map((agent) => ({ ...agent, status: "idle" as const })),
      assignments: [],
      tickets: [],
      agentThreads: {},
      recentEvents: [],
      phase: "interrupted",
      status: "interrupted",
      currentStep: readOnlyReason,
      readOnlyReason,
      runtimeError: record.runtimeError,
    };
    if (!this.contexts.has(record.taskId)) {
      const staffing = await this.staffing.get(record.taskId);
      if (staffing) {
        const projection = await this.staffing.projection(record.taskId).catch(() => undefined);
        const projectOwner = presentedAgents.find((agent) => agent.id === staffing.staffingAgentId);
        if (!projectOwner) throw new Error("项目负责人实例不存在，无法投影目标处理状态");
        const staffer: WorkspaceSnapshot["agents"][number] = {
          ...projectOwner,
          status: staffing.status === "running" ? "running" : staffing.status === "blocked" ? "blocked" : "waiting",
          currentStep: staffing.status === "blocked" ? staffing.blockReason : "处理收到的目标",
        };
        const threadEvents = projection?.thread
          ? projectThread(projection.thread, projection.payloads, record)
          : [];
        const status = staffing.status === "blocked" || staffing.status === "failed" ? "blocked" : "running";
        const staffingAgents = presentedAgents.map((agent) =>
          agent.id === staffing.staffingAgentId ? staffer : { ...agent, status: "idle" as const },
        );
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
            phase: status === "blocked" ? "blocked" : "running",
            startedAt: record.createdAt,
          },
          agents: staffingAgents,
          assignments: [],
          tickets: [],
          agentThreads: { [staffer.id]: threadEvents },
          recentEvents: threadEvents.map((event) => ({
            id: event.id,
            workspaceId: this.workspace.id,
            taskId: record.taskId,
            taskRunId: record.runId,
            actorId: staffer.id,
            type: "agent.status_changed" as const,
            summary: threadEventText(event),
            payload: event.payload,
            timestamp: event.timestamp,
            sequence: event.sequence,
          })),
          phase: status === "blocked" ? "blocked" : "running",
          status,
          currentStep: staffing.status === "blocked"
            ? staffing.blockReason
            : `${staffer.name ?? "负责人"}正在处理收到的目标`,
          runtimeError: record.runtimeError,
        };
      }
    }
    const context = await this.requireContext(record.taskId);
    const mission = await context.manager.current();
    const plan = await context.tickets.getPlan(mission.record.planId);
    const taskPausedForPresentation = plan.status === "paused";
    const linksByTicket = new Map(mission.links.map((link) => [String(link.ticketId), link]));
    const [workItems, projections] = await Promise.all([
      Promise.all(plan.graph.ticketIds.map((ticketId) => context.tickets.getWorkItem(ticketId))),
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
            projection?.execution.leaseHeld ?? false,
          ),
        name: profile?.name,
        role: profile?.role,
        capabilities: profile?.capabilities,
        currentStep: goal?.spec.objective,
      });
    }
    const lifecycle = projectWorkspaceLifecycle(plan.status, mission.record.status, tickets);
    const { status, phase } = lifecycle;
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
        endedAt: new Set(["completed", "failed", "cancelled", "interrupted"]).has(status) ? record.updatedAt : undefined,
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
      runtimeError: record.runtimeError,
    };
  }

  context(taskId: string): RuntimeContext | undefined {
    return this.contexts.get(taskId);
  }

  providerRetryState(taskId: string, agentId: string): RuntimeRetryState | undefined {
    return this.providerBackoffs.get(`${taskId}:${agentId}`);
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async tickTask(context: RuntimeContext, awaitAgentRuns = true): Promise<void> {
    let mission = await context.manager.tick();
    const runningLinkKeysAtStart = new Set(
      mission.links
        .filter((link) => link.status === "running")
        .map((link) => missionLinkKey(link)),
    );
    const planBeforeRuns = await context.tickets.getPlan(mission.record.planId);
    const planAllowsNormalTurns = planAllowsActiveAgentExecution(planBeforeRuns.status);
    const planAllowsExplicitHumanTurns = planBeforeRuns.status === "blocked";
    if (!planAllowsNormalTurns && !planAllowsExplicitHumanTurns) {
      await this.syncTaskStatus(context, planBeforeRuns.status, mission.record.status);
      return;
    }
    const scheduledAgentIds = new Set<string>();
    for (const link of mission.links) {
      if (link.status !== "running") continue;
      const runKey = this.agentRunKey(context, link.agentId);
      if (this.agentRuns.has(runKey)) continue;
      const providerBackoff = this.providerBackoffs.get(runKey);
      if (providerBackoff && providerBackoff.retryAt > this.now().getTime()) continue;
      const engine = context.engines.get(link.agentId);
      const goal = await engine?.getGoal(link.agentGoalId);
      if (goal?.status !== "active") continue;
      const pendingHumanTurn = await context.loops.get(link.agentId)?.pendingHumanTurn(link.agentThreadId);
      const ticket = await context.tickets.getTicket(link.ticketId);
      const recoveredBlockedWork = canContinueRecoveredBlockedWork({
        planStatus: planBeforeRuns.status,
        ticketStatus: ticket?.status,
        linkStatus: link.status,
        authorityKind: link.authority.kind,
        goalStatus: goal.status,
      });
      const claimedTicketWork = canContinueClaimedTicketWork({
        planStatus: planBeforeRuns.status,
        ticketStatus: ticket?.status,
        ticketAuthority: ticket?.activeAuthority,
        linkStatus: link.status,
        linkAuthority: link.authority,
        goalStatus: goal.status,
      });
      if (!planAllowsNormalTurns && !pendingHumanTurn && !recoveredBlockedWork && !claimedTicketWork) continue;
      const readiness = await engine!.executionReadiness(goal.spec.id);
      if (!readiness.ready) {
        if (readiness.reason === "agent_busy") continue;
        if (readiness.reason === "repeated_host_correction_without_progress") {
          const createdAt = this.now().toISOString();
          await engine!.appendToolItem({
            itemId: stableId("agent_contract_stalled", context.record.taskId, link.agentId, goal.spec.id, String(goal.version)),
            threadId: link.agentThreadId,
            goalId: goal.spec.id,
            kind: "observation",
            value: {
              type: "agent_contract_stalled",
              reason: readiness.reason,
              message: "Agent repeated the same Host contract violation without any accepted state change.",
            },
            createdAt,
          });
        }
        if (readiness.reason === "repeated_turn_without_progress"
          || readiness.reason === "no_durable_progress_window_elapsed") {
          await engine!.appendToolItem({
            itemId: stableId("agent_turn_stalled", context.record.taskId, link.agentId, goal.spec.id, String(goal.version)),
            threadId: link.agentThreadId,
            goalId: goal.spec.id,
            kind: "observation",
            value: {
              type: "agent_turn_stalled",
              reason: readiness.reason,
              message: readiness.reason === "repeated_turn_without_progress"
                ? "Agent produced repeated turns without a new conclusion or durable progress."
                : "Agent produced no durable progress within the configured runtime window.",
            },
            createdAt: this.now().toISOString(),
          });
        }
        await engine!.controlGoal({
          requestId: stableId("no_progress", context.record.taskId, link.agentId, goal.spec.id, String(goal.version), readiness.reason),
          goalId: goal.spec.id,
          expectedGoalVersion: goal.version,
          action: "pause",
          reason: readiness.reason,
        });
        continue;
      }
      scheduledAgentIds.add(link.agentId);
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
      // The Mission path and the idle-message path share one Agent Thread.
      // A status transition can make a link disappear before this second
      // pass, but the Agent was already scheduled in this tick. Keep the
      // message queued for the next turn instead of running it twice.
      if (scheduledAgentIds.has(agentId)) continue;
      const key = this.agentRunKey(context, agentId);
      if (this.agentRuns.has(key)) continue;
      const thread = await context.engines.get(agentId)?.getThreadForAgent(agentId, context.record.missionId);
      if (!thread) continue;
      const pendingHumanTurn = await runtime.pendingHumanTurn(thread.threadId);
      const retry = this.providerBackoffs.get(key);
      const retryTurn = retry?.kind === "provider" && retry.turnId && retry.triggerMessageId
        ? { turnId: retry.turnId, triggerMessageId: retry.triggerMessageId }
        : undefined;
      const retryingPendingTurn = Boolean(
        pendingHumanTurn
        && retryTurn
        && pendingHumanTurn.turnId === retryTurn.turnId
        && pendingHumanTurn.triggerMessageId === retryTurn.triggerMessageId,
      );
      const hasNewHumanTurn = Boolean(pendingHumanTurn && !retryingPendingTurn);
      const retryIsDue = Boolean(
        retryTurn
        && (retry?.retryAt ?? Number.POSITIVE_INFINITY) <= this.now().getTime(),
      );
      // A new human message is explicit recovery input and is allowed to
      // bypass a provider backoff. The original pending message is not new
      // input: it must wait for its own persisted retry deadline.
      if (!hasNewHumanTurn && !retryIsDue) continue;
      const run = this.trackAgentRun(key, this.runIdleAgentTurn(
        context,
        agentId,
        thread.threadId,
        pendingHumanTurn ?? retryTurn!,
      ));
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
    await this.requestFollowUpForNewAgentLinks(context, mission.links, runningLinkKeysAtStart);
  }

  private async requestFollowUpForNewAgentLinks(
    context: RuntimeContext,
    links: MissionLink[],
    runningLinkKeysAtStart: Set<string>,
  ): Promise<void> {
    for (const link of links) {
      if (link.status !== "running" || runningLinkKeysAtStart.has(missionLinkKey(link))) continue;
      const runKey = this.agentRunKey(context, link.agentId);
      if (this.agentRuns.has(runKey)) continue;
      const goal = link.agentGoalId
        ? await context.engines.get(link.agentId)?.getGoal(link.agentGoalId)
        : undefined;
      if (goal?.status !== "active") continue;
      // Mission Control may have created this link during the final manager.tick
      // after the current Agent run. Keep the scheduler alive for the next
      // independent Agent turn; do not infer a business route here.
      this.requestSchedulerTick();
      return;
    }
  }

  private async runIdleAgentTurn(
    context: RuntimeContext,
    agentId: string,
    threadId: string,
    pending: { turnId: string; triggerMessageId: string },
  ): Promise<void> {
    const result = await this.executeWithCapacity(async () => {
      const runtime = context.loops.get(agentId);
      if (!runtime) return undefined;
      return runtime.runSlice(await this.sliceInputForAgent(
        context,
        agentId,
        threadId,
        undefined,
        pending.turnId,
        pending.triggerMessageId,
      ));
    });
    if (await this.isPlanPaused(context)) return;
    if (result?.status === "yielded" && result.blockReason === "provider_error" && result.providerRetryable) {
      await this.deferIdleProviderRetry(context, agentId, threadId, pending, result);
      return;
    }
    await this.clearRetryState(context, agentId);
    await context.manager.tick();
  }

  private async syncTaskStatus(context: RuntimeContext, planStatus: string, missionStatus: string): Promise<void> {
    const status = runtimeTaskStatusFor(planStatus, missionStatus);
    if (status !== context.record.status) {
      context.record = { ...context.record, status, updatedAt: this.now().toISOString() };
      await this.store.save(context.record);
    }
  }

  private async hasRunnableWork(): Promise<boolean> {
    // Startup recovery may have verified runnable Ticket facts without
    // materializing the Agent context yet. That deferred work still needs a
    // scheduler so the first tick can restore it on demand.
    if (this.deferredTaskIds.size > 0) return true;
    for (const record of await this.store.list()) {
      if (record.status !== "active") continue;
      const context = this.contexts.get(record.taskId);
      if (context) {
        const mission = await context.manager.current().catch(() => undefined);
        if (!mission) continue;
        const plan = await context.tickets.getPlan(mission.record.planId).catch(() => undefined);
        if (plan && plan.status === "active") {
          const tickets = await Promise.all(plan.graph.ticketIds.map((ticketId) => context.tickets.getTicket(ticketId)));
          if (planHasRunnableTickets(tickets.filter((ticket) => ticket !== undefined))) return true;
        }
        continue;
      }
      const staffing = await this.staffing.get(record.taskId);
      if (staffing && !new Set(["blocked", "failed", "completed"]).has(staffing.status)) return true;
    }
    return false;
  }

  private async recordRuntimeError(context: RuntimeContext, error: RuntimeTaskError): Promise<void> {
    context.record = {
      ...context.record,
      runtimeError: error,
      updatedAt: error.at,
    };
    await this.store.save(context.record);
  }

  private async clearRuntimeError(context: RuntimeContext): Promise<void> {
    if (!context.record.runtimeError) return;
    context.record = {
      ...context.record,
      runtimeError: undefined,
      updatedAt: this.now().toISOString(),
    };
    await this.store.save(context.record);
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
    // The queue is scoped to the Mission/Agent Thread. A role or agent id alone
    // would make private messages from different tasks share one run slot.
    const key = `${taskId}:${agentId}`;
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
      this.requestSchedulerTick();
    });
    this.agentRuns.set(key, tracked);
    return tracked;
  }

  private agentRunKey(context: RuntimeContext, agentId: string): string {
    return `${context.record.taskId}:${agentId}`;
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
    const result = await this.executeWithCapacity(async () => {
      const runtime = context.loops.get(link.agentId);
      if (!runtime) return undefined;
      return runtime.runSlice(await this.sliceInput(context, link, turnId, triggerMessageId));
    });
    if (await this.isPlanPaused(context)) return;
    const key = this.agentRunKey(context, link.agentId);
    if (result?.status === "yielded" && result.blockReason === "provider_error" && result.providerRetryable) {
      await this.deferProviderRetry(context, link, result);
      return;
    }
    if (result?.status === "execution_blocked"
      && result.blockReason === "provider_error"
      && result.goal?.status === "active") {
      await context.manager.blockAgentExecution({
        agentId: link.agentId,
        turnId: result.turnId,
        reason: result.blockedMessage ?? "Agent Engine provider configuration is unavailable",
        requiredInput: {
          kind: "credential",
          description: result.blockedMessage ?? "模型服务凭证不可用，请配置后回复当前 Agent",
          details: { source: "agent_engine.provider", turnId: result.turnId },
        },
      });
      await this.clearRetryState(context, link.agentId);
      return;
    }
    if (result?.status === "execution_blocked"
      && result.goal?.status === "active"
      && (result.blockReason === "no_progress" || result.blockReason === "provider_protocol")) {
      await this.deferExecutionRetry(context, link, result);
      return;
    }
    await this.clearRetryState(context, link.agentId);
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

  private async isPlanPaused(context: RuntimeContext): Promise<boolean> {
    const mission = await context.manager.current();
    const plan = await context.tickets.getPlan(mission.record.planId);
    return plan.status === "paused";
  }

  private async deferExecutionRetry(
    context: RuntimeContext,
    link: ActiveMissionLink,
    result: AgentExecutionSliceResult,
  ): Promise<void> {
    const retry = await this.scheduleRetry(context, link.agentId, "execution");
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
    const { failures, retryAt } = await this.scheduleRetry(context, link.agentId, "provider");
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

  private async deferIdleProviderRetry(
    context: RuntimeContext,
    agentId: string,
    threadId: string,
    pending: { turnId: string; triggerMessageId: string },
    result: AgentExecutionSliceResult,
  ): Promise<void> {
    const { failures, retryAt } = await this.scheduleRetry(context, agentId, "provider", pending);
    await context.engines.get(agentId)?.appendToolItem({
      itemId: `${result.turnId}:provider-backoff`,
      turnId: result.turnId,
      threadId,
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

  private async scheduleRetry(
    context: RuntimeContext,
    agentId: string,
    kind: RuntimeRetryState["kind"],
    continuation?: { turnId: string; triggerMessageId: string },
  ): Promise<{ failures: number; retryAt: number }> {
    const key = this.agentRunKey(context, agentId);
    const previous = this.providerBackoffs.get(key);
    const failures = (previous && (!previous.kind || previous.kind === kind) ? previous.failures : 0) + 1;
    const baseMs = Math.max(1, this.options.providerRetryBaseMs ?? 5_000);
    const maxMs = Math.max(baseMs, this.options.providerRetryMaxMs ?? 60_000);
    const delayMs = Math.min(maxMs, baseMs * (2 ** Math.min(failures - 1, 10)));
    const retryAt = this.now().getTime() + delayMs;
    const next: RuntimeRetryState = {
      failures,
      retryAt,
      kind,
      ...(continuation ?? {}),
    };
    this.providerBackoffs.set(key, next);
    context.record = {
      ...context.record,
      retryStates: {
        ...(context.record.retryStates ?? {}),
        [agentId]: next,
      },
      updatedAt: this.now().toISOString(),
    };
    await this.store.save(context.record);
    return { failures, retryAt };
  }

  private restoreRetryStates(record: RuntimeTaskRecord): void {
    for (const [agentId, state] of Object.entries(record.retryStates ?? {})) {
      if (!Number.isInteger(state.failures) || state.failures < 1 || !Number.isFinite(state.retryAt)) continue;
      this.providerBackoffs.set(`${record.taskId}:${agentId}`, state);
    }
  }

  private async clearRetryState(context: RuntimeContext, agentId: string): Promise<void> {
    if (!this.providerBackoffs.delete(this.agentRunKey(context, agentId))) return;
    context.record = {
      ...context.record,
      retryStates: withoutRetryState(context.record.retryStates, agentId),
      updatedAt: this.now().toISOString(),
    };
    await this.store.save(context.record);
  }

  private async runStaffingOnce(record: RuntimeTaskRecord): Promise<void> {
    const result = await this.executeWithCapacity(() => this.staffing.runOnce(record.taskId));
    if (result.outcome?.status !== "staffed") return;
    if ((await this.requireTaskRecord(record.taskId)).status !== "active") return;
    await this.initializeMissionFromStaffing(record, result.outcome);
  }

  private async initializeMissionFromStaffing(
    record: RuntimeTaskRecord,
    outcome: Extract<TeamStaffingOutcome, { status: "staffed" }>,
  ): Promise<void> {
    if (this.contexts.has(record.taskId)) return;
    const profiles = await this.profiles.list();
    const existingAgents = await listWorkspaceAgents(this.workspace);
    const selectedAgents: WorkspaceAgent[] = [];
    for (const member of outcome.members) {
      const profile = profiles.find((item) => item.id === member.profileId);
      if (!profile) throw new Error(`Staffing profile no longer exists: ${member.profileId}`);
      const existing = existingAgents.find((agent) => agent.profileId === profile.id);
      selectedAgents.push(existing ?? await ensureWorkspaceAgent(
        this.workspace,
        profile,
        stableId("workspace-agent", this.workspace.id, profile.id),
      ));
    }
    const team = createTeamBinding(
      this.workspace,
      selectedAgents,
      profiles,
      "minimal-team",
    );
    await this.initializeMission(record, team);
  }

  private async initializeMission(record: RuntimeTaskRecord, team: TeamBinding): Promise<void> {
    if (this.contexts.has(record.taskId)) return;
    const owner = team.members.find((member) => member.capabilities.includes("mission:intake"));
    if (!owner) throw new Error("组队提案通过后仍缺少 mission:intake 能力");
    const context = await this.compose(record, team);
    await context.manager.startMission({
      missionId: record.missionId,
      objective: record.objective,
      requestedByPrincipalId: "human",
      ownerPrincipalId: owner.principalId,
      teamBinding: team,
      resolvedStart: {
        planDefinition: createMinimalTeamPlanDefinition(this.policyRef, record.objective),
        teamBindingId: team.teamBindingId,
      },
    });
    this.contexts.set(record.taskId, context);
  }

  private async requireTaskRecord(taskId: string): Promise<RuntimeTaskRecord> {
    const record = await this.store.get(taskId);
    if (!record) throw new Error("Task does not exist");
    return record;
  }

  private async compose(record: RuntimeTaskRecord, teamOverride?: TeamBinding): Promise<RuntimeContext> {
    const workspaceAgents = await listWorkspaceAgents(this.workspace);
    const profiles = await this.profiles.list();
    const missionStore = new MissionStore(this.workspace.rootPath, record.missionId);
    const persistedMission = await missionStore.read();
    const team = teamOverride ?? persistedMission?.record.teamBinding
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
          this.requestSchedulerTick();
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
    if (this.deferredTaskIds.delete(taskId)) await this.restoreActiveContext(context, record);
    return context;
  }

  private async restoreActiveContext(context: RuntimeContext, record: RuntimeTaskRecord): Promise<void> {
    const mission = await context.manager.current();
    const plan = await context.tickets.getPlan(mission.record.planId);
    const status = runtimeTaskStatusFor(plan.status, mission.record.status);
    if (status !== context.record.status) {
      context.record = { ...context.record, status, updatedAt: this.now().toISOString() };
      await this.store.save(context.record);
    }
    if (new Set(["completed", "failed", "cancelled", "waiting"]).has(context.record.status)) return;
    const ownerPrincipalId = mission.record.ownerPrincipalId
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
  }

  private async activeLink(context: RuntimeContext, agentId: string) {
    return (await context.manager.tick()).links.find((link) =>
      link.agentId === agentId && new Set(["running", "blocked", "resolving", "paused"]).has(link.status));
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

export function projectedAgentStatus(
  linkStatus: string | undefined,
  goalStatus: string | undefined,
  events: AgentThreadEvent[],
  executionLeaseHeld: boolean,
): EntityStatus {
  if (linkStatus === "blocked" || goalStatus === "blocked" || goalStatus === "usage_limited") return "blocked";
  if (goalStatus === "paused") return "paused";
  if (goalStatus === "failed") return "failed";
  if (goalStatus === "completed" || goalStatus === "cancelled") return "idle";
  const latestControl = [...events].reverse().find((event) => event.source === "system");
  const activity = (latestControl?.payload as Record<string, unknown> | undefined)?.status;
  if (linkStatus === "running" && new Set([
    "waiting",
    "provider_retry_wait",
    "execution_retry_wait",
    "external_service_waiting",
  ]).has(String(activity))) return "waiting";
  if (executionLeaseHeld) return "running";
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
  return projectWorkspaceLifecycle(plan, mission, tickets).status;
}

export interface WorkspaceLifecycleProjection {
  status: EntityStatus;
  phase: MissionPhase;
}

/**
 * RuntimeTaskRecord is the scheduler's durable fact, not the UI projection.
 * A completed Plan with a still-linked Mission has no executable work yet;
 * keeping that record active would make recovery start it again forever.
 */
export function runtimeTaskStatusFor(
  planStatus: string,
  missionStatus: string,
): RuntimeTaskRecord["status"] {
  if (missionStatus === "completed") return "completed";
  if (planStatus === "failed") return "failed";
  if (planStatus === "cancelled") return "cancelled";
  if (planStatus === "paused") return "paused";
  if (planStatus === "completed") return "waiting";
  return "active";
}

/**
 * The UI projection has one precedence order for both status and phase.
 * It observes Mission/Plan/Ticket facts; it never decides who should work next.
 */
export function projectWorkspaceLifecycle(
  plan: string,
  mission: string,
  tickets: ReadonlyArray<Pick<Ticket, "status" | "blocker">> = [],
): WorkspaceLifecycleProjection {
  if (mission === "completed") return { status: "completed", phase: "completed" };
  if (plan === "failed") return { status: "failed", phase: "failed" };
  if (plan === "cancelled") return { status: "interrupted", phase: "interrupted" };
  if (plan === "paused") return { status: "paused", phase: "paused" };
  if (tickets.some((ticket) => ticket.status === "running")) return { status: "running", phase: "running" };
  if (tickets.some((ticket) => ticket.status === "blocked" || ticket.blocker)) return { status: "blocked", phase: "blocked" };
  if (tickets.some((ticket) => ticket.status === "pending")) return { status: "running", phase: "running" };
  if (plan === "blocked") return { status: "blocked", phase: "blocked" };
  if (plan === "completed") return { status: "waiting", phase: "idle" };
  return { status: "idle", phase: "idle" };
}

export function planAllowsActiveAgentExecution(planStatus: string): boolean {
  return planStatus === "active";
}

/**
 * A blocked Plan is normally a closed execution gate. A human reply is the
 * durable recovery signal for the blocked owner: the same Goal and Mission
 * link become active again, while the Ticket remains blocked until the Agent
 * submits its next conclusion. This keeps the recovery turn in Agent Engine
 * without inventing a business route or reopening a completed Ticket.
 */
export function canContinueRecoveredBlockedWork(input: {
  planStatus: string;
  ticketStatus?: string;
  linkStatus: string;
  authorityKind?: string;
  goalStatus: string;
}): boolean {
  return input.planStatus === "blocked"
    && input.ticketStatus === "blocked"
    && input.linkStatus === "running"
    && input.authorityKind === "blocked_owner"
    && input.goalStatus === "active";
}

/**
 * A blocked Plan is an aggregate outcome, not a revocation of a Ticket that
 * already holds a current execution claim. Mission Control may legitimately
 * dispatch an amendment or recovery Ticket while the aggregate remains
 * blocked. The Ticket authority and Mission link must match before the Agent
 * turn can continue, so a stale or unclaimed Ticket cannot bypass the Plan
 * gate.
 */
export function canContinueClaimedTicketWork(input: {
  planStatus: string;
  ticketStatus?: string;
  ticketAuthority?: {
    kind?: string;
    claimId?: string;
    fencingToken?: number;
  };
  linkStatus: string;
  linkAuthority: {
    kind?: string;
    claimId?: string;
    fencingToken?: number;
  };
  goalStatus: string;
}): boolean {
  return input.planStatus === "blocked"
    && input.ticketStatus === "running"
    && input.linkStatus === "running"
    && input.goalStatus === "active"
    && input.ticketAuthority?.kind === "claim"
    && input.linkAuthority.kind === "claim"
    && input.ticketAuthority.claimId === input.linkAuthority.claimId
    && input.ticketAuthority.fencingToken === input.linkAuthority.fencingToken;
}

function hasEligibleMember(team: TeamBinding, assignment: PlannedTicketAssignment): boolean {
  return team.members.some((member) => {
    if (assignment.principalId && member.principalId !== assignment.principalId) return false;
    return (assignment.requiredCapabilities ?? []).every((capability) => member.capabilities.includes(capability))
      && (assignment.requiredTools ?? []).every((tool) => configuredToolsInclude(member.enabledTools, tool));
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

function missionLinkKey(link: MissionLink): string {
  return [String(link.ticketId), link.agentId, link.agentGoalId ?? ""].join(":");
}

function withoutRetryState(
  states: RuntimeTaskRecord["retryStates"],
  agentId: string,
): RuntimeTaskRecord["retryStates"] {
  if (!states || !(agentId in states)) return states;
  const next = { ...states };
  delete next[agentId];
  return Object.keys(next).length ? next : undefined;
}
