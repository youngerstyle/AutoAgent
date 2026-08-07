import type { AutoAgentEvent } from "../shared/types";

export function mergeEventBuffer(
  current: AutoAgentEvent[],
  incoming: AutoAgentEvent | AutoAgentEvent[],
  limit: number,
): AutoAgentEvent[] {
  const merged = [...current, ...(Array.isArray(incoming) ? incoming : [incoming])];
  const unique = new Map<string, AutoAgentEvent>();
  for (const event of merged) unique.set(event.id, event);
  return [...unique.values()].sort(compareEvents).slice(-limit);
}

function compareEvents(left: AutoAgentEvent, right: AutoAgentEvent): number {
  const timestampOrder = left.timestamp.localeCompare(right.timestamp);
  if (timestampOrder !== 0) return timestampOrder;
  const sequenceOrder = (left.sequence ?? 0) - (right.sequence ?? 0);
  return sequenceOrder !== 0 ? sequenceOrder : left.id.localeCompare(right.id);
}
