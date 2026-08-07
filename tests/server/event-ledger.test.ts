import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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
      payload: {},
    });
    await ledger.append(root, {
      workspaceId: "ws_1",
      taskId: "task_1",
      taskRunId: "run_1",
      type: "run.completed",
      summary: "done",
      payload: {},
    });

    const file = eventsFile(root, "task_1", "run_1");
    const raw = await readFile(file, "utf8");
    expect(raw.trim().split(/\r?\n/)).toHaveLength(2);

    const events = await ledger.read(root, "task_1", "run_1");
    expect(events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(events.map((event) => event.type)).toEqual(["task.created", "run.completed"]);
  });

  it("serializes concurrent appends for one task run", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-event-ledger-"));
    const ledger = new EventLedger();
    const events = await Promise.all(Array.from({ length: 24 }, (_value, index) => ledger.append(root, {
      workspaceId: "ws_ledger",
      taskId: "task_ledger",
      taskRunId: "run_ledger",
      type: "agent.step_started",
      summary: `event-${index}`,
      payload: { index },
    })));

    expect(new Set(events.map((event) => event.id)).size).toBe(24);
    expect(events.map((event) => event.sequence).sort((left, right) => (left ?? 0) - (right ?? 0)))
      .toEqual(Array.from({ length: 24 }, (_value, index) => index + 1));
    expect((await ledger.read(root, "task_ledger", "run_ledger")).map((event) => event.sequence))
      .toEqual(Array.from({ length: 24 }, (_value, index) => index + 1));
  });

  it("isolates a truncated terminal record and repairs it before the next append", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-event-ledger-tail-"));
    const ledger = new EventLedger();
    const file = eventsFile(root, "task_tail", "run_tail");
    const first = await ledger.append(root, {
      workspaceId: "ws_tail",
      taskId: "task_tail",
      taskRunId: "run_tail",
      type: "task.created",
      summary: "created",
      payload: {},
    });
    await writeFile(file, `${JSON.stringify(first)}\n{"id":"truncated"`, "utf8");

    expect((await ledger.read(root, "task_tail", "run_tail")).map((event) => event.id)).toEqual([first.id]);
    await ledger.append(root, {
      workspaceId: "ws_tail",
      taskId: "task_tail",
      taskRunId: "run_tail",
      type: "run.completed",
      summary: "done",
      payload: {},
    });

    const restored = await ledger.read(root, "task_tail", "run_tail");
    expect(restored.map((event) => event.sequence)).toEqual([1, 2]);
    expect((await readFile(file, "utf8")).trim().split(/\r?\n/)).toHaveLength(2);
  });

  it("reads the same ordered workspace history after the ledger is recreated", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-ledger-restart-"));
    const ledger = new EventLedger();
    const first = await ledger.append(root, {
      workspaceId: "ws_restart",
      taskId: "task_restart",
      taskRunId: "run_restart",
      type: "task.created",
      summary: "first",
      payload: {},
    });
    const second = await ledger.append(root, {
      workspaceId: "ws_restart",
      taskId: "task_restart",
      taskRunId: "run_restart",
      type: "run.completed",
      summary: "second",
      payload: {},
    });

    const restartedLedger = new EventLedger();
    await expect(restartedLedger.readWorkspaceSince(root, first.id)).resolves.toEqual([second]);
  });
});
