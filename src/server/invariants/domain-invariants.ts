import type { AgentStoreAggregate } from "../agent-engine/agent-store.js";
import type { MissionAggregate } from "../mission-process/mission-store.js";
import type { TicketAggregate } from "../tickets/ticket-store.js";
import { InvariantSet, type InvariantIssue } from "./invariant-set.js";

export const ticketAggregateInvariants = new InvariantSet<TicketAggregate>("Ticket aggregate", [
  (aggregate) => {
    const ownershipByTicket = new Map(aggregate.blockedOwnerships.map((owner) => [String(owner.ticketId), owner]));
    const issues: InvariantIssue[] = [];
    for (const ticket of aggregate.tickets) {
      const owner = ownershipByTicket.get(String(ticket.ticketId));
      if (ticket.status === "blocked") {
        if (!owner || ticket.activeAuthority?.kind !== "blocked_owner"
          || ticket.activeAuthority.ownershipId !== owner.ownershipId
          || ticket.activeAuthority.fencingToken !== owner.fencingToken) {
          issues.push({
            code: "blocked_owner_mismatch",
            path: `tickets.${ticket.ticketId}`,
            message: "blocked Ticket must retain its matching blocked ownership and fencing authority",
          });
        }
      } else if (ticket.status === "running" && owner) {
        if (ticket.activeAuthority?.kind !== "blocked_owner"
          || ticket.activeAuthority.ownershipId !== owner.ownershipId
          || ticket.activeAuthority.fencingToken !== owner.fencingToken) {
          issues.push({
            code: "resumed_owner_mismatch",
            path: `tickets.${ticket.ticketId}`,
            message: "a Ticket resumed after human input must preserve the blocked owner's fencing authority",
          });
        }
      } else if (owner) {
        issues.push({
          code: "orphan_blocked_owner",
          path: `blockedOwnerships.${owner.ownershipId}`,
          message: `ownership points to non-blocked Ticket ${ticket.ticketId}`,
        });
      }
    }
    return issues;
  },
  (aggregate) => {
    const issues: InvariantIssue[] = [];
    for (const [ticketId, definition] of Object.entries(aggregate.definitionsByTicketId)) {
      if (!definition.correction) continue;
      const target = aggregate.definitionsByTicketId[String(definition.correction.targetTicketId)];
      if (!target || target.assurance || target.permissions?.settleMission) {
        issues.push({
          code: "invalid_correction_target",
          path: `definitionsByTicketId.${ticketId}.correction.targetTicketId`,
          message: "correction must target an existing delivery Ticket, never assurance or settlement work",
        });
      }
    }
    return issues;
  },
]);

export const missionAggregateInvariants = new InvariantSet<MissionAggregate>("Mission aggregate", [
  (aggregate) => {
    const active = new Set(["dispatching", "starting", "running", "blocked", "resolving", "paused", "recovering"]);
    const seen = new Set<string>();
    const members = new Map(aggregate.record.teamBinding.members.map((member) => [member.agentId, member]));
    const issues: InvariantIssue[] = [];
    for (const link of aggregate.links) {
      if (active.has(link.status)) {
        const ticketId = String(link.ticketId);
        if (seen.has(ticketId)) {
          issues.push({ code: "duplicate_active_ticket_link", path: `links.${link.dispatchId}`, message: `Ticket ${ticketId} has more than one active Mission link` });
        }
        seen.add(ticketId);
      }
      const member = members.get(link.agentId);
      if (!member || member.principalId !== link.agentPrincipalId) {
        issues.push({ code: "link_team_binding_mismatch", path: `links.${link.dispatchId}`, message: "Mission link owner must match the immutable TeamBinding snapshot" });
      }
    }
    return issues;
  },
  (aggregate) => {
    if (aggregate.record.status !== "completed") return;
    const issues: InvariantIssue[] = [];
    const baselineIds = new Set(aggregate.record.baseline.criteria.map((criterion) => criterion.criterionId));
    const settledIds = aggregate.record.settlement.criterionResults.map((criterion) => criterion.criterionId);
    if (aggregate.record.settlement.baselineVersion !== aggregate.record.baseline.version
      || settledIds.length !== baselineIds.size
      || settledIds.some((criterionId) => !baselineIds.has(criterionId))) {
      issues.push({ code: "incomplete_mission_settlement", path: "record.settlement", message: "completed Mission settlement must exactly cover its accepted baseline version" });
    }
    if (aggregate.links.some((link) => !new Set(["settled", "cancelled"]).has(link.status))) {
      issues.push({ code: "completed_mission_has_active_links", path: "links", message: "completed Mission cannot retain active execution links" });
    }
    return issues;
  },
]);

export const agentAggregateInvariants = new InvariantSet<AgentStoreAggregate>("Agent aggregate", [
  (aggregate) => aggregate.goals.flatMap((goal): InvariantIssue[] => {
    if (goal.activeProposalId && !new Set(["resolving", "paused"]).has(goal.status)) {
      return [{ code: "proposal_goal_status_mismatch", path: `goals.${goal.spec.id}`, message: "active proposal is valid only while its Goal is resolving or paused" }];
    }
    if (goal.status === "resolving" && !goal.activeProposalId) {
      return [{ code: "resolving_goal_without_proposal", path: `goals.${goal.spec.id}`, message: "resolving Goal must name the proposal being settled" }];
    }
    return [];
  }),
]);
