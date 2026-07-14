import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  BlockedOwnershipReceipt,
  ClaimCommandResult,
  ClaimReceipt,
  PlanCommandResult,
  PlanId,
  PlanSnapshot,
  TicketCommandResult,
  TicketDefinition,
  TicketEvent,
  TicketEventPage,
  TicketEventQuery,
  TicketId,
  TicketSnapshot,
} from "../../shared/contracts/ticket-engine.js";
import { ticketEngineFile, ticketEngineLockFile } from "../storage/paths.js";

export type TicketStoredCommandResult = TicketCommandResult | PlanCommandResult | ClaimCommandResult;
export interface TicketStoredCommandInput { commandId: string; fingerprint: string }
export type TicketOperationRecord =
  | { kind: "claim"; requestId: string; fingerprint: string; claim: ClaimReceipt }
  | { kind: "renew_claim"; requestId: string; fingerprint: string; claim: ClaimReceipt }
  | { kind: "release_claim"; requestId: string; fingerprint: string; ticket: TicketSnapshot }
  | { kind: "transfer_blocked_ownership"; requestId: string; fingerprint: string; ownership: BlockedOwnershipReceipt };

export interface TicketOutboxEntry { position: number; event: TicketEvent }
export interface TicketStorageIdentity { taskId: string; taskRunId: string; planId: PlanId }

export interface TicketAggregate {
  schemaVersion: 3;
  storageIdentity: TicketStorageIdentity;
  aggregateVersion: number;
  plan: PlanSnapshot;
  definitionsByTicketId: Record<string, TicketDefinition>;
  tickets: TicketSnapshot[];
  claims: ClaimReceipt[];
  blockedOwnerships: BlockedOwnershipReceipt[];
  operationRecords: TicketOperationRecord[];
  commandInputs: TicketStoredCommandInput[];
  commandResults: TicketStoredCommandResult[];
  outbox: TicketOutboxEntry[];
}

export interface TicketAggregateSeed {
  schemaVersion: 3;
  plan: PlanSnapshot;
  definitionsByTicketId: Record<string, TicketDefinition>;
  tickets: TicketSnapshot[];
  claims?: ClaimReceipt[];
  blockedOwnerships?: BlockedOwnershipReceipt[];
  operationRecords?: TicketOperationRecord[];
  commandInputs?: TicketStoredCommandInput[];
  commandResults?: TicketStoredCommandResult[];
  pendingEvents?: TicketEvent[];
}

export interface TicketAggregateExpectedVersion { aggregateVersion: number; planVersion: number }
export type TicketAggregateMutation = TicketAggregate & { pendingEvents?: TicketEvent[] };
export interface TicketStoreOptions { lockWaitTimeoutMs?: number; lockRetryMs?: number; lockStaleMs?: number }

interface ResolvedTicketStoreOptions { lockWaitTimeoutMs: number; lockRetryMs: number; lockStaleMs: number }
interface PlanLockMetadata { token: string; pid: number; hostname: string; createdAt: string }

export class TicketStoreConflictError extends Error {}
export class TicketStoreCursorError extends Error {}
export class TicketStoreCorruptionError extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); }
}

const writeQueues = new Map<string, Promise<unknown>>();
const DEFAULT_OPTIONS: ResolvedTicketStoreOptions = { lockWaitTimeoutMs: 60_000, lockRetryMs: 10, lockStaleMs: 30_000 };
const TERMINAL = new Set(["completed", "returned", "failed", "cancelled"]);

export class TicketStore {
  private readonly options: ResolvedTicketStoreOptions;

  constructor(
    private readonly workspaceRoot: string,
    private readonly taskId: string,
    private readonly taskRunId: string,
    options: TicketStoreOptions = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  async create(seed: TicketAggregateSeed): Promise<TicketAggregate> {
    return this.enqueue(seed.plan.planId, async () => {
      if (await this.readFromDisk(seed.plan.planId)) throw new TicketStoreConflictError(`Plan ${seed.plan.planId} already exists`);
      const pendingEvents = seed.pendingEvents ?? [];
      const aggregate: TicketAggregate = {
        schemaVersion: 3,
        storageIdentity: this.storageIdentity(seed.plan.planId),
        aggregateVersion: 1,
        plan: structuredClone(seed.plan),
        definitionsByTicketId: structuredClone(seed.definitionsByTicketId),
        tickets: structuredClone(seed.tickets),
        claims: structuredClone(seed.claims ?? []),
        blockedOwnerships: structuredClone(seed.blockedOwnerships ?? []),
        operationRecords: structuredClone(seed.operationRecords ?? []),
        commandInputs: structuredClone(seed.commandInputs ?? []),
        commandResults: structuredClone(seed.commandResults ?? []),
        outbox: pendingEvents.map((event, index) => ({ position: index + 1, event: structuredClone(event) })),
      };
      this.validate(aggregate, seed.plan.planId);
      await writeDurableJson(this.file(seed.plan.planId), aggregate);
      return structuredClone(aggregate);
    });
  }

  async read(planId: PlanId): Promise<TicketAggregate | undefined> {
    const value = await this.readFromDisk(planId);
    return value ? structuredClone(value) : undefined;
  }

  async transact(
    planId: PlanId,
    expected: TicketAggregateExpectedVersion,
    mutate: (current: TicketAggregate) => TicketAggregateMutation | Promise<TicketAggregateMutation>,
  ): Promise<TicketAggregate> {
    return this.enqueue(planId, async () => {
      const current = await this.requireAggregate(planId);
      if (current.aggregateVersion !== expected.aggregateVersion || current.plan.version !== expected.planVersion) {
        throw new TicketStoreConflictError(`Plan ${planId} version conflict`);
      }
      const proposed = await mutate(structuredClone(current));
      if (proposed.plan.version !== current.plan.version + 1) {
        throw new TicketStoreConflictError(`Plan ${planId} must increment version exactly once`);
      }
      let position = current.outbox.at(-1)?.position ?? 0;
      const next: TicketAggregate = {
        schemaVersion: 3,
        storageIdentity: this.storageIdentity(planId),
        aggregateVersion: current.aggregateVersion + 1,
        plan: structuredClone(proposed.plan),
        definitionsByTicketId: structuredClone(proposed.definitionsByTicketId),
        tickets: structuredClone(proposed.tickets),
        claims: structuredClone(proposed.claims),
        blockedOwnerships: structuredClone(proposed.blockedOwnerships),
        operationRecords: structuredClone(proposed.operationRecords),
        commandInputs: structuredClone(proposed.commandInputs),
        commandResults: structuredClone(proposed.commandResults),
        outbox: [...current.outbox, ...(proposed.pendingEvents ?? []).map((event) => ({ position: ++position, event: structuredClone(event) }))],
      };
      this.validateTransition(current, next);
      this.validate(next, planId);
      await writeDurableJson(this.file(planId), next);
      return structuredClone(next);
    });
  }

  async getCommandResult(planId: PlanId, commandId: string): Promise<TicketStoredCommandResult | undefined> {
    const value = (await this.readFromDisk(planId))?.commandResults.find((item) => item.commandId === commandId);
    return value ? structuredClone(value) : undefined;
  }

  async getCommandInput(planId: PlanId, commandId: string): Promise<TicketStoredCommandInput | undefined> {
    const value = (await this.readFromDisk(planId))?.commandInputs.find((item) => item.commandId === commandId);
    return value ? structuredClone(value) : undefined;
  }

  async getOperationRecord(planId: PlanId, requestId: string): Promise<TicketOperationRecord | undefined> {
    const value = (await this.readFromDisk(planId))?.operationRecords.find((item) => item.requestId === requestId);
    return value ? structuredClone(value) : undefined;
  }

  async recordCommandResult(planId: PlanId, input: TicketStoredCommandInput, result: TicketStoredCommandResult): Promise<TicketAggregate> {
    return this.enqueue(planId, async () => {
      const current = await this.requireAggregate(planId);
      const existingInput = current.commandInputs.find((item) => item.commandId === input.commandId);
      const existingResult = current.commandResults.find((item) => item.commandId === input.commandId);
      if (existingInput || existingResult) {
        if (!existingResult || existingInput?.fingerprint !== input.fingerprint) throw new TicketStoreConflictError(`Command ${input.commandId} idempotency conflict`);
        return structuredClone(current);
      }
      const next = {
        ...current,
        aggregateVersion: current.aggregateVersion + 1,
        commandInputs: [...current.commandInputs, structuredClone(input)],
        commandResults: [...current.commandResults, structuredClone(result)],
      };
      this.validate(next, planId);
      await writeDurableJson(this.file(planId), next);
      return structuredClone(next);
    });
  }

  async listPlanIds(): Promise<PlanId[]> {
    const directory = path.dirname(this.file("index" as PlanId));
    let names: string[];
    try { names = await readdir(directory); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const ids: PlanId[] = [];
    for (const name of names.filter((item) => item.endsWith(".json")).sort()) {
      const raw = JSON.parse(await readFile(path.join(directory, name), "utf8")) as { schemaVersion?: number; storageIdentity?: { planId?: string } };
      if (raw.schemaVersion !== 3 || !raw.storageIdentity?.planId) continue;
      const planId = raw.storageIdentity.planId as PlanId;
      this.validate(raw, planId);
      ids.push(planId);
    }
    return ids;
  }

  async findClaim(claimId: string): Promise<ClaimReceipt | undefined> {
    for (const planId of await this.listPlanIds()) {
      const claim = (await this.readFromDisk(planId))?.claims.find((item) => item.claimId === claimId);
      if (claim) return structuredClone(claim);
    }
    return undefined;
  }

  async findOperationRecord(requestId: string): Promise<TicketOperationRecord | undefined> {
    for (const planId of await this.listPlanIds()) {
      const record = await this.getOperationRecord(planId, requestId);
      if (record) return record;
    }
    return undefined;
  }

  async findBlockedOwnership(ownershipId: string): Promise<BlockedOwnershipReceipt | undefined> {
    for (const planId of await this.listPlanIds()) {
      const value = (await this.readFromDisk(planId))?.blockedOwnerships.find((item) => item.ownershipId === ownershipId);
      if (value) return structuredClone(value);
    }
    return undefined;
  }

  async readEvents<TPlanId extends PlanId>(query: TicketEventQuery<TPlanId>): Promise<TicketEventPage<TPlanId>> {
    if (!Number.isInteger(query.limit) || query.limit < 1) throw new TicketStoreCursorError("Event page limit must be positive");
    const aggregate = await this.readFromDisk(query.planId);
    const last = aggregate?.outbox.at(-1)?.position ?? 0;
    const after = query.after ? this.decodeCursor(query.planId, query.after.position, last) : 0;
    const entries = (aggregate?.outbox ?? []).filter((item) => item.position > after).slice(0, query.limit);
    const position = entries.at(-1)?.position ?? after;
    return {
      events: structuredClone(entries.map((item) => item.event)) as TicketEventPage<TPlanId>["events"],
      nextCursor: { source: "ticket", partitionId: query.planId, position: this.encodeCursor(query.planId, position) },
    };
  }

  private validate(value: unknown, planId: PlanId): asserts value is TicketAggregate {
    if (!value || typeof value !== "object") throw new TicketStoreCorruptionError("Ticket aggregate must be an object");
    const aggregate = value as Partial<TicketAggregate>;
    if (aggregate.schemaVersion !== 3) throw new TicketStoreCorruptionError("Only Ticket aggregate schema v3 is schedulable");
    if (aggregate.storageIdentity?.planId !== planId || aggregate.plan?.planId !== planId) throw new TicketStoreCorruptionError("Plan identity mismatch");
    if (!Array.isArray(aggregate.tickets) || !aggregate.definitionsByTicketId) throw new TicketStoreCorruptionError("Plan Tickets are missing");
    const ids = new Set<string>();
    for (const ticket of aggregate.tickets) {
      if (ticket.planId !== planId || ids.has(String(ticket.ticketId))) throw new TicketStoreCorruptionError("Duplicate or foreign Ticket");
      ids.add(String(ticket.ticketId));
      if (!aggregate.definitionsByTicketId[String(ticket.ticketId)]) throw new TicketStoreCorruptionError(`Definition missing for Ticket ${ticket.ticketId}`);
    }
    if (aggregate.plan?.graph.ticketIds.some((ticketId) => !ids.has(String(ticketId)))) throw new TicketStoreCorruptionError("Plan graph references unknown Ticket");
  }

  private validateTransition(previous: TicketAggregate, next: TicketAggregate): void {
    const nextById = new Map(next.tickets.map((ticket) => [String(ticket.ticketId), ticket]));
    for (const ticket of previous.tickets) {
      const current = nextById.get(String(ticket.ticketId));
      if (!current) throw new TicketStoreCorruptionError(`Historical Ticket ${ticket.ticketId} was removed`);
      if (TERMINAL.has(ticket.status) && (current.status !== ticket.status || current.version !== ticket.version)) {
        throw new TicketStoreCorruptionError(`Terminal Ticket ${ticket.ticketId} is immutable`);
      }
    }
    const oldEdges = new Set(previous.plan.graph.dependencyEdges.map((edge) => `${edge.fromTicketId}\0${edge.toTicketId}`));
    const newEdges = new Set(next.plan.graph.dependencyEdges.map((edge) => `${edge.fromTicketId}\0${edge.toTicketId}`));
    for (const edge of oldEdges) if (!newEdges.has(edge)) throw new TicketStoreCorruptionError("Historical dependency edge was removed");
  }

  private async requireAggregate(planId: PlanId): Promise<TicketAggregate> {
    const value = await this.readFromDisk(planId);
    if (!value) throw new Error(`Plan ${planId} does not exist`);
    return value;
  }

  private async readFromDisk(planId: PlanId): Promise<TicketAggregate | undefined> {
    let raw: string;
    try { raw = await readFile(this.file(planId), "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    let value: unknown;
    try { value = JSON.parse(raw); } catch (error) { throw new TicketStoreCorruptionError(`Plan ${planId} contains invalid JSON`, { cause: error }); }
    this.validate(value, planId);
    return value;
  }

  private storageIdentity(planId: PlanId): TicketStorageIdentity { return { taskId: this.taskId, taskRunId: this.taskRunId, planId }; }
  private file(planId: PlanId): string { return ticketEngineFile(this.workspaceRoot, this.taskId, this.taskRunId, planId); }
  private lockFile(planId: PlanId): string { return ticketEngineLockFile(this.workspaceRoot, this.taskId, this.taskRunId, planId); }
  private encodeCursor(planId: PlanId, position: number): string { return `ticket:${encodeURIComponent(planId)}:${position}`; }
  private decodeCursor(planId: PlanId, value: string, last: number): number {
    const prefix = `ticket:${encodeURIComponent(planId)}:`;
    if (!value.startsWith(prefix)) throw new TicketStoreCursorError("Cursor belongs to another Plan");
    const position = Number(value.slice(prefix.length));
    if (!Number.isSafeInteger(position) || position < 0 || position > last) throw new TicketStoreCursorError("Cursor position is invalid");
    return position;
  }

  private enqueue<T>(planId: PlanId, operation: () => Promise<T>): Promise<T> {
    const key = this.file(planId).toLowerCase();
    const previous = writeQueues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.withLock(planId, operation));
    writeQueues.set(key, next);
    return next.finally(() => { if (writeQueues.get(key) === next) writeQueues.delete(key); });
  }

  private async withLock<T>(planId: PlanId, operation: () => Promise<T>): Promise<T> {
    const lock = await this.acquireLock(planId);
    try { return await operation(); } finally { await this.releaseLock(lock.file, lock.token); }
  }

  private async acquireLock(planId: PlanId): Promise<{ file: string; token: string }> {
    const file = this.lockFile(planId);
    await mkdir(path.dirname(file), { recursive: true });
    const deadline = Date.now() + this.options.lockWaitTimeoutMs;
    while (true) {
      const token = randomUUID();
      try {
        const handle = await open(file, "wx", 0o600);
        const metadata: PlanLockMetadata = { token, pid: process.pid, hostname: os.hostname(), createdAt: new Date().toISOString() };
        await handle.writeFile(`${JSON.stringify(metadata)}\n`, "utf8");
        await handle.sync();
        await handle.close();
        return { file, token };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      if (await this.recoverStaleLock(file)) continue;
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for Plan lock ${planId}`);
      await delay(this.options.lockRetryMs);
    }
  }

  private async recoverStaleLock(file: string): Promise<boolean> {
    try {
      const [content, info] = await Promise.all([readFile(file, "utf8"), stat(file)]);
      if (Date.now() - info.mtimeMs <= this.options.lockStaleMs) return false;
      const metadata = parseLockMetadata(content);
      if (metadata?.hostname === os.hostname() && isProcessAlive(metadata.pid)) return false;
      await rm(file);
      return true;
    } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
  }

  private async releaseLock(file: string, token: string): Promise<void> {
    try { if (parseLockMetadata(await readFile(file, "utf8"))?.token === token) await rm(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

function parseLockMetadata(content: string): PlanLockMetadata | undefined {
  try { return JSON.parse(content) as PlanLockMetadata; } catch { return undefined; }
}
function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}
async function writeDurableJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    await renameWithRetry(temporary, file);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
async function renameWithRetry(source: string, target: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try { await rename(source, target); return; }
    catch (error) {
      if (attempt >= 5 || !new Set(["EPERM", "EBUSY", "ENOTEMPTY"]).has(String((error as NodeJS.ErrnoException).code))) throw error;
      await delay(25 * (attempt + 1));
    }
  }
}
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
