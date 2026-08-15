import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { EvolutionPracticeDraft } from "../../shared/contracts/evolution.js";
import { HttpError } from "../errors.js";
import { workspaceEvolutionPracticeDraftsFile } from "../storage/paths.js";

type DraftInput = Omit<EvolutionPracticeDraft, "draftId" | "provenanceHash" | "status" | "createdAt" | "updatedAt">;
interface StoredDraft { eventId: string; draft: EvolutionPracticeDraft }
const queues = new Map<string, Promise<void>>();

export class PracticeDraftStore {
  constructor(private readonly workspaceId: string, private readonly workspaceRoot: string, private readonly now: () => Date = () => new Date()) {}

  async create(input: DraftInput): Promise<EvolutionPracticeDraft> {
    validate(input, this.workspaceId);
    return this.exclusive(async () => {
      const values = await this.readProjected(); const replay = values.find((item) => item.commandId === input.commandId);
      const provenanceHash = hash(canonical({ signalId: input.signalId, sourceEpisodeRefs: input.sourceEpisodeRefs, sourceRefs: input.sourceRefs }));
      if (replay) {
        if (replay.provenanceHash !== provenanceHash || replay.statement !== input.statement || replay.procedure !== input.procedure) throw new HttpError(409, "Practice draft command idempotency conflict", "PRACTICE_DRAFT_CONFLICT");
        return replay;
      }
      const timestamp = this.now().toISOString();
      const draft: EvolutionPracticeDraft = { ...structuredClone(input), draftId: `practice_draft_${hash(input.commandId).slice(0, 32)}`, provenanceHash, status: "draft", createdAt: timestamp, updatedAt: timestamp };
      await this.append(draft);
      return draft;
    });
  }

  async markConsolidated(draftIds: string[]): Promise<EvolutionPracticeDraft[]> {
    const uniqueIds = [...new Set(draftIds)].sort();
    if (!uniqueIds.length) return [];
    return this.exclusive(async () => {
      const values = await this.readProjected();
      const byId = new Map(values.map((draft) => [draft.draftId, draft]));
      const missing = uniqueIds.filter((draftId) => !byId.has(draftId));
      if (missing.length) throw new HttpError(404, `Practice drafts not found: ${missing.join(", ")}`, "PRACTICE_DRAFT_NOT_FOUND");
      const updated: EvolutionPracticeDraft[] = [];
      for (const draftId of uniqueIds) {
        const current = byId.get(draftId)!;
        if (current.status === "rejected") throw new HttpError(409, `Rejected practice draft cannot be consolidated: ${draftId}`, "PRACTICE_DRAFT_STATE_CONFLICT");
        if (current.status === "consolidated") { updated.push(current); continue; }
        const next = { ...current, status: "consolidated" as const, updatedAt: this.now().toISOString() };
        await this.append(next); updated.push(next);
      }
      return updated;
    });
  }

  async list(): Promise<EvolutionPracticeDraft[]> { return this.readProjected(); }

  private async readProjected(): Promise<EvolutionPracticeDraft[]> {
    const file = workspaceEvolutionPracticeDraftsFile(this.workspaceRoot);
    try {
      const projected = new Map<string, EvolutionPracticeDraft>();
      for (const line of (await readFile(file, "utf8")).split(/\r?\n/).filter(Boolean)) {
        const draft = (JSON.parse(line) as StoredDraft).draft; projected.set(draft.draftId, draft);
      }
      return [...projected.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.draftId.localeCompare(b.draftId));
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }

  private async append(draft: EvolutionPracticeDraft): Promise<void> {
    const file = workspaceEvolutionPracticeDraftsFile(this.workspaceRoot); await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify({ eventId: randomUUID(), draft })}\n`, { encoding: "utf8", mode: 0o600, flush: true });
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> { const key = path.resolve(workspaceEvolutionPracticeDraftsFile(this.workspaceRoot)).toLowerCase(); const previous = queues.get(key) ?? Promise.resolve(); const pending = previous.catch(() => undefined).then(operation); const settled = pending.then(() => undefined, () => undefined); queues.set(key, settled); return pending.finally(() => { if (queues.get(key) === settled) queues.delete(key); }); }
}

function validate(input: DraftInput, workspaceId: string): void {
  if (!input.commandId.trim() || !input.signalId.trim() || !input.statement.trim() || !input.trigger.trim() || !input.procedure.trim() || !input.sourceEpisodeRefs.length || !input.sourceRefs.length || input.sourceRefs.some((ref) => ref.workspaceId !== workspaceId) || input.applicability.workspaceId !== workspaceId || !input.applicability.profileId) throw new HttpError(400, "Practice draft is invalid", "INVALID_PRACTICE_DRAFT");
}
function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`; return JSON.stringify(value); }
