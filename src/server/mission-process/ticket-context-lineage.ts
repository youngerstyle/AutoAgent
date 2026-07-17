import type { PlanGraphSnapshot, TicketId } from "../../shared/contracts/ticket-engine.js";

export function orderedAncestorTicketIds(graph: PlanGraphSnapshot, targetTicketId: TicketId): TicketId[] {
  const incoming = new Map<string, TicketId[]>();
  for (const edge of graph.dependencyEdges) {
    const key = String(edge.toTicketId);
    incoming.set(key, [...(incoming.get(key) ?? []), edge.fromTicketId]);
  }

  const ancestors = new Set<string>();
  const pending = [...(incoming.get(String(targetTicketId)) ?? [])];
  while (pending.length) {
    const ticketId = pending.pop()!;
    const key = String(ticketId);
    if (ancestors.has(key)) continue;
    ancestors.add(key);
    pending.push(...(incoming.get(key) ?? []));
  }

  if (!ancestors.size) return [];

  const graphOrder = new Map(graph.ticketIds.map((ticketId, index) => [String(ticketId), index]));
  const indegree = new Map<string, number>();
  const outgoing = new Map<string, TicketId[]>();
  for (const key of ancestors) indegree.set(key, 0);
  for (const edge of graph.dependencyEdges) {
    const from = String(edge.fromTicketId);
    const to = String(edge.toTicketId);
    if (!ancestors.has(from) || !ancestors.has(to)) continue;
    indegree.set(to, (indegree.get(to) ?? 0) + 1);
    outgoing.set(from, [...(outgoing.get(from) ?? []), edge.toTicketId]);
  }

  const compare = (left: TicketId, right: TicketId) =>
    (graphOrder.get(String(left)) ?? Number.MAX_SAFE_INTEGER)
    - (graphOrder.get(String(right)) ?? Number.MAX_SAFE_INTEGER);
  const ready = graph.ticketIds.filter((ticketId) => ancestors.has(String(ticketId)) && indegree.get(String(ticketId)) === 0).sort(compare);
  const ordered: TicketId[] = [];
  while (ready.length) {
    const ticketId = ready.shift()!;
    ordered.push(ticketId);
    for (const dependant of outgoing.get(String(ticketId)) ?? []) {
      const key = String(dependant);
      const next = (indegree.get(key) ?? 0) - 1;
      indegree.set(key, next);
      if (next === 0) {
        ready.push(dependant);
        ready.sort(compare);
      }
    }
  }

  if (ordered.length !== ancestors.size) throw new Error("Ticket context lineage is not acyclic");
  return ordered;
}
