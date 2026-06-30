import { EventEmitter } from "node:events";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createId } from "../../shared/ids.js";
import type { AutoAgentEvent } from "../../shared/types.js";
import { eventsFile } from "./paths.js";

export class EventBus extends EventEmitter {
  publish(event: AutoAgentEvent): void {
    this.emit("event", event);
    this.emit(`workspace:${event.workspaceId}`, event);
    if (event.taskRunId) this.emit(`taskRun:${event.taskRunId}`, event);
  }
}

export class EventLedger {
  constructor(private readonly eventBus = new EventBus()) {}

  get bus(): EventBus {
    return this.eventBus;
  }

  async append(workspaceRoot: string, event: Omit<AutoAgentEvent, "id" | "timestamp" | "sequence"> & Partial<Pick<AutoAgentEvent, "id" | "timestamp">>): Promise<AutoAgentEvent> {
    if (!event.taskId || !event.taskRunId) {
      throw new Error("Event ledger append requires taskId and taskRunId");
    }
    const filePath = eventsFile(workspaceRoot, event.taskId, event.taskRunId);
    await mkdir(path.dirname(filePath), { recursive: true });
    const sequence = await this.nextSequence(filePath);
    const fullEvent: AutoAgentEvent = {
      ...event,
      id: event.id ?? createId("evt"),
      timestamp: event.timestamp ?? new Date().toISOString(),
      sequence
    };
    await writeFile(filePath, `${JSON.stringify(fullEvent)}\n`, { encoding: "utf8", flag: "a" });
    this.eventBus.publish(fullEvent);
    return fullEvent;
  }

  async read(workspaceRoot: string, taskId: string, taskRunId: string): Promise<AutoAgentEvent[]> {
    const filePath = eventsFile(workspaceRoot, taskId, taskRunId);
    try {
      const content = await readFile(filePath, "utf8");
      return content
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as AutoAgentEvent)
        .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
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
