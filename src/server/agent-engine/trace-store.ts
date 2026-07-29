import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { agentEngineTraceDir, agentEngineTraceRolloutFile } from "../storage/paths.js";

export type AgentTraceKind = "context" | "provider_request" | "provider_response" | "tool" | "settlement" | "error";

export interface AgentTraceRecord {
  traceId: string;
  agentId: string;
  threadId: string;
  goalId?: string;
  turnId: string;
  kind: AgentTraceKind;
  createdAt: string;
  data: unknown;
}

const queues = new Map<string, Promise<void>>();
const caches = new Map<string, Map<string, AgentTraceRecord>>();

export class AgentTraceStore {
  private readonly file: string;

  constructor(
    private readonly workspaceRoot: string,
    readonly agentId: string,
  ) {
    this.file = agentEngineTraceRolloutFile(workspaceRoot, agentId);
  }

  async append(record: AgentTraceRecord): Promise<void> {
    if (record.agentId !== this.agentId) throw new Error("Trace agent partition mismatch");
    const key = this.file.toLowerCase();
    const previous = queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      const records = await this.loadRollout();
      const existing = records.get(record.traceId);
      if (existing) {
        if (!sameTrace(existing, record)) throw new Error("Trace idempotency conflict");
        return;
      }
      await mkdir(path.dirname(this.file), { recursive: true });
      const canonical = JSON.parse(JSON.stringify(record)) as AgentTraceRecord;
      await appendFile(this.file, `${JSON.stringify(canonical)}\n`, { encoding: "utf8", mode: 0o600 });
      records.set(canonical.traceId, canonical);
    });
    queues.set(key, next);
    try {
      await next;
    } finally {
      if (queues.get(key) === next) queues.delete(key);
    }
  }

  async list(threadId?: string): Promise<AgentTraceRecord[]> {
    const [rollout, legacy] = await Promise.all([this.loadRollout(), this.loadLegacy()]);
    const records = new Map(legacy.map((record) => [record.traceId, record]));
    for (const record of rollout.values()) {
      const existing = records.get(record.traceId);
      if (existing && !sameTrace(existing, record)) throw new Error("Trace idempotency conflict");
      records.set(record.traceId, record);
    }
    return [...records.values()]
      .filter((record) => record.agentId === this.agentId && (!threadId || record.threadId === threadId))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.traceId.localeCompare(right.traceId));
  }

  private async loadRollout(): Promise<Map<string, AgentTraceRecord>> {
    const key = this.file.toLowerCase();
    const cached = caches.get(key);
    if (cached) return cached;
    let content: string;
    try {
      content = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const empty = new Map<string, AgentTraceRecord>();
      caches.set(key, empty);
      return empty;
    }
    const records = new Map<string, AgentTraceRecord>();
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      let record: AgentTraceRecord;
      try {
        record = JSON.parse(line) as AgentTraceRecord;
      } catch {
        continue;
      }
      if (record.agentId !== this.agentId) throw new Error("Trace agent partition mismatch");
      const existing = records.get(record.traceId);
      if (existing && !sameTrace(existing, record)) throw new Error("Trace idempotency conflict");
      records.set(record.traceId, record);
    }
    caches.set(key, records);
    return records;
  }

  private async loadLegacy(): Promise<AgentTraceRecord[]> {
    const directory = agentEngineTraceDir(this.workspaceRoot, this.agentId);
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const records = await Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) => (
      JSON.parse(await readFile(path.join(directory, name), "utf8")) as AgentTraceRecord
    )));
    return records.filter((record) => record.agentId === this.agentId);
  }
}

function sameTrace(left: AgentTraceRecord, right: AgentTraceRecord): boolean {
  const { createdAt: _leftCreatedAt, ...leftIdentity } = left;
  const { createdAt: _rightCreatedAt, ...rightIdentity } = right;
  return JSON.stringify(leftIdentity) === JSON.stringify(rightIdentity);
}
