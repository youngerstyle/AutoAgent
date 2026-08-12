import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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

  it("replays a later cross-run event even when its timestamp and id sort before the cursor", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-ledger-cross-run-cursor-"));
    const ledger = new EventLedger();
    const cursor = await ledger.append(root, {
      workspaceId: "ws_cross_run",
      taskId: "task_a",
      taskRunId: "run_a",
      type: "task.created",
      summary: "cursor event",
      payload: {},
      id: "evt_cursor",
      timestamp: "2026-08-01T00:00:00.000Z",
    });
    const later = await ledger.append(root, {
      workspaceId: "ws_cross_run",
      taskId: "task_b",
      taskRunId: "run_b",
      type: "agent.step_started",
      summary: "later event from another run",
      payload: {},
      id: "evt_before_cursor",
      timestamp: "2026-07-31T23:59:59.999Z",
    });

    expect((await ledger.read(root, "task_b", "run_b")).map((event) => event.id)).toEqual([later.id]);
    await expect(ledger.readWorkspaceSince(root, cursor.id)).resolves.toEqual([later]);
  });

  it("returns the latest limit events when a legacy cursor is unknown", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-ledger-legacy-limit-"));
    const taskId = "task_legacy_history";
    const taskRunId = "run_legacy_history";
    const legacyEvents = Array.from({ length: 3 }, (_value, index) => ({
      workspaceId: "ws_legacy_history",
      taskId,
      taskRunId,
      type: "agent.step_started",
      summary: `legacy event ${index + 1}`,
      payload: { index: index + 1 },
      id: `legacy-history-event-${index + 1}`,
      timestamp: `2020-01-01T00:00:0${index}.000Z`,
      sequence: index + 1,
    }));
    const legacyFile = eventsFile(root, taskId, taskRunId);
    await mkdir(path.dirname(legacyFile), { recursive: true });
    await writeFile(legacyFile, `${legacyEvents.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");

    await expect(new EventLedger().readWorkspaceSince(root, "legacy-history-cursor-unknown", 2)).resolves.toEqual([
      legacyEvents[1],
      legacyEvents[2],
    ]);
  });

  it("excludes permanent legacy records after a fresh protocol cursor", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-ledger-legacy-"));
    const legacy = {
      workspaceId: "ws_legacy",
      taskId: "task_legacy",
      taskRunId: "run_legacy",
      type: "task.created",
      summary: "legacy",
      payload: {},
      id: "legacy-event",
      timestamp: "2020-01-01T00:00:00.000Z",
      sequence: 1,
    };
    const legacyFile = eventsFile(root, legacy.taskId, legacy.taskRunId);
    await mkdir(path.dirname(legacyFile), { recursive: true });
    await writeFile(legacyFile, `${JSON.stringify(legacy)}\n`, "utf8");
    const ledger = new EventLedger();
    const fresh = await ledger.append(root, {
      workspaceId: "ws_legacy",
      taskId: "task_fresh",
      taskRunId: "run_fresh",
      type: "task.created",
      summary: "fresh",
      payload: {},
      id: "fresh-event",
      timestamp: "2021-01-01T00:00:00.000Z",
    });

    await expect(ledger.readWorkspaceSince(root, fresh.id)).resolves.toEqual([]);
    await expect(ledger.readWorkspaceSince(root, fresh.id)).resolves.toEqual([]);
  });

  it("allocates unique workspace sequences across ledger instances and task runs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-ledger-multi-instance-"));
    const ledgers = [new EventLedger(), new EventLedger()];
    const events = await Promise.all(Array.from({ length: 20 }, (_value, index) => ledgers[index % 2].append(root, {
      workspaceId: "ws_multi",
      taskId: `task_${index % 5}`,
      taskRunId: `run_${index}`,
      type: "agent.step_started",
      summary: `event-${index}`,
      payload: { index },
    })));

    const sequences = events.map((event) => event.workspaceSequence).sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(new Set(sequences).size).toBe(20);
    expect(sequences).toEqual(Array.from({ length: 20 }, (_value, index) => index + 1));
    const first = events.find((event) => event.workspaceSequence === 1)!;
    expect((await ledgers[0].readWorkspaceSince(root, first.id)).map((event) => event.workspaceSequence)).toEqual(
      Array.from({ length: 19 }, (_value, index) => index + 2),
    );
  });

  it("recovers a durable event when cursor publication fails and makes retries idempotent", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-ledger-recovery-"));
    const failing = new EventLedger(undefined, { afterEventDurableBeforeCursor: () => { throw new Error("injected cursor failure"); } });
    const request = {
      workspaceId: "ws_recovery",
      taskId: "task_recovery",
      taskRunId: "run_recovery",
      type: "task.created",
      summary: "recoverable",
      payload: { attempt: 1 },
      id: "retryable-event",
    } as const;

    await expect(failing.append(root, request)).rejects.toThrow("injected cursor failure");
    const recovered = new EventLedger();
    const retried = await recovered.append(root, request);
    expect(retried.id).toBe(request.id);
    expect(retried.workspaceSequence).toBe(1);
    expect((await recovered.read(root, request.taskId, request.taskRunId))).toHaveLength(1);
  });

  it("rejects a requested id reused with conflicting immutable content", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-ledger-id-conflict-"));
    const ledger = new EventLedger();
    await ledger.append(root, {
      workspaceId: "ws_conflict",
      taskId: "task_conflict",
      taskRunId: "run_conflict",
      type: "task.created",
      summary: "original",
      payload: { value: 1 },
      id: "same-event",
    });
    await expect(ledger.append(root, {
      workspaceId: "ws_conflict",
      taskId: "task_conflict",
      taskRunId: "run_conflict",
      type: "task.created",
      summary: "changed",
      payload: { value: 2 },
      id: "same-event",
    })).rejects.toThrow("Event id conflict");
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
