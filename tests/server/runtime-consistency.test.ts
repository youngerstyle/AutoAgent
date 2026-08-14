import { describe, expect, it } from "vitest";
import { projectRuntimeConsistency } from "../../src/server/runtime/runtime-consistency.js";

describe("runtime consistency projection", () => {
  it("reports cross-ledger lag without changing an authoritative status", () => {
    const projection = projectRuntimeConsistency({
      plan: {
        planId: "plan-a", version: 4, status: "blocked",
        graph: { ticketIds: ["ticket-a"], dependencyEdges: [], failureResolutionEdges: [], requiredTerminalTicketIds: [] },
      } as never,
      mission: {
        missionId: "mission-a", version: 7,
        record: { missionId: "mission-a", planId: "plan-a", status: "linked" },
        links: [{
          dispatchId: "dispatch-a", missionId: "mission-a", planId: "plan-a", ticketId: "ticket-a",
          ticketVersion: 2, status: "blocked", agentId: "dev", agentPrincipalId: "principal-dev",
          agentThreadId: "thread-a", agentGoalId: "goal-a", authority: { kind: "blocked_owner", ownershipId: "owner-a", fencingToken: 1 },
        }],
      } as never,
      tickets: [{ ticketId: "ticket-a", planId: "plan-a", version: 3, status: "running", attempts: [] } as never],
      goals: [{ agentId: "dev", goal: { spec: { id: "goal-a" }, version: 5, status: "active" } as never }],
    });

    expect(projection.state).toBe("reconciling");
    expect(projection.issues.map((issue) => issue.code)).toContain("blocked_link_waiting_for_ticket");
    expect(projection.asOf).toMatchObject({ planVersion: 4, missionVersion: 7, ticketVersions: { "ticket-a": 3 }, goalVersions: { dev: 5 } });
  });

  it("is consistent when Ticket, Mission link and Goal agree", () => {
    const projection = projectRuntimeConsistency({
      plan: { planId: "plan-a", version: 2, status: "active", graph: { ticketIds: ["ticket-a"] } } as never,
      mission: {
        missionId: "mission-a", version: 3, record: { planId: "plan-a", status: "linked" },
        links: [{ ticketId: "ticket-a", ticketVersion: 2, status: "running", agentId: "dev", agentGoalId: "goal-a" }],
      } as never,
      tickets: [{ ticketId: "ticket-a", version: 2, status: "running" } as never],
      goals: [{ agentId: "dev", goal: { spec: { id: "goal-a" }, version: 1 } as never }],
    });

    expect(projection).toMatchObject({ state: "consistent", issues: [] });
  });

  it("does not require a live Goal projection for settled historical links", () => {
    const projection = projectRuntimeConsistency({
      plan: { planId: "plan-a", version: 5, status: "completed", graph: { ticketIds: ["ticket-a"] } } as never,
      mission: {
        missionId: "mission-a", version: 8, record: { planId: "plan-a", status: "completed" },
        links: [{ ticketId: "ticket-a", ticketVersion: 4, status: "settled", agentId: "dev", agentGoalId: "goal-a" }],
      } as never,
      tickets: [{ ticketId: "ticket-a", version: 4, status: "completed" } as never],
      goals: [],
    });

    expect(projection).toMatchObject({ state: "consistent", issues: [] });
  });
});
