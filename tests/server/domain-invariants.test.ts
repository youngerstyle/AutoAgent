import { describe, expect, it } from "vitest";
import {
  agentAggregateInvariants,
  missionAggregateInvariants,
  ticketAggregateInvariants,
} from "../../src/server/invariants/domain-invariants.js";

describe("domain invariant companions", () => {
  it("rejects verify-the-verifier correction chains", () => {
    const issues = ticketAggregateInvariants.inspect({
      tickets: [], blockedOwnerships: [],
      definitionsByTicketId: {
        delivery: { title: "delivery" },
        qa: { title: "qa", assurance: { missionCriterionIds: ["criterion-a"] } },
        correction: { title: "fix qa", correction: { targetTicketId: "qa", sourceTicketId: "qa" } },
      },
    } as never);

    expect(issues).toContainEqual(expect.objectContaining({ code: "invalid_correction_target" }));
  });

  it("preserves blocked ownership fencing while a Ticket resumes after input", () => {
    const aggregate = {
      tickets: [{
        ticketId: "ticket-a", status: "running",
        activeAuthority: { kind: "blocked_owner", ownershipId: "owner-a", fencingToken: 7 },
      }],
      blockedOwnerships: [{ ticketId: "ticket-a", ownershipId: "owner-a", fencingToken: 7 }],
      definitionsByTicketId: {},
    } as never;

    expect(ticketAggregateInvariants.inspect(aggregate)).toEqual([]);
  });

  it("rejects a resolving Goal without its active proposal", () => {
    const issues = agentAggregateInvariants.inspect({ goals: [{ spec: { id: "goal-a" }, status: "resolving" }] } as never);
    expect(issues).toContainEqual(expect.objectContaining({ code: "resolving_goal_without_proposal" }));
  });

  it("rejects duplicate active Mission links for one Ticket", () => {
    const issues = missionAggregateInvariants.inspect({
      record: {
        status: "linked",
        teamBinding: { members: [{ agentId: "dev", principalId: "principal-dev" }] },
      },
      links: [
        { dispatchId: "a", ticketId: "ticket-a", status: "running", agentId: "dev", agentPrincipalId: "principal-dev" },
        { dispatchId: "b", ticketId: "ticket-a", status: "blocked", agentId: "dev", agentPrincipalId: "principal-dev" },
      ],
    } as never);

    expect(issues).toContainEqual(expect.objectContaining({ code: "duplicate_active_ticket_link" }));
  });
});
