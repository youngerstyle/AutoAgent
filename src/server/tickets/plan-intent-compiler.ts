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

/** Compile semantic work into the only graph shape accepted by Ticket Engine. */
export function compilePlanIntent(intent: PlanIntent, snapshot: PlanCompilerSnapshot): PlanChangeSet {
  requireText(intent.rationale, "intent.rationale");
  if (!Array.isArray(intent.increments) || intent.increments.length === 0) {
    throw new PlanIntentError("intent.increments must contain at least one delivery increment");
  }

  const incrementRefs = new Set<string>();
  const workRefs = new Set<string>();
  const existingIncrements = uniqueIncrements(snapshot.tickets);
  let nextSequence = Math.max(0, ...existingIncrements.map((item) => item.sequence)) + 1;
  const additions: PlannedTicketNode[] = [];
  const dependencyAdditions: PlanChangeSet["dependencyAdditions"] = [];
  let precedingExits: PlanTicketRef[] = exitsOfLatestIncrement(snapshot, existingIncrements);

  for (const [incrementIndex, incrementIntent] of intent.increments.entries()) {
    requireIdentifier(incrementIntent.intentRef, "increment.intentRef");
    if (incrementRefs.has(incrementIntent.intentRef)) {
      throw new PlanIntentError(`duplicate increment intentRef ${incrementIntent.intentRef}`);
    }
    incrementRefs.add(incrementIntent.intentRef);
    requireText(incrementIntent.title, `${incrementIntent.intentRef}.title`);
    requireText(incrementIntent.objective, `${incrementIntent.intentRef}.objective`);
    if (!Array.isArray(incrementIntent.workItems) || incrementIntent.workItems.length === 0) {
      throw new PlanIntentError(`${incrementIntent.intentRef}.workItems must not be empty`);
    }

    const increment: TicketDeliveryIncrement = {
      incrementId: deterministicId("increment", snapshot.planId, snapshot.sourceTicketId, incrementIntent.intentRef),
      sequence: nextSequence++,
      title: incrementIntent.title.trim(),
      objective: incrementIntent.objective.trim(),
    };
    const localRefs = new Set<string>();
    for (const work of incrementIntent.workItems) {
      requireIdentifier(work.intentRef, `${incrementIntent.intentRef}.workItems.intentRef`);
      if (workRefs.has(work.intentRef)) throw new PlanIntentError(`duplicate work intentRef ${work.intentRef}`);
      workRefs.add(work.intentRef);
      localRefs.add(work.intentRef);
    }

    const dependedOn = new Set<string>();
    for (const work of incrementIntent.workItems) {
      validateWork(work, incrementIntent.intentRef);
      for (const dependency of work.dependsOn ?? []) {
        if (!localRefs.has(dependency)) {
          throw new PlanIntentError(`${work.intentRef}.dependsOn references work outside its increment: ${dependency}`);
        }
        if (dependency === work.intentRef) throw new PlanIntentError(`${work.intentRef} cannot depend on itself`);
        dependedOn.add(dependency);
        dependencyAdditions.push({ from: { clientRef: dependency }, to: { clientRef: work.intentRef } });
      }
      additions.push({
        clientRef: work.intentRef,
        title: work.title.trim(),
        objective: work.objective.trim(),
        successCriteria: work.successCriteria.map((item) => item.trim()),
        assignment: structuredClone(work.assignment),
        outputContract: work.permissions?.settleMission
          ? { schemaRef: "mission-settlement-v1" }
          : structuredClone(work.outputContract),
        deliveryIncrement: increment,
        ...(work.missionContribution ? { missionContribution: structuredClone(work.missionContribution) } : {}),
        ...(work.assurance ? { assurance: structuredClone(work.assurance) } : {}),
        ...(work.permissions ? { permissions: structuredClone(work.permissions) } : {}),
      });
    }
    assertAcyclicIncrement(incrementIntent.intentRef, incrementIntent.workItems);

    const roots = incrementIntent.workItems.filter((work) => !(work.dependsOn?.length));
    const gates: PlanTicketRef[] = incrementIndex === 0
      ? [{ ticketId: snapshot.sourceTicketId }, ...precedingExits]
      : precedingExits;
    for (const gate of gates) {
      for (const root of roots) dependencyAdditions.push({ from: gate, to: { clientRef: root.intentRef } });
    }
    precedingExits = incrementIntent.workItems
      .filter((work) => !dependedOn.has(work.intentRef))
      .map((work) => ({ clientRef: work.intentRef }));
  }

  const terminalRefs = additions
    .filter((node) => node.permissions?.settleMission === true)
    .map((node) => ({ clientRef: node.clientRef }));
  if (terminalRefs.length === 0) {
    throw new PlanIntentError("plan intent must contain at least one settleMission work item");
  }
  const finalExitRefs = new Set(precedingExits.flatMap((ref) => "clientRef" in ref ? [ref.clientRef] : []));
  for (const terminal of terminalRefs) {
    if (!finalExitRefs.has(terminal.clientRef)) {
      throw new PlanIntentError(`settleMission work item ${terminal.clientRef} must be an exit of the final increment`);
    }
  }

  const failureResolutions = compileHistoricalFailureResolutions(snapshot, additions);

  return {
    additions,
    dependencyAdditions: dedupeEdges(dependencyAdditions),
    failureResolutions,
    cancelTicketIds: [],
    requiredTerminalRefs: terminalRefs,
  };
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

function validateWork(work: PlanIntent["increments"][number]["workItems"][number], incrementRef: string): void {
  requireText(work.title, `${incrementRef}.${work.intentRef}.title`);
  requireText(work.objective, `${incrementRef}.${work.intentRef}.objective`);
  if (!Array.isArray(work.successCriteria) || work.successCriteria.length === 0) {
    throw new PlanIntentError(`${work.intentRef}.successCriteria must not be empty`);
  }
  work.successCriteria.forEach((criterion) => requireText(criterion, `${work.intentRef}.successCriteria`));
  if (!work.assignment || typeof work.assignment !== "object") throw new PlanIntentError(`${work.intentRef}.assignment is required`);
  requireText(work.outputContract?.schemaRef, `${work.intentRef}.outputContract.schemaRef`);
}

function assertAcyclicIncrement(
  incrementRef: string,
  workItems: PlanIntent["increments"][number]["workItems"],
): void {
  const state = new Map<string, "visiting" | "visited">();
  const byRef = new Map(workItems.map((work) => [work.intentRef, work]));
  const visit = (workRef: string): void => {
    const current = state.get(workRef);
    if (current === "visiting") throw new PlanIntentError(`${incrementRef} contains a dependency cycle at ${workRef}`);
    if (current === "visited") return;
    state.set(workRef, "visiting");
    for (const dependency of byRef.get(workRef)?.dependsOn ?? []) visit(dependency);
    state.set(workRef, "visited");
  };
  for (const work of workItems) visit(work.intentRef);
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

function requireIdentifier(value: unknown, label: string): asserts value is string {
  requireText(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) throw new PlanIntentError(`${label} must be an identifier`);
}
