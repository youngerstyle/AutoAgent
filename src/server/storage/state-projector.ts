import type {
  Assignment,
  AgentRole,
  AutoAgentEvent,
  EntityStatus,
  MissionPhase,
  Task,
  TaskRun,
  Workspace,
  WorkspaceAgent,
  WorkspaceSnapshot
} from "../../shared/types.js";

interface ProjectionState {
  workspace: Workspace;
  task?: Task;
  taskRun?: TaskRun;
  agents: Map<string, WorkspaceAgent & { name?: string; role?: AgentRole; capabilities?: string[]; currentStep?: string }>;
  assignments: Map<string, Assignment>;
  phase: MissionPhase;
  status: EntityStatus;
  currentStep?: string;
}

export function projectWorkspaceState(workspace: Workspace, events: AutoAgentEvent[]): WorkspaceSnapshot {
  const state: ProjectionState = {
    workspace,
    agents: new Map(),
    assignments: new Map(),
    phase: "idle",
    status: "idle"
  };

  for (const event of events) {
    applyEvent(state, event);
  }

  return {
    workspace,
    activeTask: state.task,
    activeTaskRun: state.taskRun,
    agents: Array.from(state.agents.values()),
    assignments: Array.from(state.assignments.values()),
    recentEvents: visibleRecentEvents(events),
    phase: state.phase,
    status: state.status,
    currentStep: state.currentStep
  };
}

function applyEvent(state: ProjectionState, event: AutoAgentEvent): void {
  const payload = event.payload as Record<string, unknown>;

  if (event.type === "task.created") {
    state.task = payload.task as Task;
    state.taskRun = payload.taskRun as TaskRun;
    state.phase = "boss_intake";
    state.status = "running";
  }

  if (event.type === "task.phase_changed") {
    state.phase = payload.phase as MissionPhase;
    state.status = payload.status as EntityStatus;
  }

  if (event.type === "agent.created" || event.type === "agent.joined_workspace") {
    const agent = payload.agent as WorkspaceAgent & { name?: string; role?: AgentRole; capabilities?: string[] };
    state.agents.set(agent.id, agent);
  }

  if (event.type === "agent.status_changed") {
    const agentId = String(payload.agentId);
    const existing = state.agents.get(agentId);
    if (existing) {
      existing.status = payload.status as EntityStatus;
      state.agents.set(agentId, existing);
    }
  }

  if (event.type === "agent.step_started") {
    const agentId = String(payload.agentId);
    const step = String(payload.step);
    const existing = state.agents.get(agentId);
    if (existing) {
      existing.currentStep = step;
      existing.status = "running";
      state.agents.set(agentId, existing);
    }
    state.currentStep = step;
  }

  if (event.type === "agent.step_completed") {
    const agentId = String(payload.agentId);
    const existing = state.agents.get(agentId);
    if (existing) {
      existing.currentStep = undefined;
      existing.status = "waiting";
      state.agents.set(agentId, existing);
    }
  }

  if (event.type === "assignment.created") {
    const assignment = payload.assignment as Assignment;
    state.assignments.set(assignment.id, assignment);
  }

  if (event.type === "assignment.started" || event.type === "assignment.completed" || event.type === "assignment.failed" || event.type === "assignment.blocked") {
    const assignmentId = String(payload.assignmentId);
    const existing = state.assignments.get(assignmentId);
    if (existing) {
      existing.status = assignmentStatus(event.type);
      state.assignments.set(assignmentId, existing);
    }
  }

  if (event.type === "qa.failed") {
    state.phase = "implementation";
    state.status = "running";
  }

  if (event.type === "run.completed") {
    state.phase = "completed";
    state.status = "completed";
    if (state.task) state.task.status = "completed";
    if (state.taskRun) state.taskRun.status = "completed";
  }

  if (event.type === "run.failed") {
    state.phase = "failed";
    state.status = "failed";
  }

  if (event.type === "run.blocked") {
    state.status = "blocked";
    if (state.task) state.task.status = "blocked";
    if (state.taskRun) state.taskRun.status = "blocked";
  }

  if (event.type === "run.interrupted") {
    state.phase = "interrupted";
    state.status = "interrupted";
  }
}

function assignmentStatus(type: AutoAgentEvent["type"]): EntityStatus {
  if (type === "assignment.started") return "running";
  if (type === "assignment.completed") return "completed";
  if (type === "assignment.failed") return "failed";
  return "blocked";
}

function visibleRecentEvents(events: AutoAgentEvent[]): AutoAgentEvent[] {
  let lastBlockedIndex = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].type === "run.blocked") {
      lastBlockedIndex = index;
      break;
    }
  }
  const visible = lastBlockedIndex < 0
    ? events
    : events.filter((event, index) => !(index < lastBlockedIndex && event.type === "run.completed"));
  return visible.slice(-100);
}

function lastEventIndex(events: AutoAgentEvent[], type: AutoAgentEvent["type"]): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].type === type) return index;
  }
  return -1;
}
