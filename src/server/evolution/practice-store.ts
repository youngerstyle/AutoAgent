import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { EvolutionPractice } from "../../shared/contracts/evolution.js";
import { HttpError } from "../errors.js";
import { workspaceEvolutionPracticesFile } from "../storage/paths.js";

export type PracticeInput = Omit<EvolutionPractice, "practiceId" | "version" | "provenanceHash" | "status" | "createdAt" | "updatedAt"> & { commandId: string };
interface PracticeEvent { eventId: string; commandId: string; practice: EvolutionPractice }
const queues = new Map<string, Promise<void>>();

export class PracticeStore {
  constructor(private readonly workspaceId: string, private readonly workspaceRoot: string, private readonly now: () => Date = () => new Date()) {}

  async createCandidate(input: PracticeInput): Promise<EvolutionPractice> {
    validate(input, this.workspaceId);
    return this.exclusive(async () => {
      const events = await this.readEvents();
      const fingerprint = hash(canonical(input));
      const replay = events.find((event) => event.commandId === input.commandId);
      if (replay) {
        if (replay.practice.provenanceHash !== fingerprint) throw new HttpError(409, "Practice command idempotency conflict", "PRACTICE_CONFLICT");
        return replay.practice;
      }
      const timestamp = this.now().toISOString();
      const practice: EvolutionPractice = {
        statement: input.statement,
        trigger: input.trigger,
        procedure: input.procedure,
        expectedOutcome: structuredClone(input.expectedOutcome),
        observedComponents: [...new Set(input.observedComponents)].sort(),
        applicability: structuredClone(input.applicability),
        contraindications: [...new Set(input.contraindications)].sort(),
        sourceDraftRefs: [...new Set(input.sourceDraftRefs)].sort(),
        sourceEpisodeRefs: [...new Set(input.sourceEpisodeRefs)].sort(),
        sourceRefs: uniqueRefs(input.sourceRefs),
        practiceId: `practice_${hash(input.commandId).slice(0, 32)}`,
        version: 1,
        provenanceHash: fingerprint,
        status: "candidate",
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const file = workspaceEvolutionPracticesFile(this.workspaceRoot); await mkdir(path.dirname(file), { recursive: true });
      await appendFile(file, `${JSON.stringify({ eventId: randomUUID(), commandId: input.commandId, practice })}\n`, { encoding: "utf8", mode: 0o600, flush: true });
      return practice;
    });
  }

  async reviseCandidate(input: PracticeInput & { practiceId: string; baseVersion: number; revisionReason: string }): Promise<EvolutionPractice> {
    validate(input, this.workspaceId);
    if (!input.practiceId.trim() || !Number.isSafeInteger(input.baseVersion) || input.baseVersion < 1 || !input.revisionReason.trim()) throw new HttpError(400, "Practice revision is invalid", "INVALID_PRACTICE_REVISION");
    return this.exclusive(async () => {
      const events = await this.readEvents(); const replay = events.find((event) => event.commandId === input.commandId);
      const fingerprint = hash(canonical(input));
      if (replay) { if (replay.practice.provenanceHash !== fingerprint) throw new HttpError(409, "Practice revision command conflict", "PRACTICE_CONFLICT"); return replay.practice; }
      const versions = events.map((event) => event.practice).filter((practice) => practice.practiceId === input.practiceId).sort((a, b) => b.version - a.version);
      const base = versions[0];
      if (!base || base.version !== input.baseVersion) throw new HttpError(409, "Practice revision base is stale", "PRACTICE_CONFLICT");
      if (canonical(base.applicability) !== canonical(input.applicability)) throw new HttpError(409, "Practice revision cannot widen or change scope", "PRACTICE_SCOPE_PROMOTION_REQUIRED");
      if (!input.sourceEpisodeRefs.some((episodeId) => !base.sourceEpisodeRefs.includes(episodeId))) throw new HttpError(409, "Practice revision requires new independent Episode evidence", "PRACTICE_REVISION_EVIDENCE_REQUIRED");
      const timestamp = this.now().toISOString(); const practice: EvolutionPractice = {
        statement: input.statement, trigger: input.trigger, procedure: input.procedure, expectedOutcome: structuredClone(input.expectedOutcome),
        observedComponents: [...new Set(input.observedComponents)].sort(), applicability: structuredClone(input.applicability), contraindications: [...new Set(input.contraindications)].sort(),
        sourceDraftRefs: [...new Set(input.sourceDraftRefs)].sort(), sourceEpisodeRefs: [...new Set(input.sourceEpisodeRefs)].sort(), sourceRefs: uniqueRefs(input.sourceRefs),
        practiceId: base.practiceId, version: base.version + 1, provenanceHash: fingerprint, status: "candidate",
        previousRevision: { id: base.practiceId, version: String(base.version), contentHash: base.provenanceHash }, revisionReason: input.revisionReason.trim(), createdAt: timestamp, updatedAt: timestamp,
      };
      const file = workspaceEvolutionPracticesFile(this.workspaceRoot); await mkdir(path.dirname(file), { recursive: true });
      await appendFile(file, `${JSON.stringify({ eventId: randomUUID(), commandId: input.commandId, practice })}\n`, { encoding: "utf8", mode: 0o600, flush: true });
      return practice;
    });
  }

  async list(): Promise<EvolutionPractice[]> {
    const projected = new Map<string, EvolutionPractice>();
    for (const event of await this.readEvents()) projected.set(`${event.practice.practiceId}:${event.practice.version}`, event.practice);
    return [...projected.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.practiceId.localeCompare(b.practiceId));
  }

  private async readEvents(): Promise<PracticeEvent[]> {
    try { return (await readFile(workspaceEvolutionPracticesFile(this.workspaceRoot), "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as PracticeEvent); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const key = path.resolve(workspaceEvolutionPracticesFile(this.workspaceRoot)).toLowerCase();
    const previous = queues.get(key) ?? Promise.resolve(); const pending = previous.catch(() => undefined).then(operation);
    const settled = pending.then(() => undefined, () => undefined); queues.set(key, settled);
    return pending.finally(() => { if (queues.get(key) === settled) queues.delete(key); });
  }
}

function validate(input: PracticeInput, workspaceId: string): void {
  if (!input.commandId.trim() || !input.statement.trim() || !input.trigger.trim() || !input.procedure.trim()
    || input.sourceDraftRefs.length < 2 || input.sourceEpisodeRefs.length < 2 || !input.sourceRefs.length || !input.observedComponents.length
    || input.sourceRefs.some((ref) => ref.workspaceId !== workspaceId)
    || input.applicability.ownerLevel !== "agent_project" || input.applicability.workspaceId !== workspaceId || !input.applicability.profileId) {
    throw new HttpError(400, "Practice candidate is invalid", "INVALID_PRACTICE");
  }
}

function uniqueRefs<T>(values: T[]): T[] { return [...new Map(values.map((value) => [canonical(value), structuredClone(value)])).values()]; }
function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`; return JSON.stringify(value); }
