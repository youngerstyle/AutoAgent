import { describe, expect, it } from "vitest";
import type { PlanIntent, TicketId } from "../../src/shared/contracts/ticket-engine.js";
import {
  compilePlanIntent,
  PlanIntentError,
  type PlanCompilerSnapshot,
} from "../../src/server/mission-process/plan-intent-compiler.js";

const sourceTicketId = "ticket-planner" as TicketId;

describe("compilePlanIntent", () => {
  it("compiles a flat TodoList into a verified delivery lifecycle", () => {
    const change = compilePlanIntent(intent(), snapshot());

    expect(change.additions.map((node) => node.clientRef)).toEqual([
      "todo-01", "todo-02", "assurance", "acceptance",
    ]);
    expect(change.additions.map((node) => node.assignment.requiredCapabilities)).toEqual([
      ["architecture:design"],
      ["delivery:implement"],
      ["delivery:verify"],
      ["delivery:accept"],
    ]);
    expect(change.additions.find((node) => node.clientRef === "todo-02")?.missionContribution)
      .toEqual({ missionCriterionIds: ["criterion-a", "criterion-b"] });
    expect(change.additions.find((node) => node.clientRef === "assurance")?.assurance)
      .toEqual({ missionCriterionIds: ["criterion-a", "criterion-b"] });
    expect(change.additions.find((node) => node.clientRef === "acceptance")).toMatchObject({
      outputContract: { schemaRef: "mission-settlement-v1" },
      permissions: { settleMission: true },
    });
    expect(change.dependencyAdditions).toEqual([
      { from: { ticketId: sourceTicketId }, to: { clientRef: "todo-01" } },
      { from: { clientRef: "todo-01" }, to: { clientRef: "todo-02" } },
      { from: { clientRef: "todo-02" }, to: { clientRef: "assurance" } },
      { from: { clientRef: "assurance" }, to: { clientRef: "acceptance" } },
    ]);
    expect(change.requiredTerminalRefs).toEqual([{ clientRef: "acceptance" }]);
  });

  it("does not require an architect when the planner only asks for implementation", () => {
    const value = intent();
    value.todos = value.todos.filter((todo) => todo.kind === "implementation");
    const base = snapshot();
    base.teamMembers = base.teamMembers.filter((member) => !member.capabilities.includes("architecture:design"));

    expect(() => compilePlanIntent(value, base)).not.toThrow();
  });

  it("rejects a list with no implementation work", () => {
    const value = intent();
    value.todos = value.todos.filter((todo) => todo.kind === "architecture");
    expect(() => compilePlanIntent(value, snapshot())).toThrow("at least one implementation todo");
  });

  it("rejects a lifecycle the team cannot actually staff", () => {
    const base = snapshot();
    base.teamMembers = base.teamMembers.filter((member) => !member.capabilities.includes("delivery:verify"));
    expect(() => compilePlanIntent(intent(), base)).toThrow("independent verification");
  });

  it("gates a new delivery on every healthy exit of the latest existing increment", () => {
    const existingIncrement = { incrementId: "existing", sequence: 3, title: "Existing", objective: "Ship baseline" };
    const base = snapshot({
      tickets: [
        { ticketId: "a" as TicketId, deliveryIncrement: existingIncrement },
        { ticketId: "b" as TicketId, deliveryIncrement: existingIncrement },
        { ticketId: "c" as TicketId, deliveryIncrement: existingIncrement },
      ],
      dependencyEdges: [{ fromTicketId: "a" as TicketId, toTicketId: "b" as TicketId }],
    });
    const change = compilePlanIntent(intent(), base);

    expect(change.additions[0]?.deliveryIncrement?.sequence).toBe(4);
    expect(change.dependencyAdditions).toEqual(expect.arrayContaining([
      { from: { ticketId: sourceTicketId }, to: { clientRef: "todo-01" } },
      { from: { ticketId: "b" }, to: { clientRef: "todo-01" } },
      { from: { ticketId: "c" }, to: { clientRef: "todo-01" } },
    ]));
  });

  it("derives historical failure resolution from the generated assurance", () => {
    const failedTicketId = "failed-qa" as TicketId;
    const change = compilePlanIntent(intent(), snapshot({
      tickets: [{
        ticketId: failedTicketId,
        status: "returned",
        assurance: { missionCriterionIds: ["criterion-a"] },
      }],
      requiredTerminalTicketIds: [failedTicketId],
    }));

    expect(change.failureResolutions).toEqual([{
      failedTicketId,
      resolvedBy: { clientRef: "assurance" },
    }]);
  });

  it("does not gate replacement work on an unsuccessful latest exit", () => {
    const existingIncrement = { incrementId: "failed", sequence: 3, title: "Failed QA", objective: "Verify" };
    const failedTicketId = "failed-qa" as TicketId;
    const change = compilePlanIntent(intent(), snapshot({
      tickets: [{ ticketId: failedTicketId, status: "returned", deliveryIncrement: existingIncrement }],
    }));

    expect(change.dependencyAdditions).not.toContainEqual({
      from: { ticketId: failedTicketId },
      to: { clientRef: "todo-01" },
    });
  });
});

function intent(): PlanIntent {
  return {
    rationale: "Design, implement, verify, and accept the delivery",
    todos: [{
      kind: "architecture",
      title: "Define the technical approach",
      objective: "Record the smallest safe implementation boundary",
      successCriteria: ["The implementation boundary is actionable"],
    }, {
      kind: "implementation",
      title: "Build the delivery",
      objective: "Implement the user-visible product",
      successCriteria: ["The product runs and can be independently verified"],
    }],
  };
}

function snapshot(overrides: Partial<PlanCompilerSnapshot> = {}): PlanCompilerSnapshot {
  return {
    planId: "plan-a",
    sourceTicketId,
    missionCriterionIds: ["criterion-a", "criterion-b"],
    requiredTerminalCapabilities: ["delivery:accept"],
    teamMembers: [
      { principalId: "architect", capabilities: ["architecture:design"], enabledTools: ["listFiles", "readFile", "writeFile", "editFile"] },
      { principalId: "dev", capabilities: ["delivery:implement"], enabledTools: ["listFiles", "readFile", "writeFile", "editFile", "shell", "startService", "pollProcess", "browser"] },
      { principalId: "qa", capabilities: ["delivery:verify"], enabledTools: ["listFiles", "readFile", "shell", "startService", "pollProcess", "browser"] },
      { principalId: "boss", capabilities: ["delivery:accept"], enabledTools: ["listFiles", "readFile"] },
    ],
    tickets: [],
    dependencyEdges: [],
    ...overrides,
  };
}
