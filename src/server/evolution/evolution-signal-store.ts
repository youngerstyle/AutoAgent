import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { EvolutionSignal } from "../../shared/contracts/evolution.js";
import { HttpError } from "../errors.js";
import { workspaceEvolutionSignalLeaseFile, workspaceEvolutionSignalsFile } from "../storage/paths.js";
import { redactEvolutionText } from "./secret-redactor.js";

type SignalInput = Pick<EvolutionSignal, "commandId" | "trigger" | "priority" | "sourceRefs" | "salience" | "novelty" | "occurredAt"> &
  Partial<Pick<EvolutionSignal, "profileId" | "episodeId" | "maxAttempts">>;
interface SignalEvent { eventId: string; type: "created" | "claimed" | "succeeded" | "failed"; occurredAt: string; signal: EvolutionSignal }
const queues = new Map<string, Promise<void>>();

export class EvolutionSignalStore {
  constructor(private readonly workspaceId: string, private readonly workspaceRoot: string, private readonly now: () => Date = () => new Date()) {}

  async enqueue(input: SignalInput): Promise<EvolutionSignal> {
    validateInput(input, this.workspaceId);
    return this.exclusive(async () => {
      const projected = await this.project();
      const replay = [...projected.values()].find((item) => item.commandId === input.commandId);
      if (replay) {
        if (!sameInput(replay, input)) throw conflict("Evolution signal command idempotency conflict");
        return replay;
      }
      const timestamp = this.now().toISOString();
      const signal: EvolutionSignal = {
        ...structuredClone(input), signalId: stableId(input.commandId), workspaceId: this.workspaceId,
        status: "pending", attempts: 0, maxAttempts: input.maxAttempts ?? 5, createdAt: timestamp, updatedAt: timestamp,
      };
      await this.append("created", signal);
      return signal;
    });
  }

  async claim(workerId: string, leaseMs = 30_000): Promise<EvolutionSignal | undefined> {
    if (!workerId.trim() || !Number.isSafeInteger(leaseMs) || leaseMs < 1_000) throw invalid("Evolution signal lease is invalid");
    return this.exclusive(async () => {
      const now = this.now();
      const due = [...(await this.project()).values()].filter((item) => item.status === "pending"
        || (item.status === "retry_wait" && Date.parse(item.nextAttemptAt ?? "") <= now.getTime())
        || (item.status === "running" && Date.parse(item.lease?.expiresAt ?? "") <= now.getTime()))
        .sort((left, right) => left.priority - right.priority || left.occurredAt.localeCompare(right.occurredAt) || left.signalId.localeCompare(right.signalId));
      for (const current of due) {
        const token = randomUUID();
        if (!await this.acquireLease(current.signalId, token, workerId, leaseMs)) continue;
        const timestamp = now.toISOString();
        const signal: EvolutionSignal = { ...current, status: "running", attempts: current.attempts + 1, updatedAt: timestamp, nextAttemptAt: undefined,
          lease: { token, workerId, heartbeatAt: timestamp, expiresAt: new Date(now.getTime() + leaseMs).toISOString() } };
        await this.append("claimed", signal);
        return signal;
      }
      return undefined;
    });
  }

  async succeed(signalId: string, token: string): Promise<EvolutionSignal> {
    return this.exclusive(async () => {
      const current = await this.requireOwned(signalId, token);
      const signal: EvolutionSignal = { ...current, status: "succeeded", updatedAt: this.now().toISOString(), lease: undefined, lastError: undefined };
      await this.append("succeeded", signal); await this.releaseLease(signalId, token); return signal;
    });
  }

  async fail(signalId: string, token: string, error: { category: "transient" | "terminal"; message: string }): Promise<EvolutionSignal> {
    return this.exclusive(async () => {
      const current = await this.requireOwned(signalId, token); const now = this.now();
      const exhausted = error.category === "terminal" || current.attempts >= current.maxAttempts;
      const delay = Math.min(300_000, 1_000 * (2 ** Math.min(current.attempts - 1, 8)));
      const signal: EvolutionSignal = { ...current, status: exhausted ? "dead_letter" : "retry_wait", updatedAt: now.toISOString(), lease: undefined,
        lastError: { category: error.category, message: safeError(error.message) },
        ...(exhausted ? { nextAttemptAt: undefined } : { nextAttemptAt: new Date(now.getTime() + delay).toISOString() }) };
      await this.append("failed", signal); await this.releaseLease(signalId, token); return signal;
    });
  }

  async list(): Promise<EvolutionSignal[]> { return [...(await this.project()).values()].sort((a, b) => a.priority - b.priority || a.occurredAt.localeCompare(b.occurredAt)); }

  private async requireOwned(signalId: string, token: string): Promise<EvolutionSignal> {
    const current = (await this.project()).get(signalId);
    if (!current) throw new HttpError(404, "Evolution signal not found", "EVOLUTION_SIGNAL_NOT_FOUND");
    if (current.status !== "running" || current.lease?.token !== token) throw conflict("Evolution signal lease is not owned by this worker");
    const lease = await readLease(workspaceEvolutionSignalLeaseFile(this.workspaceRoot, signalId));
    if (!lease || lease.token !== token || Date.parse(lease.expiresAt) <= this.now().getTime()) throw conflict("Evolution signal lease expired or changed owner");
    return current;
  }

  private async acquireLease(signalId: string, token: string, workerId: string, leaseMs: number): Promise<boolean> {
    const file = workspaceEvolutionSignalLeaseFile(this.workspaceRoot, signalId); await mkdir(path.dirname(file), { recursive: true });
    const lease = { token, workerId, heartbeatAt: this.now().toISOString(), expiresAt: new Date(this.now().getTime() + leaseMs).toISOString() };
    try { const handle = await open(file, "wx", 0o600); try { await handle.writeFile(`${JSON.stringify(lease)}\n`, "utf8"); await handle.sync(); } finally { await handle.close(); } return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readLease(file); if (!existing || Date.parse(existing.expiresAt) > this.now().getTime()) return false;
      const quarantine = `${file}.stale-${process.pid}-${randomUUID()}`;
      try { await rename(file, quarantine); await rm(quarantine, { force: true }); } catch { return false; }
      return this.acquireLease(signalId, token, workerId, leaseMs);
    }
  }

  private async releaseLease(signalId: string, token: string): Promise<void> {
    const file = workspaceEvolutionSignalLeaseFile(this.workspaceRoot, signalId); const current = await readLease(file); if (current?.token !== token) return;
    const quarantine = `${file}.release-${process.pid}-${randomUUID()}`;
    try { await rename(file, quarantine); await rm(quarantine, { force: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }

  private async project(): Promise<Map<string, EvolutionSignal>> { const values = new Map<string, EvolutionSignal>(); for (const event of await readEvents(workspaceEvolutionSignalsFile(this.workspaceRoot))) values.set(event.signal.signalId, event.signal); return values; }
  private async append(type: SignalEvent["type"], signal: EvolutionSignal): Promise<void> { const file = workspaceEvolutionSignalsFile(this.workspaceRoot); await mkdir(path.dirname(file), { recursive: true }); await appendFile(file, `${JSON.stringify({ eventId: randomUUID(), type, occurredAt: this.now().toISOString(), signal })}\n`, { encoding: "utf8", mode: 0o600, flush: true }); }
  private async exclusive<T>(operation: () => Promise<T>): Promise<T> { const key = path.resolve(workspaceEvolutionSignalsFile(this.workspaceRoot)).toLowerCase(); const previous = queues.get(key) ?? Promise.resolve(); const pending = previous.catch(() => undefined).then(operation); const settled = pending.then(() => undefined, () => undefined); queues.set(key, settled); return pending.finally(() => { if (queues.get(key) === settled) queues.delete(key); }); }
}

function validateInput(input: SignalInput, workspaceId: string): void {
  if (!input.commandId?.trim() || !input.trigger || ![0, 1, 2, 3, 4].includes(input.priority) || !Number.isFinite(input.salience) || input.salience < 0 || input.salience > 1 || !Number.isFinite(input.novelty) || input.novelty < 0 || input.novelty > 1 || !Number.isFinite(Date.parse(input.occurredAt)) || !input.sourceRefs.length || input.sourceRefs.some((ref) => ref.workspaceId !== workspaceId) || !Number.isSafeInteger(input.maxAttempts ?? 5) || (input.maxAttempts ?? 5) < 1) throw invalid("Evolution signal input is invalid");
}
function sameInput(signal: EvolutionSignal, input: SignalInput): boolean { const { signalId: _id, workspaceId: _workspace, status: _status, attempts: _attempts, createdAt: _created, updatedAt: _updated, nextAttemptAt: _next, lease: _lease, lastError: _error, ...original } = signal; return JSON.stringify(original) === JSON.stringify({ ...input, maxAttempts: input.maxAttempts ?? 5 }); }
function stableId(commandId: string): string { return `signal_${createHash("sha256").update(commandId).digest("hex").slice(0, 32)}`; }
async function readEvents(file: string): Promise<SignalEvent[]> { try { return (await readFile(file, "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as SignalEvent); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; } }
async function readLease(file: string): Promise<{ token: string; workerId: string; heartbeatAt: string; expiresAt: string } | undefined> { try { return JSON.parse(await readFile(file, "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; return undefined; } }
function safeError(value: string): string { return redactEvolutionText(value).value.replace(/[\r\n]+/g, " ").slice(0, 1_000) || "Evolution signal failed"; }
function invalid(message: string): HttpError { return new HttpError(400, message, "INVALID_EVOLUTION_SIGNAL"); }
function conflict(message: string): HttpError { return new HttpError(409, message, "EVOLUTION_SIGNAL_CONFLICT"); }
