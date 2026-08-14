import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { createId } from "../../shared/ids.js";
import type { EvaluationJob, EvaluationJobRequest } from "../../shared/contracts/evolution.js";
import { HttpError } from "../errors.js";
import { writeJson } from "../storage/json.js";
import {
  workspaceEvolutionEvaluationCommandFile, workspaceEvolutionEvaluationJobsFile, workspaceEvolutionEvaluationLeaseFile,
} from "../storage/paths.js";
import { redactEvolutionText } from "./secret-redactor.js";

interface JobEvent { eventId: string; type: "created" | "claimed" | "heartbeat" | "succeeded" | "failed"; occurredAt: string; job: EvaluationJob }
interface CommandRecord { commandId: string; fingerprint: string; job: EvaluationJob }
interface Lease { token: string; workerId: string; heartbeatAt: string; expiresAt: string }
const queues = new Map<string, Promise<void>>();

export class EvaluationJobStore {
  constructor(
    private readonly workspaceId: string,
    private readonly workspaceRoot: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async enqueue(commandId: string, request: EvaluationJobRequest, maxAttempts = 3): Promise<EvaluationJob> {
    validateRequest(commandId, request, maxAttempts);
    const fingerprint = hash(canonical({ commandId, request, maxAttempts }));
    return this.exclusive(async () => {
      const commandFile = workspaceEvolutionEvaluationCommandFile(this.workspaceRoot, hash(commandId));
      const timestamp = this.now().toISOString();
      const job: EvaluationJob = {
        jobId: stableId("evaluation_job", this.workspaceId, commandId), commandId, requestFingerprint: fingerprint,
        workspaceId: this.workspaceId, status: "pending", attempts: 0, maxAttempts, request: structuredClone(request),
        createdAt: timestamp, updatedAt: timestamp,
      };
      const record: CommandRecord = { commandId, fingerprint, job };
      await mkdir(path.dirname(commandFile), { recursive: true });
      try {
        const handle = await open(commandFile, "wx", 0o600);
        try { await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8"); await handle.sync(); } finally { await handle.close(); }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = await readCommand(commandFile);
        if (!existing || existing.commandId !== commandId || existing.fingerprint !== fingerprint) throw conflict("Evaluation job command idempotency conflict");
        const projected = await this.project();
        if (!projected.has(existing.job.jobId)) await this.append("created", existing.job);
        return projected.get(existing.job.jobId) ?? existing.job;
      }
      await this.append("created", job);
      return job;
    });
  }

  async claim(workerId: string, leaseMs = 30_000): Promise<EvaluationJob | undefined> {
    if (!workerId.trim() || !Number.isSafeInteger(leaseMs) || leaseMs < 1_000) throw invalid("Evaluation lease is invalid");
    return this.exclusive(async () => {
      const timestamp = this.now();
      const due = [...(await this.project()).values()]
        .filter((job) => job.status === "pending"
          || (job.status === "retry_wait" && Date.parse(job.nextAttemptAt ?? "") <= timestamp.getTime())
          || (job.status === "running" && Date.parse(job.lease?.expiresAt ?? "") <= timestamp.getTime()))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.jobId.localeCompare(right.jobId));
      for (const current of due) {
        const token = randomUUID();
        if (!await this.acquireLease(current.jobId, token, workerId, leaseMs)) continue;
        const iso = timestamp.toISOString();
        const job: EvaluationJob = {
          ...current, status: "running", attempts: current.attempts + 1, updatedAt: iso, nextAttemptAt: undefined,
          lease: { token, workerId, heartbeatAt: iso, expiresAt: new Date(timestamp.getTime() + leaseMs).toISOString() },
        };
        await this.append("claimed", job);
        return job;
      }
      return undefined;
    });
  }

  async heartbeat(jobId: string, token: string, leaseMs = 30_000): Promise<EvaluationJob> {
    return this.exclusive(async () => {
      const current = await this.requireOwned(jobId, token);
      const timestamp = this.now();
      const job: EvaluationJob = {
        ...current, updatedAt: timestamp.toISOString(),
        lease: { ...current.lease!, heartbeatAt: timestamp.toISOString(), expiresAt: new Date(timestamp.getTime() + leaseMs).toISOString() },
      };
      await writeJson(workspaceEvolutionEvaluationLeaseFile(this.workspaceRoot, jobId), job.lease);
      await this.append("heartbeat", job);
      return job;
    });
  }

  async succeed(jobId: string, token: string, result: NonNullable<EvaluationJob["result"]>): Promise<EvaluationJob> {
    return this.exclusive(async () => {
      const current = await this.requireOwned(jobId, token);
      const job: EvaluationJob = { ...current, status: "succeeded", updatedAt: this.now().toISOString(), lease: undefined, result, lastError: undefined };
      await this.append("succeeded", job);
      await this.releaseLease(jobId, token);
      return job;
    });
  }

  async fail(jobId: string, token: string, error: { category: "transient" | "terminal"; message: string }): Promise<EvaluationJob> {
    return this.exclusive(async () => {
      const current = await this.requireOwned(jobId, token);
      const exhausted = error.category === "terminal" || current.attempts >= current.maxAttempts;
      const timestamp = this.now();
      const delay = Math.min(300_000, 1_000 * (2 ** Math.min(current.attempts - 1, 8)));
      const job: EvaluationJob = {
        ...current, status: exhausted ? "dead_letter" : "retry_wait", updatedAt: timestamp.toISOString(), lease: undefined,
        lastError: { category: error.category, message: safeError(error.message) },
        ...(exhausted ? { nextAttemptAt: undefined } : { nextAttemptAt: new Date(timestamp.getTime() + delay).toISOString() }),
      };
      await this.append("failed", job);
      await this.releaseLease(jobId, token);
      return job;
    });
  }

  async get(jobId: string): Promise<EvaluationJob> {
    const job = (await this.project()).get(jobId);
    if (!job) throw new HttpError(404, "Evaluation job not found", "EVOLUTION_EVALUATION_JOB_NOT_FOUND");
    return job;
  }

  async list(): Promise<EvaluationJob[]> {
    return [...(await this.project()).values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  private async requireOwned(jobId: string, token: string): Promise<EvaluationJob> {
    const current = (await this.project()).get(jobId);
    if (!current) throw new HttpError(404, "Evaluation job not found", "EVOLUTION_EVALUATION_JOB_NOT_FOUND");
    if (current.status !== "running" || current.lease?.token !== token) throw conflict("Evaluation lease is not owned by this worker");
    const lease = await readLease(workspaceEvolutionEvaluationLeaseFile(this.workspaceRoot, jobId));
    if (!lease || lease.token !== token || Date.parse(lease.expiresAt) <= this.now().getTime()) throw conflict("Evaluation lease expired or changed owner");
    return current;
  }

  private async acquireLease(jobId: string, token: string, workerId: string, leaseMs: number): Promise<boolean> {
    const file = workspaceEvolutionEvaluationLeaseFile(this.workspaceRoot, jobId);
    await mkdir(path.dirname(file), { recursive: true });
    const timestamp = this.now();
    const lease: Lease = { token, workerId, heartbeatAt: timestamp.toISOString(), expiresAt: new Date(timestamp.getTime() + leaseMs).toISOString() };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(file, "wx", 0o600);
        try { await handle.writeFile(`${JSON.stringify(lease)}\n`, "utf8"); await handle.sync(); } finally { await handle.close(); }
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = await readLease(file);
        if (!existing || Date.parse(existing.expiresAt) > this.now().getTime()) return false;
        const quarantine = `${file}.stale-${process.pid}-${randomUUID()}`;
        try { await rename(file, quarantine); await rm(quarantine, { force: true }); }
        catch (renameError) { if ((renameError as NodeJS.ErrnoException).code !== "ENOENT") return false; }
      }
    }
    return false;
  }

  private async releaseLease(jobId: string, token: string): Promise<void> {
    const file = workspaceEvolutionEvaluationLeaseFile(this.workspaceRoot, jobId);
    const current = await readLease(file);
    if (current?.token !== token) return;
    const quarantine = `${file}.release-${process.pid}-${randomUUID()}`;
    try { await rename(file, quarantine); await rm(quarantine, { force: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }

  private async project(): Promise<Map<string, EvaluationJob>> {
    const projected = new Map<string, EvaluationJob>();
    for (const event of await readEvents(workspaceEvolutionEvaluationJobsFile(this.workspaceRoot))) {
      if (event.job.workspaceId !== this.workspaceId) throw new Error("Evaluation job crossed its workspace boundary");
      projected.set(event.job.jobId, event.job);
    }
    return projected;
  }

  private async append(type: JobEvent["type"], job: EvaluationJob): Promise<void> {
    const file = workspaceEvolutionEvaluationJobsFile(this.workspaceRoot);
    await mkdir(path.dirname(file), { recursive: true });
    const event: JobEvent = { eventId: createId("evaluation_job_event"), type, occurredAt: this.now().toISOString(), job };
    await appendFile(file, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600, flush: true });
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const key = path.resolve(workspaceEvolutionEvaluationJobsFile(this.workspaceRoot)).toLowerCase();
    const previous = queues.get(key) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(operation);
    const settled = pending.then(() => undefined, () => undefined);
    queues.set(key, settled);
    return pending.finally(() => { if (queues.get(key) === settled) queues.delete(key); });
  }
}

function validateRequest(commandId: string, request: EvaluationJobRequest, maxAttempts: number): void {
  if (!commandId?.trim() || !request?.candidateId || !/^[a-f0-9]{64}$/.test(request.expectedContentHash)) throw invalid("Evaluation job identity is invalid");
  if (!request.suiteRef?.id || !request.suiteRef.version || !/^[a-f0-9]{64}$/.test(request.suiteRef.contentHash)
    || !request.baselineRef?.id || !request.baselineRef.version || !request.baselineRef.contentHash || !request.runtimeSnapshotRef) throw invalid("Evaluation job snapshot is incomplete");
  if (!request.evaluatorPrincipal?.id || request.evaluatorPrincipal.type !== "system") throw invalid("Evaluation jobs require a system evaluator principal");
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) throw invalid("Evaluation job retry policy is invalid");
}
async function readEvents(file: string): Promise<JobEvent[]> {
  let content: string;
  try { content = await readFile(file, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  return content.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try {
      const event = JSON.parse(line) as JobEvent;
      if (!event?.eventId || !event.job?.jobId || !["created", "claimed", "heartbeat", "succeeded", "failed"].includes(event.type)) throw new Error("invalid event");
      return event;
    } catch (error) { throw new Error(`Evaluation job ledger is corrupt at line ${index + 1}: ${(error as Error).message}`); }
  });
}
async function readLease(file: string): Promise<Lease | undefined> { try { return JSON.parse(await readFile(file, "utf8")) as Lease; } catch { return undefined; } }
async function readCommand(file: string): Promise<CommandRecord | undefined> { try { return JSON.parse(await readFile(file, "utf8")) as CommandRecord; } catch { return undefined; } }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
function safeError(value: string): string { return redactEvolutionText(value).value.replace(/[\r\n]+/g, " ").slice(0, 1_000) || "Evaluation failed"; }
function stableId(prefix: string, ...parts: string[]): string { return `${prefix}_${hash(parts.join("\0")).slice(0, 32)}`; }
function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function invalid(message: string): HttpError { return new HttpError(400, message, "INVALID_EVOLUTION_EVALUATION_JOB"); }
function conflict(message: string): HttpError { return new HttpError(409, message, "EVOLUTION_EVALUATION_JOB_CONFLICT"); }
