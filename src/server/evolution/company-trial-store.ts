import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { CompanyEvolutionTrial } from "../../shared/contracts/evolution.js";
import { HttpError } from "../errors.js";
import { globalCompanyEvolutionTrialsFile } from "../storage/paths.js";

type TrialInput = Omit<CompanyEvolutionTrial, "trialId" | "status" | "createdAt" | "updatedAt">;
interface TrialEvent { eventId: string; commandId: string; trial: CompanyEvolutionTrial }
const queues = new Map<string, Promise<void>>();

/** Append-only company trial registry. Runtime observations are attached in later events, never by mutating deployment facts. */
export class CompanyTrialStore {
  constructor(private readonly homeDir: string, private readonly companyId: string, private readonly now: () => Date = () => new Date()) {}

  async deploy(input: TrialInput): Promise<CompanyEvolutionTrial> {
    validate(input, this.companyId);
    return this.exclusive(async () => {
      const events = await this.read();
      const replay = events.find((event) => event.commandId === input.commandId);
      if (replay) {
        if (canonical(trialInput(replay.trial)) !== canonical(input)) throw new HttpError(409, "Company trial command idempotency conflict", "COMPANY_TRIAL_CONFLICT");
        return structuredClone(replay.trial);
      }
      const timestamp = this.now().toISOString();
      const trial: CompanyEvolutionTrial = {
        ...structuredClone(input), trialId: companyTrialId(input.commandId),
        status: "deployed", createdAt: timestamp, updatedAt: timestamp,
      };
      await this.append(input.commandId, trial); return trial;
    });
  }

  async get(trialId: string): Promise<CompanyEvolutionTrial> {
    const trial = (await this.project()).get(trialId);
    if (!trial) throw new HttpError(404, "Company trial not found", "COMPANY_TRIAL_NOT_FOUND");
    return structuredClone(trial);
  }
  async list(proposalId?: string): Promise<CompanyEvolutionTrial[]> {
    return [...(await this.project()).values()].filter((item) => !proposalId || item.proposalId === proposalId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.trialId.localeCompare(b.trialId));
  }
  async recordEvidence(commandId: string, trialId: string, evidenceId: string, decision: "pass" | "fail" | "inconclusive"): Promise<CompanyEvolutionTrial> {
    if (!commandId.trim() || !evidenceId.trim()) throw new HttpError(400, "Company trial evidence event is invalid", "INVALID_COMPANY_TRIAL");
    return this.exclusive(async () => {
      const events = await this.read(); const replay = events.find((event) => event.commandId === commandId); if (replay) return replay.trial;
      const current = (await this.project()).get(trialId); if (!current || current.status !== "deployed") throw new HttpError(409, "Company trial is not accepting evidence", "COMPANY_TRIAL_CONFLICT");
      const next: CompanyEvolutionTrial = { ...current, status: decision === "pass" ? "evidence_ready" : "failed", updatedAt: this.now().toISOString() };
      await this.append(commandId, next); return next;
    });
  }
  private async project(): Promise<Map<string, CompanyEvolutionTrial>> { const result = new Map<string, CompanyEvolutionTrial>(); for (const event of await this.read()) { if (event.trial.companyId !== this.companyId) throw new Error("Company trial crossed its private deployment boundary"); result.set(event.trial.trialId, event.trial); } return result; }
  private async read(): Promise<TrialEvent[]> { try { return (await readFile(globalCompanyEvolutionTrialsFile(this.homeDir), "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as TrialEvent); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; } }
  private async append(commandId: string, trial: CompanyEvolutionTrial): Promise<void> { const file = globalCompanyEvolutionTrialsFile(this.homeDir); await mkdir(path.dirname(file), { recursive: true }); await appendFile(file, `${JSON.stringify({ eventId: randomUUID(), commandId, trial })}\n`, { encoding: "utf8", mode: 0o600, flush: true }); }
  private async exclusive<T>(operation: () => Promise<T>): Promise<T> { const key = path.resolve(globalCompanyEvolutionTrialsFile(this.homeDir)).toLowerCase(); const previous = queues.get(key) ?? Promise.resolve(); const pending = previous.catch(() => undefined).then(operation); const settled = pending.then(() => undefined, () => undefined); queues.set(key, settled); return pending.finally(() => { if (queues.get(key) === settled) queues.delete(key); }); }
}

function validate(input: TrialInput, companyId: string): void {
  if (!input.commandId?.trim() || input.companyId !== companyId || !input.proposalId || !input.target.workspaceId || !input.target.profileId || !input.target.agentId
    || !input.assignment.salt || !Number.isSafeInteger(input.assignment.percentage) || input.assignment.percentage < 1 || input.assignment.percentage > 25
    || !Number.isSafeInteger(input.assignment.minimumSamplesPerArm) || input.assignment.minimumSamplesPerArm < 5
    || input.source.workspaceId === input.target.workspaceId
    || Boolean(input.source.profileId && input.source.profileId === input.target.profileId)) {
    throw new HttpError(400, "Company trial must target another project and another Agent with a valid selected/control rollout", "INVALID_COMPANY_TRIAL");
  }
}
function trialInput(value: CompanyEvolutionTrial): TrialInput { const { trialId: _trialId, status: _status, createdAt: _createdAt, updatedAt: _updatedAt, ...input } = value; return input; }
function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
export function companyTrialId(commandId: string): string { return `company_trial_${hash(commandId).slice(0, 32)}`; }
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`; return JSON.stringify(value); }
