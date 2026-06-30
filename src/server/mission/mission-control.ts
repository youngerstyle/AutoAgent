import { readdir } from "node:fs/promises";
import path from "node:path";
import type { Assignment, AutoAgentEvent, MissionPhase, Task, TaskRun, Workspace, WorkspaceAgent, WorkspaceSnapshot } from "../../shared/types.js";
import { createId } from "../../shared/ids.js";
import { phaseLabel } from "../../shared/labels.js";
import { AgentRuntime, type ProviderRunner } from "../agents/agent-runtime.js";
import { AgentProfileStore } from "../agents/profile-store.js";
import { recruitSpecialist } from "../agents/recruitment.js";
import { ensureCoreTeam, listWorkspaceAgents, profileMetadata } from "../agents/roster.js";
import { HttpError } from "../errors.js";
import { EventLedger } from "../storage/event-ledger.js";
import { projectWorkspaceState } from "../storage/state-projector.js";
import { stateFile, workspaceAutoAgentDir } from "../storage/paths.js";
import { readJson, writeJson } from "../storage/json.js";
import type { WorkspaceStore } from "../storage/workspace-store.js";
import { assignmentTypeForPhase, nextPhase } from "./phases.js";

export interface MissionState {
  task: Task;
  taskRun: TaskRun;
  nextPhase: MissionPhase;
  status: "running" | "paused" | "completed" | "failed" | "interrupted";
  pauseRequested: boolean;
  stopRequested: boolean;
  qaAttempts: number;
  context: Record<string, unknown>;
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
    if (state.status !== "paused") return this.snapshot(workspace, state.task.id, state.taskRun.id);
    state.pauseRequested = false;
    state.status = "running";
    state.task.status = "running";
    state.taskRun.status = "running";
    state.taskRun.phase = state.nextPhase;
    await this.writeState(workspace, state);
    await this.append(workspace, state, "task.phase_changed", `Task resumed at ${state.nextPhase}`, { phase: state.nextPhase, status: "running" });
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
    const result = await this.runtime.runAssignment({
      workspace,
      agent,
      taskId: state.task.id,
      taskRunId: state.taskRun.id,
      goal: state.task.goal,
      type: assignmentTypeForPhase(phase),
      brief: briefForPhase(phase, state),
      expectedArtifact: expectedArtifactForPhase(phase),
      context: state.context,
      sessionId: state.taskRun.id
    });

    state.context[phase] = result.providerResult.structured ?? result.providerResult.text;
    state.updatedAt = new Date().toISOString();

    if (phase === "architect_plan" && result.providerResult.structured?.needsSpecialist) {
      const gap = String(result.providerResult.structured.capabilityGap ?? "通用专项能力");
      const profiles = await this.agentProfiles();
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

    if (phase === "qa") {
      state.qaAttempts += 1;
      const passed = result.providerResult.structured?.passed !== false;
      if (!passed && state.qaAttempts < 3) {
        await this.append(workspace, state, "qa.failed", "测试要求开发返工", {
          feedback: result.providerResult.structured?.report ?? result.providerResult.text,
          attempt: state.qaAttempts
        });
        state.nextPhase = "implementation";
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
        await this.append(workspace, state, "run.failed", "测试重试次数耗尽，任务失败", { task: state.task, taskRun: state.taskRun });
        return state;
      }
    }

    state.nextPhase = nextPhase(phase);
    state.taskRun.phase = state.nextPhase;
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

  private runInBackground(workspace: Workspace, taskId: string, taskRunId: string): void {
    setImmediate(() => {
      void this.runUntilIdle(workspace, taskId, taskRunId).catch(() => undefined);
    });
  }

  private async agentProfiles() {
    return this.profileStore ? this.profileStore.list() : undefined;
  }

  private async findActiveState(workspace: Workspace): Promise<MissionState | undefined> {
    return (await this.readAllStates(workspace)).find((state) => state.status === "running" || state.status === "paused");
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
    const events = await this.ledger.read(workspace.rootPath, taskId, taskRunId);
    const projected = projectWorkspaceState(workspace, events);
    projected.activeTask = state.task;
    projected.activeTaskRun = state.taskRun;
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
