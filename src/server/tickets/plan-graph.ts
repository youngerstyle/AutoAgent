import { randomUUID } from "node:crypto";
import type {
  PlanChangeSet,
  PlanCompletionPolicy,
  PlanGraphSnapshot,
  PlanId,
  PlanTicketRef,
  TicketDefinition,
  TicketId,
  TicketStatus,
} from "../../shared/contracts/ticket-engine.js";

export class PlanGraphError extends Error {}

export interface MaterializedPlanGraph {
  readonly planId: PlanId;
  readonly graph: PlanGraphSnapshot;
  readonly completionPolicy: PlanCompletionPolicy;
  readonly definitionsByTicketId: Readonly<Record<string, TicketDefinition>>;
  readonly addedTicketIds: readonly TicketId[];
}

export interface GraphLimits {
  maxTickets: number;
  maxEdges: number;
}

export const DEFAULT_GRAPH_LIMITS: Readonly<GraphLimits> = Object.freeze({
  maxTickets: 2_000,
  maxEdges: 10_000,
});

export interface MaterializePlanGraphInput {
  planId: PlanId;
  change: PlanChangeSet;
  previous?: MaterializedPlanGraph;
  ticketStatuses?: TicketStatusLookup;
  ticketIdFactory?: () => TicketId;
  limits?: Partial<GraphLimits>;
}

export type TicketStatusLookup = ReadonlyMap<TicketId, TicketStatus> | Readonly<Record<string, TicketStatus>>;

export interface RequiredFailureInput {
  graph: PlanGraphSnapshot;
  completionPolicy: PlanCompletionPolicy;
  ticketStatuses: TicketStatusLookup;
}

export interface PlanOutcomeInput extends RequiredFailureInput {
  deferredOutcome?: "active" | "blocked" | "completed" | "failed";
}

export type EvaluatedPlanOutcome = "active" | "blocked" | "completed" | "failed";

export function materializePlanGraph(input: MaterializePlanGraphInput): MaterializedPlanGraph {
  if (!isUuid(String(input.planId))) throw new PlanGraphError(`Plan ID must be a UUID: ${input.planId}`);
  if (input.previous && input.previous.planId !== input.planId) {
    throw new PlanGraphError("Previous graph belongs to another Plan");
  }
  const limits = { ...DEFAULT_GRAPH_LIMITS, ...input.limits };
  const previousIds = input.previous?.graph.ticketIds ?? [];
  const previousIdSet = new Set(previousIds.map(String));
  const refs = new Map<string, TicketId>();
  const addedTicketIds: TicketId[] = [];
  const definitions = nullRecord<TicketDefinition>(input.previous?.definitionsByTicketId);
  const createId = input.ticketIdFactory ?? (() => randomUUID() as TicketId);

  for (const [index, addition] of input.change.additions.entries()) {
    const clientRef = requireIdentifier(addition.clientRef, `additions[${index}].clientRef`);
    if (refs.has(clientRef)) throw new PlanGraphError(`Duplicate clientRef ${clientRef}`);
    if (addition.parentTicketId && !previousIdSet.has(String(addition.parentTicketId))) {
      throw new PlanGraphError(`Unknown parent Ticket ${addition.parentTicketId}`);
    }
    validateDefinition(addition, `additions[${index}]`);
    const ticketId = createId();
    if (!isUuid(String(ticketId))) throw new PlanGraphError(`Ticket ID factory returned a non-UUID: ${ticketId}`);
    if (previousIdSet.has(String(ticketId)) || addedTicketIds.some((item) => item === ticketId)) {
      throw new PlanGraphError(`Duplicate Ticket ID ${ticketId}`);
    }
    refs.set(clientRef, ticketId);
    addedTicketIds.push(ticketId);
    definitions[String(ticketId)] = {
      ...(addition.parentTicketId ? { parentTicketId: addition.parentTicketId } : {}),
      title: addition.title.trim(),
      objective: addition.objective.trim(),
      successCriteria: addition.successCriteria.map((item) => item.trim()),
      assignment: cloneAssignment(addition.assignment),
      outputContract: { schemaRef: addition.outputContract.schemaRef.trim() },
      ...(addition.contextPolicy?.includeOriginalRequest === true
        ? { contextPolicy: { includeOriginalRequest: true } }
        : {}),
      ...(addition.permissions?.amendPlan === true ? { permissions: { amendPlan: true } } : {}),
    };
  }

  const ticketIds = [...previousIds, ...addedTicketIds];
  if (ticketIds.length > limits.maxTickets) throw new PlanGraphError(`Plan exceeds ${limits.maxTickets} Tickets`);
  const known = new Set(ticketIds.map(String));
  const dependencyEdges = [
    ...(input.previous?.graph.dependencyEdges ?? []),
    ...input.change.dependencyAdditions.map((edge, index) => {
      if (!("clientRef" in edge.to)) {
        throw new PlanGraphError(`dependencyAdditions[${index}] must target a newly added Ticket`);
      }
      return {
        fromTicketId: resolveRef(edge.from, refs, known, `dependencyAdditions[${index}].from`),
        toTicketId: resolveRef(edge.to, refs, known, `dependencyAdditions[${index}].to`),
      };
    }),
  ];
  if (dependencyEdges.length > limits.maxEdges) throw new PlanGraphError(`Plan exceeds ${limits.maxEdges} dependencies`);
  validateUniqueEdges(dependencyEdges);
  validateAcyclic(ticketIds, dependencyEdges);

  for (const ticketId of input.change.cancelTicketIds) {
    if (!known.has(String(ticketId))) throw new PlanGraphError(`Cannot cancel unknown Ticket ${ticketId}`);
    const status = statusOf(input.ticketStatuses, ticketId);
    if (status && isTerminal(status)) throw new PlanGraphError(`Cannot cancel terminal Ticket ${ticketId}`);
    if (status === "running" || status === "blocked") {
      throw new PlanGraphError(`Cannot cancel executing Ticket ${ticketId}`);
    }
  }

  const requiredTerminalTicketIds = input.change.requiredTerminalRefs.map((ref, index) => (
    resolveRef(ref, refs, known, `requiredTerminalRefs[${index}]`)
  ));
  if (requiredTerminalTicketIds.length === 0) {
    throw new PlanGraphError("Plan must define at least one required terminal Ticket");
  }

  return {
    planId: input.planId,
    graph: { schemaVersion: 3, ticketIds, dependencyEdges },
    completionPolicy: {
      requiredTerminalTicketIds: uniqueIds(requiredTerminalTicketIds),
      failurePolicy: "require_resolution",
      blockedPolicy: "wait",
    },
    definitionsByTicketId: definitions,
    addedTicketIds,
  };
}

export function computeRequiredClosure(
  graph: PlanGraphSnapshot,
  requiredTerminalTicketIds: readonly TicketId[],
): Set<TicketId> {
  const incoming = new Map<string, TicketId[]>();
  for (const edge of graph.dependencyEdges) {
    const list = incoming.get(String(edge.toTicketId)) ?? [];
    list.push(edge.fromTicketId);
    incoming.set(String(edge.toTicketId), list);
  }
  const closure = new Set<TicketId>();
  const queue = [...requiredTerminalTicketIds];
  while (queue.length > 0) {
    const current = queue.pop()!;
    if (closure.has(current)) continue;
    closure.add(current);
    queue.push(...(incoming.get(String(current)) ?? []));
  }
  return closure;
}

export function findUnresolvedRequiredFailures(input: RequiredFailureInput): TicketId[] {
  const required = computeRequiredClosure(input.graph, input.completionPolicy.requiredTerminalTicketIds);
  return [...required].filter((ticketId) => {
    const status = statusOf(input.ticketStatuses, ticketId);
    return status === "failed" || status === "returned" || status === "cancelled";
  });
}

export function evaluatePlanOutcome(input: PlanOutcomeInput): EvaluatedPlanOutcome {
  const required = computeRequiredClosure(input.graph, input.completionPolicy.requiredTerminalTicketIds);
  const statuses = [...required].map((ticketId) => statusOf(input.ticketStatuses, ticketId));
  const allTicketStatuses = input.graph.ticketIds.map((ticketId) => statusOf(input.ticketStatuses, ticketId));
  const hasOpenTicket = allTicketStatuses.some((status) => status === undefined || !isTerminal(status));
  if (statuses.length > 0 && statuses.every((status) => status === "completed") && !hasOpenTicket) return "completed";
  if (statuses.some((status) => status === "failed") && input.completionPolicy.failurePolicy === "fail_fast") {
    return "failed";
  }
  if (statuses.some((status) => status === "blocked" || status === "returned" || status === "failed")) {
    return "blocked";
  }
  return input.deferredOutcome ?? "active";
}

function resolveRef(
  ref: PlanTicketRef,
  localRefs: ReadonlyMap<string, TicketId>,
  knownTicketIds: ReadonlySet<string>,
  label: string,
): TicketId {
  if ("clientRef" in ref) {
    const resolved = localRefs.get(requireIdentifier(ref.clientRef, label));
    if (!resolved) throw new PlanGraphError(`${label} references a clientRef outside this change`);
    return resolved;
  }
  if (!knownTicketIds.has(String(ref.ticketId))) throw new PlanGraphError(`${label} references unknown Ticket ${ref.ticketId}`);
  return ref.ticketId;
}

function validateDefinition(value: Omit<TicketDefinition, "parentTicketId">, label: string): void {
  requireText(value.title, `${label}.title`);
  requireText(value.objective, `${label}.objective`);
  if (!Array.isArray(value.successCriteria) || value.successCriteria.length === 0) {
    throw new PlanGraphError(`${label}.successCriteria must not be empty`);
  }
  value.successCriteria.forEach((item, index) => requireText(item, `${label}.successCriteria[${index}]`));
  requireText(value.outputContract.schemaRef, `${label}.outputContract.schemaRef`);
  if (value.contextPolicy?.includeOriginalRequest !== undefined && typeof value.contextPolicy.includeOriginalRequest !== "boolean") {
    throw new PlanGraphError(`${label}.contextPolicy.includeOriginalRequest must be a boolean`);
  }
  if (value.permissions?.amendPlan !== undefined && typeof value.permissions.amendPlan !== "boolean") {
    throw new PlanGraphError(`${label}.permissions.amendPlan must be a boolean`);
  }
}

function validateUniqueEdges(edges: PlanGraphSnapshot["dependencyEdges"]): void {
  const seen = new Set<string>();
  for (const edge of edges) {
    if (edge.fromTicketId === edge.toTicketId) throw new PlanGraphError("A Ticket cannot depend on itself");
    const key = `${edge.fromTicketId}\u0000${edge.toTicketId}`;
    if (seen.has(key)) throw new PlanGraphError("Duplicate dependency edge");
    seen.add(key);
  }
}

function validateAcyclic(ticketIds: readonly TicketId[], edges: PlanGraphSnapshot["dependencyEdges"]): void {
  const indegree = new Map(ticketIds.map((ticketId) => [String(ticketId), 0]));
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    const from = String(edge.fromTicketId);
    const to = String(edge.toTicketId);
    indegree.set(to, (indegree.get(to) ?? 0) + 1);
    outgoing.set(from, [...(outgoing.get(from) ?? []), to]);
  }
  const queue = [...indegree].filter(([, count]) => count === 0).map(([id]) => id);
  let visited = 0;
  while (queue.length > 0) {
    const current = queue.shift()!;
    visited += 1;
    for (const next of outgoing.get(current) ?? []) {
      const count = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, count);
      if (count === 0) queue.push(next);
    }
  }
  if (visited !== ticketIds.length) throw new PlanGraphError("Plan dependency graph contains a cycle");
}

function statusOf(statuses: TicketStatusLookup | undefined, ticketId: TicketId): TicketStatus | undefined {
  if (!statuses) return undefined;
  if (statuses instanceof Map) return statuses.get(ticketId);
  return (statuses as Readonly<Record<string, TicketStatus>>)[String(ticketId)];
}

function isTerminal(status: TicketStatus): boolean {
  return status === "completed" || status === "returned" || status === "failed" || status === "cancelled";
}

function uniqueIds(values: readonly TicketId[]): TicketId[] {
  return [...new Map(values.map((value) => [String(value), value])).values()];
}

function nullRecord<T>(source?: Readonly<Record<string, T>>): Record<string, T> {
  return Object.assign(Object.create(null) as Record<string, T>, source ?? {});
}

function cloneAssignment(value: TicketDefinition["assignment"]): TicketDefinition["assignment"] {
  return {
    ...(value.principalId ? { principalId: value.principalId } : {}),
    ...(value.requiredCapabilities ? { requiredCapabilities: [...value.requiredCapabilities] } : {}),
  };
}

function requireIdentifier(value: string, label: string): string {
  const result = requireText(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(result)) throw new PlanGraphError(`${label} is invalid`);
  return result;
}

function requireText(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new PlanGraphError(`${label} is required`);
  return value.trim();
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
