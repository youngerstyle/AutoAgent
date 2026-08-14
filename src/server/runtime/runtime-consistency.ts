import type { AgentGoal } from "../../shared/contracts/agent-engine.js";
import type { MissionAggregate } from "../mission-process/mission-store.js";
import type { PlanSnapshot, TicketSnapshot } from "../../shared/contracts/ticket-engine.js";

export interface RuntimeConsistencyIssue {
  code: string;
  message: string;
  ticketId?: string;
  agentId?: string;
}

export interface RuntimeConsistencyProjection {
  state: "consistent" | "reconciling";
  asOf: {
    planVersion: number;
    missionVersion: number;
    ticketVersions: Record<string, number>;
    goalVersions: Record<string, number>;
  };
  issues: RuntimeConsistencyIssue[];
}

export function projectRuntimeConsistency(input: {
  plan: PlanSnapshot;
  mission: MissionAggregate;
  tickets: readonly (TicketSnapshot | undefined)[];
  goals: readonly { agentId: string; goal?: AgentGoal }[];
}): RuntimeConsistencyProjection {
  const tickets = new Map(input.tickets.flatMap((ticket) => ticket ? [[String(ticket.ticketId), ticket] as const] : []));
  const goals = new Map(input.goals.flatMap(({ agentId, goal }) => goal ? [[goal.spec.id, { agentId, goal }] as const] : []));
  const issues: RuntimeConsistencyIssue[] = [];

  if (String(input.mission.record.planId) !== String(input.plan.planId)) {
    issues.push({ code: "mission_plan_identity_mismatch", message: "Mission and Ticket Engine refer to different Plans" });
  }
  for (const ticketId of input.plan.graph.ticketIds.map(String)) {
    if (!tickets.has(ticketId)) issues.push({ code: "plan_ticket_not_visible", ticketId, message: "Plan graph Ticket is not visible at this projection watermark" });
  }

  for (const link of input.mission.links) {
    const ticketId = String(link.ticketId);
    const ticket = tickets.get(ticketId);
    if (!ticket) {
      issues.push({ code: "link_ticket_not_visible", ticketId, agentId: link.agentId, message: "Mission link Ticket is not visible at this projection watermark" });
      continue;
    }
    if (link.ticketVersion > ticket.version) {
      issues.push({ code: "link_ahead_of_ticket", ticketId, agentId: link.agentId, message: "Mission link revision is ahead of the authoritative Ticket" });
    }
    if (link.status === "blocked" && ticket.status !== "blocked") {
      issues.push({ code: "blocked_link_waiting_for_ticket", ticketId, agentId: link.agentId, message: "blocked Mission link has not yet converged with its Ticket" });
    }
    if (link.status === "running" && ticket.status !== "running") {
      issues.push({ code: "running_link_waiting_for_ticket", ticketId, agentId: link.agentId, message: "running Mission link has not yet converged with its Ticket" });
    }
    if (link.status === "settled" && !new Set(["completed", "returned", "failed", "cancelled"]).has(ticket.status)) {
      issues.push({ code: "settled_link_waiting_for_ticket", ticketId, agentId: link.agentId, message: "settled Mission link points to a non-terminal Ticket" });
    }
    const requiresLiveGoal = new Set(["running", "blocked", "resolving", "paused", "recovering"]).has(link.status);
    if (requiresLiveGoal && "agentGoalId" in link && link.agentGoalId && !goals.has(link.agentGoalId)) {
      issues.push({ code: "link_goal_not_visible", ticketId, agentId: link.agentId, message: "Mission link Goal is not visible at this projection watermark" });
    }
  }

  if (input.plan.status === "completed" && input.mission.record.status !== "completed") {
    issues.push({ code: "plan_waiting_for_mission_settlement", message: "Plan completed before Mission settlement became visible" });
  }
  if (input.mission.record.status === "completed" && input.plan.status !== "completed") {
    issues.push({ code: "mission_ahead_of_plan", message: "Mission completed before the authoritative Plan reached completed" });
  }

  return {
    state: issues.length ? "reconciling" : "consistent",
    asOf: {
      planVersion: input.plan.version,
      missionVersion: input.mission.version,
      ticketVersions: Object.fromEntries([...tickets].map(([ticketId, ticket]) => [ticketId, ticket.version])),
      goalVersions: Object.fromEntries(input.goals.flatMap(({ agentId, goal }) => goal ? [[agentId, goal.version]] : [])),
    },
    issues,
  };
}
