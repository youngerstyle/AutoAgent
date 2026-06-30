import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EventLedger } from "../../src/server/storage/event-ledger";
import { eventsFile } from "../../src/server/storage/paths";

describe("EventLedger", () => {
  it("appends ordered JSONL events under task run storage", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-ledger-"));
    const ledger = new EventLedger();

    await ledger.append(root, {
      workspaceId: "ws_1",
      taskId: "task_1",
      taskRunId: "run_1",
      type: "task.created",
      summary: "created",
      payload: {}
    });
    await ledger.append(root, {
      workspaceId: "ws_1",
      taskId: "task_1",
      taskRunId: "run_1",
      type: "run.completed",
      summary: "done",
      payload: {}
    });

    const file = eventsFile(root, "task_1", "run_1");
    const raw = await readFile(file, "utf8");
    expect(raw.trim().split(/\r?\n/)).toHaveLength(2);

    const events = await ledger.read(root, "task_1", "run_1");
    expect(events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(events.map((event) => event.type)).toEqual(["task.created", "run.completed"]);
  });
});
