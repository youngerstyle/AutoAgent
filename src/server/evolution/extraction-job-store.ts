import { randomUUID } from "node:crypto";
import { appendFile, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { createId } from "../../shared/ids.js";
import type { ExtractionJob } from "../../shared/contracts/evolution.js";
import { HttpError } from "../errors.js";
import { writeJson } from "../storage/json.js";
import { workspaceEvolutionExtractionJobsFile, workspaceEvolutionExtractionLeaseFile } from "../storage/paths.js";
import { redactEvolutionText } from "./secret-redactor.js";

interface JobEvent { eventId: string; type: "created" | "claimed" | "heartbeat" | "succeeded" | "failed"; occurredAt: string; job: ExtractionJob }
const queues = new Map<string, Promise<void>>();

export class ExtractionJobStore {
  constructor(
    private readonly workspaceId: string,
    private readonly workspaceRoot: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async enqueue(commandId: string, maxAttempts = 5): Promise<ExtractionJob> {
    if (!commandId.trim() || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) throw invalid("Extraction job command is invalid");
    return this.exclusive(async () => {
      const jobs = await this.project();
      const replay = [...jobs.values()].find((job) => job.commandId === commandId);
      if (replay) {
        if (replay.maxAttempts !== maxAttempts) throw conflict("Extraction job command idempotency conflict");
        return replay;
      }
      const timestamp = this.now().toISOString();
      const job: ExtractionJob = {
        jobId: createId("extraction"), commandId, workspaceId: this.workspaceId, kind: "experience_reconcile",
        status: "pending", attempts: 0, maxAttempts, createdAt: timestamp, updatedAt: timestamp,
      };
      await this.append("created", job);
      return job;
    });
  }

  async claim(workerId: string, leaseMs = 30_000): Promise<ExtractionJob | undefined> {
    if (!workerId.trim() || !Number.isSafeInteger(leaseMs) || leaseMs < 1_000) throw invalid("Extraction lease is invalid");
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
        const job: ExtractionJob = {
          ...current, status: "running", attempts: current.attempts + 1, updatedAt: iso, nextAttemptAt: undefined,
          lease: { token, workerId, heartbeatAt: iso, expiresAt: new Date(timestamp.getTime() + leaseMs).toISOString() },
        };
        await this.append("claimed", job);
        return job;
      }
      return undefined;
    });
  }

  async heartbeat(jobId: string, token: string, leaseMs = 30_000): Promise<ExtractionJob> {
    return this.exclusive(async () => {
      const current = await this.requireOwned(jobId, token);
      const timestamp = this.now();
      const job: ExtractionJob = { ...current, updatedAt: timestamp.toISOString(), lease: { ...current.lease!, heartbeatAt: timestamp.toISOString(), expiresAt: new Date(timestamp.getTime() + leaseMs).toISOString() } };
      await writeJson(workspaceEvolutionExtractionLeaseFile(this.workspaceRoot, jobId), job.lease);
      await this.append("heartbeat", job);
      return job;
    });
  }

  async succeed(jobId: string, token: string, result: NonNullable<ExtractionJob["result"]>): Promise<ExtractionJob> {
    return this.exclusive(async () => {
      const current = await this.requireOwned(jobId, token);
      const job: ExtractionJob = { ...current, status: "succeeded", updatedAt: this.now().toISOString(), lease: undefined, result, lastError: undefined };
      await this.append("succeeded", job);
      await this.releaseLease(jobId, token);
      return job;
    });
  }

  async fail(jobId: string, token: string, error: { category: "transient" | "terminal"; message: string }): Promise<ExtractionJob> {
    return this.exclusive(async () => {
      const current = await this.requireOwned(jobId, token);
      const exhausted = error.category === "terminal" || current.attempts >= current.maxAttempts;
      const timestamp = this.now();
      const delay = Math.min(300_000, 1_000 * (2 ** Math.min(current.attempts - 1, 8)));
      const job: ExtractionJob = {
        ...current, status: exhausted ? "dead_letter" : "retry_wait", updatedAt: timestamp.toISOString(), lease: undefined,
        lastError: { category: error.category, message: safeError(error.message) },
        ...(exhausted ? { nextAttemptAt: undefined } : { nextAttemptAt: new Date(timestamp.getTime() + delay).toISOString() }),
      };
      await this.append("failed", job);
      await this.releaseLease(jobId, token);
      return job;
    });
  }

  async list(): Promise<ExtractionJob[]> {
    return [...(await this.project()).values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  private async requireOwned(jobId: string, token: string): Promise<ExtractionJob> {
    const current = (await this.project()).get(jobId);
    if (!current) throw new HttpError(404, "Extraction job not found", "EVOLUTION_EXTRACTION_JOB_NOT_FOUND");
    if (current.status !== "running" || current.lease?.token !== token) throw conflict("Extraction lease is not owned by this worker");
    const lease = await readLease(workspaceEvolutionExtractionLeaseFile(this.workspaceRoot, jobId));
    if (!lease || lease.token !== token || Date.parse(lease.expiresAt) <= this.now().getTime()) throw conflict("Extraction lease expired or changed owner");
    return current;
  }

  private async acquireLease(jobId: string, token: string, workerId: string, leaseMs: number): Promise<boolean> {
    const file = workspaceEvolutionExtractionLeaseFile(this.workspaceRoot, jobId);
    await mkdir(path.dirname(file), { recursive: true });
    const lease = { token, workerId, heartbeatAt: this.now().toISOString(), expiresAt: new Date(this.now().getTime() + leaseMs).toISOString() };
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
    const file = workspaceEvolutionExtractionLeaseFile(this.workspaceRoot, jobId);
    const current = await readLease(file);
    if (current?.token !== token) return;
    const quarantine = `${file}.release-${process.pid}-${randomUUID()}`;
    try { await rename(file, quarantine); await rm(quarantine, { force: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }

  private async project(): Promise<Map<string, ExtractionJob>> {
    const projected = new Map<string, ExtractionJob>();
    for (const event of await readEvents(workspaceEvolutionExtractionJobsFile(this.workspaceRoot))) projected.set(event.job.jobId, event.job);
    return projected;
  }

  private async append(type: JobEvent["type"], job: ExtractionJob): Promise<void> {
    const file = workspaceEvolutionExtractionJobsFile(this.workspaceRoot);
    await mkdir(path.dirname(file), { recursive: true });
    const event: JobEvent = { eventId: createId("extraction_event"), type, occurredAt: this.now().toISOString(), job };
    await appendFile(file, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600, flush: true });
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const key = path.resolve(workspaceEvolutionExtractionJobsFile(this.workspaceRoot)).toLowerCase();
    const previous = queues.get(key) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(operation);
    const settled = pending.then(() => undefined, () => undefined);
    queues.set(key, settled);
    return pending.finally(() => { if (queues.get(key) === settled) queues.delete(key); });
  }
}

async function readEvents(file: string): Promise<JobEvent[]> {
  let content: string;
  try { content = await readFile(file, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  return content.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line) as JobEvent; } catch (error) { throw new Error(`Extraction job ledger is corrupt at line ${index + 1}: ${(error as Error).message}`); }
  });
}
async function readLease(file: string): Promise<{ token: string; workerId: string; heartbeatAt: string; expiresAt: string } | undefined> {
  try { return JSON.parse(await readFile(file, "utf8")) as { token: string; workerId: string; heartbeatAt: string; expiresAt: string }; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; return undefined; }
}
function safeError(value: string): string { return redactEvolutionText(value).value.replace(/[\r\n]+/g, " ").slice(0, 1_000) || "Extraction failed"; }
function invalid(message: string): HttpError { return new HttpError(400, message, "INVALID_EVOLUTION_EXTRACTION_JOB"); }
function conflict(message: string): HttpError { return new HttpError(409, message, "EVOLUTION_EXTRACTION_JOB_CONFLICT"); }
