import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { EvolutionPhaseJob, EvolutionPhaseJobKind } from "../../shared/contracts/evolution.js";
import { HttpError } from "../errors.js";
import { workspaceEvolutionPhaseJobLeaseFile, workspaceEvolutionPhaseJobsFile } from "../storage/paths.js";
import { redactEvolutionText } from "./secret-redactor.js";

export type EvolutionPhaseJobInput = Pick<EvolutionPhaseJob, "commandId" | "kind" | "priority" | "sourceDraftRefs" | "scheduleReason" | "availableAt"> &
  Partial<Pick<EvolutionPhaseJob, "profileId" | "sourceSignalId" | "maxAttempts">>;
interface JobEvent { eventId: string; type: "created" | "claimed" | "succeeded" | "failed"; occurredAt: string; job: EvolutionPhaseJob }
const queues = new Map<string, Promise<void>>();

/** Durable phase queue. Signal capture, reflection, and consolidation never share a mutable status. */
export class EvolutionPhaseJobStore {
  constructor(private readonly workspaceId: string, private readonly workspaceRoot: string, private readonly now: () => Date = () => new Date()) {}

  async enqueue(input: EvolutionPhaseJobInput): Promise<EvolutionPhaseJob> {
    validate(input);
    return this.exclusive(async () => {
      const jobs = await this.project(); const replay = [...jobs.values()].find((job) => job.commandId === input.commandId);
      if (replay) {
        if (canonical(jobInput(replay)) !== canonical({ ...input, maxAttempts: input.maxAttempts ?? 5 })) throw conflict("Evolution phase job command idempotency conflict");
        return structuredClone(replay);
      }
      const timestamp = this.now().toISOString();
      const job: EvolutionPhaseJob = { ...structuredClone(input), jobId: stableId(input.commandId), workspaceId: this.workspaceId,
        status: "pending", attempts: 0, maxAttempts: input.maxAttempts ?? 5, createdAt: timestamp, updatedAt: timestamp };
      await this.append("created", job); return job;
    });
  }

  async claim(kind: EvolutionPhaseJobKind, workerId: string, leaseMs = 30_000): Promise<EvolutionPhaseJob | undefined> {
    if (!workerId.trim() || !Number.isSafeInteger(leaseMs) || leaseMs < 1_000) throw invalid("Evolution phase job lease is invalid");
    return this.exclusive(async () => {
      const now = this.now(); const events = await readEvents(workspaceEvolutionPhaseJobsFile(this.workspaceRoot));
      const jobs = project(events); const lastClaim = new Map<string, number>();
      events.forEach((event, index) => { if (event.type === "claimed") lastClaim.set(event.job.profileId ?? "workspace", index); });
      const due = [...jobs.values()].filter((job) => job.kind === kind && Date.parse(job.availableAt) <= now.getTime() && (job.status === "pending"
        || (job.status === "retry_wait" && Date.parse(job.nextAttemptAt ?? "") <= now.getTime())
        || (job.status === "running" && Date.parse(job.lease?.expiresAt ?? "") <= now.getTime())))
        .sort((left, right) => left.priority - right.priority
          || (lastClaim.get(left.profileId ?? "workspace") ?? -1) - (lastClaim.get(right.profileId ?? "workspace") ?? -1)
          || left.availableAt.localeCompare(right.availableAt) || left.jobId.localeCompare(right.jobId));
      for (const current of due) {
        const token = randomUUID(); if (!await this.acquireLease(current.jobId, token, workerId, leaseMs)) continue;
        const timestamp = now.toISOString(); const job: EvolutionPhaseJob = { ...current, status: "running", attempts: current.attempts + 1,
          updatedAt: timestamp, nextAttemptAt: undefined, lease: { token, workerId, heartbeatAt: timestamp, expiresAt: new Date(now.getTime() + leaseMs).toISOString() } };
        await this.append("claimed", job); return job;
      }
      return undefined;
    });
  }

  async succeed(jobId: string, token: string): Promise<EvolutionPhaseJob> { return this.finish(jobId, token); }
  async fail(jobId: string, token: string, error: { category: "transient" | "terminal"; message: string }): Promise<EvolutionPhaseJob> {
    return this.exclusive(async () => {
      const current = await this.requireOwned(jobId, token); const now = this.now(); const exhausted = error.category === "terminal" || current.attempts >= current.maxAttempts;
      const job: EvolutionPhaseJob = { ...current, status: exhausted ? "dead_letter" : "retry_wait", updatedAt: now.toISOString(), lease: undefined,
        lastError: { category: error.category, message: safeError(error.message) }, ...(exhausted ? { nextAttemptAt: undefined } : { nextAttemptAt: new Date(now.getTime() + Math.min(300_000, 1_000 * 2 ** Math.min(current.attempts - 1, 8))).toISOString() }) };
      await this.append("failed", job); await this.releaseLease(jobId, token); return job;
    });
  }
  async list(): Promise<EvolutionPhaseJob[]> { return [...(await this.project()).values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.jobId.localeCompare(b.jobId)); }

  private async finish(jobId: string, token: string): Promise<EvolutionPhaseJob> { return this.exclusive(async () => {
    const current = await this.requireOwned(jobId, token); const job: EvolutionPhaseJob = { ...current, status: "succeeded", updatedAt: this.now().toISOString(), lease: undefined, lastError: undefined };
    await this.append("succeeded", job); await this.releaseLease(jobId, token); return job;
  }); }
  private async requireOwned(jobId: string, token: string): Promise<EvolutionPhaseJob> {
    const current = (await this.project()).get(jobId); const lease = await readLease(workspaceEvolutionPhaseJobLeaseFile(this.workspaceRoot, jobId));
    if (!current) throw new HttpError(404, "Evolution phase job not found", "EVOLUTION_PHASE_JOB_NOT_FOUND");
    if (current.status !== "running" || current.lease?.token !== token || lease?.token !== token || Date.parse(lease.expiresAt) <= this.now().getTime()) throw conflict("Evolution phase job lease is not owned by this worker");
    return current;
  }
  private async acquireLease(jobId: string, token: string, workerId: string, leaseMs: number): Promise<boolean> {
    const file = workspaceEvolutionPhaseJobLeaseFile(this.workspaceRoot, jobId); await mkdir(path.dirname(file), { recursive: true });
    const lease = { token, workerId, heartbeatAt: this.now().toISOString(), expiresAt: new Date(this.now().getTime() + leaseMs).toISOString() };
    try { const handle = await open(file, "wx", 0o600); try { await handle.writeFile(`${JSON.stringify(lease)}\n`, "utf8"); await handle.sync(); } finally { await handle.close(); } return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; const existing = await readLease(file); if (existing && Date.parse(existing.expiresAt) > this.now().getTime()) return false;
      const stale = `${file}.stale-${process.pid}-${randomUUID()}`; try { await rename(file, stale); await rm(stale, { force: true }); } catch { return false; } return this.acquireLease(jobId, token, workerId, leaseMs); }
  }
  private async releaseLease(jobId: string, token: string): Promise<void> { const file = workspaceEvolutionPhaseJobLeaseFile(this.workspaceRoot, jobId); const current = await readLease(file); if (current?.token !== token) return;
    const released = `${file}.release-${process.pid}-${randomUUID()}`; try { await rename(file, released); await rm(released, { force: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
  private async project(): Promise<Map<string, EvolutionPhaseJob>> { return project(await readEvents(workspaceEvolutionPhaseJobsFile(this.workspaceRoot))); }
  private async append(type: JobEvent["type"], job: EvolutionPhaseJob): Promise<void> { const file = workspaceEvolutionPhaseJobsFile(this.workspaceRoot); await mkdir(path.dirname(file), { recursive: true }); await appendFile(file, `${JSON.stringify({ eventId: randomUUID(), type, occurredAt: this.now().toISOString(), job })}\n`, { encoding: "utf8", mode: 0o600, flush: true }); }
  private async exclusive<T>(operation: () => Promise<T>): Promise<T> { const key = path.resolve(workspaceEvolutionPhaseJobsFile(this.workspaceRoot)).toLowerCase(); const previous = queues.get(key) ?? Promise.resolve(); const pending = previous.catch(() => undefined).then(operation); const settled = pending.then(() => undefined, () => undefined); queues.set(key, settled); return pending.finally(() => { if (queues.get(key) === settled) queues.delete(key); }); }
}

function validate(input: EvolutionPhaseJobInput): void { if (!input.commandId?.trim() || !["reflection", "consolidation"].includes(input.kind) || ![0, 1, 2, 3, 4].includes(input.priority)
  || !Number.isFinite(Date.parse(input.availableAt)) || !Array.isArray(input.sourceDraftRefs) || (input.kind === "reflection") !== Boolean(input.sourceSignalId)
  || !Number.isSafeInteger(input.maxAttempts ?? 5) || (input.maxAttempts ?? 5) < 1) throw invalid("Evolution phase job input is invalid"); }
function jobInput(job: EvolutionPhaseJob): EvolutionPhaseJobInput { return { commandId: job.commandId, kind: job.kind, priority: job.priority, sourceDraftRefs: job.sourceDraftRefs,
  scheduleReason: job.scheduleReason, availableAt: job.availableAt, ...(job.profileId ? { profileId: job.profileId } : {}), ...(job.sourceSignalId ? { sourceSignalId: job.sourceSignalId } : {}), maxAttempts: job.maxAttempts }; }
function project(events: JobEvent[]): Map<string, EvolutionPhaseJob> { const jobs = new Map<string, EvolutionPhaseJob>(); for (const event of events) jobs.set(event.job.jobId, event.job); return jobs; }
async function readEvents(file: string): Promise<JobEvent[]> { try { return (await readFile(file, "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as JobEvent); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; } }
async function readLease(file: string): Promise<EvolutionPhaseJob["lease"]> { try { return JSON.parse(await readFile(file, "utf8")); } catch { return undefined; } }
function stableId(commandId: string): string { return `phase_job_${createHash("sha256").update(commandId).digest("hex").slice(0, 32)}`; }
function safeError(value: string): string { return redactEvolutionText(value).value.replace(/[\r\n]+/g, " ").slice(0, 1_000) || "Evolution phase job failed"; }
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`; return JSON.stringify(value); }
function invalid(message: string): HttpError { return new HttpError(400, message, "INVALID_EVOLUTION_PHASE_JOB"); }
function conflict(message: string): HttpError { return new HttpError(409, message, "EVOLUTION_PHASE_JOB_CONFLICT"); }
