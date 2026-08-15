import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { CompanyTrialEvidence, CompanyTrialObservation, EvaluationObservation, MetricResult } from "../../shared/contracts/evolution.js";
import { HttpError } from "../errors.js";
import { globalCompanyEvolutionTrialEvidenceFile } from "../storage/paths.js";
import { EvidenceLedger } from "../agent-engine/evidence-ledger.js";
import { AgentTraceStore } from "../agent-engine/trace-store.js";
import { EvolutionActivationStore } from "./activation-store.js";
import { CompanyTrialStore } from "./company-trial-store.js";
import { ScopePromotionStore } from "./scope-promotion-store.js";
import { isCanaryAssignment } from "./runtime-projection.js";

interface EvidenceEvent { eventId: string; commandId: string; evidence: CompanyTrialEvidence }
const queues = new Map<string, Promise<void>>();

export class CompanyTrialEvidenceStore {
  constructor(private readonly homeDir: string, private readonly companyId: string, private readonly trials: CompanyTrialStore, private readonly proposals: ScopePromotionStore, private readonly now: () => Date = () => new Date()) {}

  async record(input: { commandId: string; trialId: string; targetWorkspaceRoot: string; observations: CompanyTrialObservation[]; startedAt: string; endedAt: string }): Promise<CompanyTrialEvidence> {
    if (!input.commandId?.trim() || !Number.isFinite(Date.parse(input.startedAt)) || !Number.isFinite(Date.parse(input.endedAt)) || Date.parse(input.startedAt) >= Date.parse(input.endedAt)) throw invalid("Company trial evidence window is invalid");
    return this.exclusive(async () => {
      const events = await this.read(); const replay = events.find((event) => event.commandId === input.commandId);
      const fingerprint = hash(canonical(input));
      if (replay) { if (hash(canonical(evidenceInput(replay.evidence, input.targetWorkspaceRoot))) !== fingerprint) throw new HttpError(409, "Company trial evidence command conflict", "COMPANY_TRIAL_EVIDENCE_CONFLICT"); return replay.evidence; }
      const trial = await this.trials.get(input.trialId);
      const proposal = await this.proposals.get(trial.proposalId);
      if (trial.companyId !== this.companyId || trial.status !== "deployed" || proposal.status !== "trial" || !proposal.trialRefs?.includes(trial.trialId)) throw new HttpError(409, "Company trial is not active", "COMPANY_TRIAL_EVIDENCE_CONFLICT");
      const observations = structuredClone(input.observations);
      await validateObservations(trial, input.targetWorkspaceRoot, observations);
      const selected = observations.filter((item) => item.arm === "selected"); const control = observations.filter((item) => item.arm === "control");
      if (selected.length < trial.assignment.minimumSamplesPerArm || control.length < trial.assignment.minimumSamplesPerArm) throw invalid("Company trial has not reached the declared minimum selected/control sample size");
      const aggregateMetrics = compare(selected.map((item) => item.result), control.map((item) => item.result));
      const decision = aggregateMetrics.every((item) => item.passed) ? "pass" : "fail";
      const evidence: CompanyTrialEvidence = {
        evidenceId: `company_trial_evidence_${hash(`${trial.trialId}:${fingerprint}`).slice(0, 32)}`, commandId: input.commandId, companyId: this.companyId,
        proposalId: trial.proposalId, trialId: trial.trialId, trialReleaseRef: trial.trialReleaseRef,
        selectedSampleSize: selected.length, controlSampleSize: control.length, observations, aggregateMetrics, decision,
        startedAt: input.startedAt, endedAt: input.endedAt, createdAt: this.now().toISOString(),
      };
      await this.append(input.commandId, evidence);
      await this.trials.recordEvidence(`trial-evidence:${evidence.evidenceId}`, trial.trialId, evidence.evidenceId, decision);
      if (decision === "pass") await this.proposals.attachTrialEvidence(`attach-trial-evidence:${evidence.evidenceId}`, proposal.proposalId, evidence.evidenceId);
      return evidence;
    });
  }

  async list(proposalId?: string): Promise<CompanyTrialEvidence[]> { return (await this.read()).map((event) => event.evidence).filter((item) => !proposalId || item.proposalId === proposalId).sort((a, b) => a.createdAt.localeCompare(b.createdAt)); }
  private async read(): Promise<EvidenceEvent[]> { try { return (await readFile(globalCompanyEvolutionTrialEvidenceFile(this.homeDir), "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as EvidenceEvent); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; } }
  private async append(commandId: string, evidence: CompanyTrialEvidence): Promise<void> { const file = globalCompanyEvolutionTrialEvidenceFile(this.homeDir); await mkdir(path.dirname(file), { recursive: true }); await appendFile(file, `${JSON.stringify({ eventId: randomUUID(), commandId, evidence })}\n`, { encoding: "utf8", mode: 0o600, flush: true }); }
  private async exclusive<T>(operation: () => Promise<T>): Promise<T> { const key = path.resolve(globalCompanyEvolutionTrialEvidenceFile(this.homeDir)).toLowerCase(); const previous = queues.get(key) ?? Promise.resolve(); const pending = previous.catch(() => undefined).then(operation); const settled = pending.then(() => undefined, () => undefined); queues.set(key, settled); return pending.finally(() => { if (queues.get(key) === settled) queues.delete(key); }); }
}

async function validateObservations(trial: Awaited<ReturnType<CompanyTrialStore["get"]>>, root: string, observations: CompanyTrialObservation[]): Promise<void> {
  if (!Array.isArray(observations) || !observations.length) throw invalid("Company trial observations are missing");
  const ids = new Set<string>(); const assignmentKeys = new Set<string>(); const evidenceIds = new Set<string>();
  const traces = await new AgentTraceStore(root, trial.target.agentId).list();
  const proofs = await new EvolutionActivationStore(root).listProofs();
  for (const item of observations) {
    if (!item.observationId || ids.has(item.observationId) || !item.assignmentKey || assignmentKeys.has(item.assignmentKey) || !validObservation(item.result)) throw invalid("Company trial observation identity or result is invalid");
    ids.add(item.observationId); assignmentKeys.add(item.assignmentKey);
    const selected = isCanaryAssignment(trial.assignment, item.assignmentKey);
    if ((selected ? "selected" : "control") !== item.arm) throw invalid("Company trial observation arm does not match its deterministic assignment");
    if (item.traceRef.kind !== "trace" || item.traceRef.workspaceId !== trial.target.workspaceId || item.traceRef.agentId !== trial.target.agentId || item.traceRef.profileId !== trial.target.profileId) throw invalid("Company trial trace identity is invalid");
    const trace = traces.find((candidate) => candidate.traceId === item.traceRef.ref);
    const traceData = trace?.data as { evolutionCanaryAssignments?: Array<{ promotionId: string; releaseId: string; selected: boolean }> } | undefined;
    if (!trace || !traceData?.evolutionCanaryAssignments?.some((assignment) => assignment.promotionId === trial.trialId && assignment.releaseId === trial.trialReleaseRef.id && assignment.selected === selected)) throw invalid("Company trial trace does not prove selected/control assignment");
    if (selected) {
      const proof = proofs.find((candidate) => candidate.proofId === item.inheritanceProofRef);
      if (!proof || proof.traceRef?.ref !== trace.traceId || proof.traceRef.profileId !== trial.target.profileId || proof.releaseRef.id !== trial.trialReleaseRef.id || proof.releaseRef.contentHash !== trial.trialReleaseRef.contentHash) throw invalid("Selected company trial observation has no matching inheritance proof");
    } else if (item.inheritanceProofRef) throw invalid("Control company trial observation cannot claim Release inheritance");
    const refs = item.evidenceRefs.filter((ref) => ref.kind === "evidence" && ref.workspaceId === trial.target.workspaceId);
    if (!refs.length || refs.some((ref) => evidenceIds.has(ref.ref))) throw invalid("Company trial observations require distinct target-project Evidence Ledger facts");
    refs.forEach((ref) => evidenceIds.add(ref.ref));
  }
  const facts = await new EvidenceLedger(root).getMany([...evidenceIds]);
  if (facts.size !== evidenceIds.size) throw invalid("Company trial observation references missing Evidence Ledger facts");
}

function compare(selected: EvaluationObservation[], control: EvaluationObservation[]): MetricResult[] {
  const result = [
    metric("task_success_rate", average(selected, (x) => Number(x.success)), average(control, (x) => Number(x.success)), "increase"),
    metric("quality_score", average(selected, (x) => x.qualityScore), average(control, (x) => x.qualityScore), "increase"),
    metric("policy_violations", average(selected, (x) => x.policyViolations), average(control, (x) => x.policyViolations), "decrease"),
    metric("safety_violations", average(selected, (x) => x.safetyViolations), average(control, (x) => x.safetyViolations), "decrease"),
  ];
  result[0]!.passed = result[0]!.candidate >= result[0]!.baseline;
  result[1]!.passed = result[1]!.candidate + 0.01 >= result[1]!.baseline;
  result[2]!.passed = result[2]!.candidate <= result[2]!.baseline;
  result[3]!.passed = result[3]!.candidate === 0;
  const improved = result[0]!.delta > 0 || result[1]!.delta > 0.01;
  if (!improved) result[0]!.passed = false;
  return result;
}
function metric(name: string, candidate: number, baseline: number, direction: "increase" | "decrease"): MetricResult { return { metric: name, baseline, candidate, delta: candidate - baseline, passed: direction === "increase" ? candidate >= baseline : candidate <= baseline, measured: true }; }
function average(values: EvaluationObservation[], pick: (value: EvaluationObservation) => number): number { return values.reduce((sum, value) => sum + pick(value), 0) / values.length; }
function validObservation(value: EvaluationObservation): boolean { return typeof value?.success === "boolean" && typeof value.costMeasured === "boolean" && [value.qualityScore, value.costUsd, value.latencyMs, value.toolFailures, value.policyViolations, value.safetyViolations].every((item) => Number.isFinite(item) && item >= 0); }
function evidenceInput(value: CompanyTrialEvidence, targetWorkspaceRoot: string): unknown { return { commandId: value.commandId, trialId: value.trialId, targetWorkspaceRoot, observations: value.observations, startedAt: value.startedAt, endedAt: value.endedAt }; }
function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`; return JSON.stringify(value); }
function invalid(message: string): HttpError { return new HttpError(400, message, "INVALID_COMPANY_TRIAL_EVIDENCE"); }
