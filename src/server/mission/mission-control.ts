import { access, readdir } from "node:fs/promises";
import path from "node:path";
import type { AgentInboxMessage, Assignment, AutoAgentEvent, LoopDebugLog, MissionPhase, Task, TaskRun, Ticket, TicketBlocker, Workspace, WorkspaceAgent, WorkspaceSnapshot } from "../../shared/types.js";
import { createId } from "../../shared/ids.js";
import { phaseLabel } from "../../shared/labels.js";
import { AgentRuntime, type ProviderRunner } from "../agents/agent-runtime.js";
import { AgentProfileStore } from "../agents/profile-store.js";
import { recruitSpecialist } from "../agents/recruitment.js";
import { ensureCoreTeam, listWorkspaceAgents, profileForRole, profileMetadata } from "../agents/roster.js";
import { HttpError } from "../errors.js";
import { EventLedger } from "../storage/event-ledger.js";
import { projectWorkspaceState } from "../storage/state-projector.js";
import { stateFile, workspaceAutoAgentDir } from "../storage/paths.js";
import { readJson, writeJson } from "../storage/json.js";
import type { WorkspaceStore } from "../storage/workspace-store.js";
import { assignmentTypeForPhase, nextPhase } from "./phases.js";
import { buildLoopDebugLog } from "./loop-debug-log.js";
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
    private readonly profileStore?: AgentProfileStore
  ) {
    this.runtime = new AgentRuntime(ledger, providerRunner);
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
    if (state.status === "blocked") this.applyHumanActionToTickets(state, "继续");
    const resumePhase = state.status === "blocked" ? phaseAfterHumanFollowup(state) : state.nextPhase;
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

    const currentPhase = state.taskRun.phase;
    const resumePhase = state.status === "blocked" ? phaseAfterHumanFollowup(state, followup) : state.nextPhase;
    const followups = Array.isArray(state.context.humanFollowups) ? state.context.humanFollowups as Array<Record<string, unknown>> : [];
    const entry = {
      message: followup,
      blockedPhase: state.status === "blocked" ? currentPhase : undefined,
      fromPhase: currentPhase,
      resumePhase,
      at: new Date().toISOString()
    };
    state.context.humanFollowups = [...followups, entry];
    state.context.latestHumanFollowup = entry;
    if (state.status === "blocked") {
      this.applyHumanActionToTickets(state, followup);
    }
    if (state.status === "blocked" || state.status === "paused") {
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
      resumePhase
    });
    await this.append(workspace, state, "task.phase_changed", `收到补充，返回阶段：${phaseLabel(resumePhase)}`, {
      phase: resumePhase,
      status: "running",
      fromPhase: currentPhase
    });

    if (runSynchronously) {
      await this.runUntilIdle(workspace, state.task.id, state.taskRun.id);
    } else {
      this.runInBackground(workspace, state.task.id, state.taskRun.id);
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
      while (state.status === "running" && state.nextPhase !== "completed") {
        if (state.stopRequested) break;
        if (state.pauseRequested) {
          await this.pauseTask(workspace.id, taskId);
          break;
        }
        state = await this.runPhase(workspace, state);
      }
      state = await this.readState(workspace, taskId, taskRunId);
      if (state.status === "running" && state.nextPhase === "completed") {
        state.status = "completed";
        state.task.status = "completed";
        state.taskRun.status = "completed";
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

  private async runPhase(workspace: Workspace, state: MissionState): Promise<MissionState> {
    const phase = state.nextPhase;
    await this.append(workspace, state, "task.phase_changed", `进入阶段：${phaseLabel(phase)}`, { phase, status: "running" });
    const agent = await this.agentForPhase(workspace, phase);
    const profiles = await this.agentProfiles();
    const profile = profileForRole(agent.roleInWorkspace, profiles);
    const ticketRuntime = this.ticketRuntime(state);
    const ticket = ticketRuntime.createTicket({
      workspaceId: workspace.id,
      taskId: state.task.id,
      taskRunId: state.taskRun.id,
      type: assignmentTypeForPhase(phase),
      brief: briefForPhase(phase, state),
      expectedArtifact: expectedArtifactForPhase(phase),
      targetAgentId: agent.id,
      targetRole: agent.roleInWorkspace
    });
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
      type: assignmentTypeForPhase(phase),
      brief: briefForPhase(phase, state),
      expectedArtifact: expectedArtifactForPhase(phase),
      context: state.context,
      sessionId: state.taskRun.id
    });
    const latestState = await this.readState(workspace, state.task.id, state.taskRun.id);
    if (latestState.stopRequested || latestState.status === "interrupted") return latestState;

    const phaseResult = result.providerResult.structured ?? result.providerResult.text;
    state.context[phase] = { result: phaseResult, toolResults: result.toolResults };
    state.updatedAt = new Date().toISOString();

    const manualTestingReason = phase === "qa" ? manualTestingReasonForPhase(result.providerResult.structured, result.providerResult.text) : undefined;
    const humanAuthorizationReason = humanAuthorizationReasonForPhase(result.providerResult.structured)
      ?? toolFailureReason(result.toolResults);
    const agentObstacle = agentObstacleReasonForPhase(phase, result.providerResult.structured);
    const missingImplementation = phase === "implementation" && !await hasImplementationEvidence(workspace, result.toolResults, result.providerResult.structured)
      ? "开发阶段没有产生真实文件写入或命令执行证据"
      : undefined;
    const qaDefectReason = phase === "qa" ? qaDefectReasonForPhase(result.providerResult.structured) : undefined;
    const manualOnlyReason = manualTestingReason && !qaDefectReason ? `需要人工测试：${manualTestingReason}` : undefined;
    if (humanAuthorizationReason || manualOnlyReason) {
      const reason = humanAuthorizationReason ?? manualOnlyReason ?? "需要 human 处理";
      const blockerManualReason = manualOnlyReason ? manualTestingReason : undefined;
      ticketRuntime.blockTicket(ticket.id, ticketBlockerFor(reason, blockerManualReason));
      this.syncTickets(state, ticketRuntime);
      result.assignment.status = "blocked";
      state.status = "blocked";
      state.task.status = "blocked";
      state.taskRun.status = "blocked";
      state.taskRun.phase = phase;
      state.taskRun.endedAt = new Date().toISOString();
      await this.writeState(workspace, state);
      await this.append(workspace, state, "assignment.blocked", `${phaseLabel(phase)}受阻：${reason}`, {
        assignmentId: result.assignment.id,
        assignmentRun: result.assignmentRun,
        reason,
        result: phaseResult,
        rawText: result.providerResult.text,
        toolResults: result.toolResults
      });
      await this.append(workspace, state, "run.blocked", `任务受阻：${phaseLabel(phase)}受阻：${reason}`, { task: state.task, taskRun: state.taskRun, reason, phase });
      return state;
    }

    if (qaDefectReason) {
      ticketRuntime.ack(ticket.id, phaseResult);
      this.syncTickets(state, ticketRuntime);
      return this.routeBackToPhaseOrFail(workspace, state, "implementation", qaDefectReason, "qaDefectRetries");
    }

    if (phase === "implementation" && (agentObstacle || missingImplementation)) {
      ticketRuntime.ack(ticket.id, phaseResult);
      this.syncTickets(state, ticketRuntime);
      const targetPhase = phaseForAgentObstacle(phase, agentObstacle ?? missingImplementation ?? "");
      return this.routeBackToPhaseOrFail(workspace, state, targetPhase, agentObstacle ?? missingImplementation ?? "开发未产出交付证据", `${targetPhase}AutonomyRetries`);
    }

    if (phase === "qa") {
      state.qaAttempts += 1;
      const passed = result.providerResult.structured?.passed !== false && !agentObstacle;
      if (!passed && state.qaAttempts < 3) {
        await this.append(workspace, state, "qa.failed", "测试要求开发返工", {
          feedback: agentObstacle ?? result.providerResult.structured?.report ?? result.providerResult.text,
          attempt: state.qaAttempts
        });
        state.nextPhase = "implementation";
        ticketRuntime.ack(ticket.id, phaseResult);
        this.syncTickets(state, ticketRuntime);
        await this.writeState(workspace, state);
        return state;
      }
      if (!passed) {
        state.status = "failed";
        state.task.status = "failed";
        state.taskRun.status = "failed";
        state.taskRun.phase = "failed";
        state.taskRun.endedAt = new Date().toISOString();
        await this.writeState(workspace, state);
        await this.append(workspace, state, "run.failed", "测试重试次数耗尽，任务失败", { task: state.task, taskRun: state.taskRun, reason: agentObstacle });
        return state;
      }
    }

    if (phase === "boss_acceptance" && agentObstacle) {
      ticketRuntime.ack(ticket.id, phaseResult);
      this.syncTickets(state, ticketRuntime);
      return this.routeBackToPhaseOrFail(workspace, state, "implementation", agentObstacle, "bossAcceptanceReworkRetries");
    }

    if (agentObstacle) {
      const targetPhase = phaseForAgentObstacle(phase, agentObstacle);
      if (targetPhase !== nextPhase(phase)) {
        ticketRuntime.ack(ticket.id, phaseResult);
        this.syncTickets(state, ticketRuntime);
        return this.routeBackToPhaseOrFail(workspace, state, targetPhase, agentObstacle, `${targetPhase}AutonomyRetries`);
      }
      await this.append(workspace, state, "task.phase_changed", `Agent 自治继续：${agentObstacle}`, {
        phase,
        status: "running",
        reason: agentObstacle
      });
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

    state.nextPhase = nextPhase(phase);
    state.taskRun.phase = state.nextPhase;
    ticketRuntime.ack(ticket.id, phaseResult);
    this.syncTickets(state, ticketRuntime);
    await this.writeState(workspace, state);
    return state;
  }

  private async agentForPhase(workspace: Workspace, phase: MissionPhase): Promise<WorkspaceAgent> {
    const role = phase === "boss_intake" || phase === "boss_acceptance"
      ? "boss"
      : phase === "pm_plan"
        ? "pm"
        : phase === "architect_plan"
          ? "architect"
          : phase === "qa"
            ? "qa"
            : "dev";
    const profiles = await this.agentProfiles();
    const agents = await ensureCoreTeam(workspace, profiles);
    const agent = agents.find((item) => item.roleInWorkspace === role);
    if (!agent) throw new HttpError(500, `Missing ${role} agent`, "MISSING_AGENT");
    return agent;
  }

  private async routeBackToPhaseOrFail(workspace: Workspace, state: MissionState, targetPhase: MissionPhase, reason: string, retryKey: string): Promise<MissionState> {
    const retries = Number(state.context[retryKey] ?? 0) + 1;
    state.context[retryKey] = retries;
    if (retries < 3) {
      state.nextPhase = targetPhase;
      state.taskRun.phase = targetPhase;
      await this.writeState(workspace, state);
      await this.append(workspace, state, "handoff.created", `Agent 自治返工：${reason}`, {
        phase: targetPhase,
        reason,
        attempt: retries
      });
      return state;
    }

    state.status = "failed";
    state.task.status = "failed";
    state.taskRun.status = "failed";
    state.taskRun.phase = "failed";
    state.taskRun.endedAt = new Date().toISOString();
    await this.writeState(workspace, state);
    const summary = targetPhase === "implementation" && reason.includes("真实文件")
      ? "开发无法产出真实交付证据，任务失败"
      : `${phaseLabel(targetPhase)}无法自治修复，任务失败`;
    await this.append(workspace, state, "run.failed", summary, {
      task: state.task,
      taskRun: state.taskRun,
      reason,
      attempts: retries
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
      runtime.completeHumanAction(blockedQa.id, {
        action: manualTestReportedFailure(message) ? "manual_test_failed" : "manual_test_passed",
        message
      });
      this.syncTickets(state, runtime);
      return;
    }
    const blocked = runtime.allTickets().find((ticket) => ticket.status === "blocked");
    if (blocked) runtime.ack(blocked.id, { humanAction: "approved", message });
    this.syncTickets(state, runtime);
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
    if (active?.task.id === taskId) return active;
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
    let events = await this.ledger.read(workspace.rootPath, taskId, taskRunId);
    const historicalBlockReason = terminalCompletionBlockReason(events);
    const historicalFailureBlockReason = terminalFailureBlockReason(events);
    if (state.status === "blocked" && historicalBlockReason && state.taskRun.phase !== historicalBlockReason.phase) {
      state.taskRun.phase = historicalBlockReason.phase;
      await this.writeState(workspace, state);
    }
    if (state.status === "completed" && historicalBlockReason && !events.some((event) => event.type === "run.blocked")) {
      state.status = "blocked";
      state.task.status = "blocked";
      state.taskRun.status = "blocked";
      state.taskRun.phase = historicalBlockReason.phase;
      state.taskRun.endedAt = new Date().toISOString();
      await this.writeState(workspace, state);
      if (historicalBlockReason.assignmentId) {
        await this.append(workspace, state, "assignment.blocked", `${phaseLabel(historicalBlockReason.phase)}受阻：${historicalBlockReason.reason}`, {
          assignmentId: historicalBlockReason.assignmentId,
          reason: historicalBlockReason.reason
        });
      }
      await this.append(workspace, state, "run.blocked", `任务受阻：${historicalBlockReason.reason}`, { task: state.task, taskRun: state.taskRun, reason: historicalBlockReason.reason });
      events = await this.ledger.read(workspace.rootPath, taskId, taskRunId);
    }
    if (state.status === "failed" && historicalFailureBlockReason && !hasRunBlockedAfterLatestFailure(events)) {
      state.status = "blocked";
      state.task.status = "blocked";
      state.taskRun.status = "blocked";
      state.taskRun.phase = historicalFailureBlockReason.phase;
      state.taskRun.endedAt = new Date().toISOString();
      state.nextPhase = historicalFailureBlockReason.phase;
      await this.writeState(workspace, state);
      await this.append(workspace, state, "assignment.blocked", `${phaseLabel(historicalFailureBlockReason.phase)}受阻：${historicalFailureBlockReason.reason}`, {
        assignmentId: historicalFailureBlockReason.assignmentId,
        assignmentRun: historicalFailureBlockReason.assignmentRun,
        reason: historicalFailureBlockReason.reason
      });
      await this.append(workspace, state, "run.blocked", `任务受阻：${historicalFailureBlockReason.reason}`, { task: state.task, taskRun: state.taskRun, reason: historicalFailureBlockReason.reason });
      events = await this.ledger.read(workspace.rootPath, taskId, taskRunId);
    }
    const projected = projectWorkspaceState(workspace, events);
    projected.activeTask = state.task;
    projected.activeTaskRun = state.taskRun;
    projected.tickets = state.tickets ?? [];
    projected.inboxMessages = state.inboxMessages ?? [];
    projected.phase = state.taskRun.phase;
    projected.status = state.status;
    return projected;
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

function ticketBlockerFor(reason: string, manualTestingReason?: string): TicketBlocker {
  if (manualTestingReason) return { type: "manual_test_required", reason: manualTestingReason };
  if (reason.includes("授权")) return { type: "human_authorization_required", reason };
  if (reason.includes("工具") || reason.includes("权限") || reason.toLowerCase().includes("policy")) return { type: "tool_policy_blocked", reason };
  return { type: "external_dependency", reason };
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
  const explicit = firstNonEmptyDefectField(structured, ["defects", "issues", "bugs", "failures", "blockers", "missing_fixes", "missingFixes"]);
  if (explicit) return explicit;
  const risk = collectNamedStrings(structured, ["static_analysis_risks", "risks", "known_risks"])
    .find(isAcceptanceBlockingRisk);
  if (risk) return `QA 发现需要开发处理的风险：${risk}`;
  const status = lower(structured.status);
  const failedQa = status === "fail" || status === "failed" || status === "not_passed";
  const reworkSignal = collectStructuredStrings(structured.report ?? structured).find(isQaReworkSignal);
  return failedQa && reworkSignal ? `QA 检查未通过：${reworkSignal}` : undefined;
}

function firstNonEmptyDefectField(structured: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = collectValuesByKey(structured, key);
    const texts = collectStructuredStrings(value);
    if (texts.length > 0) return `${key}: ${texts.join("；")}`;
  }
  return undefined;
}

function collectNamedStrings(structured: Record<string, unknown>, keys: string[]): string[] {
  return keys.flatMap((key) => collectStructuredStrings(collectValuesByKey(structured, key)));
}

function collectValuesByKey(value: unknown, key: string): unknown[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((item) => collectValuesByKey(item, key));
  return Object.entries(value).flatMap(([entryKey, entryValue]) => {
    const own = entryKey === key ? [entryValue] : [];
    return own.concat(collectValuesByKey(entryValue, key));
  });
}

function isAcceptanceBlockingRisk(text: string): boolean {
  const lowerText = text.toLowerCase();
  return lowerText.includes("blocker")
    || lowerText.includes("critical")
    || text.includes("永远达不到")
    || text.includes("无法")
    || text.includes("失败")
    || text.includes("阻塞")
    || text.includes("影响胜利")
    || text.includes("影响验收")
    || text.includes("瞬死")
    || text.includes("卡死")
    || text.includes("停止");
}

function isQaReworkSignal(text: string): boolean {
  return text.includes("打回开发")
    || text.includes("修复")
    || text.includes("缺陷")
    || text.includes("未通过")
    || text.includes("失败")
    || text.includes("返工");
}

function phaseForAgentObstacle(currentPhase: MissionPhase, reason: string): MissionPhase {
  const text = reason.toLowerCase();
  if (currentPhase === "boss_intake") return "pm_plan";
  if (currentPhase === "pm_plan") return "boss_intake";
  if (currentPhase === "architect_plan") return "pm_plan";
  if (currentPhase === "qa" || currentPhase === "boss_acceptance") return "implementation";
  if (currentPhase === "implementation") {
    if (reason.includes("需求") || reason.includes("范围") || reason.includes("验收") || reason.includes("计划") || text.includes("requirement")) return "pm_plan";
    if (reason.includes("架构") || reason.includes("接口") || reason.includes("技术方案") || text.includes("architecture")) return "architect_plan";
    return "implementation";
  }
  return currentPhase;
}

function humanAuthorizationReasonForPhase(structured?: Record<string, unknown>): string | undefined {
  if (!structured) return undefined;
  const status = lower(structured.status);
  const decision = lower(structured.decision);
  const action = lower(structured.action);
  const reason = stringValue(structured.reason) ?? stringValue(structured.report) ?? stringValue(structured.summary);
  const needsHumanAuthorization = [status, decision, action].some((value) => {
    return value.includes("human_authorization")
      || value.includes("human_approval")
      || value.includes("requires_human")
      || value.includes("await_human_authorization")
      || value.includes("await_human_approval")
      || value.includes("需要人工授权")
      || value.includes("等待人工授权")
      || value.includes("需要人工审批")
      || value.includes("等待人工审批");
  });
  return needsHumanAuthorization ? reason ?? "需要 human 授权后才能继续" : undefined;
}

function manualTestingReasonForPhase(structured: Record<string, unknown> | undefined, rawText: string): string | undefined {
  const reason = structured
    ? stringValue(structured.reason) ?? stringValue(structured.report) ?? stringValue(structured.summary) ?? rawText
    : rawText;
  const status = structured ? lower(structured.status) : "";
  const action = structured ? lower(structured.action) : "";
  const text = `${status} ${action} ${reason}`.toLowerCase();
  const explicitManualTesting = status.includes("manual_test")
    || action.includes("manual_test")
    || text.includes("manual testing");
  const missingBrowserAbility = reason.includes("缺少浏览器")
    || reason.includes("浏览器运行环境")
    || reason.includes("无法实际执行手动测试");
  const needsManualTesting = explicitManualTesting || missingBrowserAbility;
  return needsManualTesting ? reason : undefined;
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

const OBSERVATION_TOOLS = new Set(["readFile", "listFiles", "shell"]);

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
  if (!OBSERVATION_TOOLS.has(tool)) return true;
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
  const clarificationSignal = [status, decision, action].some((value) => hasClarificationSignal(value));
  return result.clarification_required === true
    || status.includes("need_clarification")
    || status.includes("awaiting_clarification")
    || status === "blocked"
    || action.includes("awaiting_clarification")
    || action.includes("return_to_clarification")
    || action === "block"
    || result.blocked === true
    || clarificationSignal
    || decision === "reject";
}

function hasClarificationSignal(value: string): boolean {
  if (!value || value.includes("不需要澄清")) return false;
  return value.includes("need clarification")
    || value.includes("needs clarification")
    || value.includes("clarification required")
    || value.includes("awaiting clarification")
    || value.includes("暂不执行")
    || value.includes("需澄清")
    || value.includes("需要澄清")
    || value.includes("等待澄清");
}

function terminalCompletionBlockReason(events: AutoAgentEvent[]): { phase: MissionPhase; reason: string; assignmentId?: string } | undefined {
  const lastHumanFollowupIndex = lastEventIndex(events, "human.followup");
  const completedAssignments = events.filter((event, index) => index > lastHumanFollowupIndex && event.type === "assignment.completed");
  for (const event of completedAssignments) {
    const payload = event.payload as Record<string, unknown>;
    const result = payload.result;
    const phase = phaseFromAssignmentSummary(event.summary);
    const reason = result && typeof result === "object"
      ? humanAuthorizationReasonForPhase(result as Record<string, unknown>)
      : undefined;
    if (reason) return { phase, reason, assignmentId: stringValue(payload.assignmentId) };
  }

  const implementation = completedAssignments.find((event) => event.summary.includes("开发"));
  if (implementation) {
    const payload = implementation.payload as Record<string, unknown>;
    const toolResults = Array.isArray(payload.toolResults) ? payload.toolResults as Array<Record<string, unknown>> : [];
  }
  return undefined;
}

function terminalFailureBlockReason(events: AutoAgentEvent[]): { phase: MissionPhase; reason: string; assignmentId?: string; assignmentRun?: unknown } | undefined {
  const latestFailureIndex = lastEventIndex(events, "run.failed");
  if (latestFailureIndex < 0) return undefined;
  const failedAssignment = events.slice(0, latestFailureIndex + 1).reverse().find((event) => event.type === "assignment.failed");
  if (!failedAssignment) return undefined;
  const payload = failedAssignment.payload as Record<string, unknown>;
  const reason = stringValue(payload.error) ?? "Agent 执行失败";
  if (!isPolicyOrPermissionFailure(reason)) return undefined;
  return {
    phase: phaseFromAssignmentId(events, stringValue(payload.assignmentId)) ?? phaseFromAssignmentSummary(failedAssignment.summary),
    reason,
    assignmentId: stringValue(payload.assignmentId),
    assignmentRun: payload.assignmentRun
  };
}

function hasRunBlockedAfterLatestFailure(events: AutoAgentEvent[]): boolean {
  const latestFailureIndex = lastEventIndex(events, "run.failed");
  if (latestFailureIndex < 0) return false;
  return events.some((event, index) => index > latestFailureIndex && event.type === "run.blocked");
}

function lastEventIndex(events: AutoAgentEvent[], type: AutoAgentEvent["type"]): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].type === type) return index;
  }
  return -1;
}

function phaseFromAssignmentId(events: AutoAgentEvent[], assignmentId?: string): MissionPhase | undefined {
  if (!assignmentId) return undefined;
  const created = events.find((event) => {
    if (event.type !== "assignment.created") return false;
    const assignment = (event.payload as Record<string, unknown>).assignment as { id?: string } | undefined;
    return assignment?.id === assignmentId;
  });
  const assignment = (created?.payload as Record<string, unknown> | undefined)?.assignment as { type?: MissionPhase } | undefined;
  return assignment?.type;
}

function phaseFromAssignmentSummary(summary: string): MissionPhase {
  if (summary.includes("需求接收")) return "boss_intake";
  if (summary.includes("计划拆解")) return "pm_plan";
  if (summary.includes("架构设计")) return "architect_plan";
  if (summary.includes("开发执行")) return "implementation";
  if (summary.includes("质量检查")) return "qa";
  if (summary.includes("老板验收")) return "boss_acceptance";
  return "boss_acceptance";
}

function phaseAfterHumanFollowup(state: MissionState, followup = ""): MissionPhase {
  const blockedPhase = state.taskRun.phase;
  if (blockedPhase === "qa") {
    if (isManualTestingBoundary(state) && !manualTestReportedFailure(followup)) return "boss_acceptance";
    return "implementation";
  }
  if (blockedPhase === "implementation") return "implementation";
  return "pm_plan";
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

function manualTestReportedFailure(followup: string): boolean {
  const text = followup.trim();
  if (!text) return false;
  if (/没有问题|没问题|无问题|没有 bug|没有bug|通过|pass|passed|ok/i.test(text)) return false;
  return /失败|未通过|不通过|有问题|有 bug|有bug|failed|fail|not pass/i.test(text);
}
