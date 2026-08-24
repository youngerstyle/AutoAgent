import { compilePlanIntent } from "../dist/server/server/mission-process/plan-intent-compiler.js";

const snapshot = {
  planId: "throughput-verification",
  sourceTicketId: "planning-ticket",
  missionCriterionIds: ["criterion-a", "criterion-b"],
  requiredTerminalCapabilities: ["delivery:accept"],
  teamMembers: [
    { principalId: "architect", capabilities: ["architecture:design"], enabledTools: ["listFiles", "readFile", "writeFile", "editFile"] },
    { principalId: "dev", capabilities: ["delivery:implement"], enabledTools: ["listFiles", "readFile", "writeFile", "editFile", "shell"] },
    { principalId: "qa", capabilities: ["delivery:verify"], enabledTools: ["listFiles", "readFile", "shell"] },
    { principalId: "boss", capabilities: ["delivery:accept"], enabledTools: ["listFiles", "readFile"] },
  ],
  tickets: [],
  dependencyEdges: [],
};

const challengeIntent = {
  rationale: "Deliver a production-ready autonomous workflow",
  todos: [
    todo("architecture", "Define architecture"),
    todo("implementation", "Implement persistence"),
    todo("implementation", "Integrate Plan create and amend"),
    todo("implementation", "Connect runtime and UI"),
    todo("implementation", "Document operations"),
  ],
};
const challenge = compilePlanIntent(challengeIntent, snapshot);
assertRefs(challenge, ["todo-01", "todo-02", "assurance", "acceptance"]);
assert(challenge.dependencyAdditions.length === 4, "Challenge replay must remain one safe ordered chain");
const implementationBatch = challenge.additions.find((node) => node.clientRef === "todo-02");
assert(implementationBatch?.successCriteria.length === 4, "Every implementation Todo criterion must survive batching");
assert(implementationBatch?.missionContribution?.missionCriterionIds.length === 2, "Mission coverage must remain on the implementation boundary");

const bounded = compilePlanIntent({
  rationale: "Verify bounded batching",
  todos: Array.from({ length: 5 }, (_, index) => todo("implementation", `Implementation ${index + 1}`)),
}, snapshot);
assertRefs(bounded, ["todo-01", "todo-05", "assurance", "acceptance"]);
assert(bounded.additions[0]?.successCriteria.length === 4, "First batch must stop at four Todos");
assert(bounded.additions[1]?.successCriteria.length === 1, "Fifth Todo must start a new execution boundary");

process.stdout.write(`${JSON.stringify({
  ok: true,
  challenge02: {
    previousTickets: 9,
    projectedTickets: 2 + challenge.additions.length,
    executionBoundariesReduced: 9 - (2 + challenge.additions.length),
    implementationTodosPreserved: implementationBatch.successCriteria.length,
  },
  boundedBatch: {
    semanticTodos: 5,
    executionBatches: bounded.additions.filter((node) => node.clientRef.startsWith("todo-")).length,
    maxTodosPerBatch: 4,
  },
}, null, 2)}\n`);

function todo(kind, title) {
  return {
    kind,
    title,
    objective: `Complete ${title}`,
    successCriteria: [`${title} is independently verifiable`],
  };
}

function assertRefs(change, expected) {
  const actual = change.additions.map((node) => node.clientRef);
  assert(JSON.stringify(actual) === JSON.stringify(expected), `Unexpected refs: ${JSON.stringify(actual)}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
