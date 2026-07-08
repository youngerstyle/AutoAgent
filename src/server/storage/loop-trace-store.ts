import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createId } from "../../shared/ids.js";
import type { LoopDebugEntryKind } from "../../shared/types.js";
import { loopTraceFile } from "./paths.js";

export interface LoopTraceRecord {
  id: string;
  taskId: string;
  taskRunId: string;
  assignmentRunId?: string;
  agentId: string;
  actor: string;
  kind: Exclude<LoopDebugEntryKind, "flow">;
  turn: number;
  timestamp: string;
  title: string;
  content: string;
  detail?: string;
  sequence?: number;
  metadata?: Record<string, unknown>;
}

export class LoopTraceStore {
  async append(
    workspaceRoot: string,
    taskId: string,
    taskRunId: string,
    record: Omit<LoopTraceRecord, "id" | "taskId" | "taskRunId" | "timestamp" | "sequence"> &
      Partial<Pick<LoopTraceRecord, "id" | "timestamp" | "sequence">>
  ): Promise<LoopTraceRecord> {
    const filePath = loopTraceFile(workspaceRoot, taskId, taskRunId);
    await mkdir(path.dirname(filePath), { recursive: true });
    const fullRecord: LoopTraceRecord = {
      ...record,
      id: record.id ?? createId("trace"),
      taskId,
      taskRunId,
      timestamp: record.timestamp ?? new Date().toISOString(),
      sequence: record.sequence ?? await this.nextSequence(filePath)
    };
    await writeFile(filePath, `${JSON.stringify(fullRecord)}\n`, { encoding: "utf8", flag: "a" });
    return fullRecord;
  }

  async read(workspaceRoot: string, taskId: string, taskRunId: string): Promise<LoopTraceRecord[]> {
    const filePath = loopTraceFile(workspaceRoot, taskId, taskRunId);
    try {
      const content = await readFile(filePath, "utf8");
      return content
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as LoopTraceRecord)
        .sort((a, b) => {
          const byTime = a.timestamp.localeCompare(b.timestamp);
          if (byTime !== 0) return byTime;
          return (a.sequence ?? 0) - (b.sequence ?? 0);
        });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async nextSequence(filePath: string): Promise<number> {
    try {
      const info = await stat(filePath);
      if (info.size === 0) return 1;
      const content = await readFile(filePath, "utf8");
      return content.split(/\r?\n/).filter(Boolean).length + 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 1;
      throw error;
    }
  }
}
