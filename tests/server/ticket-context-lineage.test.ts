import { describe, expect, it } from "vitest";
import { orderedAncestorTicketIds } from "../../src/server/mission-process/ticket-context-lineage.js";
import type { PlanGraphSnapshot, TicketId } from "../../src/shared/contracts/ticket-engine.js";

const id = (value: string) => value as TicketId;

describe("Ticket context lineage", () => {
  it("preserves every ancestor in a multi-step handoff chain", () => {
    const graph: PlanGraphSnapshot = {
      schemaVersion: 3,
      ticketIds: [id("scope"), id("architecture"), id("implementation"), id("verification")],
      dependencyEdges: [
        { fromTicketId: id("scope"), toTicketId: id("architecture") },
        { fromTicketId: id("architecture"), toTicketId: id("implementation") },
        { fromTicketId: id("implementation"), toTicketId: id("verification") },
      ],
    };

    expect(orderedAncestorTicketIds(graph, id("verification"))).toEqual([
      id("scope"),
      id("architecture"),
      id("implementation"),
    ]);
  });

  it("deduplicates shared ancestors and orders parallel branches deterministically", () => {
    const graph: PlanGraphSnapshot = {
      schemaVersion: 3,
      ticketIds: [id("brief"), id("design"), id("research"), id("build"), id("review")],
      dependencyEdges: [
        { fromTicketId: id("brief"), toTicketId: id("design") },
        { fromTicketId: id("brief"), toTicketId: id("research") },
        { fromTicketId: id("design"), toTicketId: id("build") },
        { fromTicketId: id("research"), toTicketId: id("build") },
        { fromTicketId: id("build"), toTicketId: id("review") },
      ],
    };

    expect(orderedAncestorTicketIds(graph, id("review"))).toEqual([
      id("brief"),
      id("design"),
      id("research"),
      id("build"),
    ]);
  });

  it("does not include unrelated branches or the current Ticket", () => {
    const graph: PlanGraphSnapshot = {
      schemaVersion: 3,
      ticketIds: [id("root"), id("left"), id("right"), id("left-review")],
      dependencyEdges: [
        { fromTicketId: id("root"), toTicketId: id("left") },
        { fromTicketId: id("root"), toTicketId: id("right") },
        { fromTicketId: id("left"), toTicketId: id("left-review") },
      ],
    };

    expect(orderedAncestorTicketIds(graph, id("left-review"))).toEqual([
      id("root"),
      id("left"),
    ]);
  });
});
