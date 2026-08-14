import { randomUUID } from "node:crypto";
import os from "node:os";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { MissionLink, MissionRecord, TeamBinding, TeamBindingMigration } from "../../shared/contracts/mission-control.js";
import { isKnownToolName } from "../../shared/tool-catalog.js";
import { missionProcessFile } from "../storage/paths.js";
import { missionAggregateInvariants } from "../invariants/domain-invariants.js";

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
  schemaVersion: 4;
  missionId: string;
  version: number;
  record: MissionRecord;
  links: MissionLink[];
  cursors: MissionCursorRecord[];
  steps: MissionStepRecord[];
}

const queues = new Map<string, Promise<unknown>>();
const RENAME_MAX_ATTEMPTS = 6;
const RENAME_RETRY_BACKOFF_MS = 25;

export class MissionStoreConflictError extends Error {}
export class LegacyMissionPlanError extends Error {}
export class MissionStoreCorruptionError extends Error {}

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
        schemaVersion: 4,
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

  /**
   * Upgrade an incomplete historical TeamBinding only when an operator has
   * explicitly requested the migration. Normal reads remain strict: runtime
   * recovery must never invent permissions for an old snapshot.
   */
  async migrateTeamBinding(input: {
    teamBinding: TeamBinding;
    migration: TeamBindingMigration;
  }): Promise<MissionAggregate> {
    return this.enqueue(async () => {
      const raw = await this.readRaw();
      if (!raw) throw new Error("Mission does not exist");
      assertRawMissionIdentity(raw, this.missionId);
      const current = raw as MissionAggregate;
      const currentRecord = current.record as MissionRecord;
      const next: MissionAggregate = {
        ...current,
        version: current.version + 1,
        record: {
          ...currentRecord,
          teamBinding: structuredClone(input.teamBinding),
          teamBindingMigration: structuredClone(input.migration),
        },
      };
      validate(next, this.missionId);
      await writeDurable(this.file, next);
      return structuredClone(next);
    });
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

  private async readRaw(): Promise<unknown> {
    try {
      return JSON.parse(await readFile(this.file, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(path.dirname(this.lockFile), { recursive: true });
    const deadline = Date.now() + 60_000;
    let token = "";
    while (!token) {
      const candidate = randomUUID();
      try {
        const handle = await open(this.lockFile, "wx", 0o600);
        await handle.writeFile(`${JSON.stringify({ token: candidate, pid: process.pid, hostname: os.hostname() })}\n`, "utf8");
        await handle.sync();
        await handle.close();
        token = candidate;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (await this.recoverStaleLock()) continue;
        if (Date.now() >= deadline) throw new Error("Timed out waiting for Mission lock");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    try {
      return await operation();
    } finally {
      try {
        if (parseLock(await readFile(this.lockFile, "utf8"))?.token === token) await rm(this.lockFile);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  private async recoverStaleLock(): Promise<boolean> {
    try {
      const [content, info] = await Promise.all([readFile(this.lockFile, "utf8"), stat(this.lockFile)]);
      if (Date.now() - info.mtimeMs <= 30_000) return false;
      const metadata = parseLock(content);
      if (metadata?.hostname === os.hostname() && isProcessAlive(metadata.pid)) return false;
      const [latest, latestInfo] = await Promise.all([readFile(this.lockFile, "utf8"), stat(this.lockFile)]);
      if (latest !== content || latestInfo.mtimeMs !== info.mtimeMs) return false;
      await rm(this.lockFile);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
  }
}

function parseLock(content: string): { token: string; pid: number; hostname: string } | undefined {
  try {
    const value = JSON.parse(content) as Record<string, unknown>;
    if (typeof value.token !== "string" || !Number.isSafeInteger(value.pid) || typeof value.hostname !== "string") return undefined;
    return value as { token: string; pid: number; hostname: string };
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function validate(value: MissionAggregate, missionId: string): void {
  const candidate = value as unknown as Record<string, unknown>;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MissionStoreCorruptionError("Mission aggregate must be an object");
  }
  if (candidate.schemaVersion !== 4) {
    throw new LegacyMissionPlanError("Mission uses a legacy aggregate schema");
  }
  const record = candidate.record;
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new MissionStoreCorruptionError("Mission record is invalid");
  }
  const missionRecord = record as Record<string, unknown>;
  if (candidate.missionId !== missionId || missionRecord.missionId !== missionId) {
    throw new Error("Mission aggregate identity is invalid");
  }
  if (!Number.isInteger(candidate.version) || Number(candidate.version) < 1) throw new Error("Mission version is invalid");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(missionRecord.planId))) {
    throw new LegacyMissionPlanError("Mission uses a legacy non-UUID Plan identity");
  }
  if (typeof missionRecord.objective !== "string" || missionRecord.objective.trim().length === 0) {
    throw new Error("Mission objective is invalid");
  }
  if (typeof missionRecord.ownerPrincipalId !== "string" || !missionRecord.ownerPrincipalId) {
    throw new Error("Mission owner or TeamBinding snapshot is invalid");
  }
  validateTeamBinding(missionRecord.teamBinding, missionId);
  if (missionRecord.teamBindingMigration !== undefined) {
    validateTeamBindingMigration(missionRecord.teamBindingMigration, missionId);
  }
  const aggregate = value as MissionAggregate;
  for (const field of [aggregate.links, aggregate.cursors, aggregate.steps]) if (!Array.isArray(field)) throw new Error("Mission collection is invalid");
  unique(aggregate.links.map((item) => item.dispatchId), "dispatchId");
  unique(aggregate.cursors.map((item) => item.partition), "cursor partition");
  unique(aggregate.steps.map((item) => item.stepId), "stepId");
  for (const link of aggregate.links) {
    if (link.missionId !== missionId || link.planId !== missionRecord.planId) throw new Error("Mission link identity is invalid");
  }
  missionAggregateInvariants.assert(aggregate, (message) => new MissionStoreCorruptionError(message));
}

function assertRawMissionIdentity(value: unknown, missionId: string): asserts value is MissionAggregate {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MissionStoreCorruptionError("Mission aggregate must be an object");
  }
  const candidate = value as Record<string, unknown>;
  const record = candidate.record;
  if (candidate.schemaVersion !== 4 || candidate.missionId !== missionId
    || !record || typeof record !== "object" || Array.isArray(record)
    || (record as Record<string, unknown>).missionId !== missionId
    || !Number.isInteger(candidate.version) || Number(candidate.version) < 1) {
    throw new MissionStoreCorruptionError("Mission aggregate cannot be migrated safely");
  }
}

function validateTeamBindingMigration(value: unknown, missionId: string): asserts value is TeamBindingMigration {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MissionStoreCorruptionError(`Mission ${missionId} TeamBinding migration metadata is invalid`);
  }
  const migration = value as Record<string, unknown>;
  if (migration.kind !== "reconstruct_enabled_tools"
    || migration.source !== "workspace_agent_policy"
    || typeof migration.fromContentHash !== "string" || !migration.fromContentHash
    || typeof migration.migratedAt !== "string" || !migration.migratedAt) {
    throw new MissionStoreCorruptionError(`Mission ${missionId} TeamBinding migration metadata is invalid`);
  }
}

function validateTeamBinding(value: unknown, missionId: string): asserts value is TeamBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MissionStoreCorruptionError(`Mission ${missionId} TeamBinding snapshot is invalid`);
  }
  const binding = value as Record<string, unknown>;
  if (typeof binding.teamBindingId !== "string" || !binding.teamBindingId
    || !Number.isInteger(binding.version) || Number(binding.version) < 1
    || typeof binding.contentHash !== "string" || !binding.contentHash
    || !Array.isArray(binding.members)) {
    throw new MissionStoreCorruptionError(`Mission ${missionId} TeamBinding snapshot is incomplete`);
  }
  const agentIds = new Set<string>();
  const principalIds = new Set<string>();
  for (const memberValue of binding.members) {
    if (!memberValue || typeof memberValue !== "object" || Array.isArray(memberValue)) {
      throw new MissionStoreCorruptionError(`Mission ${missionId} TeamBinding member is invalid`);
    }
    const member = memberValue as Record<string, unknown>;
    const capabilities = member.capabilities;
    const enabledTools = member.enabledTools;
    if (typeof member.agentId !== "string" || !member.agentId
      || typeof member.principalId !== "string" || !member.principalId
      || agentIds.has(member.agentId) || principalIds.has(member.principalId)
      || !Array.isArray(capabilities) || capabilities.some((item) => typeof item !== "string")
      || !Array.isArray(enabledTools)
      || enabledTools.some((item) => typeof item !== "string" || !isKnownToolName(item))) {
      throw new MissionStoreCorruptionError(
        `Mission ${missionId} TeamBinding member ${String(member.agentId ?? "unknown")} has an invalid capability/tool snapshot`,
      );
    }
    agentIds.add(member.agentId);
    principalIds.add(member.principalId);
  }
  if (binding.deliveryPolicy !== undefined) {
    const policy = binding.deliveryPolicy;
    const requiredTerminalCapabilities = policy && typeof policy === "object" && !Array.isArray(policy)
      ? (policy as Record<string, unknown>).requiredTerminalCapabilities
      : undefined;
    if (!policy || typeof policy !== "object" || Array.isArray(policy)
      || !Array.isArray(requiredTerminalCapabilities)
      || requiredTerminalCapabilities.some((item) => typeof item !== "string")) {
      throw new MissionStoreCorruptionError(`Mission ${missionId} TeamBinding delivery policy is invalid`);
    }
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
    await renameWithRetry(temporary, file);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function renameWithRetry(source: string, target: string): Promise<void> {
  for (let attempt = 0; attempt < RENAME_MAX_ATTEMPTS; attempt += 1) {
    try {
      await rename(source, target);
      return;
    } catch (error) {
      if (!isRetriableRenameError(error) || attempt === RENAME_MAX_ATTEMPTS - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, RENAME_RETRY_BACKOFF_MS * (attempt + 1)));
    }
  }
}

function isRetriableRenameError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EPERM" || code === "EBUSY" || code === "ENOTEMPTY";
}
