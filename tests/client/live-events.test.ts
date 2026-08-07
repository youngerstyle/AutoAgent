import { describe, expect, it } from "vitest";
import { mergeEventBuffer } from "../../src/client/live-events";
import type { AutoAgentEvent } from "../../src/shared/types";

describe("live event buffer", () => {
  it("deduplicates replayed events without changing their order", () => {
    const first = event("evt_1", "first");
    const second = event("evt_2", "second");
    const third = event("evt_3", "third");

    expect(mergeEventBuffer([first, second], [second, third], 10)).toEqual([first, second, third]);
  });

  it("keeps only the newest events after deduplication", () => {
    const first = event("evt_1", "first");
    const second = event("evt_2", "second");
    const third = event("evt_3", "third");

    expect(mergeEventBuffer([first, second], third, 2)).toEqual([second, third]);
  });

  it("keeps the event timeline ordered when an older snapshot arrives after a live event", () => {
    const first = eventAt("evt_1", "first", "2026-08-04T00:00:01.000Z", 1);
    const second = eventAt("evt_2", "second", "2026-08-04T00:00:02.000Z", 2);
    const third = eventAt("evt_3", "third", "2026-08-04T00:00:03.000Z", 3);

    expect(mergeEventBuffer([third], [first, second], 10)).toEqual([first, second, third]);
  });
});

function event(id: string, summary: string): AutoAgentEvent {
  return eventAt(id, summary, "2026-08-03T00:00:00.000Z", Number(id.slice(-1)));
}

function eventAt(id: string, summary: string, timestamp: string, sequence: number): AutoAgentEvent {
  return {
    id,
    workspaceId: "ws_test",
    taskId: "task_test",
    taskRunId: "run_test",
    type: "task.created",
    timestamp,
    sequence,
    summary,
    payload: {},
  };
}
