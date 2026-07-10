import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  TicketStore,
  TicketStoreConflictError,
  TicketStoreCursorError,
  type TicketAggregate,
  type TicketAggregateSeed,
} from "../../src/server/tickets/ticket-store.js";
import { ticketEngineFile, ticketEngineLockFile } from "../../src/server/storage/paths.js";
import type {
  TicketCommandResult,
  TicketEvent,
  TicketId,
  TicketSnapshot,
  WorkflowId,
  WorkflowSnapshot,
} from "../../src/shared/contracts/ticket-engine.js";

describe("TicketStore", () => {
  it("creates and reads one authoritative aggregate file per workflow", async () => {
    const fixture = await createFixture("workflow-a");

    const created = await fixture.store.create(seedAggregate(fixture.workflowId));
    const restored = await fixture.store.read(fixture.workflowId);
    const persisted = JSON.parse(await readFile(
      ticketEngineFile(fixture.root, fixture.taskId, fixture.taskRunId, fixture.workflowId),
      "utf8",
    )) as TicketAggregate;

    expect(created.aggregateVersion).toBe(1);
    expect(restored).toEqual(created);
    expect(persisted.schemaVersion).toBe(2);
    expect(persisted.workflow.workflowId).toBe(fixture.workflowId);
    expect(persisted.tickets).toHaveLength(1);
    expect(persisted.claims).toEqual([]);
    expect(persisted.blockedOwnerships).toEqual([]);
    expect(persisted.commandResults).toEqual([]);
    expect(persisted.outbox).toEqual([]);
  });

  it("atomically increments the aggregate and workflow versions", async () => {
    const fixture = await createFixture("workflow-version");
    await fixture.store.create(seedAggregate(fixture.workflowId));

    const updated = await fixture.store.transact(
      fixture.workflowId,
      { aggregateVersion: 1, workflowVersion: 1 },
      (current) => ({
        ...current,
        workflow: { ...current.workflow, version: 2, status: "paused" },
      }),
    );

    expect(updated.aggregateVersion).toBe(2);
    expect(updated.workflow.version).toBe(2);
    expect(updated.workflow.status).toBe("paused");
  });

  it("creates the first snapshot and initial outbox events in one aggregate write", async () => {
    const fixture = await createFixture("workflow-initial-events");
    const seed = seedAggregate(fixture.workflowId);
    seed.pendingEvents = [ticketReadyEvent(fixture.workflowId, 1)];

    const created = await fixture.store.create(seed);
    const events = await fixture.store.readEvents({ workflowId: fixture.workflowId, limit: 10 });

    expect(created.outbox).toHaveLength(1);
    expect(created.outbox[0]?.position).toBe(1);
    expect(events.events.map((event) => event.payload.type)).toEqual(["TicketReady"]);
  });

  it("rejects stale aggregate or workflow versions without writing", async () => {
    const fixture = await createFixture("workflow-cas");
    await fixture.store.create(seedAggregate(fixture.workflowId));

    await expect(fixture.store.transact(
      fixture.workflowId,
      { aggregateVersion: 0, workflowVersion: 1 },
      (current) => current,
    )).rejects.toBeInstanceOf(TicketStoreConflictError);

    await expect(fixture.store.transact(
      fixture.workflowId,
      { aggregateVersion: 1, workflowVersion: 0 },
      (current) => current,
    )).rejects.toBeInstanceOf(TicketStoreConflictError);

    expect((await fixture.store.read(fixture.workflowId))?.aggregateVersion).toBe(1);
    expect((await fixture.store.read(fixture.workflowId))?.workflow.version).toBe(1);
  });

  it("serializes concurrent updates for the same workflow", async () => {
    const fixture = await createFixture("workflow-concurrent");
    await fixture.store.create(seedAggregate(fixture.workflowId));

    let releaseFirst!: () => void;
    const firstCanFinish = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstEntered!: () => void;
    const firstDidEnter = new Promise<void>((resolve) => { firstEntered = resolve; });

    const first = fixture.store.transact(
      fixture.workflowId,
      { aggregateVersion: 1, workflowVersion: 1 },
      async (current) => {
        firstEntered();
        await firstCanFinish;
        return { ...current, workflow: { ...current.workflow, version: 2 } };
      },
    );
    await firstDidEnter;
    const restartedStore = new TicketStore(fixture.root, fixture.taskId, fixture.taskRunId);
    const staleSecond = restartedStore.transact(
      fixture.workflowId,
      { aggregateVersion: 1, workflowVersion: 1 },
      (current) => ({ ...current, workflow: { ...current.workflow, version: 2 } }),
    );
    releaseFirst();

    await expect(first).resolves.toMatchObject({ aggregateVersion: 2 });
    await expect(staleSecond).rejects.toBeInstanceOf(TicketStoreConflictError);
    expect((await fixture.store.read(fixture.workflowId))?.aggregateVersion).toBe(2);
  });

  it("serializes true child-process writers so one commits and one observes a version conflict", async () => {
    const fixture = await createFixture("workflow-process-race");
    await fixture.store.create(seedAggregate(fixture.workflowId));
    const startFile = path.join(fixture.root, "start-race");

    const first = runTransactionChild(fixture, startFile);
    const second = runTransactionChild(fixture, startFile);
    await writeFile(startFile, "go", "utf8");
    const results = await Promise.all([first, second]);

    expect(results.map((result) => result.status).sort()).toEqual(["committed", "conflict"]);
    const restored = await fixture.store.read(fixture.workflowId);
    expect(restored?.aggregateVersion).toBe(2);
    expect(restored?.workflow.version).toBe(2);
  });

  it("recovers an expired lock whose owner process is gone", async () => {
    const fixture = await createFixture("workflow-stale-lock");
    const lockFile = ticketEngineLockFile(
      fixture.root,
      fixture.taskId,
      fixture.taskRunId,
      fixture.workflowId,
    );
    await mkdir(path.dirname(lockFile), { recursive: true });
    await writeFile(lockFile, JSON.stringify({
      token: "abandoned",
      pid: 999_999_999,
      hostname: os.hostname(),
      createdAt: new Date(0).toISOString(),
    }), "utf8");
    await utimes(lockFile, new Date(0), new Date(0));

    const store = new TicketStore(fixture.root, fixture.taskId, fixture.taskRunId, {
      lockStaleMs: 1,
      lockWaitTimeoutMs: 1_000,
      lockRetryMs: 2,
    });
    await expect(store.create(seedAggregate(fixture.workflowId))).resolves.toMatchObject({
      aggregateVersion: 1,
    });
  });

  it("persists command results and restores them in a new store instance", async () => {
    const fixture = await createFixture("workflow-command");
    await fixture.store.create(seedAggregate(fixture.workflowId));
    const result: TicketCommandResult = {
      accepted: true,
      commandId: "command-1",
      proposalId: "proposal-1",
      ticketStatus: "completed",
      ticketVersion: 2,
      workflowStatus: "active",
      workflowVersion: 2,
    };

    await fixture.store.transact(
      fixture.workflowId,
      { aggregateVersion: 1, workflowVersion: 1 },
      (current) => ({
        ...current,
        workflow: { ...current.workflow, version: 2 },
        commandResults: [...current.commandResults, result],
      }),
    );

    const restarted = new TicketStore(fixture.root, fixture.taskId, fixture.taskRunId);
    await expect(restarted.getCommandResult(fixture.workflowId, "command-1")).resolves.toEqual(result);
  });

  it("pages outbox events in stable ascending order after restart", async () => {
    const fixture = await createFixture("workflow-events");
    await fixture.store.create(seedAggregate(fixture.workflowId));
    const events = [1, 2, 3].map((version) => ticketReadyEvent(fixture.workflowId, version));

    await fixture.store.transact(
      fixture.workflowId,
      { aggregateVersion: 1, workflowVersion: 1 },
      (current) => ({
        ...current,
        workflow: { ...current.workflow, version: 2 },
        pendingEvents: events,
      }),
    );

    const restarted = new TicketStore(fixture.root, fixture.taskId, fixture.taskRunId);
    const first = await restarted.readEvents({ workflowId: fixture.workflowId, limit: 2 });
    const second = await restarted.readEvents({
      workflowId: fixture.workflowId,
      after: first.nextCursor,
      limit: 2,
    });

    expect(first.events.map((event) => event.aggregateVersion)).toEqual([1, 2]);
    expect(second.events.map((event) => event.aggregateVersion)).toEqual([3]);
    expect(first.nextCursor.partitionId).toBe(fixture.workflowId);
    expect(first.nextCursor.position).toContain(fixture.workflowId);
    expect(second.nextCursor.position).toContain(fixture.workflowId);
  });

  it("rejects a cursor from another workflow partition", async () => {
    const first = await createFixture("workflow-one");
    const secondId = "workflow-two" as WorkflowId;
    await first.store.create(seedAggregate(first.workflowId));
    await first.store.create(seedAggregate(secondId));
    const page = await first.store.readEvents({ workflowId: first.workflowId, limit: 1 });

    await expect(first.store.readEvents({
      workflowId: secondId,
      after: page.nextCursor,
      limit: 1,
    })).rejects.toBeInstanceOf(TicketStoreCursorError);
  });

  it("rejects cursors with a forged source or a position beyond the durable outbox boundary", async () => {
    const fixture = await createFixture("workflow-forged-cursor");
    const seed = seedAggregate(fixture.workflowId);
    seed.pendingEvents = [ticketReadyEvent(fixture.workflowId, 1)];
    await fixture.store.create(seed);
    const page = await fixture.store.readEvents({ workflowId: fixture.workflowId, limit: 1 });

    await expect(fixture.store.readEvents({
      workflowId: fixture.workflowId,
      after: { ...page.nextCursor, source: "agent" } as never,
      limit: 1,
    })).rejects.toBeInstanceOf(TicketStoreCursorError);
    await expect(fixture.store.readEvents({
      workflowId: fixture.workflowId,
      after: {
        ...page.nextCursor,
        position: `ticket:${encodeURIComponent(fixture.workflowId)}:2`,
      },
      limit: 1,
    })).rejects.toBeInstanceOf(TicketStoreCursorError);
  });

  it("hashes every untrusted Ticket Engine path component including Windows device names", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-ticket-path-"));
    const taskId = "../../escape/CON";
    const taskRunId = "..\\AUX\\run";
    const workflowId = "CON/*?:workflow" as WorkflowId;
    const file = ticketEngineFile(root, taskId, taskRunId, workflowId);
    const engineRoot = path.resolve(root, ".autoagent", "ticket-engine");

    expect(path.resolve(file).startsWith(`${engineRoot}${path.sep}`)).toBe(true);
    expect(path.relative(engineRoot, file).split(path.sep).every((part) => (
      part === "tasks" || part === "runs" || part === "workflows" || /^[A-Za-z0-9_-]+(?:\.json)?$/.test(part)
    ))).toBe(true);
    expect(file).not.toContain("CON");
    expect(file).not.toContain("AUX");
    expect(file).not.toContain("escape");

    const store = new TicketStore(root, taskId, taskRunId);
    const created = await store.create(seedAggregate(workflowId));
    expect(created.storageIdentity).toEqual({ taskId, taskRunId, workflowId });
    expect((await store.read(workflowId))?.workflow.workflowId).toBe(workflowId);
  });

  it.each([
    ["negative aggregate version", (value: TicketAggregate) => { value.aggregateVersion = -1; }],
    ["negative workflow version", (value: TicketAggregate) => { value.workflow.version = -1; }],
    ["negative ticket version", (value: TicketAggregate) => { value.tickets[0]!.version = -1; }],
    ["non-contiguous outbox", (value: TicketAggregate) => {
      value.outbox = [{ position: 2, event: ticketReadyEvent(value.workflow.workflowId, 1) }];
    }],
    ["duplicate command id", (value: TicketAggregate) => {
      const result = completedCommandResult("duplicate", 1);
      value.commandResults = [result, result];
    }],
    ["foreign ticket", (value: TicketAggregate) => {
      value.tickets[0]!.workflowId = "foreign-workflow" as WorkflowId;
    }],
  ])("fails closed when readable JSON contains %s", async (_label, corrupt) => {
    const fixture = await createFixture(`workflow-corrupt-${_label}`);
    await fixture.store.create(seedAggregate(fixture.workflowId));
    const file = ticketEngineFile(fixture.root, fixture.taskId, fixture.taskRunId, fixture.workflowId);
    const persisted = JSON.parse(await readFile(file, "utf8")) as TicketAggregate;
    corrupt(persisted);
    await writeFile(file, JSON.stringify(persisted), "utf8");

    await expect(fixture.store.read(fixture.workflowId)).rejects.toThrow();
  });

  it("leaves a parseable durable aggregate and no lock or temporary file after a committed write", async () => {
    const fixture = await createFixture("workflow-durable-write");
    await fixture.store.create(seedAggregate(fixture.workflowId));
    await fixture.store.transact(
      fixture.workflowId,
      { aggregateVersion: 1, workflowVersion: 1 },
      (current) => ({ ...current, workflow: { ...current.workflow, version: 2 } }),
    );

    const file = ticketEngineFile(fixture.root, fixture.taskId, fixture.taskRunId, fixture.workflowId);
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ aggregateVersion: 2 });
    expect((await readdir(path.dirname(file))).filter((name) => name.includes(".tmp") || name.endsWith(".lock"))).toEqual([]);
  });
});

async function createFixture(workflow: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-ticket-store-"));
  return {
    root,
    taskId: "task-1",
    taskRunId: "run-1",
    workflowId: workflow as WorkflowId,
    store: new TicketStore(root, "task-1", "run-1"),
  };
}

function seedAggregate(workflowId: WorkflowId): TicketAggregateSeed {
  const ticketId = `${workflowId}-ticket` as TicketId;
  const workflow: WorkflowSnapshot = {
    workflowId,
    version: 1,
    status: "active",
    graph: {
      schemaVersion: 2,
      nodes: [{ nodeKey: "start" as never, ticketId, active: true }],
      dependencyEdges: [],
    },
    completionPolicy: {
      requiredTerminalTicketIds: [ticketId],
      failurePolicy: "require_resolution",
      blockedPolicy: "wait",
    },
    policyRef: { policyId: "default", policyVersion: 1, contentHash: "hash" },
  };
  const ticket: TicketSnapshot = {
    ticketId,
    workflowId,
    version: 1,
    status: "ready",
  };
  return {
    schemaVersion: 2,
    workflow,
    tickets: [ticket],
    claims: [],
    blockedOwnerships: [],
    commandResults: [],
  };
}

function ticketReadyEvent(workflowId: WorkflowId, aggregateVersion: number): TicketEvent {
  return {
    eventId: `event-${aggregateVersion}`,
    workflowId,
    aggregateType: "ticket",
    aggregateId: `${workflowId}-ticket` as TicketId,
    aggregateVersion,
    occurredAt: new Date(aggregateVersion * 1_000).toISOString(),
    payload: { type: "TicketReady", ticketVersion: aggregateVersion },
  };
}

function completedCommandResult(commandId: string, workflowVersion: number): TicketCommandResult {
  return {
    accepted: true,
    commandId,
    proposalId: `proposal-${commandId}`,
    ticketStatus: "completed",
    ticketVersion: workflowVersion,
    workflowStatus: "active",
    workflowVersion,
  };
}

interface TransactionChildResult {
  status: "committed" | "conflict" | "error";
  error?: string;
}

function runTransactionChild(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  startFile: string,
): Promise<TransactionChildResult> {
  const moduleUrl = pathToFileURL(path.resolve("src/server/tickets/ticket-store.ts")).href;
  const script = `
    import { existsSync } from "node:fs";
    import { setTimeout as delay } from "node:timers/promises";
    const { TicketStore, TicketStoreConflictError } = await import(process.env.STORE_MODULE_URL);
    while (!existsSync(process.env.START_FILE)) await delay(2);
    const store = new TicketStore(process.env.STORE_ROOT, process.env.TASK_ID, process.env.TASK_RUN_ID);
    try {
      await store.transact(
        process.env.WORKFLOW_ID,
        { aggregateVersion: 1, workflowVersion: 1 },
        async (current) => {
          await delay(75);
          return { ...current, workflow: { ...current.workflow, version: 2 } };
        },
      );
      console.log(JSON.stringify({ status: "committed" }));
    } catch (error) {
      console.log(JSON.stringify({
        status: error instanceof TicketStoreConflictError ? "conflict" : "error",
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        STORE_MODULE_URL: moduleUrl,
        STORE_ROOT: fixture.root,
        TASK_ID: fixture.taskId,
        TASK_RUN_ID: fixture.taskRunId,
        WORKFLOW_ID: fixture.workflowId,
        START_FILE: startFile,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) return reject(new Error(`Transaction child exited ${code}: ${stderr}`));
      try {
        resolve(JSON.parse(stdout.trim()) as TransactionChildResult);
      } catch {
        reject(new Error(`Invalid transaction child output: ${stdout}\n${stderr}`));
      }
    });
  });
}
