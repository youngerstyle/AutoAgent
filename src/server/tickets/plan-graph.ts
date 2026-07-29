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
import { isKnownToolName } from "../../shared/tool-catalog.js";

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
      ...(addition.deliveryIncrement ? { deliveryIncrement: {
        incrementId: addition.deliveryIncrement.incrementId.trim(),
        sequence: addition.deliveryIncrement.sequence,
        title: addition.deliveryIncrement.title.trim(),
        objective: addition.deliveryIncrement.objective.trim(),
      } } : {}),
      ...(addition.missionContribution ? { missionContribution: {
        missionCriterionIds: addition.missionContribution.missionCriterionIds.map((item) => item.trim()),
      } } : {}),
      ...(addition.assurance ? { assurance: {
        missionCriterionIds: addition.assurance.missionCriterionIds.map((item) => item.trim()),
      } } : {}),
      ...(addition.contextPolicy?.includeOriginalRequest === true
        || addition.contextPolicy?.establishesMissionBaseline === true
        || addition.contextPolicy?.requiresMissionBaseline === true
        ? { contextPolicy: {
            ...(addition.contextPolicy.includeOriginalRequest === true ? { includeOriginalRequest: true } : {}),
            ...(addition.contextPolicy.establishesMissionBaseline === true ? { establishesMissionBaseline: true } : {}),
            ...(addition.contextPolicy.requiresMissionBaseline === true ? { requiresMissionBaseline: true } : {}),
          } }
        : {}),
      ...(addition.permissions?.amendPlan === true || addition.permissions?.settleMission === true
        ? { permissions: {
            ...(addition.permissions.amendPlan === true ? { amendPlan: true } : {}),
            ...(addition.permissions.settleMission === true ? { settleMission: true } : {}),
          } }
        : {}),
    };
  }

  const ticketIds = [...previousIds, ...addedTicketIds];
  if (ticketIds.length > limits.maxTickets) throw new PlanGraphError(`Plan exceeds ${limits.maxTickets} Tickets`);
  const known = new Set(ticketIds.map(String));
  const dependencyEdges = [
    ...(input.previous?.graph.dependencyEdges ?? []),
    ...input.change.dependencyAdditions.map((edge, index) => {
      if ("ticketId" in edge.to) {
        const targetStatus = statusOf(input.ticketStatuses, edge.to.ticketId);
        if (targetStatus !== "pending") {
          throw new PlanGraphError(
            `dependencyAdditions[${index}] can target an existing Ticket only while it is pending`,
          );
        }
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
  validateDeliveryIncrements(definitions, dependencyEdges);

  const failureResolutionEdges = [
    ...(input.previous?.graph.failureResolutionEdges ?? []),
    ...(input.change.failureResolutions ?? []).map((resolution, index) => {
      if (!previousIdSet.has(String(resolution.failedTicketId))) {
        throw new PlanGraphError(`failureResolutions[${index}] must reference an existing failed Ticket`);
      }
      const failedStatus = statusOf(input.ticketStatuses, resolution.failedTicketId);
      if (failedStatus !== "failed" && failedStatus !== "returned" && failedStatus !== "cancelled") {
        throw new PlanGraphError(`failureResolutions[${index}].failedTicketId must be terminal unsuccessful`);
      }
      const resolutionTicketId = resolveRef(
        resolution.resolvedBy,
        refs,
        known,
        `failureResolutions[${index}].resolvedBy`,
      );
      if (!addedTicketIds.includes(resolutionTicketId)) {
        throw new PlanGraphError(`failureResolutions[${index}].resolvedBy must reference a Ticket added by this change`);
      }
      validateAssuranceResolutionProgress({
        index,
        failedTicketId: resolution.failedTicketId,
        resolutionTicketId,
        addedTicketIds,
        definitions,
        dependencyEdges,
      });
      return { failedTicketId: resolution.failedTicketId, resolutionTicketId };
    }),
  ];
  validateUniqueFailureResolutions(failureResolutionEdges);

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
    graph: { schemaVersion: 3, ticketIds, dependencyEdges, failureResolutionEdges },
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
    return isUnsuccessful(status) && !hasDeclaredResolutionInClosure(input.graph, ticketId, required);
  });
}

export function evaluatePlanOutcome(input: PlanOutcomeInput): EvaluatedPlanOutcome {
  const required = computeRequiredClosure(input.graph, input.completionPolicy.requiredTerminalTicketIds);
  const statuses = [...required].map((ticketId) => effectiveStatus(input.graph, input.ticketStatuses, ticketId));
  const allTicketStatuses = input.graph.ticketIds.map((ticketId) => statusOf(input.ticketStatuses, ticketId));
  const hasOpenTicket = allTicketStatuses.some((status) => status === undefined || !isTerminal(status));
  if (statuses.length > 0 && statuses.every((status) => status === "completed") && !hasOpenTicket) return "completed";
  if (statuses.some((status) => isUnsuccessful(status))) {
    return input.completionPolicy.failurePolicy === "fail_fast" ? "failed" : "blocked";
  }
  if (statuses.some((status) => status === "blocked")) {
    return "blocked";
  }
  return input.deferredOutcome ?? "active";
}

export function isTicketDependencySatisfied(
  graph: PlanGraphSnapshot,
  ticketStatuses: TicketStatusLookup,
  ticketId: TicketId,
): boolean {
  return effectiveStatus(graph, ticketStatuses, ticketId) === "completed";
}

function effectiveStatus(
  graph: PlanGraphSnapshot,
  ticketStatuses: TicketStatusLookup,
  ticketId: TicketId,
  visiting = new Set<string>(),
): TicketStatus | undefined {
  const status = statusOf(ticketStatuses, ticketId);
  if (!isUnsuccessful(status)) return status;
  if (visiting.has(String(ticketId))) return status;
  const nextVisiting = new Set(visiting).add(String(ticketId));
  const resolutions = (graph.failureResolutionEdges ?? [])
    .filter((edge) => edge.failedTicketId === ticketId)
    .map((edge) => edge.resolutionTicketId);
  return resolutions.some((resolutionId) => (
    effectiveStatus(graph, ticketStatuses, resolutionId, nextVisiting) === "completed"
  )) ? "completed" : status;
}

function hasDeclaredResolutionInClosure(
  graph: PlanGraphSnapshot,
  failedTicketId: TicketId,
  requiredClosure: ReadonlySet<TicketId>,
): boolean {
  return (graph.failureResolutionEdges ?? []).some((edge) => (
    edge.failedTicketId === failedTicketId && requiredClosure.has(edge.resolutionTicketId)
  ));
}

function isUnsuccessful(status: TicketStatus | undefined): status is "failed" | "returned" | "cancelled" {
  return status === "failed" || status === "returned" || status === "cancelled";
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
  if (value.assignment.requiredTools !== undefined) {
    if (!Array.isArray(value.assignment.requiredTools)
      || value.assignment.requiredTools.some((tool) => !isKnownToolName(tool))) {
      throw new PlanGraphError(`${label}.assignment.requiredTools contains an unknown tool`);
    }
    if (new Set(value.assignment.requiredTools).size !== value.assignment.requiredTools.length) {
      throw new PlanGraphError(`${label}.assignment.requiredTools must be unique`);
    }
  }
  if (value.missionContribution !== undefined) {
    validateCriterionIds(value.missionContribution.missionCriterionIds, `${label}.missionContribution.missionCriterionIds`);
  }
  if (value.deliveryIncrement !== undefined) {
    requireIdentifier(value.deliveryIncrement.incrementId, `${label}.deliveryIncrement.incrementId`);
    if (!Number.isSafeInteger(value.deliveryIncrement.sequence) || value.deliveryIncrement.sequence <= 0) {
      throw new PlanGraphError(`${label}.deliveryIncrement.sequence must be a positive integer`);
    }
    requireText(value.deliveryIncrement.title, `${label}.deliveryIncrement.title`);
    requireText(value.deliveryIncrement.objective, `${label}.deliveryIncrement.objective`);
  }
  if (value.assurance !== undefined) {
    validateCriterionIds(value.assurance.missionCriterionIds, `${label}.assurance.missionCriterionIds`);
  }
  if (value.contextPolicy?.includeOriginalRequest !== undefined && typeof value.contextPolicy.includeOriginalRequest !== "boolean") {
    throw new PlanGraphError(`${label}.contextPolicy.includeOriginalRequest must be a boolean`);
  }
  if (value.contextPolicy?.establishesMissionBaseline !== undefined && typeof value.contextPolicy.establishesMissionBaseline !== "boolean") {
    throw new PlanGraphError(`${label}.contextPolicy.establishesMissionBaseline must be a boolean`);
  }
  if (value.contextPolicy?.requiresMissionBaseline !== undefined && typeof value.contextPolicy.requiresMissionBaseline !== "boolean") {
    throw new PlanGraphError(`${label}.contextPolicy.requiresMissionBaseline must be a boolean`);
  }
  if (value.permissions?.amendPlan !== undefined && typeof value.permissions.amendPlan !== "boolean") {
    throw new PlanGraphError(`${label}.permissions.amendPlan must be a boolean`);
  }
  if (value.permissions?.settleMission !== undefined && typeof value.permissions.settleMission !== "boolean") {
    throw new PlanGraphError(`${label}.permissions.settleMission must be a boolean`);
  }
}

function validateCriterionIds(value: string[], label: string): void {
  if (!Array.isArray(value) || value.length === 0) {
    throw new PlanGraphError(`${label} must be a non-empty array`);
  }
  for (const [index, criterionId] of value.entries()) requireText(criterionId, `${label}[${index}]`);
  if (new Set(value).size !== value.length) throw new PlanGraphError(`${label} must not contain duplicates`);
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

function validateUniqueFailureResolutions(
  edges: NonNullable<PlanGraphSnapshot["failureResolutionEdges"]>,
): void {
  const seen = new Set<string>();
  for (const edge of edges) {
    if (edge.failedTicketId === edge.resolutionTicketId) {
      throw new PlanGraphError("A Ticket cannot resolve itself");
    }
    const key = `${edge.failedTicketId}\u0000${edge.resolutionTicketId}`;
    if (seen.has(key)) throw new PlanGraphError("Duplicate failure resolution edge");
    seen.add(key);
  }
}

function validateAssuranceResolutionProgress(input: {
  index: number;
  failedTicketId: TicketId;
  resolutionTicketId: TicketId;
  addedTicketIds: readonly TicketId[];
  definitions: Readonly<Record<string, TicketDefinition>>;
  dependencyEdges: PlanGraphSnapshot["dependencyEdges"];
}): void {
  const failed = input.definitions[String(input.failedTicketId)];
  const resolution = input.definitions[String(input.resolutionTicketId)];
  if (!failed?.assurance || !resolution?.assurance) return;

  const coveredCriteria = new Set(resolution.assurance.missionCriterionIds);
  const hasNewUpstreamExecution = input.addedTicketIds.some((ticketId) => {
    if (ticketId === input.resolutionTicketId) return false;
    const definition = input.definitions[String(ticketId)];
    if (!definition?.missionContribution || definition.assurance) return false;
    if (!definition.missionContribution.missionCriterionIds.some((criterionId) => coveredCriteria.has(criterionId))) {
      return false;
    }
    return hasDependencyPath(ticketId, input.resolutionTicketId, input.dependencyEdges);
  });
  if (!hasNewUpstreamExecution) {
    throw new PlanGraphError(
      `failureResolutions[${input.index}] cannot replace an unsuccessful assurance Ticket `
      + "without new upstream execution work for the same Mission criterion",
    );
  }
}

function hasDependencyPath(
  fromTicketId: TicketId,
  toTicketId: TicketId,
  edges: PlanGraphSnapshot["dependencyEdges"],
): boolean {
  const outgoing = new Map<string, TicketId[]>();
  for (const edge of edges) {
    const key = String(edge.fromTicketId);
    outgoing.set(key, [...(outgoing.get(key) ?? []), edge.toTicketId]);
  }
  const visited = new Set<string>();
  const queue = [fromTicketId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === toTicketId) return true;
    if (visited.has(String(current))) continue;
    visited.add(String(current));
    queue.push(...(outgoing.get(String(current)) ?? []));
  }
  return false;
}

function validateDeliveryIncrements(
  definitions: Readonly<Record<string, TicketDefinition>>,
  edges: PlanGraphSnapshot["dependencyEdges"],
): void {
  const canonical = new Map<string, NonNullable<TicketDefinition["deliveryIncrement"]>>();
  for (const definition of Object.values(definitions)) {
    const increment = definition.deliveryIncrement;
    if (!increment) continue;
    const previous = canonical.get(increment.incrementId);
    if (previous && (
      previous.sequence !== increment.sequence
      || previous.title !== increment.title
      || previous.objective !== increment.objective
    )) {
      throw new PlanGraphError(`Delivery increment ${increment.incrementId} has conflicting definitions`);
    }
    canonical.set(increment.incrementId, increment);
  }
  for (const edge of edges) {
    const from = definitions[String(edge.fromTicketId)]?.deliveryIncrement;
    const to = definitions[String(edge.toTicketId)]?.deliveryIncrement;
    if (from && to && from.sequence > to.sequence) {
      throw new PlanGraphError(`Delivery increment dependency cannot move backward from ${from.incrementId} to ${to.incrementId}`);
    }
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
    ...(value.requiredTools ? { requiredTools: [...value.requiredTools] } : {}),
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
