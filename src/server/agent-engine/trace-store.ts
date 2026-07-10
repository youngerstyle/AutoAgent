import { mkdir, open, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { agentEngineTraceDir, agentEngineTraceFile } from "../storage/paths.js";

export type AgentTraceKind = "context" | "provider_request" | "provider_response" | "tool" | "settlement";

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

export class AgentTraceStore {
  constructor(
    private readonly workspaceRoot: string,
    readonly agentId: string,
  ) {}

  async append(record: AgentTraceRecord): Promise<void> {
    if (record.agentId !== this.agentId) throw new Error("Trace agent partition mismatch");
    const file = agentEngineTraceFile(this.workspaceRoot, this.agentId, record.traceId);
    await mkdir(path.dirname(file), { recursive: true });
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(file, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        await rm(file, { force: true }).catch(() => undefined);
        throw error;
      }
      const existing = JSON.parse(await readFile(file, "utf8")) as AgentTraceRecord;
      if (JSON.stringify(existing) !== JSON.stringify(record)) throw new Error("Trace idempotency conflict");
    }
  }

  async list(threadId?: string): Promise<AgentTraceRecord[]> {
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
    return records
      .filter((record) => record.agentId === this.agentId && (!threadId || record.threadId === threadId))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.traceId.localeCompare(right.traceId));
  }
}
