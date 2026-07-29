import { randomUUID } from "node:crypto";
import os from "node:os";
import { mkdir, open, readFile, rm, stat, utimes } from "node:fs/promises";
import path from "node:path";
import type {
  AgentEvent,
  AgentEventPage,
  AgentEventQuery,
  AgentGoal,
  AgentThreadItem,
  AgentThreadSnapshot,
  GoalResolutionProposal,
  SettleProposalResult,
} from "../../shared/contracts/agent-engine.js";
import {
  agentEngineLegacyAggregateFile,
  agentEngineExecutionLeaseFile,
  agentEngineLockFile,
  agentEngineRolloutFile,
} from "../storage/paths.js";

export interface AgentStoredPayload {
  payloadRef: string;
  value: unknown;
}

export interface AgentDecisionRecord {
  decisionId: string;
  proposalId: string;
  fingerprint: string;
  result: SettleProposalResult;
}

export interface AgentControlRecord {
  requestId: string;
  fingerprint: string;
  goal: AgentGoal;
}

export interface AgentStoreAggregate {
  schemaVersion: 2;
  agentId: string;
  aggregateVersion: number;
  threads: AgentThreadSnapshot[];
  threadKeys: Array<{ idempotencyKey: string; scopeId: string; threadId: string }>;
  messageIds: Array<{ messageId: string; threadId: string; fingerprint: string }>;
  payloads: AgentStoredPayload[];
  goals: AgentGoal[];
  goalStartKeys: Array<{ idempotencyKey: string; goalId: string; fingerprint: string }>;
  proposals: GoalResolutionProposal[];
  decisions: AgentDecisionRecord[];
  controls: AgentControlRecord[];
  outbox: Array<{ position: number; event: AgentEvent }>;
}

export type AgentStoreMutation = AgentStoreAggregate & { pendingEvents?: AgentEvent[] };

interface StoredThreadDelta {
  threadId: string;
  create?: Omit<AgentThreadSnapshot, "items">;
  expectedVersion: number;
  version: number;
  appendedItems: AgentThreadItem[];
}

interface AgentStoreCommit {
  schemaVersion: 1;
  type: "agent_store_commit";
  agentId: string;
  aggregateVersion: number;
  occurredAt: string;
  threads: StoredThreadDelta[];
  threadKeys: AgentStoreAggregate["threadKeys"];
  messageIds: AgentStoreAggregate["messageIds"];
  payloads: AgentStoredPayload[];
  goals: AgentGoal[];
  goalStartKeys: AgentStoreAggregate["goalStartKeys"];
  proposals: GoalResolutionProposal[];
  decisions: AgentDecisionRecord[];
  controls: AgentControlRecord[];
  outbox: AgentStoreAggregate["outbox"];
}

interface AgentStoreSnapshot {
  schemaVersion: 1;
  type: "agent_store_snapshot";
  agentId: string;
  aggregateVersion: number;
  occurredAt: string;
  aggregate: AgentStoreAggregate;
}

export class AgentStoreCursorError extends Error {}
export class AgentStoreConflictError extends Error {}
export class AgentStoreCorruptionError extends Error {}

export interface AgentStoreOptions {
  lockWaitTimeoutMs?: number;
  lockRetryMs?: number;
  lockStaleMs?: number;
  executionLeaseStaleMs?: number;
  executionLeaseHeartbeatMs?: number;
}

interface ResolvedAgentStoreOptions {
  lockWaitTimeoutMs: number;
  lockRetryMs: number;
  lockStaleMs: number;
  executionLeaseStaleMs: number;
  executionLeaseHeartbeatMs: number;
}

const DEFAULT_OPTIONS: ResolvedAgentStoreOptions = {
  lockWaitTimeoutMs: 60_000,
  lockRetryMs: 10,
  lockStaleMs: 30_000,
  executionLeaseStaleMs: 120_000,
  executionLeaseHeartbeatMs: 10_000,
};

const queues = new Map<string, Promise<unknown>>();

export class AgentStore {
  private readonly file: string;
  private readonly legacyFile: string;
  private readonly lockFile: string;
  private readonly executionLeaseFile: string;
  private readonly options: ResolvedAgentStoreOptions;
  private cached?: { size: number; mtimeMs: number; aggregate: AgentStoreAggregate };

  constructor(
    workspaceRoot: string,
    readonly agentId: string,
    options: AgentStoreOptions = {},
  ) {
    if (!agentId.trim()) throw new Error("agentId is required");
    this.file = agentEngineRolloutFile(workspaceRoot, agentId);
    this.legacyFile = agentEngineLegacyAggregateFile(workspaceRoot, agentId);
    this.lockFile = agentEngineLockFile(workspaceRoot, agentId);
    this.executionLeaseFile = agentEngineExecutionLeaseFile(workspaceRoot, agentId);
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  async executionLeaseHeld(): Promise<boolean> {
    try {
      await stat(this.executionLeaseFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    if (await this.recoverStaleExecutionLease()) return false;
    return true;
  }

  async withExecutionLease<T>(
    operation: () => Promise<T>,
  ): Promise<{ acquired: true; value: T } | { acquired: false }> {
    const token = await this.tryAcquireExecutionLease();
    if (!token) return { acquired: false };
    const heartbeat = setInterval(() => {
      void this.heartbeatExecutionLease(token);
    }, this.options.executionLeaseHeartbeatMs);
    heartbeat.unref();
    try {
      return { acquired: true, value: await operation() };
    } finally {
      clearInterval(heartbeat);
      await this.releaseExecutionLease(token);
    }
  }

  async read(): Promise<AgentStoreAggregate> {
    let info;
    try {
      info = await stat(this.file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        const queuedWrite = queues.get(this.file.toLowerCase());
        if (queuedWrite) {
          await queuedWrite.catch(() => undefined);
          return this.read();
        }
        try {
          await stat(this.legacyFile);
          return this.withLock(() => this.loadRolloutFromDisk());
        } catch (legacyError) {
          if ((legacyError as NodeJS.ErrnoException).code !== "ENOENT") throw legacyError;
        }
        const aggregate = emptyAggregate(this.agentId);
        this.cached = { size: 0, mtimeMs: 0, aggregate };
        return aggregate;
      }
      throw error;
    }
    if (this.cached?.size === info.size && this.cached.mtimeMs === info.mtimeMs) {
      return this.cached.aggregate;
    }
    return this.loadRollout(info.size, info.mtimeMs);
  }

  async transact(
    mutate: (current: AgentStoreAggregate) => AgentStoreMutation | Promise<AgentStoreMutation>,
  ): Promise<AgentStoreAggregate> {
    const key = this.file.toLowerCase();
    const previous = queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.withLock(async () => {
      const current = await this.loadRolloutFromDisk();
      const proposed = await mutate(current);
      if (proposed.aggregateVersion === current.aggregateVersion && !proposed.pendingEvents?.length) {
        return current;
      }
      if (proposed.aggregateVersion !== current.aggregateVersion + 1) {
        throw new AgentStoreConflictError("Agent aggregate version must increase by exactly one");
      }
      const pendingEvents = proposed.pendingEvents ?? [];
      const outbox = [...current.outbox];
      let position = outbox.at(-1)?.position ?? 0;
      for (const event of pendingEvents) outbox.push({ position: ++position, event: structuredClone(event) });
      const { pendingEvents: _pendingEvents, ...persisted } = proposed;
      const candidate = { ...persisted, outbox };
      validateAggregate(candidate, this.agentId);
      // Canonicalize only the incremental commit. Re-serializing the complete
      // aggregate on every append makes a long-running thread progressively
      // slower and causes quadratic work. Applying the canonical commit keeps
      // the hot projection byte-equivalent to a projection recovered from JSONL.
      const commit = JSON.parse(JSON.stringify(createCommit(current, candidate))) as AgentStoreCommit;
      validateCommit(commit, this.agentId, current.aggregateVersion + 1);
      const aggregate = applyCommit(current, commit);
      await this.appendCommit(commit);
      const info = await stat(this.file);
      this.cached = { size: info.size, mtimeMs: info.mtimeMs, aggregate };
      return aggregate;
    }));
    queues.set(key, next);
    try {
      return await next;
    } finally {
      if (queues.get(key) === next) queues.delete(key);
    }
  }

  async readEvents<TAgentId extends string>(
    query: AgentEventQuery<TAgentId>,
  ): Promise<AgentEventPage<AgentEvent, TAgentId>> {
    if (query.agentId !== this.agentId) throw new AgentStoreCursorError("Agent partition mismatch");
    if (!Number.isInteger(query.limit) || query.limit < 1) {
      throw new AgentStoreCursorError("Event page limit must be positive");
    }
    const aggregate = await this.read();
    const after = query.after ? decodeCursor(query.after, query.agentId, aggregate.outbox.length) : 0;
    const entries = aggregate.outbox.filter((entry) => entry.position > after).slice(0, query.limit);
    const position = entries.at(-1)?.position ?? after;
    return {
      events: entries.map((entry) => structuredClone(entry.event)),
      nextCursor: {
        source: "agent",
        partitionId: query.agentId,
        position: encodeCursor(query.agentId, position),
      },
    };
  }

  async payload(payloadRef: string): Promise<unknown> {
    return structuredClone((await this.read()).payloads.find((item) => item.payloadRef === payloadRef)?.value);
  }

  async payloads(payloadRefs: readonly string[]): Promise<Map<string, unknown>> {
    const wanted = new Set(payloadRefs);
    return new Map(
      (await this.read()).payloads
        .filter((item) => wanted.has(item.payloadRef))
        .map((item) => [item.payloadRef, structuredClone(item.value)]),
    );
  }

  private async loadRolloutFromDisk(): Promise<AgentStoreAggregate> {
    try {
      const info = await stat(this.file);
      if (this.cached?.size === info.size && this.cached.mtimeMs === info.mtimeMs) {
        return this.cached.aggregate;
      }
      return this.loadRollout(info.size, info.mtimeMs);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        const migrated = await this.migrateLegacyAggregate();
        if (migrated) return migrated;
        const aggregate = emptyAggregate(this.agentId);
        this.cached = { size: 0, mtimeMs: 0, aggregate };
        return aggregate;
      }
      throw error;
    }
  }

  private async loadRollout(size: number, mtimeMs: number): Promise<AgentStoreAggregate> {
    let content: string;
    try {
      content = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyAggregate(this.agentId);
      throw error;
    }
    let aggregate = emptyAggregate(this.agentId);
    let hasStateRecord = false;
    const lines = content.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!.trim();
      if (!line) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        // Match Codex rollout recovery: malformed JSONL records do not discard
        // the valid ordered history around them.
        continue;
      }
      if ((value as { type?: unknown })?.type === "agent_store_snapshot") {
        validateSnapshot(value, this.agentId, hasStateRecord);
        aggregate = structuredClone(value.aggregate);
      } else {
        validateCommit(value, this.agentId, aggregate.aggregateVersion + 1);
        aggregate = applyCommit(aggregate, value);
      }
      hasStateRecord = true;
    }
    validateAggregate(aggregate, this.agentId);
    this.cached = { size, mtimeMs, aggregate };
    return aggregate;
  }

  private async migrateLegacyAggregate(): Promise<AgentStoreAggregate | undefined> {
    let content: string;
    try {
      content = await readFile(this.legacyFile, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    let aggregate: unknown;
    try {
      aggregate = JSON.parse(content);
    } catch {
      throw new AgentStoreCorruptionError("Legacy Agent aggregate is invalid JSON");
    }
    validateAggregate(aggregate, this.agentId);
    const snapshot: AgentStoreSnapshot = {
      schemaVersion: 1,
      type: "agent_store_snapshot",
      agentId: this.agentId,
      aggregateVersion: aggregate.aggregateVersion,
      occurredAt: new Date().toISOString(),
      aggregate,
    };
    await this.writeSnapshot(snapshot, aggregate);
    return aggregate;
  }

  private async writeSnapshot(
    snapshot: AgentStoreSnapshot,
    aggregate: AgentStoreAggregate,
  ): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const handle = await open(this.file, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(snapshot)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    const info = await stat(this.file);
    this.cached = { size: info.size, mtimeMs: info.mtimeMs, aggregate };
  }

  private async appendCommit(commit: AgentStoreCommit): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const handle = await open(this.file, "a", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(commit)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const token = await this.acquireLock();
    try {
      return await operation();
    } finally {
      await this.releaseLock(token);
    }
  }

  private async acquireLock(): Promise<string> {
    await mkdir(path.dirname(this.lockFile), { recursive: true });
    const deadline = Date.now() + this.options.lockWaitTimeoutMs;
    while (true) {
      const token = randomUUID();
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(this.lockFile, "wx", 0o600);
        await handle.writeFile(`${JSON.stringify({ token, pid: process.pid, hostname: os.hostname() })}\n`, "utf8");
        await handle.sync();
        await handle.close();
        return token;
      } catch (error) {
        await handle?.close().catch(() => undefined);
        if (!await this.isLockContention(error)) throw error;
      }
      if (await this.recoverStaleLock()) continue;
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for Agent lock ${this.agentId}`);
      await delay(this.options.lockRetryMs);
    }
  }

  private async isLockContention(error: unknown): Promise<boolean> {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return true;
    if (code !== "EPERM" && code !== "EACCES") return false;
    try {
      await stat(this.lockFile);
      return true;
    } catch (statError) {
      if ((statError as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw statError;
    }
  }

  private async recoverStaleLock(): Promise<boolean> {
    try {
      const [content, info] = await Promise.all([readFile(this.lockFile, "utf8"), stat(this.lockFile)]);
      if (Date.now() - info.mtimeMs <= this.options.lockStaleMs) return false;
      const metadata = parseLock(content);
      if (metadata?.hostname === os.hostname() && isProcessAlive(metadata.pid)) return false;
      const [latest, latestInfo] = await Promise.all([readFile(this.lockFile, "utf8"), stat(this.lockFile)]);
      if (latest !== content || latestInfo.mtimeMs !== info.mtimeMs) return false;
      await rm(this.lockFile);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
  }

  private async releaseLock(token: string): Promise<void> {
    const deadline = Date.now() + this.options.lockWaitTimeoutMs;
    while (true) {
      try {
        if (parseLock(await readFile(this.lockFile, "utf8"))?.token === token) await rm(this.lockFile);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return;
        if ((code !== "EPERM" && code !== "EACCES") || Date.now() >= deadline) throw error;
        await delay(this.options.lockRetryMs);
      }
    }
  }

  private async tryAcquireExecutionLease(): Promise<string | undefined> {
    await mkdir(path.dirname(this.executionLeaseFile), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = randomUUID();
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(this.executionLeaseFile, "wx", 0o600);
        await handle.writeFile(`${JSON.stringify({
          token,
          pid: process.pid,
          hostname: os.hostname(),
          acquiredAt: new Date().toISOString(),
        })}\n`, "utf8");
        await handle.sync();
        await handle.close();
        return token;
      } catch (error) {
        await handle?.close().catch(() => undefined);
        if (!await this.isExecutionLeaseContention(error)) throw error;
      }
      if (!await this.recoverStaleExecutionLease()) return undefined;
    }
    return undefined;
  }

  private async isExecutionLeaseContention(error: unknown): Promise<boolean> {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return true;
    if (code !== "EPERM" && code !== "EACCES") return false;
    try {
      await stat(this.executionLeaseFile);
      return true;
    } catch (statError) {
      if ((statError as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw statError;
    }
  }

  private async recoverStaleExecutionLease(): Promise<boolean> {
    try {
      const [content, info] = await Promise.all([
        readFile(this.executionLeaseFile, "utf8"),
        stat(this.executionLeaseFile),
      ]);
      const metadata = parseLock(content);
      const locallyOwned = metadata?.hostname === os.hostname();
      if (locallyOwned && isProcessAlive(metadata.pid)) return false;
      if (!locallyOwned && Date.now() - info.mtimeMs <= this.options.executionLeaseStaleMs) return false;
      const [latest, latestInfo] = await Promise.all([
        readFile(this.executionLeaseFile, "utf8"),
        stat(this.executionLeaseFile),
      ]);
      if (latest !== content || latestInfo.mtimeMs !== info.mtimeMs) return false;
      await rm(this.executionLeaseFile);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
  }

  private async heartbeatExecutionLease(token: string): Promise<void> {
    try {
      if (parseLock(await readFile(this.executionLeaseFile, "utf8"))?.token !== token) return;
      const now = new Date();
      await utimes(this.executionLeaseFile, now, now);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async releaseExecutionLease(token: string): Promise<void> {
    try {
      if (parseLock(await readFile(this.executionLeaseFile, "utf8"))?.token === token) {
        await rm(this.executionLeaseFile);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function createCommit(current: AgentStoreAggregate, next: AgentStoreAggregate): AgentStoreCommit {
  return {
    schemaVersion: 1,
    type: "agent_store_commit",
    agentId: next.agentId,
    aggregateVersion: next.aggregateVersion,
    occurredAt: new Date().toISOString(),
    threads: threadDeltas(current.threads, next.threads),
    threadKeys: appended(current.threadKeys, next.threadKeys, "thread keys"),
    messageIds: appended(current.messageIds, next.messageIds, "message ids"),
    payloads: appended(current.payloads, next.payloads, "payloads"),
    goals: changedByKey(current.goals, next.goals, (item) => item.spec.id, "goals"),
    goalStartKeys: appended(current.goalStartKeys, next.goalStartKeys, "goal start keys"),
    proposals: appended(current.proposals, next.proposals, "proposals"),
    decisions: appended(current.decisions, next.decisions, "decisions"),
    controls: appended(current.controls, next.controls, "controls"),
    outbox: appended(current.outbox, next.outbox, "outbox"),
  };
}

function threadDeltas(current: AgentThreadSnapshot[], next: AgentThreadSnapshot[]): StoredThreadDelta[] {
  const currentById = new Map(current.map((thread) => [thread.threadId, thread]));
  if (next.length < current.length) throw new AgentStoreConflictError("Threads cannot be removed");
  const deltas: StoredThreadDelta[] = [];
  for (const thread of next) {
    const previous = currentById.get(thread.threadId);
    if (!previous) {
      deltas.push({
        threadId: thread.threadId,
        create: {
          threadId: thread.threadId,
          agentId: thread.agentId,
          scopeId: thread.scopeId,
          version: thread.version,
        },
        expectedVersion: 0,
        version: thread.version,
        appendedItems: structuredClone(thread.items),
      });
      continue;
    }
    if (previous.agentId !== thread.agentId || previous.scopeId !== thread.scopeId || thread.items.length < previous.items.length) {
      throw new AgentStoreConflictError("Thread identity or history cannot be rewritten");
    }
    for (let index = 0; index < previous.items.length; index += 1) {
      if (!same(previous.items[index], thread.items[index])) {
        throw new AgentStoreConflictError("Thread history must remain an unchanged prefix");
      }
    }
    const appendedItems = thread.items.slice(previous.items.length);
    if (appendedItems.length || thread.version !== previous.version) {
      deltas.push({
        threadId: thread.threadId,
        expectedVersion: previous.version,
        version: thread.version,
        appendedItems: structuredClone(appendedItems),
      });
    }
    currentById.delete(thread.threadId);
  }
  if (currentById.size) throw new AgentStoreConflictError("Threads cannot be removed");
  return deltas;
}

function applyCommit(current: AgentStoreAggregate, commit: AgentStoreCommit): AgentStoreAggregate {
  const threads = structuredClone(current.threads);
  for (const delta of commit.threads) {
    let thread = threads.find((item) => item.threadId === delta.threadId);
    if (!thread) {
      if (!delta.create || delta.expectedVersion !== 0) throw new AgentStoreCorruptionError("Thread creation delta is invalid");
      thread = { ...delta.create, items: [] };
      threads.push(thread);
    } else if (delta.create || thread.version !== delta.expectedVersion) {
      throw new AgentStoreCorruptionError("Thread delta version is invalid");
    }
    thread.items.push(...structuredClone(delta.appendedItems));
    thread.version = delta.version;
  }
  const goals = structuredClone(current.goals);
  for (const goal of commit.goals) {
    const index = goals.findIndex((item) => item.spec.id === goal.spec.id);
    if (index < 0) goals.push(structuredClone(goal));
    else goals[index] = structuredClone(goal);
  }
  const next: AgentStoreAggregate = {
    schemaVersion: 2,
    agentId: current.agentId,
    aggregateVersion: commit.aggregateVersion,
    threads,
    threadKeys: [...current.threadKeys, ...structuredClone(commit.threadKeys)],
    messageIds: [...current.messageIds, ...structuredClone(commit.messageIds)],
    payloads: [...current.payloads, ...structuredClone(commit.payloads)],
    goals,
    goalStartKeys: [...current.goalStartKeys, ...structuredClone(commit.goalStartKeys)],
    proposals: [...current.proposals, ...structuredClone(commit.proposals)],
    decisions: mergeExactDuplicates(
      current.decisions,
      structuredClone(commit.decisions),
      (item) => item.decisionId,
      "decisionId",
    ),
    controls: [...current.controls, ...structuredClone(commit.controls)],
    outbox: [...current.outbox, ...structuredClone(commit.outbox)],
  };
  validateAggregate(next, current.agentId);
  return next;
}

function emptyAggregate(agentId: string): AgentStoreAggregate {
  return {
    schemaVersion: 2,
    agentId,
    aggregateVersion: 0,
    threads: [],
    threadKeys: [],
    messageIds: [],
    payloads: [],
    goals: [],
    goalStartKeys: [],
    proposals: [],
    decisions: [],
    controls: [],
    outbox: [],
  };
}

function validateCommit(value: unknown, agentId: string, expectedVersion: number): asserts value is AgentStoreCommit {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AgentStoreCorruptionError("Agent rollout item must be an object");
  const commit = value as AgentStoreCommit;
  if (commit.schemaVersion !== 1 || commit.type !== "agent_store_commit" || commit.agentId !== agentId
    || commit.aggregateVersion !== expectedVersion) {
    throw new AgentStoreCorruptionError("Agent rollout sequence or identity is invalid");
  }
  for (const field of ["threads", "threadKeys", "messageIds", "payloads", "goals", "goalStartKeys", "proposals", "decisions", "controls", "outbox"] as const) {
    if (!Array.isArray(commit[field])) throw new AgentStoreCorruptionError(`Agent rollout ${field} must be an array`);
  }
}

function validateSnapshot(value: unknown, agentId: string, hasStateRecord: boolean): asserts value is AgentStoreSnapshot {
  if (hasStateRecord || !value || typeof value !== "object" || Array.isArray(value)) {
    throw new AgentStoreCorruptionError("Agent rollout snapshot position is invalid");
  }
  const snapshot = value as AgentStoreSnapshot;
  if (snapshot.schemaVersion !== 1 || snapshot.type !== "agent_store_snapshot" || snapshot.agentId !== agentId
    || snapshot.aggregateVersion !== snapshot.aggregate?.aggregateVersion) {
    throw new AgentStoreCorruptionError("Agent rollout snapshot identity is invalid");
  }
  validateAggregate(snapshot.aggregate, agentId);
}

function validateAggregate(value: unknown, agentId: string): asserts value is AgentStoreAggregate {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AgentStoreCorruptionError("Agent aggregate must be an object");
  const aggregate = value as AgentStoreAggregate;
  if (aggregate.schemaVersion !== 2 || aggregate.agentId !== agentId || !Number.isInteger(aggregate.aggregateVersion)) {
    throw new AgentStoreCorruptionError("Agent aggregate identity is invalid");
  }
  for (const field of ["threads", "threadKeys", "messageIds", "payloads", "goals", "goalStartKeys", "proposals", "decisions", "controls", "outbox"] as const) {
    if (!Array.isArray(aggregate[field])) throw new AgentStoreCorruptionError(`Agent aggregate ${field} must be an array`);
  }
  const threadIds = unique(aggregate.threads.map((item) => item.threadId), "threadId");
  unique(aggregate.threadKeys.map((item) => item.idempotencyKey), "thread idempotency key");
  unique(aggregate.messageIds.map((item) => item.messageId), "messageId");
  unique(aggregate.payloads.map((item) => item.payloadRef), "payloadRef");
  const goalIds = unique(aggregate.goals.map((item) => item.spec.id), "goalId");
  unique(aggregate.goalStartKeys.map((item) => item.idempotencyKey), "goal idempotency key");
  const proposalIds = unique(aggregate.proposals.map((item) => item.proposalId), "proposalId");
  exactDuplicateKeys(aggregate.decisions, (item) => item.decisionId, "decisionId");
  unique(aggregate.controls.map((item) => item.requestId), "control requestId");
  for (const thread of aggregate.threads) {
    if (thread.agentId !== agentId || !threadIds.has(thread.threadId)) throw new AgentStoreCorruptionError("Thread identity is invalid");
    let expected = 1;
    for (const item of thread.items) {
      if (item.sequence !== expected++) throw new AgentStoreCorruptionError("Thread sequence is invalid");
    }
  }
  for (const goal of aggregate.goals) {
    if (!threadIds.has(goal.spec.threadId)) throw new AgentStoreCorruptionError("Goal thread is invalid");
    if (goal.activeProposalId && !proposalIds.has(goal.activeProposalId)) throw new AgentStoreCorruptionError("Goal proposal is invalid");
  }
  for (const proposal of aggregate.proposals) {
    if (!goalIds.has(proposal.goalId)) throw new AgentStoreCorruptionError("Proposal goal is invalid");
  }
  let position = 0;
  const eventsById = new Map<string, AgentEvent>();
  for (const entry of aggregate.outbox) {
    if (entry.position !== ++position) throw new AgentStoreCorruptionError("Agent outbox is invalid");
    const previous = eventsById.get(entry.event.eventId);
    if (previous && !same(previous, entry.event)) throw new AgentStoreCorruptionError("Agent outbox eventId conflicts");
    eventsById.set(entry.event.eventId, entry.event);
  }
}

function mergeExactDuplicates<T>(
  current: T[],
  appendedItems: T[],
  key: (value: T) => string,
  label: string,
): T[] {
  const merged = structuredClone(current);
  const byKey = new Map(merged.map((item) => [key(item), item]));
  for (const item of appendedItems) {
    const previous = byKey.get(key(item));
    if (previous) {
      if (!same(previous, item)) throw new AgentStoreCorruptionError(`Duplicate ${label} conflicts`);
      continue;
    }
    merged.push(item);
    byKey.set(key(item), item);
  }
  return merged;
}

function exactDuplicateKeys<T>(items: T[], key: (value: T) => string, label: string): void {
  const byKey = new Map<string, T>();
  for (const item of items) {
    const id = key(item);
    const previous = byKey.get(id);
    if (previous && !same(previous, item)) throw new AgentStoreCorruptionError(`Duplicate ${label} conflicts`);
    byKey.set(id, item);
  }
}

function appended<T>(current: T[], next: T[], label: string): T[] {
  if (next.length < current.length) throw new AgentStoreConflictError(`${label} cannot be removed`);
  for (let index = 0; index < current.length; index += 1) {
    if (!same(current[index], next[index])) throw new AgentStoreConflictError(`${label} must remain an unchanged prefix`);
  }
  return structuredClone(next.slice(current.length));
}

function changedByKey<T>(current: T[], next: T[], key: (value: T) => string, label: string): T[] {
  const nextKeys = new Set(next.map(key));
  if (current.some((item) => !nextKeys.has(key(item)))) throw new AgentStoreConflictError(`${label} cannot be removed`);
  const currentByKey = new Map(current.map((item) => [key(item), item]));
  return structuredClone(next.filter((item) => !same(currentByKey.get(key(item)), item)));
}

function same(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  return JSON.stringify(left) === JSON.stringify(right);
}

function parseLock(content: string): { token: string; pid: number; hostname: string } | undefined {
  try {
    const value = JSON.parse(content) as Record<string, unknown>;
    if (typeof value.token !== "string" || !Number.isSafeInteger(value.pid) || typeof value.hostname !== "string") return undefined;
    return value as { token: string; pid: number; hostname: string };
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function unique(values: string[], label: string): Set<string> {
  const set = new Set(values);
  if (set.size !== values.length) throw new AgentStoreCorruptionError(`Duplicate ${label}`);
  return set;
}

function encodeCursor(agentId: string, position: number): string {
  return Buffer.from(JSON.stringify({ v: 1, agentId, position })).toString("base64url");
}

function decodeCursor(cursor: { source: "agent"; partitionId: string; position: string }, agentId: string, max: number): number {
  if (cursor.source !== "agent" || cursor.partitionId !== agentId) throw new AgentStoreCursorError("Cursor partition mismatch");
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor.position, "base64url").toString("utf8"));
  } catch {
    throw new AgentStoreCursorError("Cursor is invalid");
  }
  const record = value as { v?: unknown; agentId?: unknown; position?: unknown };
  if (record.v !== 1 || record.agentId !== agentId || !Number.isInteger(record.position) || Number(record.position) < 0 || Number(record.position) > max) {
    throw new AgentStoreCursorError("Cursor is invalid");
  }
  return Number(record.position);
}
