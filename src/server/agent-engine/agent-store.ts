import type {
  AgentEvent,
  AgentEventPage,
  AgentEventQuery,
  AgentGoal,
  AgentThreadSnapshot,
  GoalResolutionProposal,
  SettleProposalResult,
} from "../../shared/contracts/agent-engine.js";
import { agentEngineFile, agentEngineLockFile } from "../storage/paths.js";

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

export class AgentStoreCursorError extends Error {}
export class AgentStoreConflictError extends Error {}
export class AgentStoreCorruptionError extends Error {}

export interface AgentStoreOptions {
  lockWaitTimeoutMs?: number;
  lockRetryMs?: number;
  lockStaleMs?: number;
}

interface ResolvedAgentStoreOptions {
  lockWaitTimeoutMs: number;
  lockRetryMs: number;
  lockStaleMs: number;
}

const DEFAULT_OPTIONS: ResolvedAgentStoreOptions = {
  lockWaitTimeoutMs: 60_000,
  lockRetryMs: 10,
  lockStaleMs: 30_000,
};

const queues = new Map<string, Promise<unknown>>();

export class AgentStore {
  private readonly file: string;
  private readonly lockFile: string;
  private readonly options: ResolvedAgentStoreOptions;

  constructor(
    workspaceRoot: string,
    readonly agentId: string,
    options: AgentStoreOptions = {},
  ) {
    if (!agentId.trim()) throw new Error("agentId is required");
    this.file = agentEngineFile(workspaceRoot, agentId);
    this.lockFile = agentEngineLockFile(workspaceRoot, agentId);
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  async read(): Promise<AgentStoreAggregate> {
    let content: string;
    try {
      content = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyAggregate(this.agentId);
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch (error) {
      throw new AgentStoreCorruptionError(`Agent aggregate ${this.agentId} contains invalid JSON`, { cause: error });
    }
    validateAggregate(value, this.agentId);
    return structuredClone(value as AgentStoreAggregate);
  }

  async transact(
    mutate: (current: AgentStoreAggregate) => AgentStoreMutation | Promise<AgentStoreMutation>,
  ): Promise<AgentStoreAggregate> {
    const key = this.file.toLowerCase();
    const previous = queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.withLock(async () => {
        const current = await this.read();
        const proposed = await mutate(structuredClone(current));
        if (proposed.aggregateVersion === current.aggregateVersion && !proposed.pendingEvents?.length) {
          return structuredClone(current);
        }
        if (proposed.aggregateVersion !== current.aggregateVersion + 1) {
          throw new AgentStoreConflictError("Agent aggregate version must increase by exactly one");
        }
        const pendingEvents = proposed.pendingEvents ?? [];
        const outbox = [...current.outbox];
        let position = outbox.at(-1)?.position ?? 0;
        for (const event of pendingEvents) outbox.push({ position: ++position, event: structuredClone(event) });
        const { pendingEvents: _pendingEvents, ...persisted } = proposed;
        const aggregate: AgentStoreAggregate = { ...persisted, outbox };
        validateAggregate(aggregate, this.agentId);
        await writeDurableJson(this.file, aggregate);
        return structuredClone(aggregate);
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
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      if (await this.recoverStaleLock()) continue;
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for Agent lock ${this.agentId}`);
      await delay(this.options.lockRetryMs);
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
    try {
      if (parseLock(await readFile(this.lockFile, "utf8"))?.token === token) await rm(this.lockFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
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

function validateAggregate(value: unknown, agentId: string): asserts value is AgentStoreAggregate {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AgentStoreCorruptionError("Agent aggregate must be an object");
  const aggregate = value as AgentStoreAggregate;
  if (aggregate.schemaVersion !== 2 || aggregate.agentId !== agentId || !Number.isInteger(aggregate.aggregateVersion)) {
    throw new Error("Agent aggregate identity is invalid");
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
  unique(aggregate.decisions.map((item) => item.decisionId), "decisionId");
  unique(aggregate.controls.map((item) => item.requestId), "control requestId");
  for (const thread of aggregate.threads) {
    if (thread.agentId !== agentId || !threadIds.has(thread.threadId)) throw new Error("Thread identity is invalid");
    let expected = 1;
    for (const item of thread.items) {
      if (item.sequence !== expected++) throw new Error("Thread sequence is invalid");
    }
  }
  for (const goal of aggregate.goals) {
    if (!threadIds.has(goal.spec.threadId)) throw new Error("Goal thread is invalid");
    if (goal.activeProposalId && !proposalIds.has(goal.activeProposalId)) throw new Error("Goal proposal is invalid");
  }
  for (const proposal of aggregate.proposals) {
    if (!goalIds.has(proposal.goalId)) throw new Error("Proposal goal is invalid");
  }
  let position = 0;
  const eventIds = new Set<string>();
  for (const entry of aggregate.outbox) {
    if (entry.position !== ++position || eventIds.has(entry.event.eventId)) throw new Error("Agent outbox is invalid");
    eventIds.add(entry.event.eventId);
  }
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
    await rename(temporary, file);
    if (process.platform !== "win32") {
      const directoryHandle = await open(directory, "r");
      try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function unique(values: string[], label: string): Set<string> {
  const set = new Set(values);
  if (set.size !== values.length) throw new Error(`Duplicate ${label}`);
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
import { randomUUID } from "node:crypto";
import os from "node:os";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
