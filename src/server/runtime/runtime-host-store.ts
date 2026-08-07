import { readJson, writeJson } from "../storage/json.js";
import { runtimeHostFile } from "../storage/paths.js";

export interface RuntimeTaskRecord {
  taskId: string;
  runId: string;
  missionId: string;
  title: string;
  objective: string;
  status: "active" | "paused" | "waiting" | "completed" | "failed" | "cancelled";
  retryStates?: Record<string, RuntimeRetryState>;
  runtimeError?: RuntimeTaskError;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeTaskError {
  source: "scheduler" | "agent_turn";
  message: string;
  at: string;
  agentId?: string;
  turnId?: string;
}

export interface RuntimeRetryState {
  failures: number;
  retryAt: number;
  /** The producer of the retry. Older records may omit this field. */
  kind?: "provider" | "execution";
  /** Idle-agent retries need the original human turn to be replayed. */
  turnId?: string;
  triggerMessageId?: string;
}

interface RuntimeHostState {
  schemaVersion: 2;
  tasks: RuntimeTaskRecord[];
}

export class RuntimeHostStore {
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly workspaceRoot: string) {}

  async list(): Promise<RuntimeTaskRecord[]> {
    return (await readJson<RuntimeHostState>(runtimeHostFile(this.workspaceRoot), { schemaVersion: 2, tasks: [] })).tasks;
  }

  async save(record: RuntimeTaskRecord): Promise<void> {
    const operation = this.pending.then(async () => {
      const tasks = await this.list();
      await writeJson(runtimeHostFile(this.workspaceRoot), {
        schemaVersion: 2,
        tasks: [...tasks.filter((item) => item.taskId !== record.taskId), record],
      } satisfies RuntimeHostState);
    });
    this.pending = operation.catch(() => undefined);
    await operation;
  }

  async get(taskId: string): Promise<RuntimeTaskRecord | undefined> {
    return (await this.list()).find((item) => item.taskId === taskId);
  }
}
