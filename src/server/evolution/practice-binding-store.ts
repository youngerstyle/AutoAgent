import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { EvolutionArtifactKind, EvolutionPracticeBinding, VersionedEvolutionRef } from "../../shared/contracts/evolution.js";
import { HttpError } from "../errors.js";
import { workspaceEvolutionPracticeBindingsFile } from "../storage/paths.js";

interface BindingEvent { eventId: string; commandId: string; binding: EvolutionPracticeBinding }
const queues = new Map<string, Promise<void>>();

export class PracticeBindingStore {
  constructor(private readonly workspaceRoot: string, private readonly now: () => Date = () => new Date()) {}

  async propose(commandId: string, practiceRef: VersionedEvolutionRef, kind: EvolutionArtifactKind, target: string): Promise<EvolutionPracticeBinding> {
    if (!commandId.trim() || !practiceRef.id || !practiceRef.version || !/^[a-f0-9]{64}$/.test(practiceRef.contentHash) || !target.trim()) throw new HttpError(400, "Practice binding is invalid", "INVALID_PRACTICE_BINDING");
    return this.exclusive(async () => {
      const events = await this.readEvents(); const replay = events.find((event) => event.commandId === commandId);
      if (replay) {
        if (replay.binding.practiceRef.id !== practiceRef.id || replay.binding.kind !== kind || replay.binding.target !== target) throw new HttpError(409, "Practice binding command conflict", "PRACTICE_BINDING_CONFLICT");
        return replay.binding;
      }
      const timestamp = this.now().toISOString();
      const binding: EvolutionPracticeBinding = { bindingId: `binding_${hash(commandId).slice(0, 32)}`, practiceRef: structuredClone(practiceRef), kind, target, status: "proposed", createdAt: timestamp, updatedAt: timestamp };
      await this.append(commandId, binding); return binding;
    });
  }

  async attachCandidate(commandId: string, bindingId: string, candidateRef: VersionedEvolutionRef): Promise<EvolutionPracticeBinding> {
    return this.exclusive(async () => {
      const values = await this.project(); const current = values.get(bindingId);
      if (!current) throw new HttpError(404, "Practice binding not found", "PRACTICE_BINDING_NOT_FOUND");
      if (current.candidateRef) {
        if (JSON.stringify(current.candidateRef) !== JSON.stringify(candidateRef)) throw new HttpError(409, "Practice binding candidate conflict", "PRACTICE_BINDING_CONFLICT");
        return current;
      }
      const next: EvolutionPracticeBinding = { ...current, candidateRef: structuredClone(candidateRef), status: "candidate_created", updatedAt: this.now().toISOString() };
      await this.append(commandId, next); return next;
    });
  }

  async list(): Promise<EvolutionPracticeBinding[]> { return [...(await this.project()).values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.bindingId.localeCompare(b.bindingId)); }
  private async project(): Promise<Map<string, EvolutionPracticeBinding>> { const result = new Map<string, EvolutionPracticeBinding>(); for (const event of await this.readEvents()) result.set(event.binding.bindingId, event.binding); return result; }
  private async readEvents(): Promise<BindingEvent[]> { try { return (await readFile(workspaceEvolutionPracticeBindingsFile(this.workspaceRoot), "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as BindingEvent); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; } }
  private async append(commandId: string, binding: EvolutionPracticeBinding): Promise<void> { const file = workspaceEvolutionPracticeBindingsFile(this.workspaceRoot); await mkdir(path.dirname(file), { recursive: true }); await appendFile(file, `${JSON.stringify({ eventId: randomUUID(), commandId, binding })}\n`, { encoding: "utf8", mode: 0o600, flush: true }); }
  private async exclusive<T>(operation: () => Promise<T>): Promise<T> { const key = path.resolve(workspaceEvolutionPracticeBindingsFile(this.workspaceRoot)).toLowerCase(); const previous = queues.get(key) ?? Promise.resolve(); const pending = previous.catch(() => undefined).then(operation); const settled = pending.then(() => undefined, () => undefined); queues.set(key, settled); return pending.finally(() => { if (queues.get(key) === settled) queues.delete(key); }); }
}

function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
