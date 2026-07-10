import { readJson, writeJson } from "../storage/json.js";
import { runtimeHostFile } from "../storage/paths.js";

export interface RuntimeTaskRecord {
  taskId: string;
  runId: string;
  missionId: string;
  title: string;
  objective: string;
  status: "active" | "paused" | "completed" | "failed" | "cancelled";
  createdAt: string;
  updatedAt: string;
}

interface RuntimeHostState {
  schemaVersion: 2;
  tasks: RuntimeTaskRecord[];
}

export class RuntimeHostStore {
  constructor(private readonly workspaceRoot: string) {}

  async list(): Promise<RuntimeTaskRecord[]> {
    return (await readJson<RuntimeHostState>(runtimeHostFile(this.workspaceRoot), { schemaVersion: 2, tasks: [] })).tasks;
  }

  async save(record: RuntimeTaskRecord): Promise<void> {
    const tasks = await this.list();
    await writeJson(runtimeHostFile(this.workspaceRoot), {
      schemaVersion: 2,
      tasks: [...tasks.filter((item) => item.taskId !== record.taskId), record],
    } satisfies RuntimeHostState);
  }

  async get(taskId: string): Promise<RuntimeTaskRecord | undefined> {
    return (await this.list()).find((item) => item.taskId === taskId);
  }
}
