import { createHash } from "node:crypto";
import type {
  PlanChangeSet,
  PlanIntent,
  PlanTicketRef,
  PlannedTicketNode,
  TicketDeliveryIncrement,
  TicketId,
} from "../../shared/contracts/ticket-engine.js";

export interface PlanCompilerSnapshot {
  planId: string;
  sourceTicketId: TicketId;
  missionCriterionIds: string[];
  requiredTerminalCapabilities: string[];
  teamMembers: Array<{
    principalId: string;
    capabilities: string[];
    enabledTools: Array<"listFiles" | "readFile" | "readImage" | "writeFile" | "editFile" | "shell" | "startService" | "pollProcess" | "browser">;
  }>;
  tickets: Array<{
    ticketId: TicketId;
    status?: "pending" | "ready" | "running" | "blocked" | "completed" | "failed" | "returned" | "cancelled";
    deliveryIncrement?: TicketDeliveryIncrement;
    assurance?: { missionCriterionIds: string[] };
  }>;
  dependencyEdges: Array<{ fromTicketId: TicketId; toTicketId: TicketId }>;
  requiredTerminalTicketIds?: TicketId[];
  failureResolutionEdges?: Array<{ failedTicketId: TicketId; resolutionTicketId: TicketId }>;
}

export class PlanIntentError extends Error {}

const MAX_TODOS_PER_EXECUTION_BATCH = 4;

/** Compile Mission work intent into the graph shape accepted by Ticket Engine. */
export function compilePlanIntent(intent: PlanIntent, snapshot: PlanCompilerSnapshot): PlanChangeSet {
  requireText(intent.rationale, "intent.rationale");
  if (!Array.isArray(intent.todos) || intent.todos.length === 0) {
    throw new PlanIntentError("intent.todos must contain at least one delivery todo");
  }
  if (!intent.todos.some((todo) => todo.kind === "implementation")) {
    throw new PlanIntentError("intent.todos must contain at least one implementation todo");
  }

  const implementationMember = memberForCapabilities(snapshot, ["delivery:implement"]);
  const assuranceMember = memberForCapabilities(snapshot, ["delivery:verify"]);
  const terminalCapabilities = snapshot.requiredTerminalCapabilities.length
    ? snapshot.requiredTerminalCapabilities
    : ["delivery:accept"];
  const acceptanceMember = memberForCapabilities(snapshot, terminalCapabilities);
  const architectureMember = intent.todos.some((todo) => todo.kind === "architecture")
    ? memberForCapabilities(snapshot, ["architecture:design"])
    : undefined;

  const existingIncrements = uniqueIncrements(snapshot.tickets);
  const nextSequence = Math.max(0, ...existingIncrements.map((item) => item.sequence)) + 1;
  const additions: PlannedTicketNode[] = [];
  const dependencyAdditions: PlanChangeSet["dependencyAdditions"] = [];
  const increment: TicketDeliveryIncrement = {
    incrementId: deterministicId("increment", snapshot.planId, snapshot.sourceTicketId, "delivery"),
    sequence: nextSequence,
    title: `Verified delivery ${nextSequence}`,
    objective: intent.rationale.trim(),
  };
  for (const [index, todo] of intent.todos.entries()) {
    validateTodo(todo, index);
  }
  const batches = batchConsecutiveTodos(intent.todos);
  const todoRefs = batches.map((batch) => `todo-${String(batch.startIndex + 1).padStart(2, "0")}`);
  let lastImplementationBatchIndex = -1;
  for (const [index, batch] of batches.entries()) {
    if (batch.kind === "implementation") lastImplementationBatchIndex = index;
  }

  for (const [index, batch] of batches.entries()) {
    const member = batch.kind === "architecture" ? architectureMember! : implementationMember;
    const materialized = materializeTodoBatch(batch);
    additions.push({
      clientRef: todoRefs[index]!,
      title: materialized.title,
      objective: materialized.objective,
      successCriteria: materialized.successCriteria,
      assignment: assignmentFor(member, batch.kind === "architecture" ? ["architecture:design"] : ["delivery:implement"]),
      outputContract: { schemaRef: "delivery-v1" },
      deliveryIncrement: increment,
      ...(index === lastImplementationBatchIndex && snapshot.missionCriterionIds.length
        ? { missionContribution: { missionCriterionIds: [...snapshot.missionCriterionIds] } }
        : {}),
    });
  }

  additions.push({
    clientRef: "assurance",
    title: "Independent acceptance verification",
    objective: "Independently verify the complete delivery against every Mission criterion and verification anchor",
    successCriteria: ["Every assigned Mission criterion is verified from current observable evidence"],
    assignment: assignmentFor(assuranceMember, ["delivery:verify"]),
    outputContract: { schemaRef: "mission-assurance-v1" },
    deliveryIncrement: increment,
    assurance: { missionCriterionIds: [...snapshot.missionCriterionIds] },
  });
  additions.push({
    clientRef: "acceptance",
    title: "Final Mission acceptance",
    objective: "Decide final acceptance from the authoritative baseline and independent assurance",
    successCriteria: ["The final decision is traceable to authoritative Mission assurance"],
    assignment: assignmentFor(acceptanceMember, terminalCapabilities),
    outputContract: { schemaRef: "mission-settlement-v1" },
    deliveryIncrement: increment,
    permissions: { settleMission: true },
  });

  const gates: PlanTicketRef[] = [
    { ticketId: snapshot.sourceTicketId },
    ...exitsOfLatestIncrement(snapshot, existingIncrements),
  ];
  const firstRef = todoRefs[0]!;
  for (const gate of gates) dependencyAdditions.push({ from: gate, to: { clientRef: firstRef } });
  for (let index = 1; index < todoRefs.length; index += 1) {
    dependencyAdditions.push({ from: { clientRef: todoRefs[index - 1]! }, to: { clientRef: todoRefs[index]! } });
  }
  dependencyAdditions.push({ from: { clientRef: todoRefs.at(-1)! }, to: { clientRef: "assurance" } });
  dependencyAdditions.push({ from: { clientRef: "assurance" }, to: { clientRef: "acceptance" } });

  const failureResolutions = compileHistoricalFailureResolutions(snapshot, additions);

  return {
    additions,
    dependencyAdditions: dedupeEdges(dependencyAdditions),
    failureResolutions,
    cancelTicketIds: [],
    requiredTerminalRefs: [{ clientRef: "acceptance" }],
  };
}

function assignmentFor(
  member: PlanCompilerSnapshot["teamMembers"][number] | undefined,
  requiredCapabilities: string[],
) {
  return {
    requiredCapabilities,
    ...(member ? { principalId: member.principalId, requiredTools: [...member.enabledTools] } : {}),
  };
}

function memberForCapabilities(
  snapshot: PlanCompilerSnapshot,
  requiredCapabilities: string[],
): PlanCompilerSnapshot["teamMembers"][number] | undefined {
  return snapshot.teamMembers.find((candidate) =>
    requiredCapabilities.every((capability) => candidate.capabilities.includes(capability)));
}

function compileHistoricalFailureResolutions(
  snapshot: PlanCompilerSnapshot,
  additions: PlannedTicketNode[],
): NonNullable<PlanChangeSet["failureResolutions"]> {
  const required = requiredClosure(snapshot);
  const alreadyResolved = new Set((snapshot.failureResolutionEdges ?? [])
    .filter((edge) => required.has(String(edge.resolutionTicketId)))
    .map((edge) => String(edge.failedTicketId)));
  const unresolved = snapshot.tickets.filter((ticket) => (
    required.has(String(ticket.ticketId))
    && (ticket.status === "failed" || ticket.status === "returned" || ticket.status === "cancelled")
    && !alreadyResolved.has(String(ticket.ticketId))
  ));
  if (unresolved.length === 0) return [];

  const assuranceNodes = additions.filter((node) => node.assurance && node.outputContract.schemaRef === "mission-assurance-v1");
  return unresolved.map((failed) => {
    const failedCriteria = new Set(failed.assurance?.missionCriterionIds ?? []);
    const replacement = assuranceNodes.find((node) => {
      const covered = new Set(node.assurance?.missionCriterionIds ?? []);
      return [...failedCriteria].every((criterionId) => covered.has(criterionId));
    });
    if (!replacement) {
      throw new PlanIntentError(
        `historical unsuccessful Ticket ${failed.ticketId} requires a new mission-assurance-v1 work item covering its criteria`,
      );
    }
    return { failedTicketId: failed.ticketId, resolvedBy: { clientRef: replacement.clientRef } };
  });
}

function requiredClosure(snapshot: PlanCompilerSnapshot): Set<string> {
  const incoming = new Map<string, string[]>();
  for (const edge of snapshot.dependencyEdges) {
    const key = String(edge.toTicketId);
    incoming.set(key, [...(incoming.get(key) ?? []), String(edge.fromTicketId)]);
  }
  const required = new Set<string>();
  const queue = (snapshot.requiredTerminalTicketIds ?? []).map(String);
  while (queue.length > 0) {
    const current = queue.pop()!;
    if (required.has(current)) continue;
    required.add(current);
    queue.push(...(incoming.get(current) ?? []));
  }
  return required;
}

function exitsOfLatestIncrement(
  snapshot: PlanCompilerSnapshot,
  increments: TicketDeliveryIncrement[],
): Array<{ ticketId: TicketId }> {
  const latest = increments.at(-1);
  if (!latest) return [];
  const ids = new Set(snapshot.tickets
    .filter((ticket) => ticket.deliveryIncrement?.incrementId === latest.incrementId)
    .map((ticket) => String(ticket.ticketId)));
  const withOutgoingInIncrement = new Set(snapshot.dependencyEdges
    .filter((edge) => ids.has(String(edge.fromTicketId)) && ids.has(String(edge.toTicketId)))
    .map((edge) => String(edge.fromTicketId)));
  return snapshot.tickets
    .filter((ticket) => (
      ids.has(String(ticket.ticketId))
      && !withOutgoingInIncrement.has(String(ticket.ticketId))
      && ticket.status !== "failed"
      && ticket.status !== "returned"
      && ticket.status !== "cancelled"
      && !hasUnsuccessfulAncestor(ticket.ticketId, snapshot)
    ))
    .map((ticket) => ({ ticketId: ticket.ticketId }));
}

function hasUnsuccessfulAncestor(ticketId: TicketId, snapshot: PlanCompilerSnapshot): boolean {
  const byId = new Map(snapshot.tickets.map((ticket) => [String(ticket.ticketId), ticket]));
  const incoming = new Map<string, TicketId[]>();
  for (const edge of snapshot.dependencyEdges) {
    const key = String(edge.toTicketId);
    incoming.set(key, [...(incoming.get(key) ?? []), edge.fromTicketId]);
  }
  const visited = new Set<string>();
  const queue = [...(incoming.get(String(ticketId)) ?? [])];
  while (queue.length > 0) {
    const current = queue.pop()!;
    if (visited.has(String(current))) continue;
    visited.add(String(current));
    const status = byId.get(String(current))?.status;
    if (status === "failed" || status === "returned" || status === "cancelled") return true;
    queue.push(...(incoming.get(String(current)) ?? []));
  }
  return false;
}

function uniqueIncrements(tickets: PlanCompilerSnapshot["tickets"]): TicketDeliveryIncrement[] {
  const result = new Map<string, TicketDeliveryIncrement>();
  for (const ticket of tickets) {
    if (ticket.deliveryIncrement && !result.has(ticket.deliveryIncrement.incrementId)) {
      result.set(ticket.deliveryIncrement.incrementId, ticket.deliveryIncrement);
    }
  }
  return [...result.values()].sort((a, b) => a.sequence - b.sequence || a.incrementId.localeCompare(b.incrementId));
}

function validateTodo(todo: PlanIntent["todos"][number], index: number): void {
  const label = `intent.todos[${index}]`;
  if (todo.kind !== "architecture" && todo.kind !== "implementation") {
    throw new PlanIntentError(`${label}.kind must be architecture or implementation`);
  }
  requireText(todo.title, `${label}.title`);
  requireText(todo.objective, `${label}.objective`);
  if (!Array.isArray(todo.successCriteria) || todo.successCriteria.length === 0) {
    throw new PlanIntentError(`${label}.successCriteria must not be empty`);
  }
  todo.successCriteria.forEach((criterion) => requireText(criterion, `${label}.successCriteria`));
}

interface TodoBatch {
  kind: PlanIntent["todos"][number]["kind"];
  startIndex: number;
  todos: PlanIntent["todos"];
}

function batchConsecutiveTodos(todos: PlanIntent["todos"]): TodoBatch[] {
  const batches: TodoBatch[] = [];
  for (const [index, todo] of todos.entries()) {
    const current = batches.at(-1);
    if (current?.kind === todo.kind && current.todos.length < MAX_TODOS_PER_EXECUTION_BATCH) {
      current.todos.push(todo);
    } else {
      batches.push({ kind: todo.kind, startIndex: index, todos: [todo] });
    }
  }
  return batches;
}

function materializeTodoBatch(batch: TodoBatch): Pick<PlanIntent["todos"][number], "title" | "objective" | "successCriteria"> {
  if (batch.todos.length === 1) {
    const todo = batch.todos[0]!;
    return {
      title: todo.title.trim(),
      objective: todo.objective.trim(),
      successCriteria: todo.successCriteria.map((item) => item.trim()),
    };
  }

  const label = batch.kind === "architecture" ? "Architecture batch" : "Implementation batch";
  return {
    title: `${label}: ${batch.todos.map((todo) => todo.title.trim()).join(" · ")}`,
    objective: batch.todos
      .map((todo, index) => `${index + 1}. ${todo.title.trim()}: ${todo.objective.trim()}`)
      .join("\n"),
    successCriteria: batch.todos.flatMap((todo) => todo.successCriteria
      .map((criterion) => `[${todo.title.trim()}] ${criterion.trim()}`)),
  };
}

function dedupeEdges(edges: PlanChangeSet["dependencyAdditions"]): PlanChangeSet["dependencyAdditions"] {
  const seen = new Set<string>();
  return edges.filter((edge) => {
    const key = JSON.stringify(edge);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function deterministicId(prefix: string, ...parts: Array<string | TicketId>): string {
  return `${prefix}_${createHash("sha256").update(JSON.stringify(parts)).digest("base64url").slice(0, 20)}`;
}

function requireText(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new PlanIntentError(`${label} must be non-empty text`);
}
