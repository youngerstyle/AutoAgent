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
    expect(change.additions.map((node) => node.assignment.requiredTools)).toEqual([
      ["listFiles", "readFile", "writeFile", "editFile"],
      ["listFiles", "readFile", "writeFile", "editFile", "shell", "startService", "pollProcess", "browser"],
      ["listFiles", "readFile", "shell", "startService", "pollProcess", "browser"],
      ["listFiles", "readFile"],
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

  it("batches consecutive same-owner implementation todos into one durable execution boundary", () => {
    const value = intent();
    value.todos.push({
      kind: "implementation",
      title: "Add runtime integration",
      objective: "Wire the delivery into the runtime",
      successCriteria: ["Runtime uses the delivery"],
    }, {
      kind: "implementation",
      title: "Add atomic admission",
      objective: "Guard authoritative command paths",
      successCriteria: ["Admission is atomic"],
    }, {
      kind: "implementation",
      title: "Document operations",
      objective: "Record the recovery procedure",
      successCriteria: ["Recovery steps are actionable"],
    });

    const change = compilePlanIntent(value, snapshot());
    const implementation = change.additions.find((node) => node.clientRef === "todo-02");

    expect(change.additions.map((node) => node.clientRef)).toEqual([
      "todo-01", "todo-02", "assurance", "acceptance",
    ]);
    expect(implementation).toMatchObject({
      title: "Implementation batch: Build the delivery · Add runtime integration · Add atomic admission · Document operations",
      objective: expect.stringContaining("1. Build the delivery: Implement the user-visible product"),
      successCriteria: [
        "[Build the delivery] The product runs and can be independently verified",
        "[Add runtime integration] Runtime uses the delivery",
        "[Add atomic admission] Admission is atomic",
        "[Document operations] Recovery steps are actionable",
      ],
      assignment: { principalId: "dev", requiredCapabilities: ["delivery:implement"] },
      missionContribution: { missionCriterionIds: ["criterion-a", "criterion-b"] },
    });
    expect(change.dependencyAdditions).toEqual([
      { from: { ticketId: sourceTicketId }, to: { clientRef: "todo-01" } },
      { from: { clientRef: "todo-01" }, to: { clientRef: "todo-02" } },
      { from: { clientRef: "todo-02" }, to: { clientRef: "assurance" } },
      { from: { clientRef: "assurance" }, to: { clientRef: "acceptance" } },
    ]);
    expect(2 + change.additions.length).toBe(6);
  });

  it("keeps role transitions as separate ordered execution boundaries", () => {
    const value = intent();
    value.todos.push({
      kind: "architecture",
      title: "Review the integration boundary",
      objective: "Review architecture after implementation",
      successCriteria: ["Boundary review is recorded"],
    }, {
      kind: "implementation",
      title: "Apply the boundary review",
      objective: "Implement the reviewed changes",
      successCriteria: ["Reviewed changes are implemented"],
    });

    const change = compilePlanIntent(value, snapshot());

    expect(change.additions.slice(0, -2).map((node) => ({ ref: node.clientRef, capability: node.assignment.requiredCapabilities?.[0] }))).toEqual([
      { ref: "todo-01", capability: "architecture:design" },
      { ref: "todo-02", capability: "delivery:implement" },
      { ref: "todo-03", capability: "architecture:design" },
      { ref: "todo-04", capability: "delivery:implement" },
    ]);
  });

  it("compiles independent workstreams as parallel branches with an assurance join", () => {
    const value: PlanIntent = {
      rationale: "Build independent frontend and backend slices",
      todos: [{
        kind: "architecture", title: "Define boundary", objective: "Define shared contracts", successCriteria: ["Contract is actionable"],
      }, {
        kind: "implementation", workstream: "frontend", title: "Build UI", objective: "Implement the UI", successCriteria: ["UI works"],
      }, {
        kind: "implementation", workstream: "backend", title: "Build API", objective: "Implement the API", successCriteria: ["API works"],
      }, {
        kind: "implementation", workstream: "frontend", title: "Wire UI", objective: "Wire the UI contract", successCriteria: ["UI is wired"],
      }],
    };

    const base = snapshot();
    const firstDeveloper = base.teamMembers.find((member) => member.principalId === "dev")!;
    base.teamMembers.push({ ...firstDeveloper, principalId: "dev-2" });
    const change = compilePlanIntent(value, base);

    expect(change.additions.slice(0, -2).map((node) => node.clientRef)).toEqual(["todo-01", "todo-02", "todo-03", "todo-04"]);
    expect(change.dependencyAdditions).toEqual([
      { from: { ticketId: sourceTicketId }, to: { clientRef: "todo-01" } },
      { from: { clientRef: "todo-01" }, to: { clientRef: "todo-02" } },
      { from: { clientRef: "todo-01" }, to: { clientRef: "todo-03" } },
      { from: { clientRef: "todo-02" }, to: { clientRef: "todo-04" } },
      { from: { clientRef: "todo-04" }, to: { clientRef: "assurance" } },
      { from: { clientRef: "todo-03" }, to: { clientRef: "assurance" } },
      { from: { clientRef: "assurance" }, to: { clientRef: "acceptance" } },
    ]);
    expect(change.additions.filter((node) => node.missionContribution).map((node) => node.clientRef))
      .toEqual(["todo-02", "todo-03", "todo-04"]);
    expect(change.additions.slice(1, 4).map((node) => node.assignment.principalId))
      .toEqual(["dev", "dev-2", "dev"]);
    expect(change.additions.slice(0, 4).map((node) => node.workstream))
      .toEqual([undefined, "frontend", "backend", "frontend"]);
  });

  it("treats an unlabelled todo as a global barrier between workstream waves", () => {
    const value: PlanIntent = {
      rationale: "Build, integrate, then extend",
      todos: [{ kind: "implementation", workstream: "a", title: "A", objective: "A", successCriteria: ["A"] },
        { kind: "implementation", workstream: "b", title: "B", objective: "B", successCriteria: ["B"] },
        { kind: "implementation", title: "Integrate", objective: "Integrate", successCriteria: ["Integrated"] },
        { kind: "implementation", workstream: "c", title: "C", objective: "C", successCriteria: ["C"] }],
    };
    const change = compilePlanIntent(value, snapshot());
    expect(change.dependencyAdditions).toEqual(expect.arrayContaining([
      { from: { clientRef: "todo-01" }, to: { clientRef: "todo-03" } },
      { from: { clientRef: "todo-02" }, to: { clientRef: "todo-03" } },
      { from: { clientRef: "todo-03" }, to: { clientRef: "todo-04" } },
    ]));
  });

  it("rejects workstreams on architecture todos", () => {
    const value = intent();
    value.todos[0]!.workstream = "architecture";
    expect(() => compilePlanIntent(value, snapshot())).toThrow("workstream is only valid for implementation work");
  });

  it("bounds one execution batch to four semantic todos", () => {
    const value = intent();
    value.todos = Array.from({ length: 5 }, (_, index) => ({
      kind: "implementation" as const,
      title: `Implementation ${index + 1}`,
      objective: `Complete implementation ${index + 1}`,
      successCriteria: [`Implementation ${index + 1} works`],
    }));

    const change = compilePlanIntent(value, snapshot());

    expect(change.additions.map((node) => node.clientRef)).toEqual([
      "todo-01", "todo-05", "assurance", "acceptance",
    ]);
    expect(change.additions[0]?.successCriteria).toHaveLength(4);
    expect(change.additions[1]?.successCriteria).toHaveLength(1);
    expect(change.additions[1]?.missionContribution).toEqual({ missionCriterionIds: ["criterion-a", "criterion-b"] });
  });

  it("rejects a list with no implementation work", () => {
    const value = intent();
    value.todos = value.todos.filter((todo) => todo.kind === "architecture");
    expect(() => compilePlanIntent(value, snapshot())).toThrow("at least one implementation todo");
  });

  it("leaves a capability vacancy for Mission Control staffing instead of rejecting the plan", () => {
    const base = snapshot();
    base.teamMembers = base.teamMembers.filter((member) => !member.capabilities.includes("delivery:verify"));
    const change = compilePlanIntent(intent(), base);
    expect(change.additions.find((node) => node.clientRef === "assurance")?.assignment).toEqual({
      requiredCapabilities: ["delivery:verify"],
    });
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
