import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  BlockedOwnershipReceipt,
  ClaimCommandResult,
  ClaimReceipt,
  TicketCommandResult,
  TicketEvent,
  TicketEventPage,
  TicketEventQuery,
  TicketSnapshot,
  WorkflowCommandResult,
  WorkflowId,
  WorkflowSnapshot,
} from "../../shared/contracts/ticket-engine.js";
import { ticketEngineFile, ticketEngineLockFile } from "../storage/paths.js";

export type TicketStoredCommandResult =
  | TicketCommandResult
  | WorkflowCommandResult
  | ClaimCommandResult;

export interface TicketOutboxEntry {
  position: number;
  event: TicketEvent;
}

export interface TicketStorageIdentity {
  taskId: string;
  taskRunId: string;
  workflowId: WorkflowId;
}

export interface TicketAggregate {
  schemaVersion: 2;
  storageIdentity: TicketStorageIdentity;
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

export interface TicketStoreOptions {
  lockWaitTimeoutMs?: number;
  lockRetryMs?: number;
  lockStaleMs?: number;
}

interface ResolvedTicketStoreOptions {
  lockWaitTimeoutMs: number;
  lockRetryMs: number;
  lockStaleMs: number;
}

interface WorkflowLockMetadata {
  token: string;
  pid: number;
  hostname: string;
  createdAt: string;
}

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

export class TicketStoreCorruptionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TicketStoreCorruptionError";
  }
}

const workflowWriteQueues = new Map<string, Promise<unknown>>();
const DEFAULT_OPTIONS: ResolvedTicketStoreOptions = {
  lockWaitTimeoutMs: 60_000,
  lockRetryMs: 10,
  lockStaleMs: 30_000,
};
const RENAME_MAX_ATTEMPTS = 6;

export class TicketStore {
  private readonly options: ResolvedTicketStoreOptions;

  constructor(
    private readonly workspaceRoot: string,
    private readonly taskId: string,
    private readonly taskRunId: string,
    options: TicketStoreOptions = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    for (const [name, value] of Object.entries(this.options)) {
      if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be non-negative`);
    }
  }

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
        storageIdentity: this.storageIdentity(seed.workflow.workflowId),
        aggregateVersion: 1,
        outbox: pendingEvents.map((event, index) => ({ position: index + 1, event })),
      };
      this.validateAggregate(aggregate, seed.workflow.workflowId);
      await writeDurableJson(this.file(seed.workflow.workflowId), aggregate);
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
        storageIdentity: this.storageIdentity(workflowId),
        aggregateVersion: current.aggregateVersion + 1,
        workflow: structuredClone(proposed.workflow),
        tickets: structuredClone(proposed.tickets),
        claims: structuredClone(proposed.claims),
        blockedOwnerships: structuredClone(proposed.blockedOwnerships),
        commandResults: structuredClone(proposed.commandResults),
        outbox: nextOutbox,
      };
      this.validateAggregate(next, workflowId);
      await writeDurableJson(this.file(workflowId), next);
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

    const aggregate = await this.readFromDisk(query.workflowId);
    const lastDurablePosition = aggregate?.outbox.at(-1)?.position ?? 0;
    const afterPosition = query.after
      ? this.decodeCursor(query.workflowId, query.after, lastDurablePosition)
      : 0;
    const entries = (aggregate?.outbox ?? [])
      .filter((entry) => entry.position > afterPosition)
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
    let content: string;
    try {
      content = await readFile(this.file(workflowId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }

    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch (error) {
      throw new TicketStoreCorruptionError(`Workflow ${workflowId} contains invalid JSON`, {
        cause: error,
      });
    }
    this.validateAggregate(value, workflowId);
    return value as TicketAggregate;
  }

  private validateAggregate(value: unknown, workflowId: WorkflowId): asserts value is TicketAggregate {
    const aggregate = requireRecord(value, "aggregate");
    if (aggregate.schemaVersion !== 2) this.corrupt("unsupported schemaVersion");
    requirePositiveVersion(aggregate.aggregateVersion, "aggregateVersion");

    const identity = requireRecord(aggregate.storageIdentity, "storageIdentity");
    if (
      identity.taskId !== this.taskId
      || identity.taskRunId !== this.taskRunId
      || identity.workflowId !== workflowId
    ) {
      this.corrupt("storage identity does not match the requested aggregate");
    }

    const workflow = requireRecord(aggregate.workflow, "workflow");
    if (workflow.workflowId !== workflowId) this.corrupt("workflowId does not match its aggregate");
    requirePositiveVersion(workflow.version, "workflow.version");
    if (typeof workflow.status !== "string" || !WORKFLOW_STATUSES.has(workflow.status)) {
      this.corrupt("workflow.status is invalid");
    }

    const graph = requireRecord(workflow.graph, "workflow.graph");
    if (graph.schemaVersion !== 2) this.corrupt("workflow.graph schemaVersion is invalid");
    const graphNodes = requireArray(graph.nodes, "workflow.graph.nodes");
    const graphTicketIds = new Set<string>();
    for (const [index, rawNode] of graphNodes.entries()) {
      const node = requireRecord(rawNode, `workflow.graph.nodes[${index}]`);
      const ticketId = requireNonEmptyString(node.ticketId, `workflow.graph.nodes[${index}].ticketId`);
      if (graphTicketIds.has(ticketId)) this.corrupt(`duplicate graph ticketId ${ticketId}`);
      graphTicketIds.add(ticketId);
      requireNonEmptyString(node.nodeKey, `workflow.graph.nodes[${index}].nodeKey`);
      if (typeof node.active !== "boolean") this.corrupt(`workflow.graph.nodes[${index}].active is invalid`);
    }
    for (const [index, rawEdge] of requireArray(graph.dependencyEdges, "workflow.graph.dependencyEdges").entries()) {
      const edge = requireRecord(rawEdge, `workflow.graph.dependencyEdges[${index}]`);
      if (!graphTicketIds.has(String(edge.fromTicketId)) || !graphTicketIds.has(String(edge.toTicketId))) {
        this.corrupt(`workflow.graph.dependencyEdges[${index}] references an unknown ticket`);
      }
    }

    const completionPolicy = requireRecord(workflow.completionPolicy, "workflow.completionPolicy");
    for (const ticketId of requireArray(
      completionPolicy.requiredTerminalTicketIds,
      "workflow.completionPolicy.requiredTerminalTicketIds",
    )) {
      if (typeof ticketId !== "string" || !graphTicketIds.has(ticketId)) {
        this.corrupt("completion policy references an unknown ticket");
      }
    }
    const policyRef = requireRecord(workflow.policyRef, "workflow.policyRef");
    requireNonEmptyString(policyRef.policyId, "workflow.policyRef.policyId");
    requirePositiveVersion(policyRef.policyVersion, "workflow.policyRef.policyVersion");
    requireNonEmptyString(policyRef.contentHash, "workflow.policyRef.contentHash");

    const tickets = requireArray(aggregate.tickets, "tickets");
    const ticketIds = new Set<string>();
    for (const [index, rawTicket] of tickets.entries()) {
      const ticket = requireRecord(rawTicket, `tickets[${index}]`);
      const ticketId = requireNonEmptyString(ticket.ticketId, `tickets[${index}].ticketId`);
      if (ticketIds.has(ticketId)) this.corrupt(`duplicate ticketId ${ticketId}`);
      ticketIds.add(ticketId);
      if (ticket.workflowId !== workflowId) this.corrupt(`ticket ${ticketId} belongs to another workflow`);
      requirePositiveVersion(ticket.version, `tickets[${index}].version`);
      if (typeof ticket.status !== "string" || !TICKET_STATUSES.has(ticket.status)) {
        this.corrupt(`ticket ${ticketId} has an invalid status`);
      }
    }
    if (ticketIds.size !== graphTicketIds.size || [...graphTicketIds].some((id) => !ticketIds.has(id))) {
      this.corrupt("workflow graph and ticket snapshots are inconsistent");
    }

    const claims = requireArray(aggregate.claims, "claims");
    const claimIds = new Set<string>();
    for (const [index, rawClaim] of claims.entries()) {
      const claim = requireRecord(rawClaim, `claims[${index}]`);
      const claimId = requireNonEmptyString(claim.claimId, `claims[${index}].claimId`);
      if (claimIds.has(claimId)) this.corrupt(`duplicate claimId ${claimId}`);
      claimIds.add(claimId);
      this.validateOwnedTicket(claim, workflowId, ticketIds, `claims[${index}]`);
      requireNonNegativeInteger(claim.fencingToken, `claims[${index}].fencingToken`);
    }

    const ownershipIds = new Set<string>();
    for (const [index, rawOwnership] of requireArray(
      aggregate.blockedOwnerships,
      "blockedOwnerships",
    ).entries()) {
      const ownership = requireRecord(rawOwnership, `blockedOwnerships[${index}]`);
      const ownershipId = requireNonEmptyString(
        ownership.ownershipId,
        `blockedOwnerships[${index}].ownershipId`,
      );
      if (ownershipIds.has(ownershipId)) this.corrupt(`duplicate ownershipId ${ownershipId}`);
      ownershipIds.add(ownershipId);
      this.validateOwnedTicket(ownership, workflowId, ticketIds, `blockedOwnerships[${index}]`);
      requireNonNegativeInteger(ownership.fencingToken, `blockedOwnerships[${index}].fencingToken`);
    }

    const commandIds = new Set<string>();
    for (const [index, rawResult] of requireArray(aggregate.commandResults, "commandResults").entries()) {
      const result = requireRecord(rawResult, `commandResults[${index}]`);
      const commandId = requireNonEmptyString(result.commandId, `commandResults[${index}].commandId`);
      if (commandIds.has(commandId)) this.corrupt(`duplicate commandId ${commandId}`);
      commandIds.add(commandId);
      if (typeof result.accepted !== "boolean") this.corrupt(`commandResults[${index}].accepted is invalid`);
    }

    const eventIds = new Set<string>();
    for (const [index, rawEntry] of requireArray(aggregate.outbox, "outbox").entries()) {
      const entry = requireRecord(rawEntry, `outbox[${index}]`);
      if (entry.position !== index + 1) this.corrupt("outbox positions must be contiguous from one");
      const event = requireRecord(entry.event, `outbox[${index}].event`);
      const eventId = requireNonEmptyString(event.eventId, `outbox[${index}].event.eventId`);
      if (eventIds.has(eventId)) this.corrupt(`duplicate eventId ${eventId}`);
      eventIds.add(eventId);
      if (event.workflowId !== workflowId) this.corrupt(`event ${eventId} belongs to another workflow`);
      requirePositiveVersion(event.aggregateVersion, `outbox[${index}].event.aggregateVersion`);
      if (event.aggregateType === "ticket") {
        if (typeof event.aggregateId !== "string" || !ticketIds.has(event.aggregateId)) {
          this.corrupt(`event ${eventId} references an unknown ticket`);
        }
      } else if (event.aggregateType === "workflow") {
        if (event.aggregateId !== workflowId) this.corrupt(`event ${eventId} references another workflow`);
      } else {
        this.corrupt(`event ${eventId} has an invalid aggregateType`);
      }
      const payload = requireRecord(event.payload, `outbox[${index}].event.payload`);
      if (typeof payload.type !== "string" || !EVENT_TYPES.has(payload.type)) {
        this.corrupt(`event ${eventId} has an invalid payload type`);
      }
    }
  }

  private validateOwnedTicket(
    value: Record<string, unknown>,
    workflowId: WorkflowId,
    ticketIds: Set<string>,
    label: string,
  ): void {
    if (value.workflowId !== workflowId) this.corrupt(`${label} belongs to another workflow`);
    if (typeof value.ticketId !== "string" || !ticketIds.has(value.ticketId)) {
      this.corrupt(`${label} references an unknown ticket`);
    }
    requirePositiveVersion(value.ticketVersion, `${label}.ticketVersion`);
  }

  private corrupt(message: string): never {
    throw new TicketStoreCorruptionError(message);
  }

  private encodeCursor(workflowId: WorkflowId, position: number): string {
    return `ticket:${encodeURIComponent(workflowId)}:${position}`;
  }

  private decodeCursor(
    workflowId: WorkflowId,
    cursor: { source: "ticket"; partitionId: WorkflowId; position: string },
    lastDurablePosition: number,
  ): number {
    if (cursor.source !== "ticket") {
      throw new TicketStoreCursorError(`Cursor source ${String(cursor.source)} is not ticket`);
    }
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
    if (position > lastDurablePosition) {
      throw new TicketStoreCursorError(
        `Cursor position ${position} is beyond durable outbox position ${lastDurablePosition}`,
      );
    }
    return position;
  }

  private storageIdentity(workflowId: WorkflowId): TicketStorageIdentity {
    return { taskId: this.taskId, taskRunId: this.taskRunId, workflowId };
  }

  private file(workflowId: WorkflowId): string {
    return ticketEngineFile(this.workspaceRoot, this.taskId, this.taskRunId, workflowId);
  }

  private lockFile(workflowId: WorkflowId): string {
    return ticketEngineLockFile(this.workspaceRoot, this.taskId, this.taskRunId, workflowId);
  }

  private enqueue<T>(workflowId: WorkflowId, operation: () => Promise<T>): Promise<T> {
    const key = this.file(workflowId).toLowerCase();
    const previous = workflowWriteQueues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.withWorkflowLock(workflowId, operation));
    workflowWriteQueues.set(key, next);
    return next.finally(() => {
      if (workflowWriteQueues.get(key) === next) workflowWriteQueues.delete(key);
    });
  }

  private async withWorkflowLock<T>(workflowId: WorkflowId, operation: () => Promise<T>): Promise<T> {
    const lock = await this.acquireWorkflowLock(workflowId);
    try {
      return await operation();
    } finally {
      await this.releaseWorkflowLock(lock.file, lock.token);
    }
  }

  private async acquireWorkflowLock(workflowId: WorkflowId): Promise<{ file: string; token: string }> {
    const file = this.lockFile(workflowId);
    await mkdir(path.dirname(file), { recursive: true });
    const deadline = Date.now() + this.options.lockWaitTimeoutMs;

    while (true) {
      const token = randomUUID();
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(file, "wx", 0o600);
        const metadata: WorkflowLockMetadata = {
          token,
          pid: process.pid,
          hostname: os.hostname(),
          createdAt: new Date().toISOString(),
        };
        await handle.writeFile(`${JSON.stringify(metadata)}\n`, "utf8");
        await handle.sync();
        await handle.close();
        return { file, token };
      } catch (error) {
        await handle?.close().catch(() => undefined);
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          if (handle) await rm(file, { force: true }).catch(() => undefined);
          throw error;
        }
      }

      if (await this.recoverStaleLock(file)) continue;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for Ticket workflow lock ${workflowId}`);
      }
      await delay(this.options.lockRetryMs);
    }
  }

  private async recoverStaleLock(file: string): Promise<boolean> {
    let firstContent: string;
    let firstStat: Awaited<ReturnType<typeof stat>>;
    try {
      [firstContent, firstStat] = await Promise.all([readFile(file, "utf8"), stat(file)]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      return false;
    }
    if (Date.now() - firstStat.mtimeMs <= this.options.lockStaleMs) return false;

    const metadata = parseLockMetadata(firstContent);
    if (metadata?.hostname === os.hostname() && isProcessAlive(metadata.pid)) return false;

    try {
      const [latestContent, latestStat] = await Promise.all([readFile(file, "utf8"), stat(file)]);
      if (latestContent !== firstContent || latestStat.mtimeMs !== firstStat.mtimeMs) return false;
      await rm(file);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
  }

  private async releaseWorkflowLock(file: string, token: string): Promise<void> {
    try {
      const metadata = parseLockMetadata(await readFile(file, "utf8"));
      if (metadata?.token === token) await rm(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

const WORKFLOW_STATUSES = new Set(["active", "paused", "blocked", "completed", "failed", "cancelled"]);
const TICKET_STATUSES = new Set([
  "pending",
  "ready",
  "running",
  "blocked",
  "completed",
  "returned",
  "failed",
  "cancelled",
]);
const EVENT_TYPES = new Set([
  "TicketReady",
  "TicketClaimed",
  "ClaimExpired",
  "TicketBlocked",
  "TicketTerminal",
  "AuthorityRevoked",
  "WorkflowStatusChanged",
]);

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TicketStoreCorruptionError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new TicketStoreCorruptionError(`${label} must be an array`);
  return value;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TicketStoreCorruptionError(`${label} must be a non-empty string`);
  }
  return value;
}

function requirePositiveVersion(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new TicketStoreCorruptionError(`${label} must be a positive integer`);
  }
  return Number(value);
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TicketStoreCorruptionError(`${label} must be a non-negative integer`);
  }
  return Number(value);
}

function parseLockMetadata(content: string): WorkflowLockMetadata | undefined {
  try {
    const value = JSON.parse(content) as Partial<WorkflowLockMetadata>;
    if (
      typeof value.token !== "string"
      || typeof value.pid !== "number"
      || typeof value.hostname !== "string"
      || typeof value.createdAt !== "string"
    ) return undefined;
    return value as WorkflowLockMetadata;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function writeDurableJson(file: string, value: unknown): Promise<void> {
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await renameWithRetry(temporary, file);
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function renameWithRetry(source: string, target: string): Promise<void> {
  for (let attempt = 0; attempt < RENAME_MAX_ATTEMPTS; attempt += 1) {
    try {
      await rename(source, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!new Set(["EPERM", "EBUSY", "ENOTEMPTY"]).has(String(code)) || attempt === RENAME_MAX_ATTEMPTS - 1) {
        throw error;
      }
      await delay(25 * (attempt + 1));
    }
  }
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") {
    // Node cannot open directories for FlushFileBuffers on Windows. The temporary file itself is
    // flushed before the atomic rename; POSIX additionally persists the directory entry below.
    return;
  }
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
