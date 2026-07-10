import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { MissionLink, MissionRecord } from "../../shared/contracts/mission-control.js";
import { missionProcessFile } from "../storage/paths.js";

export interface MissionCursorRecord {
  partition: string;
  cursor: unknown;
  appliedVersions: Record<string, number>;
}

export interface MissionStepRecord {
  stepId: string;
  fingerprint: string;
  result: unknown;
}

export interface MissionAggregate {
  schemaVersion: 2;
  missionId: string;
  version: number;
  record: MissionRecord;
  links: MissionLink[];
  cursors: MissionCursorRecord[];
  steps: MissionStepRecord[];
}

const queues = new Map<string, Promise<unknown>>();

export class MissionStoreConflictError extends Error {}

export class MissionStore {
  private readonly file: string;
  private readonly lockFile: string;

  constructor(workspaceRoot: string, readonly missionId: string) {
    this.file = missionProcessFile(workspaceRoot, missionId);
    this.lockFile = `${this.file}.lock`;
  }

  async create(record: MissionRecord): Promise<MissionAggregate> {
    return this.enqueue(async () => {
      if (await this.read()) throw new MissionStoreConflictError("Mission already exists");
      const aggregate: MissionAggregate = {
        schemaVersion: 2,
        missionId: this.missionId,
        version: 1,
        record: structuredClone(record),
        links: [],
        cursors: [],
        steps: [],
      };
      validate(aggregate, this.missionId);
      await writeDurable(this.file, aggregate);
      return aggregate;
    });
  }

  async read(): Promise<MissionAggregate | undefined> {
    try {
      const value = JSON.parse(await readFile(this.file, "utf8")) as MissionAggregate;
      validate(value, this.missionId);
      return structuredClone(value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async transact(
    expectedVersion: number,
    mutate: (current: MissionAggregate) => MissionAggregate | Promise<MissionAggregate>,
  ): Promise<MissionAggregate> {
    return this.enqueue(async () => {
      const current = await this.read();
      if (!current) throw new Error("Mission does not exist");
      if (current.version !== expectedVersion) throw new MissionStoreConflictError("Mission version conflict");
      const next = await mutate(structuredClone(current));
      if (next.version === current.version) return current;
      if (next.version !== current.version + 1) throw new MissionStoreConflictError("Mission version must increase by one");
      validate(next, this.missionId);
      await writeDurable(this.file, next);
      return structuredClone(next);
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const key = this.file.toLowerCase();
    const previous = queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.withLock(operation));
    queues.set(key, next);
    return next.finally(() => {
      if (queues.get(key) === next) queues.delete(key);
    });
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(path.dirname(this.lockFile), { recursive: true });
    const deadline = Date.now() + 60_000;
    let token = "";
    while (!token) {
      const candidate = randomUUID();
      try {
        const handle = await open(this.lockFile, "wx", 0o600);
        await handle.writeFile(candidate, "utf8");
        await handle.sync();
        await handle.close();
        token = candidate;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (Date.now() >= deadline) throw new Error("Timed out waiting for Mission lock");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    try {
      return await operation();
    } finally {
      try {
        if ((await readFile(this.lockFile, "utf8")) === token) await rm(this.lockFile);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
}

function validate(value: MissionAggregate, missionId: string): void {
  if (value.schemaVersion !== 2 || value.missionId !== missionId || value.record.missionId !== missionId) {
    throw new Error("Mission aggregate identity is invalid");
  }
  if (!Number.isInteger(value.version) || value.version < 1) throw new Error("Mission version is invalid");
  for (const field of [value.links, value.cursors, value.steps]) if (!Array.isArray(field)) throw new Error("Mission collection is invalid");
  unique(value.links.map((item) => item.dispatchId), "dispatchId");
  unique(value.cursors.map((item) => item.partition), "cursor partition");
  unique(value.steps.map((item) => item.stepId), "stepId");
  for (const link of value.links) {
    if (link.missionId !== missionId || link.workflowId !== value.record.workflowId) throw new Error("Mission link identity is invalid");
  }
}

function unique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label}`);
}

async function writeDurable(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, file);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
