import { describe, expect, it } from "vitest";
import type { PlanChangeSet, PlanId, TicketId, TicketStatus } from "../../src/shared/contracts/ticket-engine.js";
import { evaluatePlanOutcome, materializePlanGraph } from "../../src/server/tickets/plan-graph.js";

const planId = "99e14a79-351c-46ff-9378-19954abf4573" as PlanId;
const ids = [
  "037483db-32c7-4fba-9290-a21b39a11ce8",
  "608a910a-c799-4998-a679-ccf5ab5ff59a",
  "18dd56a2-c0d5-43a1-ae67-b1d39033a2c4",
].map((value) => value as TicketId);

function change(refs: string[]): PlanChangeSet {
  return {
    additions: refs.map((clientRef) => ({
      clientRef,
      title: "同名工作",
      objective: `完成 ${clientRef}`,
      successCriteria: [`${clientRef} 完成`],
      assignment: {},
      outputContract: { schemaRef: "result-v1" },
    })),
    dependencyAdditions: refs.slice(1).map((ref, index) => ({
      from: { clientRef: refs[index]! },
      to: { clientRef: ref },
    })),
    cancelTicketIds: [],
    requiredTerminalRefs: [{ clientRef: refs.at(-1)! }],
  };
}

describe("append-only Plan graph", () => {
  it("rejects a semantic Plan ID instead of treating it as durable identity", () => {
    expect(() => materializePlanGraph({
      planId: "planning-v1" as PlanId,
      change: change(["planning"]),
    })).toThrow(/Plan ID must be a UUID/);
  });

  it("creates different UUID Tickets even when titles and responsibilities are identical", () => {
    let index = 0;
    const graph = materializePlanGraph({ planId, change: change(["first", "second"]), ticketIdFactory: () => ids[index++]! });
    expect(graph.graph.ticketIds).toEqual(ids.slice(0, 2));
    expect(new Set(graph.graph.ticketIds).size).toBe(2);
    expect(graph.definitionsByTicketId[ids[0]].title).toBe("同名工作");
    expect(graph.definitionsByTicketId[ids[1]].title).toBe("同名工作");
  });

  it("preserves an explicit original-request context policy on the materialized Ticket", () => {
    const input = change(["intake"]);
    input.additions[0]!.contextPolicy = { includeOriginalRequest: true };

    const graph = materializePlanGraph({ planId, change: input, ticketIdFactory: () => ids[0] });

    expect(graph.definitionsByTicketId[ids[0]].contextPolicy).toEqual({ includeOriginalRequest: true });
  });

  it("preserves explicit Mission baseline and settlement authority without inferring roles", () => {
    const input = change(["intake", "acceptance"]);
    input.additions[0]!.contextPolicy = { establishesMissionBaseline: true };
    input.additions[1]!.permissions = { settleMission: true };
    let index = 0;

    const graph = materializePlanGraph({ planId, change: input, ticketIdFactory: () => ids[index++]! });

    expect(graph.definitionsByTicketId[ids[0]].contextPolicy).toEqual({ establishesMissionBaseline: true });
    expect(graph.definitionsByTicketId[ids[1]].permissions).toEqual({ settleMission: true });
  });

  it("preserves Mission assurance declarations as Ticket definition data", () => {
    const input = change(["verification"]);
    input.additions[0]!.missionContribution = { missionCriterionIds: ["criterion-a"] };
    input.additions[0]!.outputContract = { schemaRef: "mission-assurance-v1" };
    input.additions[0]!.assurance = { missionCriterionIds: ["criterion-a", "criterion-b"] };

    const graph = materializePlanGraph({ planId, change: input, ticketIdFactory: () => ids[0] });

    expect(graph.definitionsByTicketId[ids[0]].assurance).toEqual({
      missionCriterionIds: ["criterion-a", "criterion-b"],
    });
    expect(graph.definitionsByTicketId[ids[0]].missionContribution).toEqual({
      missionCriterionIds: ["criterion-a"],
    });
  });

  it("appends new Tickets without changing historical Ticket identity", () => {
    const first = materializePlanGraph({ planId, change: change(["planning"]), ticketIdFactory: () => ids[0] });
    const second = materializePlanGraph({
      planId,
      previous: first,
      change: {
        ...change(["implementation"]),
        dependencyAdditions: [{ from: { ticketId: ids[0] }, to: { clientRef: "implementation" } }],
      },
      ticketIdFactory: () => ids[1],
    });
    expect(second.graph.ticketIds).toEqual([ids[0], ids[1]]);
    expect(second.graph.dependencyEdges).toEqual([{ fromTicketId: ids[0], toTicketId: ids[1] }]);
  });

  it("rejects client references from an earlier change", () => {
    const first = materializePlanGraph({ planId, change: change(["planning"]), ticketIdFactory: () => ids[0] });
    expect(() => materializePlanGraph({
      planId,
      previous: first,
      change: {
        ...change(["qa"]),
        dependencyAdditions: [{ from: { clientRef: "planning" }, to: { clientRef: "qa" } }],
      },
      ticketIdFactory: () => ids[1],
    })).toThrow(/outside this change/);
  });

  it("rejects cancelling a terminal Ticket", () => {
    const first = materializePlanGraph({ planId, change: change(["planning"]), ticketIdFactory: () => ids[0] });
    const statuses = new Map<TicketId, TicketStatus>([[ids[0], "completed"]]);
    expect(() => materializePlanGraph({
      planId,
      previous: first,
      ticketStatuses: statuses,
      change: { ...change(["next"]), cancelTicketIds: [ids[0]] },
      ticketIdFactory: () => ids[1],
    })).toThrow(/terminal Ticket/);
  });

  it("rejects cancelling a Ticket that is currently executing", () => {
    const first = materializePlanGraph({ planId, change: change(["planning"]), ticketIdFactory: () => ids[0] });
    const statuses = new Map<TicketId, TicketStatus>([[ids[0], "running"]]);
    expect(() => materializePlanGraph({
      planId,
      previous: first,
      ticketStatuses: statuses,
      change: { ...change(["next"]), cancelTicketIds: [ids[0]] },
      ticketIdFactory: () => ids[1],
    })).toThrow(/executing Ticket/);
  });

  it("rejects adding a new prerequisite to an existing Ticket", () => {
    const first = materializePlanGraph({ planId, change: change(["planning"]), ticketIdFactory: () => ids[0] });
    expect(() => materializePlanGraph({
      planId,
      previous: first,
      change: {
        ...change(["late-prerequisite"]),
        dependencyAdditions: [{ from: { clientRef: "late-prerequisite" }, to: { ticketId: ids[0] } }],
      },
      ticketIdFactory: () => ids[1],
    })).toThrow(/target a newly added Ticket/);
  });

  it("computes completion from required Ticket IDs rather than the latest PM response", () => {
    const graph = materializePlanGraph({ planId, change: change(["planning", "dev"]), ticketIdFactory: () => ids.shift()! });
    const statuses = new Map<TicketId, TicketStatus>(graph.graph.ticketIds.map((id) => [id, "completed"]));
    expect(evaluatePlanOutcome({ graph: graph.graph, completionPolicy: graph.completionPolicy, ticketStatuses: statuses })).toBe("completed");
    statuses.set(graph.graph.ticketIds[1], "ready");
    expect(evaluatePlanOutcome({ graph: graph.graph, completionPolicy: graph.completionPolicy, ticketStatuses: statuses })).toBe("active");
  });

  it("does not complete while an older non-cancelled branch still has open Tickets", () => {
    const [amendment, oldAcceptance, newAcceptance] = [
      "97f10503-c6de-48e4-b56b-f84404b76965",
      "6f5e1767-402a-4af0-b48e-6c9e9a926451",
      "00c5ca54-0a60-4db2-9a48-34f1d4eb3725",
    ].map((value) => value as TicketId);
    const graph = {
      schemaVersion: 3 as const,
      ticketIds: [amendment!, oldAcceptance!, newAcceptance!],
      dependencyEdges: [
        { fromTicketId: amendment!, toTicketId: oldAcceptance! },
        { fromTicketId: amendment!, toTicketId: newAcceptance! },
      ],
    };
    const completionPolicy = {
      requiredTerminalTicketIds: [newAcceptance!],
      failurePolicy: "require_resolution" as const,
      blockedPolicy: "wait" as const,
    };
    const statuses = new Map<TicketId, TicketStatus>([
      [amendment!, "completed"],
      [oldAcceptance!, "running"],
      [newAcceptance!, "completed"],
    ]);

    expect(evaluatePlanOutcome({ graph, completionPolicy, ticketStatuses: statuses })).toBe("active");

    statuses.set(oldAcceptance!, "returned");
    expect(evaluatePlanOutcome({ graph, completionPolicy, ticketStatuses: statuses })).toBe("completed");
  });
});
