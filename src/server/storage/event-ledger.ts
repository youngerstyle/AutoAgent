import { EventEmitter } from "node:events";
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { createId } from "../../shared/ids.js";
import type { AutoAgentEvent } from "../../shared/types.js";
import { eventsFile, workspaceAutoAgentDir, workspaceEventCursorFile } from "./paths.js";

export class EventBus extends EventEmitter {
  publish(event: AutoAgentEvent): void {
    this.emit("event", event);
    this.emit(`workspace:${event.workspaceId}`, event);
    if (event.taskRunId) this.emit(`taskRun:${event.taskRunId}`, event);
  }
}

type CursorState = { next?: number };
type WorkspaceLock = { token: string; pid: number; hostname: string };

/** Test-only failure boundary; production callers can omit it. */
export type EventLedgerOptions = {
  afterEventDurableBeforeCursor?: () => void | Promise<void>;
};

export class EventLedger {
  private readonly appendTails = new Map<string, Promise<void>>();
  private readonly workspaceAppendTails = new Map<string, Promise<void>>();

  constructor(private readonly eventBus = new EventBus(), private readonly options: EventLedgerOptions = {}) {}
  get bus(): EventBus { return this.eventBus; }

  async append(workspaceRoot: string, event: Omit<AutoAgentEvent, "id" | "timestamp" | "sequence"> & Partial<Pick<AutoAgentEvent, "id" | "timestamp">>): Promise<AutoAgentEvent> {
    if (!event.taskId || !event.taskRunId) throw new Error("Event ledger append requires taskId and taskRunId");
    const root = path.resolve(workspaceRoot);
    const filePath = eventsFile(root, event.taskId, event.taskRunId);
    const previous = this.appendTails.get(filePath) ?? Promise.resolve();
    const workspacePrevious = this.workspaceAppendTails.get(root) ?? Promise.resolve();
    const operation = Promise.all([previous, workspacePrevious]).then(async () => {
      const release = await acquireWorkspaceLock(root);
      try {
        await mkdir(path.dirname(filePath), { recursive: true });
        const existing = await readEventFile(filePath);
        if (existing.corruptTail) await writeDurableText(filePath, existing.validContent);
        const requestedId = event.id;
        if (requestedId) {
          const duplicate = (await readWorkspaceEvents(root)).find((candidate) => candidate.id === requestedId);
          if (duplicate) {
            if (!sameImmutableEvent(duplicate, event)) {
              throw new Error(`Event id conflict: ${requestedId}`);
            }
            return duplicate;
          }
        }
        const persisted = await readWorkspaceEvents(root);
        const maxPersisted = persisted.reduce((max, item) => Math.max(max, validWorkspaceSequence(item) ?? 0), 0);
        // Event files are authoritative after restart: a stale cursor is repaired by
        // the next successful append, without advancing the cursor before its event.
        const workspaceSequence = maxPersisted + 1;
        const sequence = (existing.events.at(-1)?.sequence ?? existing.events.length) + 1;
        const fullEvent: AutoAgentEvent = {
          ...event,
          id: event.id ?? createId("evt"),
          timestamp: event.timestamp ?? new Date().toISOString(),
          sequence,
          workspaceSequence,
        };
        await appendDurable(filePath, fullEvent);
        await this.options.afterEventDurableBeforeCursor?.();
        await writeCursor(root, { next: workspaceSequence + 1 });
        this.eventBus.publish(fullEvent);
        return fullEvent;
      } finally {
        await release();
      }
    });
    const tail = operation.then(() => undefined, () => undefined);
    this.appendTails.set(filePath, tail);
    this.workspaceAppendTails.set(root, tail);
    void tail.then(() => {
      if (this.appendTails.get(filePath) === tail) this.appendTails.delete(filePath);
      if (this.workspaceAppendTails.get(root) === tail) this.workspaceAppendTails.delete(root);
    });
    return operation;
  }

  async read(workspaceRoot: string, taskId: string, taskRunId: string): Promise<AutoAgentEvent[]> {
    try { return (await readEventFile(eventsFile(path.resolve(workspaceRoot), taskId, taskRunId))).events.sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }

  async readWorkspaceSince(workspaceRoot: string, afterEventId: string, limit = 500): Promise<AutoAgentEvent[]> {
    const events = await this.readWorkspace(path.resolve(workspaceRoot));
    const cursor = events.find((event) => event.id === afterEventId);
    if (cursor?.workspaceSequence !== undefined) {
      return events
        .filter((event) => event.workspaceSequence !== undefined && event.workspaceSequence > cursor.workspaceSequence!)
        .sort(compareWorkspaceEvents).slice(0, limit);
    }
    const cursorIndex = events.findIndex((event) => event.id === afterEventId);
    const history = cursorIndex >= 0 ? events.slice(cursorIndex + 1) : events;
    return limit > 0 ? history.slice(-limit) : [];
  }

  private async readWorkspace(root: string): Promise<AutoAgentEvent[]> { return readWorkspaceEvents(root); }
}

function validWorkspaceSequence(event: AutoAgentEvent): number | undefined {
  return Number.isSafeInteger(event.workspaceSequence) && event.workspaceSequence! > 0 ? event.workspaceSequence : undefined;
}
function validNext(value: CursorState): value is { next: number } { return Number.isSafeInteger(value.next) && value.next! > 0; }
function compareWorkspaceEvents(a: AutoAgentEvent, b: AutoAgentEvent): number {
  const order = (a.workspaceSequence ?? 0) - (b.workspaceSequence ?? 0);
  return order || a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id);
}

async function readCursor(root: string): Promise<CursorState> {
  try { return JSON.parse(await readFile(workspaceEventCursorFile(root), "utf8")) as CursorState; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
}
async function writeCursor(root: string, value: CursorState): Promise<void> {
  const target = workspaceEventCursorFile(root);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "w", 0o600);
  try { await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8"); await handle.sync(); }
  finally { await handle.close(); }
  try { await rename(temporary, target); await syncDirectory(path.dirname(target)); }
  catch (error) { await rm(temporary, { force: true }).catch(() => undefined); throw error; }
}
async function syncDirectory(directory: string): Promise<void> {
  try { const handle = await open(directory, "r"); try { await handle.sync(); } finally { await handle.close(); } }
  catch (error) {
    // Windows does not support opening directories for fsync; the atomic rename is still durable enough for this platform.
    if (process.platform !== "win32") throw error;
  }
}
function sameImmutableEvent(existing: AutoAgentEvent, requested: Omit<AutoAgentEvent, "id" | "timestamp" | "sequence"> & Partial<Pick<AutoAgentEvent, "id" | "timestamp">>): boolean {
  return existing.taskId === requested.taskId
    && existing.taskRunId === requested.taskRunId
    && existing.type === requested.type
    && existing.summary === requested.summary
    && JSON.stringify(existing.payload) === JSON.stringify(requested.payload)
    && (requested.timestamp === undefined || existing.timestamp === requested.timestamp);
}
async function appendDurable(filePath: string, event: AutoAgentEvent): Promise<void> {
  const handle = await open(filePath, "a", 0o600);
  try { await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8"); await handle.sync(); }
  finally { await handle.close(); }
}

async function acquireWorkspaceLock(root: string): Promise<() => Promise<void>> {
  const lockFile = path.join(workspaceAutoAgentDir(root), "event-append.lock");
  await mkdir(path.dirname(lockFile), { recursive: true });
  for (;;) {
    const token = randomUUID();
    try {
      const handle = await open(lockFile, "wx", 0o600);
      const owner: WorkspaceLock = { token, pid: process.pid, hostname: os.hostname() };
      await handle.writeFile(JSON.stringify(owner), "utf8"); await handle.sync(); await handle.close();
      return async () => {
        try { const current = JSON.parse(await readFile(lockFile, "utf8")) as WorkspaceLock; if (current.token === token) await rm(lockFile); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let owner: WorkspaceLock | undefined;
      try { owner = JSON.parse(await readFile(lockFile, "utf8")) as WorkspaceLock; } catch { /* another writer is publishing metadata */ }
      if (owner?.hostname === os.hostname() && !isProcessAlive(owner.pid)) { await rm(lockFile, { force: true }); continue; }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}
function isProcessAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } }

async function readWorkspaceEvents(root: string): Promise<AutoAgentEvent[]> {
  const tasksRoot = path.join(workspaceAutoAgentDir(root), "tasks");
  const events: AutoAgentEvent[] = [];
  let taskEntries;
  try { taskEntries = await readdir(tasksRoot, { withFileTypes: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  for (const task of taskEntries) {
    if (!task.isDirectory()) continue;
    const runsRoot = path.join(tasksRoot, task.name, "runs");
    let runs; try { runs = await readdir(runsRoot, { withFileTypes: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    for (const run of runs) {
      if (!run.isDirectory()) continue;
      try { events.push(...(await readEventFile(eventsFile(root, task.name, run.name))).events); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }
  return events.sort((a, b) => validWorkspaceSequence(a) === undefined ? (validWorkspaceSequence(b) === undefined ? a.timestamp.localeCompare(b.timestamp) : -1) : validWorkspaceSequence(b) === undefined ? 1 : compareWorkspaceEvents(a, b));
}

async function readEventFile(filePath: string): Promise<{ events: AutoAgentEvent[]; validContent: string; corruptTail: boolean }> {
  let content: string;
  try { content = await readFile(filePath, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { events: [], validContent: "", corruptTail: false }; throw error; }
  const lines = content.split(/\r?\n/).filter(Boolean); const events: AutoAgentEvent[] = []; let validLines = 0;
  for (const [index, line] of lines.entries()) {
    try { events.push(JSON.parse(line) as AutoAgentEvent); validLines = index + 1; }
    catch (error) { if (index === lines.length - 1) return { events, validContent: validLines ? `${lines.slice(0, validLines).join("\n")}\n` : "", corruptTail: true }; throw new Error(`Event ledger contains a corrupt non-terminal record: ${filePath}`, { cause: error }); }
  }
  return { events, validContent: content, corruptTail: false };
}
async function writeDurableText(filePath: string, content: string): Promise<void> { const handle = await open(filePath, "w", 0o600); try { await handle.writeFile(content, "utf8"); await handle.sync(); } finally { await handle.close(); } }
