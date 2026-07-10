import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  TicketStore,
  TicketStoreConflictError,
  TicketStoreCursorError,
  type TicketAggregate,
  type TicketAggregateSeed,
} from "../../src/server/tickets/ticket-store.js";
import { ticketEngineFile } from "../../src/server/storage/paths.js";
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
