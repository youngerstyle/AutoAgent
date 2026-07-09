import { access, readdir } from "node:fs/promises";
import path from "node:path";
import type { AgentDirectMessage, AgentInboxMessage, AgentRole, Assignment, AssignmentType, AutoAgentEvent, LoopDebugLog, MissionPhase, Task, TaskRun, Ticket, TicketBlocker, TicketType, Workspace, WorkspaceAgent, WorkspaceSnapshot } from "../../shared/types.js";
import { createId } from "../../shared/ids.js";
import { phaseLabel, roleLabel } from "../../shared/labels.js";
import { AgentRuntime, type AgentRuntimeLimits, type AssignmentResult, type ProviderRunner } from "../agents/agent-runtime.js";
import { AgentProfileStore } from "../agents/profile-store.js";
import { recruitSpecialist } from "../agents/recruitment.js";
import { ensureCoreTeam, listWorkspaceAgents, profileForRole, profileMetadata } from "../agents/roster.js";
import { HttpError } from "../errors.js";
import { EventLedger } from "../storage/event-ledger.js";
import { projectWorkspaceState } from "../storage/state-projector.js";
import { stateFile, workspaceAutoAgentDir } from "../storage/paths.js";
import { readJson, writeJson } from "../storage/json.js";
import type { WorkspaceStore } from "../storage/workspace-store.js";
import { RUNTIME_LIMITS } from "../runtime-limits.js";
import { isObservationTool } from "../tools/tool-catalog.js";
import { buildLoopDebugLog } from "./loop-debug-log.js";
import { TICKET_GRAPH_CONTRACT_NAME, planItemAliases, planItemDependencyKeys, planItemPrimaryKey, planItemTicketType, plannedTicketItems, ticketTypeFromValue, validatePlannedTicketGraph } from "./ticket-graph-contract.js";
import { createTicketRuntime, type TicketRuntime } from "./ticket-runtime.js";

export interface MissionState {
  task: Task;
  taskRun: TaskRun;
  nextPhase: MissionPhase;
  status: "running" | "waiting" | "paused" | "blocked" | "completed" | "failed" | "interrupted";
  pauseRequested: boolean;
  stopRequested: boolean;
  qaAttempts: number;
  context: Record<string, unknown>;
  tickets: Ticket[];
  inboxMessages: AgentInboxMessage[];
  updatedAt: string;
}

export interface StartTaskOptions {
  autoRun?: boolean;
  runSynchronously?: boolean;
}

export class MissionControl {
  private readonly runtime: AgentRuntime;
  private readonly running = new Set<string>();

  constructor(
    private readonly workspaceStore: WorkspaceStore,
    private readonly ledger: EventLedger,
    providerRunner: ProviderRunner,
    private readonly profileStore?: AgentProfileStore,
    runtimeLimits?: AgentRuntimeLimits
  ) {
    this.runtime = new AgentRuntime(ledger, providerRunner, undefined, undefined, undefined, runtimeLimits);
  }

  async startTask(input: { workspaceId: string; goal: string; title?: string }, options: StartTaskOptions = {}): Promise<WorkspaceSnapshot> {
    const workspace = await this.workspaceStore.get(input.workspaceId);
    const active = await this.findActiveState(workspace);
    if (active) throw new HttpError(409, "Workspace already has an active TaskRun", "ACTIVE_TASK_RUN");

    const task: Task = {
      id: createId("task"),
      workspaceId: workspace.id,
      title: input.title?.trim() || input.goal.trim().slice(0, 80) || "Untitled task",
      goal: input.goal,
      status: "running",
      createdBy: "user"
    };
    const taskRun: TaskRun = {
      id: createId("tr"),
      taskId: task.id,
      workspaceId: workspace.id,
      status: "running",
      phase: "boss_intake",
      startedAt: new Date().toISOString()
    };
    task.activeTaskRunId = taskRun.id;

    const state: MissionState = {
      task,
      taskRun,
      nextPhase: "boss_intake",
      status: "running",
      pauseRequested: false,
      stopRequested: false,
      qaAttempts: 0,
      context: { goal: input.goal },
      tickets: [],
      inboxMessages: [],
      updatedAt: new Date().toISOString()
    };
    this.seedInitialTickets(workspace, state);
    await this.writeState(workspace, state);
    await this.append(workspace, state, "task.created", "Task run created", { task, taskRun });

    const profiles = await this.agentProfiles();
    for (const agent of await ensureCoreTeam(workspace, profiles)) {
      await this.append(workspace, state, "agent.joined_workspace", `${profileMetadata(agent, profiles).name} joined workspace`, {
        agent: { ...agent, ...profileMetadata(agent, profiles) }
      });
    }

    if (options.autoRun ?? true) {
      if (options.runSynchronously) {
        await this.runUntilIdle(workspace, state.task.id, state.taskRun.id);
      } else {
        this.runInBackground(workspace, state.task.id, state.taskRun.id);
      }
    }
    return this.snapshot(workspace, state.task.id, state.taskRun.id);
  }

  async pauseTask(workspaceId: string, taskId: string): Promise<MissionState> {
    const workspace = await this.workspaceStore.get(workspaceId);
    const state = await this.readStateForTask(workspace, taskId);
    if (state.status !== "running") return state;
    state.pauseRequested = true;
    state.status = "paused";
    state.task.status = "paused";
    state.taskRun.status = "paused";
    state.taskRun.phase = "paused";
    await this.writeState(workspace, state);
    await this.append(workspace, state, "task.phase_changed", "任务已暂停", { phase: "paused", status: "paused", nextPhase: state.nextPhase });
    return state;
  }

  async resumeTask(workspaceId: string, taskId: string, runSynchronously = false): Promise<WorkspaceSnapshot> {
    const workspace = await this.workspaceStore.get(workspaceId);
    const state = await this.readStateForTask(workspace, taskId);
    if (state.status !== "paused" && state.status !== "blocked" && state.status !== "waiting") return this.snapshot(workspace, state.task.id, state.taskRun.id);
    if (state.status === "blocked") {
      if (state.taskRun.phase === "qa" && isManualTestingBoundary(state)) return this.snapshot(workspace, state.task.id, state.taskRun.id);
      this.applyHumanActionToTickets(state, "继续");
    }
    const resumeTicket = this.nextRunnableTicket(state);
    const resumePhase = resumeTicket ? phaseForTicket(resumeTicket) : state.nextPhase;
    state.pauseRequested = false;
    state.status = "running";
    state.task.status = "running";
    state.taskRun.status = "running";
    state.nextPhase = resumePhase;
    state.taskRun.phase = resumePhase;
    state.taskRun.endedAt = undefined;
    await this.writeState(workspace, state);
    await this.append(workspace, state, "task.phase_changed", `任务继续：${phaseLabel(resumePhase)}`, { phase: resumePhase, status: "running" });
    if (runSynchronously) {
      await this.runUntilIdle(workspace, state.task.id, state.taskRun.id);
    } else {
      this.runInBackground(workspace, state.task.id, state.taskRun.id);
    }
    return this.snapshot(workspace, state.task.id, state.taskRun.id);
  }

  async followUpTask(workspaceId: string, taskId: string, message: string, runSynchronously = false): Promise<WorkspaceSnapshot> {
    const workspace = await this.workspaceStore.get(workspaceId);
    const state = await this.readStateForTask(workspace, taskId);
    const followup = message.trim();
    if (!followup) throw new HttpError(400, "Follow-up message is required", "FOLLOWUP_REQUIRED");
    if (state.status === "completed" || state.status === "failed" || state.status === "interrupted") {
      throw new HttpError(409, "Task is already terminal", "TASK_TERMINAL");
    }

    const blockedTicket = state.status === "blocked" ? this.blockedTicket(state) : undefined;
    const currentPhase = blockedTicket ? phaseForTicket(blockedTicket) : state.taskRun.phase;
    const blockedFollowupAction = state.status === "blocked"
      ? await this.runTicketResumeReview(workspace, state, followup)
      : "continue";
    const followups = Array.isArray(state.context.humanFollowups) ? state.context.humanFollowups as Array<Record<string, unknown>> : [];
    const entry = {
      message: followup,
      blockedTicketId: blockedTicket?.id,
      blockedPhase: blockedTicket ? currentPhase : undefined,
      fromPhase: currentPhase,
      at: new Date().toISOString()
    };
    state.context.humanFollowups = [...followups, entry];
    state.context.latestHumanFollowup = entry;
    if (state.status === "blocked" && blockedFollowupAction !== "hold") {
      this.applyHumanActionToTickets(state, followup);
    }
    if ((state.status === "blocked" && blockedFollowupAction !== "hold") || state.status === "paused") {
      const resumeTicket = this.nextRunnableTicket(state);
      const resumePhase = resumeTicket ? phaseForTicket(resumeTicket) : currentPhase;
      state.nextPhase = resumePhase;
      state.pauseRequested = false;
      state.stopRequested = false;
      state.status = "running";
      state.task.status = "running";
      state.taskRun.status = "running";
      state.taskRun.phase = resumePhase;
      state.taskRun.endedAt = undefined;
    }
    await this.writeState(workspace, state);
    await this.append(workspace, state, "human.followup", "human 已补充说明", {
      message: followup,
      fromPhase: currentPhase,
      resumeTicketId: blockedTicket?.id,
      action: blockedFollowupAction
    });
    if (blockedFollowupAction !== "hold") {
      await this.append(workspace, state, "task.phase_changed", "收到补充，恢复可运行工单", {
        phase: state.taskRun.phase,
        status: "running",
        fromPhase: currentPhase
      });
    }

    if (runSynchronously && blockedFollowupAction !== "hold") {
      await this.runUntilIdle(workspace, state.task.id, state.taskRun.id);
    } else if (blockedFollowupAction !== "hold") {
      this.runInBackground(workspace, state.task.id, state.taskRun.id);
    }
    return this.snapshot(workspace, state.task.id, state.taskRun.id);
  }

  async sendAgentMessage(workspaceId: string, taskId: string, agentId: string, message: string, runSynchronously = false): Promise<WorkspaceSnapshot> {
    const workspace = await this.workspaceStore.get(workspaceId);
    const state = await this.readStateForTask(workspace, taskId);
    const directMessage = message.trim();
    if (!directMessage) throw new HttpError(400, "Agent message is required", "AGENT_MESSAGE_REQUIRED");
    if (state.status === "completed" || state.status === "failed" || state.status === "interrupted") {
      throw new HttpError(409, "Task is already terminal", "TASK_TERMINAL");
    }

    const agents = await listWorkspaceAgents(workspace);
    const targetAgent = agents.find((agent) => agent.id === agentId);
    if (!targetAgent) throw new HttpError(404, "Agent not found in workspace", "AGENT_NOT_FOUND");

    const blockedTicket = state.status === "blocked" ? this.blockedTicketForAgent(state, targetAgent) : undefined;
    this.appendAgentDirectMessage(state, targetAgent.id, directMessage);
    await this.writeState(workspace, state);
    await this.append(workspace, state, "human.agent_message", `human 发给${roleLabel(targetAgent.roleInWorkspace)}：${directMessage.slice(0, 80)}`, {
      agentId: targetAgent.id,
      role: targetAgent.roleInWorkspace,
      message: directMessage,
      blockedTicketId: blockedTicket?.id
    });

    if (blockedTicket) {
      return this.followUpTask(workspaceId, taskId, directMessage, runSynchronously);
    }

    if (state.status === "waiting") {
      const nextTicket = this.nextRunnableTicket(state);
      if (nextTicket) {
        state.status = "running";
        state.task.status = "running";
        state.taskRun.status = "running";
        state.nextPhase = phaseForTicket(nextTicket);
        state.taskRun.phase = state.nextPhase;
        state.updatedAt = new Date().toISOString();
        await this.writeState(workspace, state);
        if (runSynchronously) {
          await this.runUntilIdle(workspace, state.task.id, state.taskRun.id);
        } else {
          this.runInBackground(workspace, state.task.id, state.taskRun.id);
        }
      }
    }

    return this.snapshot(workspace, state.task.id, state.taskRun.id);
  }

  async stopTask(workspaceId: string, taskId: string): Promise<MissionState> {
    const workspace = await this.workspaceStore.get(workspaceId);
    const state = await this.readStateForTask(workspace, taskId);
    if (state.status === "completed" || state.status === "failed" || state.status === "interrupted") return state;
    state.stopRequested = true;
    state.status = "interrupted";
    state.task.status = "interrupted";
    state.taskRun.status = "interrupted";
    state.taskRun.phase = "interrupted";
    state.taskRun.endedAt = new Date().toISOString();
    const tickets = this.ticketRuntime(state);
    tickets.cancelOpenTickets("任务已停止");
    this.syncTickets(state, tickets);
    await this.writeState(workspace, state);
    await this.append(workspace, state, "run.interrupted", "Task interrupted", { task: state.task, taskRun: state.taskRun });
    return state;
  }

  async snapshotByWorkspace(workspaceId: string): Promise<WorkspaceSnapshot> {
    const workspace = await this.workspaceStore.get(workspaceId);
    const state = (await this.findActiveState(workspace)) ?? (await this.findLatestState(workspace));
    if (!state) {
      const profiles = await this.agentProfiles();
      const agents = await listWorkspaceAgents(workspace);
      return {
        workspace,
        agents: agents.map((agent) => ({ ...agent, ...profileMetadata(agent, profiles) })),
        assignments: [],
        recentEvents: [],
        phase: "idle",
        status: "idle"
      };
    }
    return this.snapshot(workspace, state.task.id, state.taskRun.id);
  }

  async loopDebugLogByWorkspace(workspaceId: string): Promise<LoopDebugLog> {
    const workspace = await this.workspaceStore.get(workspaceId);
    const state = (await this.findActiveState(workspace)) ?? (await this.findLatestState(workspace));
    if (!state) return { entries: [] };
    const events = await this.ledger.read(workspace.rootPath, state.task.id, state.taskRun.id);
    return buildLoopDebugLog({
      workspace,
      task: state.task,
      taskRun: state.taskRun,
      events
    });
  }

  async runUntilIdle(workspace: Workspace, taskId: string, taskRunId: string): Promise<void> {
    const runKey = `${workspace.id}:${taskRunId}`;
    if (this.running.has(runKey)) return;
    this.running.add(runKey);
    try {
      let state = await this.readState(workspace, taskId, taskRunId);
      while (state.status === "running") {
        if (state.stopRequested) break;
        if (state.pauseRequested) {
          await this.pauseTask(workspace.id, taskId);
          break;
        }
        const nextTicket = this.nextRunnableTicket(state);
        if (!nextTicket) break;
        state = await this.runTicket(workspace, state, nextTicket.id);
      }
      state = await this.readState(workspace, taskId, taskRunId);
      if (state.status === "running" && this.isTicketGraphComplete(state)) {
        state.status = "completed";
        state.task.status = "completed";
        state.taskRun.status = "completed";
        state.nextPhase = "completed";
        state.taskRun.phase = "completed";
        state.taskRun.endedAt = new Date().toISOString();
        await this.writeState(workspace, state);
        await this.append(workspace, state, "run.completed", "任务已完成", { task: state.task, taskRun: state.taskRun });
      }
    } catch (error) {
      const state = await this.readState(workspace, taskId, taskRunId);
      state.status = "failed";
      state.task.status = "failed";
      state.taskRun.status = "failed";
      state.taskRun.phase = "failed";
      state.taskRun.endedAt = new Date().toISOString();
      await this.writeState(workspace, state);
      await this.append(workspace, state, "run.failed", "任务失败", { error: (error as Error).message, task: state.task, taskRun: state.taskRun });
      throw error;
    } finally {
      this.running.delete(runKey);
    }
  }

  private async runTicket(workspace: Workspace, state: MissionState, ticketId: string): Promise<MissionState> {
    const ticketRuntime = this.ticketRuntime(state);
    const ticket = ticketRuntime.ticket(ticketId);
    if (!ticket || ticket.status !== "pending") return state;
    const phase = phaseForTicket(ticket);
    state.nextPhase = phase;
    state.taskRun.phase = phase;
    await this.append(workspace, state, "task.phase_changed", `进入阶段：${phaseLabel(phase)}`, { phase, status: "running" });
    const agent = await this.agentForTicket(workspace, ticket);
    const profiles = await this.agentProfiles();
    const profile = profileForRole(agent.roleInWorkspace, profiles);
    const claimed = ticketRuntime.claimNext(agent);
    this.syncTickets(state, ticketRuntime);
    if (!claimed) {
      state.status = "waiting";
      state.task.status = "waiting";
      state.taskRun.status = "waiting";
      await this.writeState(workspace, state);
      await this.append(workspace, state, "handoff.created", `${profile.name}正在忙，${phaseLabel(phase)}工单已进入队列`, {
        ticketId: ticket.id,
        targetAgentId: agent.id,
        targetRole: agent.roleInWorkspace
      });
      return state;
    }
    await this.writeState(workspace, state);
    const result = await this.runtime.runAssignment({
      workspace,
      agent,
      profile,
      taskId: state.task.id,
      taskRunId: state.taskRun.id,
      goal: state.task.goal,
      type: assignmentTypeForTicket(ticket),
      brief: ticket.brief,
      expectedArtifact: ticket.expectedArtifact,
      currentTicket: ticket,
      context: contextForAgent(state.context, agent.id),
      sessionId: state.taskRun.id
    });
    const latestState = await this.readState(workspace, state.task.id, state.taskRun.id);
    if (latestState.stopRequested || latestState.status === "interrupted") return latestState;
    if (result.kind === "yielded") {
      ticketRuntime.yieldTicket(ticket.id, {
        reason: result.reason,
        assignmentRunId: result.assignmentRun.id
      });
      this.syncTickets(state, ticketRuntime);
      state.status = "running";
      state.task.status = "running";
      state.taskRun.status = "running";
      state.nextPhase = phase;
      state.taskRun.phase = phase;
      state.updatedAt = new Date().toISOString();
      await this.writeState(workspace, state);
      await this.append(workspace, state, "task.phase_changed", `${phaseLabel(phase)}已保存进度，等待继续`, {
        phase,
        status: "running",
        ticketId: ticket.id,
        yielded: true,
        reason: result.reason,
        assignmentRunId: result.assignmentRun.id
      });
      return state;
    }

    const phaseResult = result.providerResult.structured ?? result.providerResult.text;
    state.context[phase] = { result: phaseResult, toolResults: result.toolResults };
    state.updatedAt = new Date().toISOString();

    const manualTestingReason = phase === "qa" ? manualTestingReasonForPhase(result.providerResult.structured, result.providerResult.text) : undefined;
    const roleToolBoundaryReason = roleToolBoundaryReasonForPhase(phase, agent, result.toolResults);
    const explicitAuthorizationReason = humanAuthorizationReasonForPhase(result.providerResult.structured);
    const blockingToolFailureReason = toolFailureReason(result.toolResults);
    const humanAuthorizationReason = explicitAuthorizationReason ?? blockingToolFailureReason;
    const planningClarificationReason = phase === "pm_plan" ? planningClarificationReasonForPhase(result.providerResult.structured) : undefined;
    const agentObstacle = agentObstacleReasonForPhase(phase, result.providerResult.structured);
    const missingImplementation = phase === "implementation" && !await hasImplementationEvidence(workspace, result.toolResults, result.providerResult.structured)
      ? "开发阶段没有产生真实文件写入或命令执行证据"
      : undefined;
    const qaDefectReason = phase === "qa" ? qaDefectReasonForPhase(result.providerResult.structured) : undefined;
    const manualOnlyReason = manualTestingReason && !qaDefectReason ? `需要人工测试：${manualTestingReason}` : undefined;
    if (roleToolBoundaryReason) {
      ticketRuntime.ack(ticket.id, phaseResult);
      this.syncTickets(state, ticketRuntime);
      return this.createFollowupTicketAndContinue(workspace, state, "implementation", roleToolBoundaryReason, "implementationRoleBoundaryRetries", ticket);
    }

    const invalidPmPlanReason = phase === "pm_plan"
      && !humanAuthorizationReason
      && !manualOnlyReason
      && !planningClarificationReason
      && !agentObstacle
      ? this.pmPlanValidationReason(ticket, phaseResult)
      : undefined;

    if (invalidPmPlanReason) {
      return this.yieldPmTicketForGraphRepair(workspace, state, ticketRuntime, ticket, result, phaseResult, invalidPmPlanReason);
    }

    if (phase === "pm_plan") {
      delete state.context.ticketGraphContractReview;
    }

    if (humanAuthorizationReason || manualOnlyReason || planningClarificationReason || invalidPmPlanReason) {
      const reason = humanAuthorizationReason ?? manualOnlyReason ?? planningClarificationReason ?? invalidPmPlanReason ?? "需要 human 处理";
      return this.blockCurrentTicket(workspace, state, ticketRuntime, ticket, result, phaseResult, reason, {
        manualTestingReason: manualOnlyReason ? manualTestingReason : undefined,
        explicitAuthorization: Boolean(explicitAuthorizationReason),
        toolPolicyBlocked: Boolean(blockingToolFailureReason)
      });
    }

    if (qaDefectReason) {
      ticketRuntime.ack(ticket.id, phaseResult);
      this.syncTickets(state, ticketRuntime);
      return this.createFollowupTicketAndContinue(workspace, state, "rework", qaDefectReason, "qaDefectRetries", ticket);
    }

    if (phase === "implementation" && (agentObstacle || missingImplementation)) {
      ticketRuntime.ack(ticket.id, phaseResult);
      this.syncTickets(state, ticketRuntime);
      const targetType = agentObstacle ? targetTicketTypeFromStructured(result.providerResult.structured) : "rework";
      if (!targetType) {
        return this.blockCurrentTicket(workspace, state, ticketRuntime, ticket, result, phaseResult, agentObstacle ?? "开发受阻但未明确后续工单");
      }
      const retryKey = missingImplementation ? "implementationAutonomyRetries" : `${targetType}AutonomyRetries`;
      return this.createFollowupTicketAndContinue(workspace, state, targetType, agentObstacle ?? missingImplementation ?? "开发未产出交付证据", retryKey, ticket);
    }

    if (phase === "qa") {
      state.qaAttempts += 1;
      const passed = result.providerResult.structured?.passed !== false && !agentObstacle;
      if (!passed) {
        await this.append(workspace, state, "qa.failed", "测试要求开发返工", {
          feedback: agentObstacle ?? result.providerResult.structured?.report ?? result.providerResult.text,
          attempt: state.qaAttempts
        });
        ticketRuntime.ack(ticket.id, phaseResult);
        this.syncTickets(state, ticketRuntime);
        this.createFollowupTicket(state, "rework", ticket, agentObstacle ?? "测试要求开发返工");
        await this.writeState(workspace, state);
        return state;
      }
    }

    if (phase === "boss_acceptance" && agentObstacle) {
      ticketRuntime.ack(ticket.id, phaseResult);
      this.syncTickets(state, ticketRuntime);
      const targetType = targetTicketTypeFromStructured(result.providerResult.structured) ?? "rework";
      return this.createFollowupTicketAndContinue(workspace, state, targetType, agentObstacle, "bossAcceptanceReworkRetries", ticket);
    }

    if (agentObstacle) {
      const targetType = targetTicketTypeFromStructured(result.providerResult.structured);
      if (targetType) {
        ticketRuntime.ack(ticket.id, phaseResult);
        this.syncTickets(state, ticketRuntime);
        return this.createFollowupTicketAndContinue(workspace, state, targetType, agentObstacle, `${targetType}AutonomyRetries`, ticket);
      }
      return this.blockCurrentTicket(workspace, state, ticketRuntime, ticket, result, phaseResult, agentObstacle);
    }

    if (phase === "architect_plan" && result.providerResult.structured?.needsSpecialist) {
      const gap = String(result.providerResult.structured.capabilityGap ?? "通用专项能力");
      const defaultProfile = profiles?.[0];
      const specialist = await recruitSpecialist({
        workspace,
        taskId: state.task.id,
        taskRunId: state.taskRun.id,
        capabilityGap: gap,
        ledger: this.ledger,
        defaultProvider: defaultProfile?.defaultProvider,
        defaultModel: defaultProfile?.defaultModel
      });
      await this.runtime.runAssignment({
        workspace,
        agent: specialist,
        taskId: state.task.id,
        taskRunId: state.taskRun.id,
        goal: state.task.goal,
        type: "specialist",
        brief: `处理能力缺口：${gap}`,
        expectedArtifact: "专家建议",
        context: state.context,
        sessionId: state.taskRun.id
      });
      state.context.specialist = { capabilityGap: gap, agentId: specialist.id };
    }

    ticketRuntime.ack(ticket.id, phaseResult);
    this.syncTickets(state, ticketRuntime);
    this.createNextTicketsForCompletedTicket(state, ticket);
    await this.writeState(workspace, state);
    return state;
  }

  private seedInitialTickets(workspace: Workspace, state: MissionState): void {
    const runtime = this.ticketRuntime(state);
    const bossTicket = runtime.createTicket({
      workspaceId: workspace.id,
      taskId: state.task.id,
      taskRunId: state.taskRun.id,
      type: "boss_intake",
      brief: briefForPhase("boss_intake", state),
      expectedArtifact: expectedArtifactForPhase("boss_intake"),
      targetRole: "boss"
    });
    runtime.createTicket({
      workspaceId: workspace.id,
      taskId: state.task.id,
      taskRunId: state.taskRun.id,
      type: "pm_plan",
      brief: briefForPhase("pm_plan", state),
      expectedArtifact: expectedArtifactForPhase("pm_plan"),
      targetRole: "pm",
      parentTicketId: bossTicket.id,
      createdByTicketId: bossTicket.id,
      dependsOnTicketIds: [bossTicket.id]
    });
    this.syncTickets(state, runtime);
  }

  private nextRunnableTicket(state: MissionState): Ticket | undefined {
    return (state.tickets ?? [])
      .filter((ticket) => ticket.status === "pending")
      .filter((ticket) => this.ticketDependenciesSatisfied(state, ticket))
      .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt))[0];
  }

  private ticketDependenciesSatisfied(state: MissionState, ticket: Ticket): boolean {
    const dependencies = ticket.dependsOnTicketIds ?? [];
    return dependencies.every((id) => {
      const dependency = state.tickets.find((item) => item.id === id);
      return dependency?.status === "completed";
    });
  }

  private isTicketGraphComplete(state: MissionState): boolean {
    const tickets = state.tickets ?? [];
    return tickets.length > 0 && tickets.every((ticket) => ticket.status === "completed" || ticket.status === "returned" || ticket.status === "cancelled");
  }

  private createNextTicketsForCompletedTicket(state: MissionState, sourceTicket: Ticket): void {
    const planned = sourceTicket.type === "pm_plan"
      ? this.createTicketsFromPmPlan(state, sourceTicket)
      : false;
    if (planned || this.hasPlannedSuccessor(state, sourceTicket)) return;
    const transition = transitionAfterCompletedTicket(sourceTicket);
    if (transition) this.createFollowupTicket(state, transition.type, sourceTicket, transition.reason);
  }

  private createTicketsFromPmPlan(state: MissionState, sourceTicket: Ticket): boolean {
    const planItems = plannedTicketItems(sourceTicket.result);
    if (planItems.length === 0) return false;

    const runtime = this.ticketRuntime(state);
    runtime.cancelOpenDescendants(sourceTicket.id, "PM 已重新拆解工单图");
    const ticketsByKey = new Map<string, Ticket>([[sourceTicket.id, sourceTicket]]);
    ticketsByKey.set("pm", sourceTicket);
    ticketsByKey.set("pm_plan", sourceTicket);

    let previousTicket: Ticket | undefined;
    for (const [index, item] of planItems.entries()) {
      const type = planItemTicketType(item);
      if (!type) throw new Error(`Invalid planned ticket type: ${String(item.type ?? item.ticket_type ?? "")}`);
      const role = canonicalRoleForTicketType(type);
      const fallbackDependencies = index === 0 ? [sourceTicket.id] : previousTicket ? [previousTicket.id] : [sourceTicket.id];
      const dependencyIds = dependencyIdsForPlanItem(item, ticketsByKey, fallbackDependencies);
      const parentTicketId = dependencyIds[0] ?? sourceTicket.id;
      const ticket = runtime.createTicket({
        workspaceId: state.task.workspaceId,
        taskId: state.task.id,
        taskRunId: state.taskRun.id,
        type,
        brief: stringValue(item.brief) ?? stringValue(item.title) ?? briefForPhase(phaseForTicketType(type), state),
        expectedArtifact: stringValue(item.expectedArtifact) ?? stringValue(item.artifact) ?? expectedArtifactForPhase(phaseForTicketType(type)),
        targetRole: role,
        priority: numberValue(item.priority) ?? 0,
        parentTicketId,
        createdByTicketId: parentTicketId,
        plannedByTicketId: sourceTicket.id,
        dependsOnTicketIds: dependencyIds
      });
      const key = planItemPrimaryKey(item, type, index);
      ticketsByKey.set(key, ticket);
      for (const alias of planItemAliases(item, type, index)) ticketsByKey.set(alias, ticket);
      ticketsByKey.set(ticket.id, ticket);
      previousTicket = ticket;
    }

    this.syncTickets(state, runtime);
    const next = this.nextRunnableTicket(state);
    if (next) {
      state.nextPhase = phaseForTicket(next);
      state.taskRun.phase = state.nextPhase;
    }
    return true;
  }

  private hasPlannedSuccessor(state: MissionState, sourceTicket: Ticket): boolean {
    return state.tickets.some((ticket) => {
      if (ticket.id === sourceTicket.id) return false;
      return ticket.dependsOnTicketIds?.includes(sourceTicket.id) || ticket.parentTicketId === sourceTicket.id;
    });
  }

  private createFollowupTicket(state: MissionState, type: TicketType, sourceTicket: Ticket, returnReason?: string): Ticket | undefined {
    const runtime = this.ticketRuntime(state);
    if (type === "rework") {
      runtime.cancelOpenDescendants(sourceTicket.id, "上游工单需要返工，暂停原下游");
    }
    const phase = phaseForTicketType(type);
    const role = canonicalRoleForTicketType(type);
    const ticket = runtime.createTicket({
      workspaceId: state.task.workspaceId,
      taskId: state.task.id,
      taskRunId: state.taskRun.id,
      type,
      brief: returnReason ? `${briefForPhase(phase, state)}：${returnReason}` : briefForPhase(phase, state),
      expectedArtifact: expectedArtifactForPhase(phase),
      targetRole: role,
      parentTicketId: sourceTicket.id,
      createdByTicketId: sourceTicket.id,
      dependsOnTicketIds: [sourceTicket.id],
      returnReason
    });
    this.syncTickets(state, runtime);
    state.nextPhase = phase;
    state.taskRun.phase = phase;
    return ticket;
  }

  private requiresTicketGraph(ticket: Ticket): boolean {
    return ticket.type === "pm_plan" && !ticket.plannedByTicketId;
  }

  private pmPlanValidationReason(ticket: Ticket, result: unknown): string | undefined {
    const planItems = plannedTicketItems(result);
    if (this.requiresTicketGraph(ticket) && planItems.length === 0) {
      return "PM 没有返回 ticketGraph，无法形成可执行工单 DAG";
    }
    if (planItems.length === 0) return undefined;
    return validatePlannedTicketGraph(planItems)?.reason;
  }

  private async agentForPhase(workspace: Workspace, phase: MissionPhase): Promise<WorkspaceAgent> {
    const role = roleForPhase(phase);
    const profiles = await this.agentProfiles();
    const agents = await ensureCoreTeam(workspace, profiles);
    const agent = agents.find((item) => item.roleInWorkspace === role);
    if (!agent) throw new HttpError(500, `Missing ${role} agent`, "MISSING_AGENT");
    return agent;
  }

  private async agentForTicket(workspace: Workspace, ticket: Ticket): Promise<WorkspaceAgent> {
    const profiles = await this.agentProfiles();
    const agents = await ensureCoreTeam(workspace, profiles);
    const agent = ticket.targetAgentId
      ? agents.find((item) => item.id === ticket.targetAgentId)
      : agents.find((item) => item.roleInWorkspace === (ticket.targetRole ?? roleForPhase(phaseForTicket(ticket))));
    if (!agent) throw new HttpError(500, `Missing ${ticket.targetRole ?? phaseForTicket(ticket)} agent`, "MISSING_AGENT");
    return agent;
  }

  private async createFollowupTicketAndContinue(workspace: Workspace, state: MissionState, targetType: TicketType, reason: string, retryKey: string, sourceTicket: Ticket): Promise<MissionState> {
    const retries = Number(state.context[retryKey] ?? 0) + 1;
    state.context[retryKey] = retries;
    const ticket = this.createFollowupTicket(state, targetType, sourceTicket, reason);
    await this.writeState(workspace, state);
    await this.append(workspace, state, "ticket.created", `已创建后续工单：${phaseLabel(phaseForTicketType(targetType))}`, {
      ticketId: ticket?.id,
      ticketType: targetType,
      reason,
      attempt: retries
    });
    return state;
  }

  private async blockCurrentTicket(
    workspace: Workspace,
    state: MissionState,
    ticketRuntime: TicketRuntime,
    ticket: Ticket,
    result: AssignmentResult,
    phaseResult: unknown,
    reason: string,
    blockerInput: { manualTestingReason?: string; explicitAuthorization?: boolean; toolPolicyBlocked?: boolean } = {}
  ): Promise<MissionState> {
    const phase = phaseForTicket(ticket);
    ticketRuntime.blockTicket(ticket.id, ticketBlockerFor({ reason, ...blockerInput }));
    this.syncTickets(state, ticketRuntime);
    result.assignment.status = "blocked";
    state.status = "blocked";
    state.task.status = "blocked";
    state.taskRun.status = "blocked";
    state.taskRun.phase = phase;
    state.nextPhase = phase;
    state.taskRun.endedAt = new Date().toISOString();
    await this.writeState(workspace, state);
    await this.append(workspace, state, "assignment.blocked", `${phaseLabel(phase)}受阻：${reason}`, {
      assignmentId: result.assignment.id,
      assignmentRun: result.assignmentRun,
      reason,
      result: phaseResult,
      rawText: result.providerResult.text,
      toolResults: result.toolResults,
      ticketId: ticket.id
    });
    await this.append(workspace, state, "run.blocked", `任务受阻：${phaseLabel(phase)}受阻：${reason}`, { task: state.task, taskRun: state.taskRun, reason, phase, ticketId: ticket.id });
    return state;
  }

  private async yieldPmTicketForGraphRepair(
    workspace: Workspace,
    state: MissionState,
    ticketRuntime: TicketRuntime,
    ticket: Ticket,
    result: AssignmentResult,
    phaseResult: unknown,
    reason: string
  ): Promise<MissionState> {
    const repairAttempt = (ticket.execution?.continuationCount ?? 0) + 1;
    if (repairAttempt > RUNTIME_LIMITS.maxTicketSelfRepairAttempts) {
      return this.blockCurrentTicket(workspace, state, ticketRuntime, ticket, result, phaseResult, `${reason}；PM 自修已达到 ${RUNTIME_LIMITS.maxTicketSelfRepairAttempts} 次，需 human 介入。`);
    }

    state.context.ticketGraphContractReview = {
      contract: TICKET_GRAPH_CONTRACT_NAME,
      ticketId: ticket.id,
      reason,
      attempt: repairAttempt,
      maxAttempts: RUNTIME_LIMITS.maxTicketSelfRepairAttempts,
      previousResult: phaseResult,
      instruction: "你刚刚返回的 ticketGraph 没有通过工单合约校验。请不要请求 human 接锅；请基于校验原因重新输出完整、待执行、可交接、可验收的 ticketGraph。"
    };
    ticketRuntime.yieldTicket(ticket.id, {
      reason: `PM ticketGraph 未通过合约校验：${reason}`,
      assignmentRunId: result.assignmentRun.id
    });
    this.syncTickets(state, ticketRuntime);
    state.status = "running";
    state.task.status = "running";
    state.taskRun.status = "running";
    state.nextPhase = "pm_plan";
    state.taskRun.phase = "pm_plan";
    state.updatedAt = new Date().toISOString();
    await this.writeState(workspace, state);
    await this.append(workspace, state, "assignment.yielded", "产品/项目工单图未通过合约校验，已返回 PM 自修", {
      assignmentId: result.assignment.id,
      assignmentRun: result.assignmentRun,
      reason,
      ticketId: ticket.id,
      contract: TICKET_GRAPH_CONTRACT_NAME,
      attempt: repairAttempt,
      maxAttempts: RUNTIME_LIMITS.maxTicketSelfRepairAttempts
    });
    await this.append(workspace, state, "task.phase_changed", "计划拆解已保存反馈，等待 PM 自修", {
      phase: "pm_plan",
      status: "running",
      ticketId: ticket.id,
      yielded: true,
      reason
    });
    return state;
  }

  private runInBackground(workspace: Workspace, taskId: string, taskRunId: string): void {
    setImmediate(() => {
      void this.runUntilIdle(workspace, taskId, taskRunId).catch(() => undefined);
    });
  }

  private ticketRuntime(state: MissionState): TicketRuntime {
    return createTicketRuntime(state.tickets ?? [], state.inboxMessages ?? []);
  }

  private syncTickets(state: MissionState, runtime: TicketRuntime): void {
    state.tickets = runtime.allTickets();
    state.inboxMessages = runtime.allMessages();
  }

  private applyHumanActionToTickets(state: MissionState, message: string): void {
    const runtime = this.ticketRuntime(state);
    const blockedQa = runtime.allTickets().find((ticket) => ticket.type === "qa" && ticket.status === "blocked" && ticket.blocker?.type === "manual_test_required");
    if (blockedQa) {
      const action = blockedFollowupActionFromReview(state.context.ticketResumeReview);
      if (action === "hold") {
        this.syncTickets(state, runtime);
        return;
      }
      runtime.completeHumanAction(blockedQa.id, {
        action: action === "fail_manual_test" ? "manual_test_failed" : "manual_test_passed",
        message
      });
      this.syncTickets(state, runtime);
      return;
    }
    const blocked = runtime.allTickets().find((ticket) => ticket.status === "blocked");
    if (blocked) runtime.reopenBlockedTicket(blocked.id);
    this.syncTickets(state, runtime);
  }

  private async runTicketResumeReview(workspace: Workspace, state: MissionState, message: string): Promise<BlockedFollowupAction> {
    const ticket = state.tickets.find((item) => item.status === "blocked" && phaseForTicket(item) === state.taskRun.phase)
      ?? state.tickets.find((item) => item.status === "blocked");
    if (!ticket) return "hold";
    const ownerAgent = await this.agentForTicket(workspace, ticket);
    const profiles = await this.agentProfiles();
    const reviewContext = ticketResumeReviewContext(state, ticket, message, ownerAgent.id);
    const review = await this.runtime.runAssignment({
      workspace,
      agent: ownerAgent,
      profile: profileForRole(ownerAgent.roleInWorkspace, profiles),
      taskId: state.task.id,
      taskRunId: state.taskRun.id,
      goal: state.task.goal,
      type: assignmentTypeForTicket(ticket),
      brief: ticketResumeReviewBrief(ticket, message),
      expectedArtifact: "ticket_resume_review 结构化判断",
      currentTicket: ticket,
      context: reviewContext,
      sessionId: state.taskRun.id
    });
    if (review.kind === "yielded") {
      state.context.ticketResumeReview = {
        result: { action: "hold", reason: review.reason },
        rawText: review.reason,
        toolResults: review.toolResults
      };
      return "hold";
    }
    state.context.ticketResumeReview = {
      result: review.providerResult.structured ?? review.providerResult.text,
      rawText: review.providerResult.text,
      toolResults: review.toolResults
    };
    return blockedFollowupActionFromReview(state.context.ticketResumeReview);
  }

  private async agentProfiles() {
    return this.profileStore ? this.profileStore.list() : undefined;
  }

  private async findActiveState(workspace: Workspace): Promise<MissionState | undefined> {
    return (await this.readAllStates(workspace)).find((state) => state.status === "running" || state.status === "waiting" || state.status === "paused" || state.status === "blocked");
  }

  private async findLatestState(workspace: Workspace): Promise<MissionState | undefined> {
    return (await this.readAllStates(workspace)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  }

  private async readAllStates(workspace: Workspace): Promise<MissionState[]> {
    const tasksRoot = path.join(workspaceAutoAgentDir(workspace.rootPath), "tasks");
    try {
      const states: MissionState[] = [];
      const taskEntries = await readdir(tasksRoot, { withFileTypes: true });
      for (const taskEntry of taskEntries.filter((entry) => entry.isDirectory())) {
        const runsRoot = path.join(tasksRoot, taskEntry.name, "runs");
        const runEntries = await readdir(runsRoot, { withFileTypes: true });
        for (const runEntry of runEntries.filter((entry) => entry.isDirectory())) {
          const state = await readJson<MissionState | undefined>(stateFile(workspace.rootPath, taskEntry.name, runEntry.name), undefined);
          if (state) states.push(state);
        }
      }
      return states;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async readStateForTask(workspace: Workspace, taskId: string): Promise<MissionState> {
    const active = await this.findActiveState(workspace);
    if (active?.task.id === taskId) {
      return active;
    }
    throw new HttpError(404, `Active task not found: ${taskId}`, "TASK_NOT_FOUND");
  }

  private async readState(workspace: Workspace, taskId: string, taskRunId: string): Promise<MissionState> {
    const state = await readJson<MissionState | undefined>(stateFile(workspace.rootPath, taskId, taskRunId), undefined);
    if (!state) throw new HttpError(404, `Task run not found: ${taskRunId}`, "TASK_RUN_NOT_FOUND");
    return state;
  }

  private async writeState(workspace: Workspace, state: MissionState): Promise<void> {
    state.updatedAt = new Date().toISOString();
    await writeJson(stateFile(workspace.rootPath, state.task.id, state.taskRun.id), state);
  }

  private async snapshot(workspace: Workspace, taskId: string, taskRunId: string): Promise<WorkspaceSnapshot> {
    const state = await this.readState(workspace, taskId, taskRunId);
    const events = await this.ledger.read(workspace.rootPath, taskId, taskRunId);
    const projected = projectWorkspaceState(workspace, events);
    projected.activeTask = state.task;
    projected.activeTaskRun = state.taskRun;
    projected.tickets = state.tickets ?? [];
    projected.inboxMessages = state.inboxMessages ?? [];
    projected.agentMessages = agentMessagesByAgent(state.context);
    projected.phase = state.taskRun.phase;
    projected.status = state.status;
    projected.humanLoop = humanLoopSnapshot(state);
    return projected;
  }

  private blockedTicket(state: MissionState): Ticket | undefined {
    return (state.tickets ?? []).find((ticket) => ticket.status === "blocked");
  }

  private blockedTicketForAgent(state: MissionState, agent: WorkspaceAgent): Ticket | undefined {
    return (state.tickets ?? []).find((ticket) =>
      ticket.status === "blocked"
      && (ticket.targetAgentId === agent.id || (!ticket.targetAgentId && ticket.targetRole === agent.roleInWorkspace))
    );
  }

  private appendAgentDirectMessage(state: MissionState, agentId: string, message: string): void {
    const byAgent = agentMessagesByAgent(state.context);
    const entry: AgentDirectMessage = {
      id: createId("hm"),
      agentId,
      taskId: state.task.id,
      taskRunId: state.taskRun.id,
      message,
      createdBy: "human",
      createdAt: new Date().toISOString()
    };
    state.context.agentMessages = {
      ...byAgent,
      [agentId]: [...(byAgent[agentId] ?? []), entry]
    };
    state.updatedAt = entry.createdAt;
  }

  private async reconcileBlockedTicketState(workspace: Workspace, state: MissionState): Promise<Ticket | undefined> {
    const ticket = this.blockedTicket(state);
    if (!ticket) return undefined;
    const phase = phaseForTicket(ticket);
    const alreadyBlocked = state.status === "blocked"
      && state.task.status === "blocked"
      && state.taskRun.status === "blocked"
      && state.taskRun.phase === phase;
    if (alreadyBlocked) return undefined;

    state.status = "blocked";
    state.task.status = "blocked";
    state.taskRun.status = "blocked";
    state.taskRun.phase = phase;
    state.nextPhase = phase;
    state.taskRun.endedAt = new Date().toISOString();
    await this.writeState(workspace, state);
    return ticket;
  }

  private async append(
    workspace: Workspace,
    state: MissionState,
    type: AutoAgentEvent["type"],
    summary: string,
    payload: Record<string, unknown>
  ) {
    return this.ledger.append(workspace.rootPath, {
      workspaceId: workspace.id,
      taskId: state.task.id,
      taskRunId: state.taskRun.id,
      type,
      summary,
      payload
    });
  }
}

function briefForPhase(phase: MissionPhase, state: MissionState): string {
  if (phase === "boss_intake") return `判断需求是否可执行：${state.task.goal}`;
  if (phase === "pm_plan") return "把目标拆成小规模执行计划";
  if (phase === "architect_plan") return "判断架构方案、技术路径和能力缺口";
  if (phase === "implementation") return "按计划开发并产出交付物";
  if (phase === "qa") return "验证实现并给出通过或失败结论";
  if (phase === "boss_acceptance") return "验收或驳回已完成任务";
  return "专家专项处理";
}

function expectedArtifactForPhase(phase: MissionPhase): string {
  if (phase === "boss_intake") return "可执行性判断";
  if (phase === "pm_plan") return "执行计划";
  if (phase === "architect_plan") return "技术方案";
  if (phase === "implementation") return "可运行变更或实现报告";
  if (phase === "qa") return "测试报告";
  if (phase === "boss_acceptance") return "验收结论";
  return "专家建议";
}

function ticketBlockerFor(input: {
  reason: string;
  manualTestingReason?: string;
  explicitAuthorization?: boolean;
  toolPolicyBlocked?: boolean;
}): TicketBlocker {
  if (input.manualTestingReason) return { type: "manual_test_required", reason: input.manualTestingReason };
  if (input.explicitAuthorization) return { type: "human_authorization_required", reason: input.reason };
  if (input.toolPolicyBlocked) return { type: "tool_policy_blocked", reason: input.reason };
  return { type: "external_dependency", reason: input.reason };
}

function transitionAfterCompletedTicket(ticket: Ticket): { type: TicketType; reason: string } | undefined {
  if (ticket.type === "rework") return { type: "qa", reason: "返工完成后需要重新质量检查" };
  if (ticket.type === "qa") return { type: "boss_acceptance", reason: "质量检查通过，进入老板验收" };
  return undefined;
}

function agentObstacleReasonForPhase(phase: MissionPhase, structured?: Record<string, unknown>): string | undefined {
  if (!structured) return undefined;
  const status = lower(structured.status);
  const decision = lower(structured.decision);
  const action = lower(structured.action);
  const reason = stringValue(structured.reason) ?? stringValue(structured.report) ?? stringValue(structured.summary);
  const needsClarification = isBlockingDecision(structured);
  if (needsClarification) return reason ?? "需要补充事实或澄清后才能继续";
  if (phase === "boss_acceptance" && (decision === "reject" || structured.accepted === false)) {
    return reason ?? "老板验收未通过";
  }
  return undefined;
}

function qaDefectReasonForPhase(structured?: Record<string, unknown>): string | undefined {
  if (!structured) return undefined;
  const status = lower(structured.status);
  const action = lower(structured.action);
  if (status.includes("manual_test") || action.includes("manual_test")) return undefined;
  const explicit = firstNonEmptyDefectField(structured, ["defects", "issues", "bugs", "failures", "blockers", "missing_fixes", "missingFixes"]);
  if (explicit) return explicit;
  const failedQa = status === "fail" || status === "failed" || status === "not_passed";
  if (failedQa) {
    return stringValue(structured.reason)
      ?? stringValue(structured.summary)
      ?? stringValue(structured.report)
      ?? "QA 返回未通过";
  }
  return undefined;
}

function roleToolBoundaryReasonForPhase(phase: MissionPhase, agent: WorkspaceAgent, toolResults: Array<Record<string, unknown>>): string | undefined {
  const failedWrite = toolResults.find((result) => {
    return result.ok === false
      && String(result.tool ?? "") === "writeFile"
      && isPolicyOrPermissionFailure(String(result.error ?? ""));
  });
  if (!failedWrite) return undefined;
  if (agent.roleInWorkspace === "dev" || agent.roleInWorkspace === "specialist") return undefined;
  const target = String(failedWrite.path || "");
  return `${phaseLabel(phase)}阶段的${roleLabel(agent.roleInWorkspace)}没有写项目文件权限，写入${target || "项目文件"}应交给开发或具备写权限的 Agent。`;
}

function firstNonEmptyDefectField(structured: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = collectValuesByKey(structured, key);
    const texts = collectStructuredStrings(value);
    if (texts.length > 0) return `${key}: ${texts.join("；")}`;
  }
  return undefined;
}

function collectValuesByKey(value: unknown, key: string): unknown[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((item) => collectValuesByKey(item, key));
  return Object.entries(value).flatMap(([entryKey, entryValue]) => {
    const own = entryKey === key ? [entryValue] : [];
    return own.concat(collectValuesByKey(entryValue, key));
  });
}

function phaseForTicket(ticket: Ticket): MissionPhase {
  return phaseForTicketType(ticket.type);
}

function phaseForTicketType(type: TicketType): MissionPhase {
  if (type === "rework") return "implementation";
  if (type === "human_action") return "boss_acceptance";
  if (type === "specialist") return "implementation";
  return type;
}

function assignmentTypeForTicket(ticket: Ticket): AssignmentType {
  if (ticket.type === "rework") return "implementation";
  if (ticket.type === "human_action") return "boss_acceptance";
  return ticket.type;
}

function roleForPhase(phase: MissionPhase): AgentRole {
  if (phase === "boss_intake" || phase === "boss_acceptance") return "boss";
  if (phase === "pm_plan") return "pm";
  if (phase === "architect_plan") return "architect";
  if (phase === "qa") return "qa";
  return "dev";
}

function canonicalRoleForTicketType(type: TicketType): AgentRole {
  if (type === "boss_intake" || type === "boss_acceptance" || type === "human_action") return "boss";
  if (type === "pm_plan") return "pm";
  if (type === "architect_plan") return "architect";
  if (type === "qa") return "qa";
  if (type === "specialist") return "specialist";
  return "dev";
}

function dependencyIdsForPlanItem(item: Record<string, unknown>, ticketsByKey: Map<string, Ticket>, fallback: string[]): string[] {
  const raw = planItemDependencyKeys(item);
  if (!raw) return fallback;
  const ids = raw
    .map((value) => ticketsByKey.get(value)?.id)
    .filter((value): value is string => Boolean(value));
  return ids.length > 0 ? ids : fallback;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function targetTicketTypeFromStructured(structured: Record<string, unknown> | undefined): TicketType | undefined {
  const raw = stringValue(structured?.target_ticket_type)
    ?? stringValue(structured?.targetTicketType);
  return raw ? ticketTypeFromValueOrUndefined(raw) : undefined;
}

function ticketTypeFromValueOrUndefined(value: string): TicketType | undefined {
  const normalized = value.trim();
  const allowed = new Set<TicketType>(["boss_intake", "pm_plan", "architect_plan", "implementation", "qa", "boss_acceptance", "specialist", "rework", "human_action"]);
  if (allowed.has(normalized as TicketType)) return normalized as TicketType;
  if (normalized === "pm" || normalized === "product") return "pm_plan";
  if (normalized === "architect" || normalized === "architecture") return "architect_plan";
  if (normalized === "dev" || normalized === "development") return "implementation";
  if (normalized === "acceptance") return "boss_acceptance";
  return undefined;
}

function humanAuthorizationReasonForPhase(structured?: Record<string, unknown>): string | undefined {
  if (!structured) return undefined;
  const status = lower(structured.status);
  const decision = lower(structured.decision);
  const action = lower(structured.action);
  const reason = stringValue(structured.reason) ?? stringValue(structured.report) ?? stringValue(structured.summary);
  const needsHumanAuthorization = [status, decision, action].some((value) => {
    return value === "human_authorization_required"
      || value === "human_approval_required"
      || value === "requires_human"
      || value === "await_human_authorization"
      || value === "await_human_approval";
  });
  return needsHumanAuthorization ? reason ?? "需要 human 授权后才能继续" : undefined;
}

function planningClarificationReasonForPhase(structured?: Record<string, unknown>): string | undefined {
  if (!structured) return undefined;
  const status = lower(structured.status);
  const decision = lower(structured.decision);
  const action = lower(structured.action);
  const needsClarification = structured.clarification_required === true
    || status === "need_clarification"
    || status === "awaiting_clarification"
    || decision === "need_clarification"
    || action === "awaiting_clarification"
    || action === "return_to_clarification";
  if (!needsClarification) return undefined;
  return stringValue(structured.reason)
    ?? stringValue(structured.report)
    ?? stringValue(structured.summary)
    ?? "PM 需要 human 补充范围、功能或验收标准后才能继续拆解";
}

function manualTestingReasonForPhase(structured: Record<string, unknown> | undefined, rawText: string): string | undefined {
  if (!structured) return undefined;
  const reason = structured
    ? stringValue(structured.reason) ?? stringValue(structured.report) ?? stringValue(structured.summary) ?? rawText
    : rawText;
  const status = lower(structured.status);
  const action = lower(structured.action);
  const explicitManualTesting = status === "manual_test_required"
    || action === "manual_test_required";
  return explicitManualTesting ? reason : undefined;
}

async function hasImplementationEvidence(workspace: Workspace, toolResults: Array<Record<string, unknown>>, structured?: Record<string, unknown>): Promise<boolean> {
  if (toolResults.some((result) => {
    const tool = String(result.tool ?? "");
    if (tool === "writeFile") return result.ok === true;
    if (tool === "shell") return Number(result.exitCode) === 0;
    return false;
  })) return true;
  return hasDeclaredWorkspaceArtifact(workspace, structured);
}

async function hasDeclaredWorkspaceArtifact(workspace: Workspace, structured?: Record<string, unknown>): Promise<boolean> {
  if (!structured) return false;
  const candidate = stringValue(structured.artifact)
    ?? stringValue(structured.deliverable)
    ?? stringValue(structured.manual_test_file)
    ?? stringValue(structured.path)
    ?? stringValue(structured.file);
  const workspaceRoot = path.resolve(workspace.rootPath);
  if (candidate && await workspacePathExists(workspaceRoot, candidate)) return true;
  for (const value of collectStructuredStrings(structured)) {
    for (const extracted of extractArtifactPathCandidates(value)) {
      if (await workspacePathExists(workspaceRoot, extracted)) return true;
    }
  }
  return false;
}

async function workspacePathExists(workspaceRoot: string, candidate: string): Promise<boolean> {
  const absolute = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(workspaceRoot, candidate);
  if (absolute !== workspaceRoot && !absolute.startsWith(`${workspaceRoot}${path.sep}`)) return false;
  try {
    await access(absolute);
    return true;
  } catch {
    return false;
  }
}

function collectStructuredStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => collectStructuredStrings(item));
  if (value && typeof value === "object") return Object.values(value).flatMap((item) => collectStructuredStrings(item));
  return [];
}

function extractArtifactPathCandidates(text: string): string[] {
  const candidates = new Set<string>();
  const extensionPattern = "html?|jsx?|tsx?|css|json|md|txt|py|cs|go|rs|java|kt|swift|php|rb|ya?ml|toml|xml";
  const absolutePattern = new RegExp(`[A-Za-z]:\\\\[^\\r\\n"'<>|]+?\\.(?:${extensionPattern})`, "gi");
  const relativePattern = new RegExp(`(?:[A-Za-z0-9_.-]+[\\\\/])*[A-Za-z0-9_.-]+\\.(?:${extensionPattern})`, "gi");
  for (const match of text.matchAll(absolutePattern)) candidates.add(match[0].trim());
  for (const match of text.matchAll(relativePattern)) candidates.add(match[0].trim());
  return [...candidates];
}

function toolFailureReason(toolResults: Array<Record<string, unknown>>): string | undefined {
  const failed = toolResults.find(isBlockingToolFailure);
  if (!failed) return undefined;
  const tool = String(failed.tool ?? "工具");
  const target = String(failed.path || failed.command || "");
  const error = String(failed.error ?? "工具执行失败");
  return `${tool}${target ? ` (${target})` : ""} 执行失败：${error}`;
}

function isBlockingToolFailure(result: Record<string, unknown>): boolean {
  const failed = result.ok === false || typeof result.error === "string";
  if (!failed) return false;
  const tool = String(result.tool ?? "");
  if (!isObservationTool(tool)) return true;
  return isPolicyOrPermissionFailure(String(result.error ?? ""));
}

function isPolicyOrPermissionFailure(error: string): boolean {
  const message = error.toLowerCase();
  return message.includes("not allowed")
    || message.includes("allowlisted")
    || message.includes("path escapes workspace")
    || message.includes("tool_denied")
    || message.includes("permission denied")
    || message.includes("eacces")
    || message.includes("eperm");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function lower(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function isBlockingDecision(result: Record<string, unknown>): boolean {
  const status = lower(result.status);
  const decision = lower(result.decision);
  const action = lower(result.action);
  return result.clarification_required === true
    || status === "need_clarification"
    || status === "awaiting_clarification"
    || status === "blocked"
    || action === "awaiting_clarification"
    || action === "return_to_clarification"
    || action === "block"
    || result.blocked === true
    || decision === "reject";
}

function contextForAgent(context: Record<string, unknown>, agentId: string): Record<string, unknown> {
  const { agentMessages, ...baseContext } = context;
  const directMessages = agentMessagesByAgent(context)[agentId] ?? [];
  return {
    ...baseContext,
    agentDirectMessages: directMessages,
    latestAgentDirectMessage: directMessages.at(-1)
  };
}

function agentMessagesByAgent(context: Record<string, unknown>): Record<string, AgentDirectMessage[]> {
  const raw = context.agentMessages;
  if (!isRecord(raw)) return {};
  const result: Record<string, AgentDirectMessage[]> = {};
  for (const [agentId, value] of Object.entries(raw)) {
    if (!Array.isArray(value)) continue;
    result[agentId] = value.filter(isAgentDirectMessage);
  }
  return result;
}

function isAgentDirectMessage(value: unknown): value is AgentDirectMessage {
  if (!isRecord(value)) return false;
  return typeof value.id === "string"
    && typeof value.agentId === "string"
    && typeof value.taskId === "string"
    && typeof value.taskRunId === "string"
    && typeof value.message === "string"
    && value.createdBy === "human"
    && typeof value.createdAt === "string";
}

function isManualTestingBoundary(state: MissionState): boolean {
  const qaContext = state.context.qa as { result?: unknown } | undefined;
  const result = qaContext?.result;
  if (isRecord(result)) {
    const status = stringValue(result.status)?.toLowerCase();
    if (status === "manual_test_required") return true;
  }
  return typeof result === "string" && result.includes("manual_test_required");
}

type BlockedFollowupAction = "continue" | "hold" | "pass_manual_test" | "fail_manual_test";

function ticketResumeReviewContext(state: MissionState, ticket: Ticket, message: string, agentId: string): Record<string, unknown> {
  const {
    latestHumanFollowup,
    ticketResumeReview,
    humanFollowups,
    ...taskContext
  } = state.context;
  return {
    humanFollowup: message,
    blockedTicket: ticket,
    ticketResumeReview: {
      ticketId: ticket.id,
      blocker: ticket.blocker,
      allowedActions: ticketResumeAllowedActions(ticket)
    },
    humanFollowupHistory: humanFollowups,
    previousHumanFollowup: latestHumanFollowup,
    previousTicketResumeReview: ticketResumeReview,
    taskContext: contextForAgent(taskContext, agentId)
  };
}

function ticketResumeReviewBrief(ticket: Ticket, humanFollowup: string): string {
  return [
    "你正在处理一个被 human 回复唤醒的 blocked 工单。先做 ticket_resume_review 分类 turn，不要直接执行原任务。",
    "只根据当前工单状态、阻塞原因、上次输出和本轮 humanFollowup 判断下一步动作，并返回结构化 JSON。",
    "本轮 humanFollowup 原文：",
    humanFollowup,
    `允许动作：${ticketResumeAllowedActions(ticket).join("、")}。`,
    "如果 human 只是在提问、补充现象、请求帮助或信息不足，返回 {\"decision\":\"need_more_info\",\"reason\":\"...\",\"reply_to_human\":\"...\"}。",
    "如果 human 明确回答了当前阻塞问题，或把专业取舍委托给当前 Agent 自行判断，且不涉及人工测试通过、生产/安全/隐私/付费/删除等不可逆边界，返回 {\"decision\":\"continue\",\"reason\":\"...\"}；后续执行时把关键假设写进工单或产物。",
    "只有当前 Agent 无法专业判断、且缺失信息会改变不可逆边界时，才继续 need_more_info，并只问最少必要问题。",
    ticket.blocker?.type === "manual_test_required"
      ? "人工测试边界：测试通过返回 {\"human_action\":\"manual_test_passed\",\"reason\":\"...\"}；测试失败返回 {\"human_action\":\"manual_test_failed\",\"reason\":\"...\"}；不明确则返回 {\"human_action\":\"need_more_info\",\"reason\":\"...\",\"reply_to_human\":\"...\"}。"
      : undefined,
    "不要把提问当成批准；不要自行猜测 human 已同意或已验收；也不要把明确授权当前 Agent 专业判断的回复当作未回答。"
  ].filter(Boolean).join("\n");
}

function ticketResumeAllowedActions(ticket: Ticket): string[] {
  if (ticket.blocker?.type === "manual_test_required") return ["manual_test_passed", "manual_test_failed", "need_more_info"];
  return ["continue", "need_more_info"];
}

function blockedFollowupActionFromReview(review: unknown): Exclude<BlockedFollowupAction, "continue"> | "continue" {
  const result = isRecord(review) && "result" in review ? review.result : review;
  if (!isRecord(result)) return "hold";
  const rawAction = stringValue(result.human_action)
    ?? stringValue(result.decision)
    ?? stringValue(result.action)
    ?? stringValue(result.status);
  if (rawAction === "manual_test_passed" || rawAction === "passed" || rawAction === "pass") return "pass_manual_test";
  if (rawAction === "manual_test_failed" || rawAction === "failed" || rawAction === "fail") return "fail_manual_test";
  if (rawAction === "continue" || rawAction === "approve" || rawAction === "approved" || rawAction === "authorized") return "continue";
  if (rawAction === "need_more_info" || rawAction === "needs_more_info" || rawAction === "need_clarification" || rawAction === "ask_human") return "hold";
  return "hold";
}

function humanLoopSnapshot(state: MissionState): WorkspaceSnapshot["humanLoop"] | undefined {
  if (state.status !== "blocked") return undefined;
  const review = isRecord(state.context.ticketResumeReview) ? state.context.ticketResumeReview : undefined;
  const result = review && isRecord(review.result) ? review.result : undefined;
  if (!result) return undefined;
  const text = stringValue(result.reply_to_human)
    ?? stringValue(result.replyToHuman)
    ?? stringValue(result.message)
    ?? stringValue(result.reason)
    ?? (review ? stringValue(review.rawText) : undefined);
  if (!text) return undefined;
  const action = blockedFollowupActionFromReview(review);
  const latestHumanFollowup = isRecord(state.context.latestHumanFollowup) ? state.context.latestHumanFollowup : undefined;
  const phase = missionPhaseValue(action === "hold" ? latestHumanFollowup?.blockedPhase : latestHumanFollowup?.resumePhase)
    ?? missionPhaseValue(latestHumanFollowup?.fromPhase)
    ?? missionPhaseValue(latestHumanFollowup?.resumePhase)
    ?? state.taskRun.phase;
  const ticket = state.tickets.find((item) => item.status === "blocked" && phaseForTicket(item) === phase)
    ?? state.tickets.find((item) => item.status === "blocked");
  if (!ticket || phaseForTicket(ticket) !== phase) return undefined;
  return {
    latestReply: {
      agentId: ticket?.targetAgentId,
      phase,
      action,
      reason: stringValue(result.reason),
      text
    }
  };
}

function missionPhaseValue(value: unknown): MissionPhase | undefined {
  const phase = stringValue(value);
  if (!phase) return undefined;
  if (MISSION_PHASE_SET.has(phase as MissionPhase)) return phase as MissionPhase;
  return undefined;
}

const MISSION_PHASE_SET = new Set<MissionPhase>([
  "idle",
  "boss_intake",
  "pm_plan",
  "architect_plan",
  "implementation",
  "qa",
  "boss_acceptance",
  "paused",
  "completed",
  "failed",
  "interrupted"
]);
