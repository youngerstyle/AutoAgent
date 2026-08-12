import { describe, expect, it } from "vitest";
import type { PlanIntent, TicketId } from "../../src/shared/contracts/ticket-engine.js";
import { compilePlanIntent, PlanIntentError } from "../../src/server/tickets/plan-intent-compiler.js";

const sourceTicketId = "ticket-planner" as TicketId;

describe("compilePlanIntent", () => {
  it("derives increment boundaries, dependencies, and terminal refs", () => {
    const change = compilePlanIntent(intent(), {
      planId: "plan-a",
      sourceTicketId,
      tickets: [],
      dependencyEdges: [],
    });

    expect(change.additions.map((node) => node.clientRef)).toEqual(["research", "build", "qa", "accept"]);
    expect(change.additions.map((node) => node.deliveryIncrement?.sequence)).toEqual([1, 2, 2, 2]);
    expect(change.dependencyAdditions).toEqual(expect.arrayContaining([
      { from: { ticketId: sourceTicketId }, to: { clientRef: "research" } },
      { from: { clientRef: "research" }, to: { clientRef: "build" } },
      { from: { clientRef: "build" }, to: { clientRef: "qa" } },
      { from: { clientRef: "qa" }, to: { clientRef: "accept" } },
    ]));
    expect(change.requiredTerminalRefs).toEqual([{ clientRef: "accept" }]);
  });

  it("gates a new increment on every exit of the latest existing increment", () => {
    const existingIncrement = { incrementId: "existing", sequence: 3, title: "Existing", objective: "Ship baseline" };
    const nextIncrement = intent().increments[0]!;
    nextIncrement.workItems[0]!.permissions = { settleMission: true };
    const change = compilePlanIntent({
      rationale: "Extend delivery",
      increments: [nextIncrement],
    }, {
      planId: "plan-a",
      sourceTicketId,
      tickets: [
        { ticketId: "a" as TicketId, deliveryIncrement: existingIncrement },
        { ticketId: "b" as TicketId, deliveryIncrement: existingIncrement },
        { ticketId: "c" as TicketId, deliveryIncrement: existingIncrement },
      ],
      dependencyEdges: [{ fromTicketId: "a" as TicketId, toTicketId: "b" as TicketId }],
    });

    expect(change.additions[0]?.deliveryIncrement?.sequence).toBe(4);
    expect(change.dependencyAdditions).toEqual(expect.arrayContaining([
      { from: { ticketId: sourceTicketId }, to: { clientRef: "research" } },
      { from: { ticketId: "b" }, to: { clientRef: "research" } },
      { from: { ticketId: "c" }, to: { clientRef: "research" } },
    ]));
  });

  it("rejects cross-increment hand-written dependencies", () => {
    const value = intent();
    value.increments[1]!.workItems[0]!.dependsOn = ["research"];
    expect(() => compilePlanIntent(value, {
      planId: "plan-a",
      sourceTicketId,
      tickets: [],
      dependencyEdges: [],
    })).toThrow(PlanIntentError);
  });

  it("rejects cyclic semantic work before it reaches Ticket Engine", () => {
    const value = intent();
    value.increments[1]!.workItems[0]!.dependsOn = ["accept"];
    expect(() => compilePlanIntent(value, {
      planId: "plan-a", sourceTicketId, tickets: [], dependencyEdges: [],
    })).toThrow("dependency cycle");
  });

  it("derives historical failure resolution from replacement assurance intent", () => {
    const value = intent();
    value.increments[1]!.workItems[1]!.assurance = { missionCriterionIds: ["criterion-a"] };
    const failedTicketId = "failed-qa" as TicketId;
    const change = compilePlanIntent(value, {
      planId: "plan-a",
      sourceTicketId,
      tickets: [{
        ticketId: failedTicketId,
        status: "returned",
        assurance: { missionCriterionIds: ["criterion-a"] },
      }],
      dependencyEdges: [],
      requiredTerminalTicketIds: [failedTicketId],
    });

    expect(change.failureResolutions).toEqual([{
      failedTicketId,
      resolvedBy: { clientRef: "qa" },
    }]);
  });

  it("does not redeclare a historical failure already resolved in the required closure", () => {
    const value = intent();
    const failedTicketId = "failed-qa" as TicketId;
    const priorResolutionId = "prior-resolution" as TicketId;
    const change = compilePlanIntent(value, {
      planId: "plan-a",
      sourceTicketId,
      tickets: [
        { ticketId: failedTicketId, status: "returned" },
        { ticketId: priorResolutionId, status: "completed" },
      ],
      dependencyEdges: [{ fromTicketId: failedTicketId, toTicketId: priorResolutionId }],
      requiredTerminalTicketIds: [priorResolutionId],
      failureResolutionEdges: [{ failedTicketId, resolutionTicketId: priorResolutionId }],
    });

    expect(change.failureResolutions).toEqual([]);
  });

  it("does not gate replacement work on a terminal unsuccessful exit", () => {
    const existingIncrement = { incrementId: "failed-increment", sequence: 3, title: "Failed QA", objective: "Verify" };
    const nextIncrement = intent().increments[0]!;
    nextIncrement.workItems[0]!.permissions = { settleMission: true };
    const failedTicketId = "failed-qa" as TicketId;
    const change = compilePlanIntent({ rationale: "Replace failed work", increments: [nextIncrement] }, {
      planId: "plan-a",
      sourceTicketId,
      tickets: [{ ticketId: failedTicketId, status: "returned", deliveryIncrement: existingIncrement }],
      dependencyEdges: [],
    });

    expect(change.dependencyAdditions).toContainEqual({
      from: { ticketId: sourceTicketId },
      to: { clientRef: "research" },
    });
    expect(change.dependencyAdditions).not.toContainEqual({
      from: { ticketId: failedTicketId },
      to: { clientRef: "research" },
    });
  });

  it("does not gate replacement work on an exit blocked by an unsuccessful ancestor", () => {
    const existingIncrement = { incrementId: "failed-increment", sequence: 3, title: "Failed QA", objective: "Verify" };
    const nextIncrement = intent().increments[0]!;
    nextIncrement.workItems[0]!.permissions = { settleMission: true };
    const failedTicketId = "failed-qa" as TicketId;
    const blockedExitId = "blocked-acceptance" as TicketId;
    const change = compilePlanIntent({ rationale: "Replace failed work", increments: [nextIncrement] }, {
      planId: "plan-a",
      sourceTicketId,
      tickets: [
        { ticketId: failedTicketId, status: "returned", deliveryIncrement: existingIncrement },
        { ticketId: blockedExitId, status: "pending", deliveryIncrement: existingIncrement },
      ],
      dependencyEdges: [{ fromTicketId: failedTicketId, toTicketId: blockedExitId }],
    });

    expect(change.dependencyAdditions).not.toContainEqual({
      from: { ticketId: blockedExitId },
      to: { clientRef: "research" },
    });
  });
});

function intent(): PlanIntent {
  return {
    rationale: "Acquire an authoritative baseline before implementation",
    increments: [
      {
        intentRef: "reference",
        title: "Reference baseline",
        objective: "Acquire auditable facts",
        workItems: [{
          intentRef: "research",
          title: "Research",
          objective: "Acquire baseline",
          successCriteria: ["Evidence is auditable"],
          assignment: { requiredCapabilities: ["plan:plan"] },
          outputContract: { schemaRef: "result-v1" },
        }],
      },
      {
        intentRef: "delivery",
        title: "Verified delivery",
        objective: "Implement and verify",
        workItems: [
          {
            intentRef: "build",
            title: "Build",
            objective: "Implement against baseline",
            successCriteria: ["Implementation matches baseline"],
            assignment: { requiredCapabilities: ["code:write"] },
            outputContract: { schemaRef: "result-v1" },
          },
          {
            intentRef: "qa",
            title: "Verify",
            objective: "Verify delivery",
            successCriteria: ["Verification is reproducible"],
            assignment: { requiredCapabilities: ["test:verify"] },
            outputContract: { schemaRef: "mission-assurance-v1" },
            dependsOn: ["build"],
          },
          {
            intentRef: "accept",
            title: "Accept",
            objective: "Settle mission",
            successCriteria: ["Mission criteria are satisfied"],
            assignment: { requiredCapabilities: ["mission:accept"] },
            outputContract: { schemaRef: "result-v1" },
            dependsOn: ["qa"],
            permissions: { settleMission: true },
          },
        ],
      },
    ],
  };
}
