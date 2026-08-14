import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { SourcePatchDeliveryRecord } from "./delivery-providers.js";
import { workspaceEvolutionSourceDeliveryLedgerFile } from "../storage/paths.js";

interface SourceDeliveryEvent {
  commandId: string;
  occurredAt: string;
  record: SourcePatchDeliveryRecord;
}

const queues = new Map<string, Promise<void>>();

export class SourcePatchDeliveryStore {
  private readonly file: string;
  constructor(workspaceRoot: string) { this.file = workspaceEvolutionSourceDeliveryLedgerFile(workspaceRoot); }

  async list(): Promise<SourcePatchDeliveryRecord[]> {
    return [...(await this.project()).values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.deliveryId.localeCompare(b.deliveryId));
  }
  async get(deliveryId: string): Promise<SourcePatchDeliveryRecord | undefined> {
    const value = (await this.project()).get(deliveryId);
    return value ? structuredClone(value) : undefined;
  }
  async append(commandId: string, record: SourcePatchDeliveryRecord): Promise<SourcePatchDeliveryRecord> {
    const key = this.file.toLowerCase();
    const previous = queues.get(key) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(async () => {
      const events = await readEvents(this.file);
      const replay = events.find((event) => event.commandId === commandId);
      const event: SourceDeliveryEvent = { commandId, occurredAt: record.updatedAt, record: structuredClone(record) };
      if (replay) {
        if (canonical(replay) !== canonical(event)) throw new Error("Source delivery command conflict");
        return;
      }
      const current = events.filter((item) => item.record.deliveryId === record.deliveryId).at(-1)?.record;
      if (current && current.candidateId !== record.candidateId) throw new Error("Source delivery identity conflict");
      await mkdir(path.dirname(this.file), { recursive: true });
      await appendFile(this.file, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600, flush: true });
    });
    const settled = pending.then(() => undefined, () => undefined);
    queues.set(key, settled);
    try { await pending; } finally { if (queues.get(key) === settled) queues.delete(key); }
    return (await this.get(record.deliveryId))!;
  }
  private async project(): Promise<Map<string, SourcePatchDeliveryRecord>> {
    const records = new Map<string, SourcePatchDeliveryRecord>();
    for (const event of await readEvents(this.file)) records.set(event.record.deliveryId, structuredClone(event.record));
    return records;
  }
}

async function readEvents(file: string): Promise<SourceDeliveryEvent[]> {
  let raw: string;
  try { raw = await readFile(file, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  return raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as SourceDeliveryEvent);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
