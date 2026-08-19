import { createHash } from "node:crypto";
import { appendFile, mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import type { EvaluationCaseResult, EvolutionPairedTrial, EvolutionPairedTrialRequest } from "../../shared/contracts/evolution.js";
import { HttpError } from "../errors.js";
import { workspaceEvolutionPairedTrialCommandFile, workspaceEvolutionPairedTrialsFile } from "../storage/paths.js";
import { redactEvolutionText } from "./secret-redactor.js";
import { validLocalTrialInputRef } from "./trial-input-ref.js";

interface TrialEvent { type: "created" | "dispatched" | "succeeded" | "failed" | "inconclusive"; occurredAt: string; trial: EvolutionPairedTrial }
interface CommandRecord { commandId: string; fingerprint: string; trial: EvolutionPairedTrial }
const queues = new Map<string, Promise<void>>();

export class EvolutionPairedTrialStore {
  constructor(private readonly workspaceId: string, private readonly workspaceRoot: string, private readonly now: () => Date = () => new Date()) {}

  async enqueue(commandId: string, request: EvolutionPairedTrialRequest, maxAttempts = 3): Promise<EvolutionPairedTrial> {
    validateRequest(commandId, request, this.workspaceId);
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) throw invalid("Paired trial retry policy is invalid");
    const fingerprint = hash(canonical({ commandId, request, maxAttempts }));
    return this.exclusive(async () => {
      const commandFile = workspaceEvolutionPairedTrialCommandFile(this.workspaceRoot, hash(commandId));
      const timestamp = this.now().toISOString();
      const trial: EvolutionPairedTrial = {
        trialId: stableId("paired_trial", this.workspaceId, commandId), commandId, requestFingerprint: fingerprint,
        workspaceId: this.workspaceId, request: structuredClone(request), status: "pending", attempts: 0, maxAttempts, createdAt: timestamp, updatedAt: timestamp,
      };
      await mkdir(path.dirname(commandFile), { recursive: true });
      try {
        const handle = await open(commandFile, "wx", 0o600);
        try { await handle.writeFile(`${JSON.stringify({ commandId, fingerprint, trial } satisfies CommandRecord)}\n`, "utf8"); await handle.sync(); } finally { await handle.close(); }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = await readCommand(commandFile);
        if (!existing || existing.commandId !== commandId || existing.fingerprint !== fingerprint) throw conflict("Paired trial command idempotency conflict");
        const current = (await this.project()).get(existing.trial.trialId);
        if (!current) await this.append("created", existing.trial);
        return current ?? existing.trial;
      }
      await this.append("created", trial);
      return trial;
    });
  }

  async markDispatched(trialId: string, dispatchRef: string): Promise<EvolutionPairedTrial> {
    if (!dispatchRef.trim()) throw invalid("Paired trial dispatch reference is invalid");
    return this.transition(trialId, "dispatched", (current) => {
      if (current.dispatchRef && current.dispatchRef !== dispatchRef) throw conflict("Paired trial dispatch reference conflict");
      if (!["pending", "retry_wait", "dispatched"].includes(current.status)) throw conflict(`Paired trial cannot dispatch from ${current.status}`);
      return { ...current, status: "dispatched", attempts: current.status === "dispatched" ? current.attempts : current.attempts + 1, dispatchRef, nextAttemptAt: undefined, updatedAt: this.now().toISOString() };
    });
  }

  async succeed(trialId: string, caseResults: EvaluationCaseResult[]): Promise<EvolutionPairedTrial> {
    if (!Array.isArray(caseResults) || !caseResults.length) throw invalid("Paired trial result is empty");
    return this.transition(trialId, "succeeded", (current) => ({ ...current, status: "succeeded", caseResults: structuredClone(caseResults), lastError: undefined, updatedAt: this.now().toISOString() }));
  }

  async fail(trialId: string, input: { status: "failed" | "inconclusive"; category: "transient" | "terminal"; message: string; countAttempt?: boolean }): Promise<EvolutionPairedTrial> {
    return this.transition(trialId, input.status, (current) => {
      const timestamp = this.now();
      const attempts = current.attempts + (input.countAttempt ? 1 : 0);
      const retry = input.category === "transient" && attempts < current.maxAttempts;
      const delay = Math.min(300_000, 1_000 * (2 ** Math.min(Math.max(0, attempts - 1), 8)));
      return {
        ...current, attempts, status: retry ? "retry_wait" : input.status, dispatchRef: retry ? undefined : current.dispatchRef, updatedAt: timestamp.toISOString(),
        ...(retry ? { nextAttemptAt: new Date(timestamp.getTime() + delay).toISOString() } : { nextAttemptAt: undefined }),
        lastError: { category: input.category, message: safeError(input.message) },
      };
    });
  }

  async listDispatchable(): Promise<EvolutionPairedTrial[]> {
    const now = this.now().getTime();
    return (await this.list()).filter((item) => item.status === "pending" || (item.status === "retry_wait" && Date.parse(item.nextAttemptAt ?? "") <= now));
  }

  async get(trialId: string): Promise<EvolutionPairedTrial> {
    const value = (await this.project()).get(trialId);
    if (!value) throw new HttpError(404, "Paired trial not found", "EVOLUTION_PAIRED_TRIAL_NOT_FOUND");
    return value;
  }

  async list(): Promise<EvolutionPairedTrial[]> {
    return [...(await this.project()).values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.trialId.localeCompare(right.trialId));
  }

  private async transition(trialId: string, type: TrialEvent["type"], update: (current: EvolutionPairedTrial) => EvolutionPairedTrial): Promise<EvolutionPairedTrial> {
    return this.exclusive(async () => {
      const current = (await this.project()).get(trialId);
      if (!current) throw new HttpError(404, "Paired trial not found", "EVOLUTION_PAIRED_TRIAL_NOT_FOUND");
      const next = update(current);
      await this.append(type, next);
      return next;
    });
  }

  private async project(): Promise<Map<string, EvolutionPairedTrial>> {
    const projected = new Map<string, EvolutionPairedTrial>();
    for (const event of await readEvents(workspaceEvolutionPairedTrialsFile(this.workspaceRoot))) {
      if (event.trial.workspaceId !== this.workspaceId) throw new Error("Paired trial crossed its workspace boundary");
      projected.set(event.trial.trialId, event.trial);
    }
    return projected;
  }

  private async append(type: TrialEvent["type"], trial: EvolutionPairedTrial): Promise<void> {
    const file = workspaceEvolutionPairedTrialsFile(this.workspaceRoot);
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify({ type, occurredAt: this.now().toISOString(), trial } satisfies TrialEvent)}\n`, { encoding: "utf8", mode: 0o600, flush: true });
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const key = path.resolve(workspaceEvolutionPairedTrialsFile(this.workspaceRoot)).toLowerCase();
    const previous = queues.get(key) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(operation);
    const settled = pending.then(() => undefined, () => undefined);
    queues.set(key, settled);
    return pending.finally(() => { if (queues.get(key) === settled) queues.delete(key); });
  }
}

function validateRequest(commandId: string, request: EvolutionPairedTrialRequest, workspaceId: string): void {
  if (!commandId.trim() || !request.candidateId || !/^[a-f0-9]{64}$/.test(request.expectedContentHash)) throw invalid("Paired trial identity is invalid");
  if (!validRef(request.suiteRef) || !validRef(request.baselineRef) || !validRef(request.policyRef) || !request.runtimeSnapshotRef.trim()) throw invalid("Paired trial snapshot is incomplete");
  if (!Array.isArray(request.cases) || request.cases.length < 3 || request.cases.some((item) => !validLocalTrialInputRef(item.inputRef, workspaceId))) throw invalid("Paired trial cases must use locally resolvable authoritative facts");
  const groups = new Set(request.cases.map((item) => item.group));
  if (!["target", "regression", "safety"].every((group) => groups.has(group as "target" | "regression" | "safety"))) throw invalid("Paired trial requires target, regression, and safety cases");
}
function validRef(value: { id: string; version: string; contentHash: string } | undefined): boolean { return Boolean(value?.id && value.version && value.contentHash); }
async function readEvents(file: string): Promise<TrialEvent[]> { try { return (await readFile(file, "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as TrialEvent); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; } }
async function readCommand(file: string): Promise<CommandRecord | undefined> { try { return JSON.parse(await readFile(file, "utf8")) as CommandRecord; } catch { return undefined; } }
function safeError(value: string): string { return redactEvolutionText(value).value.replace(/[\r\n]+/g, " ").slice(0, 1_000) || "Paired trial failed"; }
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`; return JSON.stringify(value); }
function stableId(prefix: string, ...parts: string[]): string { return `${prefix}_${hash(parts.join("\0")).slice(0, 32)}`; }
function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function invalid(message: string): HttpError { return new HttpError(400, message, "INVALID_EVOLUTION_PAIRED_TRIAL"); }
function conflict(message: string): HttpError { return new HttpError(409, message, "EVOLUTION_PAIRED_TRIAL_CONFLICT"); }
