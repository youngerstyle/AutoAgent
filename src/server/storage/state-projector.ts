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
  const lastHumanFollowupIndex = lastEventIndex(events, "human.followup");
  const firstBlocking = firstBlockingAssignment(events, lastHumanFollowupIndex);
  let lastBlockedIndex = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].type === "run.blocked") {
      lastBlockedIndex = index;
      break;
    }
  }
  if (firstBlocking) {
    const visible = events.filter((event, index) => index <= firstBlocking.index || event.type === "assignment.blocked" || event.type === "run.blocked");
    return normalizeBlockedEventReasons(visible, firstBlocking).slice(-100);
  }
  const visible = lastBlockedIndex < 0
    ? events
    : events.filter((event, index) => !(index < lastBlockedIndex && event.type === "run.completed"));
  return normalizeBlockedEventReasons(visible).slice(-100);
}

function lastEventIndex(events: AutoAgentEvent[], type: AutoAgentEvent["type"]): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].type === type) return index;
  }
  return -1;
}

function normalizeBlockedEventReasons(events: AutoAgentEvent[], blocking?: BlockingAssignment): AutoAgentEvent[] {
  if (blocking) {
    return events.map((event) => {
      if (event.type !== "run.blocked" && event.type !== "assignment.blocked") return event;
      const summary = event.type === "run.blocked"
        ? `任务受阻：${blocking.phaseLabel}没有通过`
        : `${blocking.phaseLabel}受阻`;
      return {
        ...event,
        summary,
        payload: {
          ...(event.payload as Record<string, unknown>),
          reason: `${blocking.phaseLabel}没有通过；后面的阶段运行是旧流程 bug 产生的无效后续，不代表团队已经交付。${blocking.reason ? `原因：${blocking.reason}` : ""}`
        }
      };
    });
  }
  return events;
}

interface BlockingAssignment {
  index: number;
  phaseLabel: string;
  reason?: string;
}

function firstBlockingAssignment(events: AutoAgentEvent[], afterIndex = -1): BlockingAssignment | undefined {
  for (let index = Math.max(0, afterIndex + 1); index < events.length; index += 1) {
    const event = events[index];
    if (event.type !== "assignment.completed") continue;
    const payload = event.payload as Record<string, unknown>;
    const result = payload.result as Record<string, unknown> | undefined;
    if (!result || typeof result !== "object") continue;
    if (!isBlockingResult(result)) continue;
    return {
      index,
      phaseLabel: phaseLabelFromAssignmentEvent(event),
      reason: stringValue(result.reason)
    };
  }
  return undefined;
}

function isBlockingResult(result: Record<string, unknown>): boolean {
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

function phaseLabelFromAssignmentEvent(event: AutoAgentEvent): string {
  const payload = event.payload as Record<string, unknown>;
  const assignment = payload.assignment as { type?: string } | undefined;
  const type = assignment?.type;
  if (type === "boss_intake") return "需求接收";
  if (type === "pm_plan") return "计划拆解";
  if (type === "architect_plan") return "架构设计";
  if (type === "implementation") return "开发执行";
  if (type === "qa") return "质量检查";
  if (type === "boss_acceptance") return "老板验收";
  if (event.summary.includes("需求接收")) return "需求接收";
  if (event.summary.includes("计划拆解")) return "计划拆解";
  if (event.summary.includes("架构设计")) return "架构设计";
  if (event.summary.includes("开发执行")) return "开发执行";
  if (event.summary.includes("质量检查")) return "质量检查";
  if (event.summary.includes("老板验收")) return "老板验收";
  return "任务";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function lower(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}
