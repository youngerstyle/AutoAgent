import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createId } from "../../shared/ids.js";
import type {
  EvolutionCandidate, EvolutionPrincipalRef, MemoryLifecycleState, PromotionRecord, RecordMemoryUsageInput,
} from "../../shared/contracts/evolution.js";
import { HttpError } from "../errors.js";
import { workspaceEvolutionMemoryLifecycleFile } from "../storage/paths.js";

type LifecycleEvent = {
  eventId: string;
  commandId: string;
  fingerprint: string;
  occurredAt: string;
} & (
  | { type: "memory.registered"; state: MemoryLifecycleState }
  | { type: "memory.used"; input: RecordMemoryUsageInput }
  | { type: "memory.pinned"; releaseId: string; pinned: boolean; approvedBy: EvolutionPrincipalRef }
  | { type: "memory.transitioned"; releaseId: string; status: MemoryLifecycleState["status"]; reason: string; approvedBy: EvolutionPrincipalRef }
);
type NewLifecycleEvent = LifecycleEvent extends infer Event ? Event extends { eventId: string } ? Omit<Event, "eventId"> : never : never;

const queues = new Map<string, Promise<void>>();

export class MemoryLifecycleStore {
  constructor(
    private readonly workspaceId: string,
    private readonly workspaceRoot: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async register(promotion: PromotionRecord, candidate: EvolutionCandidate): Promise<MemoryLifecycleState> {
    if (candidate.kind !== "memory" || promotion.stage !== "production" || promotion.candidateId !== candidate.candidateId || promotion.toRelease.contentHash !== candidate.contentHash) {
      throw invalid("Only a matching production Memory release can enter lifecycle governance");
    }
    const timestamp = promotion.createdAt;
    const state: MemoryLifecycleState = {
      releaseId: promotion.toRelease.id, releaseRef: structuredClone(promotion.toRelease), target: candidate.target,
      scope: structuredClone(candidate.scope), status: "active", pinned: false, registeredAt: timestamp, updatedAt: timestamp,
      useCount: 0, successfulEpisodeCount: 0, failedEpisodeCount: 0,
    };
    await this.append({
      type: "memory.registered", commandId: `register:${promotion.promotionId}`, occurredAt: timestamp,
      fingerprint: hash(JSON.stringify({ promotionId: promotion.promotionId, state })), state,
    });
    return (await this.get(state.releaseId))!;
  }

  async recordUsage(input: RecordMemoryUsageInput): Promise<MemoryLifecycleState> {
    if (!input.commandId?.trim() || !input.releaseId || !input.episodeId || !["succeeded", "returned", "failed", "blocked", "cancelled"].includes(input.outcome)
      || !Number.isFinite(Date.parse(input.occurredAt)) || !input.sourceRefs.length || input.sourceRefs.some((ref) => ref.workspaceId !== this.workspaceId)) throw invalid("Memory usage record is invalid");
    if (!await this.get(input.releaseId)) throw new HttpError(404, "Memory lifecycle release not found", "EVOLUTION_MEMORY_NOT_FOUND");
    await this.append({
      type: "memory.used", commandId: input.commandId, occurredAt: input.occurredAt,
      fingerprint: hash(JSON.stringify(input)), input: structuredClone(input),
    });
    return (await this.get(input.releaseId))!;
  }

  async pin(commandId: string, releaseId: string, pinned: boolean, approvedBy: EvolutionPrincipalRef): Promise<MemoryLifecycleState> {
    if (approvedBy.type !== "human" || !approvedBy.id) throw new HttpError(403, "Memory pin changes require human approval", "EVOLUTION_APPROVAL_REQUIRED");
    if (!await this.get(releaseId)) throw new HttpError(404, "Memory lifecycle release not found", "EVOLUTION_MEMORY_NOT_FOUND");
    const occurredAt = this.now().toISOString();
    await this.append({ type: "memory.pinned", commandId, occurredAt, fingerprint: hash(JSON.stringify({ commandId, releaseId, pinned, approvedBy })), releaseId, pinned, approvedBy });
    return (await this.get(releaseId))!;
  }

  async transition(commandId: string, releaseId: string, status: MemoryLifecycleState["status"], reason: string, approvedBy: EvolutionPrincipalRef): Promise<MemoryLifecycleState> {
    const current = await this.get(releaseId);
    if (!current) throw new HttpError(404, "Memory lifecycle release not found", "EVOLUTION_MEMORY_NOT_FOUND");
    if (!reason.trim() || !approvedBy.id || approvedBy.type === "agent") throw invalid("Memory lifecycle transition is invalid");
    if (current.pinned && status !== "active" && approvedBy.type !== "human") throw new HttpError(409, "Pinned Memory requires human approval to retire", "EVOLUTION_MEMORY_PINNED");
    const occurredAt = this.now().toISOString();
    await this.append({
      type: "memory.transitioned", commandId, occurredAt,
      fingerprint: hash(JSON.stringify({ commandId, releaseId, status, reason, approvedBy })), releaseId, status, reason: reason.trim(), approvedBy,
    });
    return (await this.get(releaseId))!;
  }

  async maintain(options: { staleAfterDays?: number; archiveAfterDays?: number } = {}): Promise<MemoryLifecycleState[]> {
    const staleAfterMs = positiveDays(options.staleAfterDays ?? 30) * 86_400_000;
    const archiveAfterMs = positiveDays(options.archiveAfterDays ?? 90) * 86_400_000;
    if (archiveAfterMs <= staleAfterMs) throw invalid("Memory archive threshold must exceed stale threshold");
    const now = this.now();
    for (const state of await this.list()) {
      if (state.pinned || state.status === "archived") continue;
      const reference = Date.parse(state.lastSuccessfulAt ?? state.lastUsedAt ?? state.registeredAt);
      const age = now.getTime() - reference;
      if (state.status === "active" && age >= staleAfterMs) {
        await this.transition(`maintenance:stale:${state.releaseId}:${now.toISOString()}`, state.releaseId, "stale", "No successful use within the stale window", { type: "system", id: "memory-lifecycle-maintainer/v1" });
      } else if (state.status === "stale" && age >= archiveAfterMs) {
        await this.transition(`maintenance:archive:${state.releaseId}:${now.toISOString()}`, state.releaseId, "archived", "No successful use within the archive window", { type: "system", id: "memory-lifecycle-maintainer/v1" });
      }
    }
    return this.list();
  }

  async get(releaseId: string): Promise<MemoryLifecycleState | undefined> { return (await this.project()).states.get(releaseId); }
  async list(): Promise<MemoryLifecycleState[]> { return [...(await this.project()).states.values()].sort((a, b) => a.registeredAt.localeCompare(b.registeredAt) || a.releaseId.localeCompare(b.releaseId)); }

  private async append(event: NewLifecycleEvent): Promise<void> {
    await this.exclusive(async () => {
      const state = await this.project();
      const replay = state.commands.get(event.commandId);
      if (replay) {
        if (replay.fingerprint !== event.fingerprint || replay.type !== event.type) throw conflict("Memory lifecycle command idempotency conflict");
        return;
      }
      const file = workspaceEvolutionMemoryLifecycleFile(this.workspaceRoot);
      await mkdir(path.dirname(file), { recursive: true });
      await appendFile(file, `${JSON.stringify({ ...event, eventId: createId("memory_event") })}\n`, { encoding: "utf8", mode: 0o600, flush: true });
    });
  }

  private async project(): Promise<{ states: Map<string, MemoryLifecycleState>; commands: Map<string, LifecycleEvent> }> {
    const states = new Map<string, MemoryLifecycleState>();
    const commands = new Map<string, LifecycleEvent>();
    for (const event of await readEvents(workspaceEvolutionMemoryLifecycleFile(this.workspaceRoot))) {
      const replay = commands.get(event.commandId);
      if (replay && replay.fingerprint !== event.fingerprint) throw new Error("Memory lifecycle command conflict");
      commands.set(event.commandId, event);
      if (event.type === "memory.registered") {
        if (event.state.scope.workspaceId !== this.workspaceId) throw new Error("Memory lifecycle crossed its workspace boundary");
        const existing = states.get(event.state.releaseId);
        if (existing && existing.releaseRef.contentHash !== event.state.releaseRef.contentHash) throw new Error("Memory release identity conflict");
        states.set(event.state.releaseId, structuredClone(existing ?? event.state));
      } else {
        const releaseId = event.type === "memory.used" ? event.input.releaseId : event.releaseId;
        const current = states.get(releaseId);
        if (!current) throw new Error("Memory lifecycle event references an unregistered release");
        if (event.type === "memory.used") {
          const succeeded = event.input.outcome === "succeeded";
          const failed = event.input.outcome === "failed" || event.input.outcome === "returned";
          states.set(current.releaseId, {
            ...current, useCount: current.useCount + 1,
            successfulEpisodeCount: current.successfulEpisodeCount + Number(succeeded),
            failedEpisodeCount: current.failedEpisodeCount + Number(failed),
            lastUsedAt: event.input.occurredAt, ...(succeeded ? { lastSuccessfulAt: event.input.occurredAt } : {}),
            lastEpisodeId: event.input.episodeId, lastOutcome: event.input.outcome, updatedAt: event.occurredAt,
          });
        } else if (event.type === "memory.pinned") {
          states.set(current.releaseId, { ...current, pinned: event.pinned, ...(event.pinned ? { status: "active" as const } : {}), updatedAt: event.occurredAt });
        } else {
          states.set(current.releaseId, { ...current, status: event.status, updatedAt: event.occurredAt });
        }
      }
    }
    return { states, commands };
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const key = path.resolve(workspaceEvolutionMemoryLifecycleFile(this.workspaceRoot)).toLowerCase();
    const previous = queues.get(key) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(operation);
    const settled = pending.then(() => undefined, () => undefined);
    queues.set(key, settled);
    return pending.finally(() => { if (queues.get(key) === settled) queues.delete(key); });
  }
}

async function readEvents(file: string): Promise<LifecycleEvent[]> {
  let raw: string; try { raw = await readFile(file, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  return raw.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { const event = JSON.parse(line) as LifecycleEvent; if (!event?.eventId || !event.commandId || !event.fingerprint || !event.type) throw new Error("invalid event"); return event; }
    catch (error) { throw new Error(`Memory lifecycle ledger is corrupt at line ${index + 1}: ${(error as Error).message}`); }
  });
}
function positiveDays(value: number): number { if (!Number.isFinite(value) || value <= 0) throw invalid("Memory lifecycle threshold is invalid"); return value; }
function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function invalid(message: string): HttpError { return new HttpError(400, message, "INVALID_EVOLUTION_MEMORY_LIFECYCLE"); }
function conflict(message: string): HttpError { return new HttpError(409, message, "EVOLUTION_MEMORY_LIFECYCLE_CONFLICT"); }
