import { EventEmitter } from "node:events";
import { mkdir, open, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createId } from "../../shared/ids.js";
import type { AutoAgentEvent } from "../../shared/types.js";
import { eventsFile, workspaceAutoAgentDir } from "./paths.js";

export class EventBus extends EventEmitter {
  publish(event: AutoAgentEvent): void {
    this.emit("event", event);
    this.emit(`workspace:${event.workspaceId}`, event);
    if (event.taskRunId) this.emit(`taskRun:${event.taskRunId}`, event);
  }
}

export class EventLedger {
  private readonly appendTails = new Map<string, Promise<void>>();

  constructor(private readonly eventBus = new EventBus()) {}

  get bus(): EventBus {
    return this.eventBus;
  }

  async append(workspaceRoot: string, event: Omit<AutoAgentEvent, "id" | "timestamp" | "sequence"> & Partial<Pick<AutoAgentEvent, "id" | "timestamp">>): Promise<AutoAgentEvent> {
    if (!event.taskId || !event.taskRunId) {
      throw new Error("Event ledger append requires taskId and taskRunId");
    }
    const filePath = eventsFile(workspaceRoot, event.taskId, event.taskRunId);
    const previous = this.appendTails.get(filePath) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      await mkdir(path.dirname(filePath), { recursive: true });
      const existing = await readEventFile(filePath);
      if (existing.corruptTail) await writeDurableText(filePath, existing.validContent);
      const sequence = (existing.events.at(-1)?.sequence ?? existing.events.length) + 1;
      const fullEvent: AutoAgentEvent = {
        ...event,
        id: event.id ?? createId("evt"),
        timestamp: event.timestamp ?? new Date().toISOString(),
        sequence
      };
      const handle = await open(filePath, "a", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(fullEvent)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      this.eventBus.publish(fullEvent);
      return fullEvent;
    });
    const tail = operation.then(() => undefined, () => undefined);
    this.appendTails.set(filePath, tail);
    void tail.then(() => {
      if (this.appendTails.get(filePath) === tail) this.appendTails.delete(filePath);
    });
    return operation;
  }

  async read(workspaceRoot: string, taskId: string, taskRunId: string): Promise<AutoAgentEvent[]> {
    const filePath = eventsFile(workspaceRoot, taskId, taskRunId);
    try {
      return (await readEventFile(filePath)).events
        .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async readWorkspaceSince(workspaceRoot: string, afterEventId: string, limit = 500): Promise<AutoAgentEvent[]> {
    const events = await this.readWorkspace(workspaceRoot);
    const cursorIndex = events.findIndex((event) => event.id === afterEventId);
    const afterCursor = cursorIndex >= 0 ? events.slice(cursorIndex + 1) : events;
    return afterCursor.slice(-limit);
  }

  private async readWorkspace(workspaceRoot: string): Promise<AutoAgentEvent[]> {
    const tasksRoot = path.join(workspaceAutoAgentDir(workspaceRoot), "tasks");
    const events: AutoAgentEvent[] = [];
    let taskEntries;
    try {
      taskEntries = await readdir(tasksRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    for (const taskEntry of taskEntries) {
      if (!taskEntry.isDirectory()) continue;
      const runsRoot = path.join(tasksRoot, taskEntry.name, "runs");
      let runEntries;
      try {
        runEntries = await readdir(runsRoot, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      for (const runEntry of runEntries) {
        if (!runEntry.isDirectory()) continue;
        try {
          events.push(...await this.read(workspaceRoot, taskEntry.name, runEntry.name));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    }

    return events.sort((left, right) => {
      const timestampOrder = left.timestamp.localeCompare(right.timestamp);
      if (timestampOrder !== 0) return timestampOrder;
      const sequenceOrder = (left.sequence ?? 0) - (right.sequence ?? 0);
      return sequenceOrder !== 0 ? sequenceOrder : left.id.localeCompare(right.id);
    });
  }

}

async function readEventFile(filePath: string): Promise<{
  events: AutoAgentEvent[];
  validContent: string;
  corruptTail: boolean;
}> {
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { events: [], validContent: "", corruptTail: false };
    }
    throw error;
  }
  const lines = content.split(/\r?\n/).filter(Boolean);
  const events: AutoAgentEvent[] = [];
  let validLines = 0;
  for (const [index, line] of lines.entries()) {
    try {
      events.push(JSON.parse(line) as AutoAgentEvent);
      validLines = index + 1;
    } catch (error) {
      if (index === lines.length - 1) {
        return {
          events,
          validContent: validLines ? `${lines.slice(0, validLines).join("\n")}\n` : "",
          corruptTail: true,
        };
      }
      throw new Error(`Event ledger contains a corrupt non-terminal record: ${filePath}`, { cause: error });
    }
  }
  return { events, validContent: content, corruptTail: false };
}

async function writeDurableText(filePath: string, content: string): Promise<void> {
  const handle = await open(filePath, "w", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}
