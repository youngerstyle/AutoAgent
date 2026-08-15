import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { EvolutionPrincipalRef, EvolutionScopePromotionProposal, EvolutionPracticeScope, ScopePromotionStatus, VersionedEvolutionRef } from "../../shared/contracts/evolution.js";
import { HttpError } from "../errors.js";
import { globalCompanyEvolutionPromotionProposalsFile } from "../storage/paths.js";

type ProposalInput = Pick<EvolutionScopePromotionProposal, "commandId" | "companyId" | "origin" | "targetScope" | "originReleaseRef" | "practiceRef" | "inheritanceProofRefs" | "effectWindowRefs" | "generalizationRisks">;
interface PromotionEvent { eventId: string; commandId: string; proposal: EvolutionScopePromotionProposal }
const queues = new Map<string, Promise<void>>();

export class ScopePromotionStore {
  constructor(private readonly homeDir: string, private readonly companyId: string, private readonly now: () => Date = () => new Date()) {}

  async propose(input: ProposalInput): Promise<EvolutionScopePromotionProposal> {
    const normalized = { ...structuredClone(input), inheritanceProofRefs: unique(input.inheritanceProofRefs), effectWindowRefs: unique(input.effectWindowRefs), generalizationRisks: unique(input.generalizationRisks) };
    validateProposal(normalized, this.companyId);
    return this.exclusive(async () => {
      const events = await this.readEvents(); const fingerprint = canonical(normalized);
      const replay = events.find((event) => event.commandId === normalized.commandId);
      if (replay) {
        if (canonical(proposalInput(replay.proposal)) !== fingerprint) throw conflict("Scope promotion command idempotency conflict");
        return replay.proposal;
      }
      const timestamp = this.now().toISOString();
      const proposal: EvolutionScopePromotionProposal = {
        ...normalized, proposalId: `scope_promotion_${hash(normalized.commandId).slice(0, 32)}`,
        status: "proposed", createdAt: timestamp, updatedAt: timestamp,
      };
      await this.append(normalized.commandId, proposal); return proposal;
    });
  }

  async transition(commandId: string, proposalId: string, targetStatus: Exclude<ScopePromotionStatus, "proposed">, reviewedBy: EvolutionPrincipalRef): Promise<EvolutionScopePromotionProposal> {
    if (!commandId.trim() || !proposalId || !reviewedBy?.id || !["agent", "human", "system"].includes(reviewedBy.type)) throw invalid("Scope promotion transition is invalid");
    return this.exclusive(async () => {
      const events = await this.readEvents(); const replay = events.find((event) => event.commandId === commandId);
      if (replay) {
        if (replay.proposal.proposalId !== proposalId || replay.proposal.status !== targetStatus) throw conflict("Scope promotion transition command conflict");
        return replay.proposal;
      }
      const current = (await this.project(events)).get(proposalId);
      if (!current) throw new HttpError(404, "Scope promotion proposal not found", "SCOPE_PROMOTION_NOT_FOUND");
      if (!allowed(current.status, targetStatus, current.targetScope)) throw conflict(`Scope promotion cannot move from ${current.status} to ${targetStatus}`);
      if (["reviewed", "approved", "rejected"].includes(targetStatus) && reviewedBy.type !== "human") throw new HttpError(403, "Scope promotion review requires a human", "SCOPE_PROMOTION_HUMAN_REQUIRED");
      const next: EvolutionScopePromotionProposal = { ...current, status: targetStatus, reviewedBy: structuredClone(reviewedBy), updatedAt: this.now().toISOString() };
      await this.append(commandId, next); return next;
    });
  }

  async list(): Promise<EvolutionScopePromotionProposal[]> { return [...(await this.project(await this.readEvents())).values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.proposalId.localeCompare(b.proposalId)); }
  private async project(events: PromotionEvent[]): Promise<Map<string, EvolutionScopePromotionProposal>> { const result = new Map<string, EvolutionScopePromotionProposal>(); for (const event of events) { if (event.proposal.companyId !== this.companyId) throw new Error("Scope promotion crossed its company boundary"); result.set(event.proposal.proposalId, event.proposal); } return result; }
  private async readEvents(): Promise<PromotionEvent[]> { try { return (await readFile(globalCompanyEvolutionPromotionProposalsFile(this.homeDir), "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as PromotionEvent); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; } }
  private async append(commandId: string, proposal: EvolutionScopePromotionProposal): Promise<void> { const file = globalCompanyEvolutionPromotionProposalsFile(this.homeDir); await mkdir(path.dirname(file), { recursive: true }); await appendFile(file, `${JSON.stringify({ eventId: randomUUID(), commandId, proposal })}\n`, { encoding: "utf8", mode: 0o600, flush: true }); }
  private async exclusive<T>(operation: () => Promise<T>): Promise<T> { const key = path.resolve(globalCompanyEvolutionPromotionProposalsFile(this.homeDir)).toLowerCase(); const previous = queues.get(key) ?? Promise.resolve(); const pending = previous.catch(() => undefined).then(operation); const settled = pending.then(() => undefined, () => undefined); queues.set(key, settled); return pending.finally(() => { if (queues.get(key) === settled) queues.delete(key); }); }
}

function validateProposal(input: ProposalInput, companyId: string): void {
  if (!input.commandId.trim() || input.companyId !== companyId || !validRef(input.originReleaseRef) || !validRef(input.practiceRef)
    || !input.inheritanceProofRefs.length || !input.effectWindowRefs.length || !input.targetScope || !legalExpansion(input.origin, input.targetScope)) throw invalid("Scope promotion proposal is invalid");
  if (input.targetScope.ownerLevel === "company" && !input.generalizationRisks.length) throw invalid("Company promotion must declare generalization risks");
}
function legalExpansion(origin: ProposalInput["origin"], target: EvolutionPracticeScope): boolean {
  if (origin.ownerLevel === "agent_project" && target.ownerLevel === "agent") return Boolean(origin.profileId && target.profileId === origin.profileId && !target.workspaceId);
  if (origin.ownerLevel === "agent_project" && target.ownerLevel === "project") return Boolean(origin.workspaceId && target.workspaceId === origin.workspaceId && !target.profileId);
  if (["agent", "project"].includes(origin.ownerLevel) && target.ownerLevel === "company") return !target.workspaceId && !target.profileId;
  return false;
}
function allowed(current: ScopePromotionStatus, next: ScopePromotionStatus, target: EvolutionPracticeScope): boolean {
  if (next === "rejected") return ["proposed", "reviewed", "trial"].includes(current);
  if (current === "proposed" && next === "reviewed") return true;
  if (current === "reviewed" && next === "trial") return target.ownerLevel === "company";
  if (current === "reviewed" && next === "approved") return target.ownerLevel !== "company";
  return current === "trial" && next === "approved" && target.ownerLevel === "company";
}
function proposalInput(value: EvolutionScopePromotionProposal): ProposalInput { const { commandId, companyId, origin, targetScope, originReleaseRef, practiceRef, inheritanceProofRefs, effectWindowRefs, generalizationRisks } = value; return { commandId, companyId, origin, targetScope, originReleaseRef, practiceRef, inheritanceProofRefs, effectWindowRefs, generalizationRisks }; }
function validRef(value: VersionedEvolutionRef): boolean { return Boolean(value?.id && value.version && /^[a-f0-9]{64}$/.test(value.contentHash)); }
function unique(values: string[]): string[] { return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort(); }
function invalid(message: string): HttpError { return new HttpError(400, message, "INVALID_SCOPE_PROMOTION"); }
function conflict(message: string): HttpError { return new HttpError(409, message, "SCOPE_PROMOTION_CONFLICT"); }
function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`; return JSON.stringify(value); }
