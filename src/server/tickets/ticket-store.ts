import path from "node:path";
import type {
  BlockedOwnershipReceipt,
  ClaimCommandResult,
  ClaimReceipt,
  TicketCommandResult,
  TicketEvent,
  TicketEventPage,
  TicketEventQuery,
  TicketId,
  TicketSnapshot,
  WorkflowCommandResult,
  WorkflowId,
  WorkflowSnapshot,
} from "../../shared/contracts/ticket-engine.js";
import { readJson, writeJson } from "../storage/json.js";
import { ticketEngineFile } from "../storage/paths.js";

export type TicketStoredCommandResult =
  | TicketCommandResult
  | WorkflowCommandResult
  | ClaimCommandResult;

export interface TicketOutboxEntry {
  position: number;
  event: TicketEvent;
}

export interface TicketAggregate {
  schemaVersion: 2;
  aggregateVersion: number;
  workflow: WorkflowSnapshot;
  tickets: TicketSnapshot[];
  claims: ClaimReceipt[];
  blockedOwnerships: BlockedOwnershipReceipt[];
  commandResults: TicketStoredCommandResult[];
  outbox: TicketOutboxEntry[];
}

export interface TicketAggregateSeed {
  schemaVersion: 2;
  workflow: WorkflowSnapshot;
  tickets: TicketSnapshot[];
  claims: ClaimReceipt[];
  blockedOwnerships: BlockedOwnershipReceipt[];
  commandResults: TicketStoredCommandResult[];
  pendingEvents?: TicketEvent[];
}

export interface TicketAggregateExpectedVersion {
  aggregateVersion: number;
  workflowVersion: number;
}

export type TicketAggregateMutation = TicketAggregate & {
  pendingEvents?: TicketEvent[];
};

export class TicketStoreConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TicketStoreConflictError";
  }
}

export class TicketStoreCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TicketStoreCursorError";
  }
}

const workflowWriteQueues = new Map<string, Promise<unknown>>();

export class TicketStore {
  constructor(
    private readonly workspaceRoot: string,
    private readonly taskId: string,
    private readonly taskRunId: string,
  ) {}

  async create(seed: TicketAggregateSeed): Promise<TicketAggregate> {
    return this.enqueue(seed.workflow.workflowId, async () => {
      const existing = await this.readFromDisk(seed.workflow.workflowId);
      if (existing) {
        throw new TicketStoreConflictError(`Workflow ${seed.workflow.workflowId} already exists`);
      }

      const { pendingEvents = [], ...persistedSeed } = structuredClone(seed);
      const aggregate: TicketAggregate = {
        ...persistedSeed,
        schemaVersion: 2,
        aggregateVersion: 1,
        outbox: pendingEvents.map((event, index) => ({ position: index + 1, event })),
      };
      this.validateAggregate(aggregate, seed.workflow.workflowId);
      await writeJson(this.file(seed.workflow.workflowId), aggregate);
      return structuredClone(aggregate);
    });
  }

  async read(workflowId: WorkflowId): Promise<TicketAggregate | undefined> {
    const aggregate = await this.readFromDisk(workflowId);
    return aggregate ? structuredClone(aggregate) : undefined;
  }

  async transact(
    workflowId: WorkflowId,
    expected: TicketAggregateExpectedVersion,
    mutate: (current: TicketAggregate) => TicketAggregateMutation | Promise<TicketAggregateMutation>,
  ): Promise<TicketAggregate> {
    return this.enqueue(workflowId, async () => {
      const current = await this.requireAggregate(workflowId);
      if (
        current.aggregateVersion !== expected.aggregateVersion
        || current.workflow.version !== expected.workflowVersion
      ) {
        throw new TicketStoreConflictError(
          `Workflow ${workflowId} version conflict: expected aggregate ${expected.aggregateVersion}`
          + `/workflow ${expected.workflowVersion}, current aggregate ${current.aggregateVersion}`
          + `/workflow ${current.workflow.version}`,
        );
      }

      const proposed = await mutate(structuredClone(current));
      const pendingEvents = proposed.pendingEvents ?? [];
      if (proposed.workflow.version !== current.workflow.version + 1) {
        throw new TicketStoreConflictError(
          `Workflow ${workflowId} must increment workflow version by exactly one`,
        );
      }

      const nextOutbox = [...current.outbox];
      let position = nextOutbox.at(-1)?.position ?? 0;
      for (const event of pendingEvents) {
        position += 1;
        nextOutbox.push({ position, event: structuredClone(event) });
      }

      const next: TicketAggregate = {
        schemaVersion: 2,
        aggregateVersion: current.aggregateVersion + 1,
        workflow: structuredClone(proposed.workflow),
        tickets: structuredClone(proposed.tickets),
        claims: structuredClone(proposed.claims),
        blockedOwnerships: structuredClone(proposed.blockedOwnerships),
        commandResults: structuredClone(proposed.commandResults),
        outbox: nextOutbox,
      };
      this.validateAggregate(next, workflowId);
      await writeJson(this.file(workflowId), next);
      return structuredClone(next);
    });
  }

  async getCommandResult(
    workflowId: WorkflowId,
    commandId: string,
  ): Promise<TicketStoredCommandResult | undefined> {
    const aggregate = await this.readFromDisk(workflowId);
    return structuredClone(aggregate?.commandResults.find((result) => result.commandId === commandId));
  }

  async readEvents<TWorkflowId extends WorkflowId>(
    query: TicketEventQuery<TWorkflowId>,
  ): Promise<TicketEventPage<TWorkflowId>> {
    if (!Number.isInteger(query.limit) || query.limit < 1) {
      throw new TicketStoreCursorError("Event page limit must be a positive integer");
    }

    const afterPosition = query.after ? this.decodeCursor(query.workflowId, query.after) : 0;
    const aggregate = await this.readFromDisk(query.workflowId);
    const entries = (aggregate?.outbox ?? [])
      .filter((entry) => entry.position > afterPosition)
      .sort((left, right) => left.position - right.position)
      .slice(0, query.limit);
    const lastPosition = entries.at(-1)?.position ?? afterPosition;

    return {
      events: structuredClone(entries.map((entry) => entry.event)) as TicketEventPage<TWorkflowId>["events"],
      nextCursor: {
        source: "ticket",
        partitionId: query.workflowId,
        position: this.encodeCursor(query.workflowId, lastPosition),
      },
    };
  }

  private async requireAggregate(workflowId: WorkflowId): Promise<TicketAggregate> {
    const aggregate = await this.readFromDisk(workflowId);
    if (!aggregate) throw new Error(`Workflow ${workflowId} does not exist`);
    return aggregate;
  }

  private async readFromDisk(workflowId: WorkflowId): Promise<TicketAggregate | undefined> {
    const aggregate = await readJson<TicketAggregate | undefined>(this.file(workflowId), undefined);
    if (!aggregate) return undefined;
    this.validateAggregate(aggregate, workflowId);
    return aggregate;
  }

  private validateAggregate(aggregate: TicketAggregate, workflowId: WorkflowId): void {
    if (aggregate.schemaVersion !== 2) throw new Error("Unsupported Ticket aggregate schema");
    if (aggregate.workflow.workflowId !== workflowId) {
      throw new Error(`Ticket aggregate workflow mismatch for ${workflowId}`);
    }
    for (const ticket of aggregate.tickets) this.assertWorkflow(ticket.workflowId, workflowId, "ticket");
    for (const claim of aggregate.claims) this.assertWorkflow(claim.workflowId, workflowId, "claim");
    for (const ownership of aggregate.blockedOwnerships) {
      this.assertWorkflow(ownership.workflowId, workflowId, "blocked ownership");
    }
    for (const entry of aggregate.outbox) {
      this.assertWorkflow(entry.event.workflowId, workflowId, "outbox event");
    }
  }

  private assertWorkflow(actual: WorkflowId, expected: WorkflowId, subject: string): void {
    if (actual !== expected) throw new Error(`${subject} belongs to workflow ${actual}, expected ${expected}`);
  }

  private encodeCursor(workflowId: WorkflowId, position: number): string {
    return `ticket:${encodeURIComponent(workflowId)}:${position}`;
  }

  private decodeCursor(
    workflowId: WorkflowId,
    cursor: { source: "ticket"; partitionId: WorkflowId; position: string },
  ): number {
    if (cursor.partitionId !== workflowId) {
      throw new TicketStoreCursorError(
        `Cursor belongs to workflow ${cursor.partitionId}, not ${workflowId}`,
      );
    }
    const prefix = `ticket:${encodeURIComponent(workflowId)}:`;
    if (!cursor.position.startsWith(prefix)) {
      throw new TicketStoreCursorError(`Cursor namespace does not match workflow ${workflowId}`);
    }
    const position = Number(cursor.position.slice(prefix.length));
    if (!Number.isSafeInteger(position) || position < 0) {
      throw new TicketStoreCursorError("Cursor position is invalid");
    }
    return position;
  }

  private file(workflowId: WorkflowId): string {
    return ticketEngineFile(this.workspaceRoot, this.taskId, this.taskRunId, workflowId);
  }

  private enqueue<T>(workflowId: WorkflowId, operation: () => Promise<T>): Promise<T> {
    const key = path.resolve(this.file(workflowId)).toLowerCase();
    const previous = workflowWriteQueues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    workflowWriteQueues.set(key, next);
    return next.finally(() => {
      if (workflowWriteQueues.get(key) === next) workflowWriteQueues.delete(key);
    });
  }
}
