import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createId } from "../../shared/ids.js";
import type {
  EvaluationCaseResult,
  EvaluationRun,
  EvolutionCandidate,
  MetricResult,
  PromoteEvolutionCandidateInput,
  PromotionRecord,
  RecordEvaluationInput,
} from "../../shared/contracts/evolution.js";
import { HttpError } from "../errors.js";
import { EvidenceLedger } from "../agent-engine/evidence-ledger.js";
import { workspaceEvolutionEvaluationsFile, workspaceEvolutionPromotionsFile } from "../storage/paths.js";
import type { EvolutionStore } from "./evolution-store.js";
import { scoreMetricExpectations, withMandatoryEvolutionMetrics } from "./metric-gate.js";
import { EvolutionReleaseRegistry } from "./release-registry.js";
import { EvolutionTelemetryStore } from "./telemetry-store.js";
import { MemoryLifecycleStore } from "./memory-lifecycle-store.js";

const queues = new Map<string, Promise<void>>();
interface EvaluationEntry { commandId: string; run: EvaluationRun }
interface PromotionEntry { commandId: string; record: PromotionRecord; action: "promote" | "rollback" | "supersede"; fingerprint?: string }

export class EvolutionEvaluationStore {
  constructor(
    private readonly workspaceId: string,
    private readonly workspaceRoot: string,
    private readonly candidates: EvolutionStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async recordEvaluation(input: RecordEvaluationInput): Promise<EvaluationRun> {
    return this.exclusive(async () => {
      validateEvaluationInput(input, this.workspaceId);
      const entries = await readLines<EvaluationEntry>(workspaceEvolutionEvaluationsFile(this.workspaceRoot));
      const replay = entries.find((entry) => entry.commandId === input.commandId);
      if (replay) {
        if (evaluationFingerprint(input) !== evaluationRunFingerprint(replay.run, input.commandId)) throw conflict("Evaluation command idempotency conflict");
        return replay.run;
      }
      const candidate = await this.candidates.get(input.candidateId);
      if (candidate.status !== "ready_for_eval") throw conflict("Candidate must bind an immutable Eval Suite before evaluation");
      if (!candidate.evaluationSuiteRefs?.some((ref) => sameVersionedRef(ref, input.suiteRef))) throw conflict("Evaluation suite is not bound to this candidate revision");
      if (candidate.contentHash !== input.expectedContentHash) throw conflict("Evaluation candidate hash mismatch");
      if (samePrincipal(candidate, input.evaluatorPrincipal)) throw new HttpError(403, "Candidate proposer cannot evaluate the same candidate", "EVOLUTION_DUTY_CONFLICT");
      await validateEvaluationEvidence(this.workspaceRoot, input.caseResults);
      const aggregateMetrics = scoreEvaluation(candidate, input.caseResults);
      const decision = evaluationDecision(input.caseResults, aggregateMetrics);
      const run: EvaluationRun = {
        evaluationId: createId("eval"), candidateId: candidate.candidateId, candidateHash: candidate.contentHash,
        suiteRef: structuredClone(input.suiteRef), baselineRef: structuredClone(input.baselineRef),
        runtimeSnapshotRef: input.runtimeSnapshotRef, caseResults: structuredClone(input.caseResults),
        aggregateMetrics, decision, evaluatorPrincipal: structuredClone(input.evaluatorPrincipal),
        grader: structuredClone(input.grader), createdAt: this.now().toISOString(),
      };
      await appendLine(workspaceEvolutionEvaluationsFile(this.workspaceRoot), { commandId: input.commandId, run } satisfies EvaluationEntry);
      return run;
    });
  }

  async listEvaluations(candidateId?: string): Promise<EvaluationRun[]> {
    return (await readLines<EvaluationEntry>(workspaceEvolutionEvaluationsFile(this.workspaceRoot)))
      .map((entry) => entry.run).filter((run) => !candidateId || run.candidateId === candidateId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.evaluationId.localeCompare(right.evaluationId));
  }

  async getEvaluationByCommand(commandId: string): Promise<EvaluationRun | undefined> {
    return (await readLines<EvaluationEntry>(workspaceEvolutionEvaluationsFile(this.workspaceRoot)))
      .find((entry) => entry.commandId === commandId)?.run;
  }

  async promote(input: PromoteEvolutionCandidateInput): Promise<PromotionRecord> {
    return this.exclusive(async () => {
      if (!["shadow", "canary", "production"].includes(input.stage)) throw invalid("Promotion stage is invalid");
      if (input.approvedBy.type === "agent") throw new HttpError(403, "Agent principals cannot approve promotion", "EVOLUTION_DUTY_CONFLICT");
      const entries = await readLines<PromotionEntry>(workspaceEvolutionPromotionsFile(this.workspaceRoot));
      const replay = entries.find((entry) => entry.commandId === input.commandId);
      const fingerprint = hash(JSON.stringify(input));
      if (replay) {
        if (replay.action !== "promote" || replay.fingerprint !== fingerprint) throw conflict("Promotion command idempotency conflict");
        const replayCandidate = await this.candidates.get(replay.record.candidateId);
        await new EvolutionReleaseRegistry(this.workspaceRoot, this.now).publish(replay.record, replayCandidate);
        if (replay.record.stage === "production" && replay.record.sourcePromotionId) {
          await this.markSuperseded(entries, replay.record.sourcePromotionId, replay.record.promotionId);
        }
        if (replay.record.stage === "production" && replayCandidate.kind === "memory") await new MemoryLifecycleStore(this.workspaceId, this.workspaceRoot, this.now).register(replay.record, replayCandidate);
        return replay.record;
      }
      const candidate = await this.candidates.get(input.candidateId);
      if (candidate.contentHash !== input.expectedContentHash) throw conflict("Promotion candidate hash mismatch");
      if (candidate.kind === "skill" && (candidate.validation?.scanner?.decision !== "pass" || candidate.validation.scanner.candidateHash !== candidate.contentHash)) {
        throw new HttpError(409, "Skill promotion requires a passing static scan for the same immutable content", "EVOLUTION_SKILL_SCAN_REQUIRED");
      }
      const evaluation = (await this.listEvaluations(candidate.candidateId)).find((run) => run.evaluationId === input.evaluationId);
      if (!evaluation || evaluation.candidateHash !== candidate.contentHash || evaluation.decision !== "pass") {
        throw new HttpError(409, "Promotion requires an independent passing EvaluationRun for the same content", "EVOLUTION_EVALUATION_REQUIRED");
      }
      enforceApproval(candidate, input.stage, input.approvedBy);
      const promotions = await this.listPromotions();
      if (promotions.some((item) => item.status === "active" && item.stage === input.stage && item.candidateId === candidate.candidateId && item.toRelease.contentHash === candidate.contentHash)) {
        throw conflict(`Candidate already has an active ${input.stage} promotion`);
      }
      const source = input.fromPromotionId ? promotions.find((item) => item.promotionId === input.fromPromotionId) : undefined;
      if (input.stage === "shadow" && input.fromPromotionId) throw conflict("Shadow promotion cannot declare a source promotion");
      if (input.stage !== "canary" && input.rolloutPercent !== undefined) throw invalid("Only canary promotion can declare a rollout percentage");
      const rolloutPercentage = input.stage === "canary" ? (input.rolloutPercent ?? 10) : undefined;
      if (rolloutPercentage !== undefined && (!Number.isInteger(rolloutPercentage) || rolloutPercentage < 1 || rolloutPercentage > 25)) {
        throw invalid("Canary rollout percentage must be an integer between 1 and 25");
      }
      if (input.stage === "canary" && (!source || source.status !== "active" || source.stage !== "shadow" || source.candidateId !== candidate.candidateId || source.toRelease.contentHash !== candidate.contentHash)) {
        throw new HttpError(409, "Canary promotion requires the active shadow release for the same candidate", "EVOLUTION_PROMOTION_LINEAGE_REQUIRED");
      }
      if (input.stage === "production" && (!source || source.status !== "active" || source.stage !== "canary" || source.candidateId !== candidate.candidateId || source.toRelease.contentHash !== candidate.contentHash)) {
        throw new HttpError(409, "Production promotion requires the active canary release for the same candidate", "EVOLUTION_PROMOTION_LINEAGE_REQUIRED");
      }
      let telemetryId: string | undefined;
      if (input.stage === "production") {
        const telemetry = input.telemetryId ? await new EvolutionTelemetryStore(this.workspaceId, this.workspaceRoot, this.candidates, this, this.now).get(input.telemetryId) : undefined;
        if (!telemetry || telemetry.decision !== "pass" || telemetry.releaseRef.id !== source!.toRelease.id || telemetry.candidateHash !== candidate.contentHash) {
          throw new HttpError(409, "Production promotion requires passing canary telemetry for the same release", "EVOLUTION_TELEMETRY_REQUIRED");
        }
        telemetryId = telemetry.telemetryId;
      }
      const registry = new EvolutionReleaseRegistry(this.workspaceRoot, this.now);
      const currentProduction = input.stage === "production" ? await registry.current("production", candidate) : undefined;
      const releaseId = stableId("release", candidate.candidateId, candidate.contentHash, input.stage);
      const toRelease = { id: releaseId, version: input.stage === "production" ? `${candidate.revision}` : `${candidate.revision}-${input.stage}`, contentHash: candidate.contentHash };
      const record: PromotionRecord = {
        promotionId: createId("promotion"), candidateId: candidate.candidateId, evaluationId: evaluation.evaluationId,
        ...(input.stage === "canary" && source ? { fromRelease: source.toRelease } : {}),
        ...(input.stage === "production" && currentProduction?.release ? { fromRelease: currentProduction.release } : {}),
        toRelease, stage: input.stage, scope: structuredClone(candidate.scope), approvedBy: structuredClone(input.approvedBy),
        policyRef: structuredClone(input.policyRef), status: "active", createdAt: this.now().toISOString(),
        ...(source ? { sourcePromotionId: source.promotionId } : {}), ...(telemetryId ? { telemetryId } : {}),
        ...(rolloutPercentage !== undefined ? { rollout: { percentage: rolloutPercentage, salt: stableId("rollout", candidate.candidateId, candidate.contentHash) } } : {}),
      };
      await appendLine(workspaceEvolutionPromotionsFile(this.workspaceRoot), { commandId: input.commandId, record, action: "promote", fingerprint } satisfies PromotionEntry);
      await registry.publish(record, candidate);
      if (record.stage === "production" && record.sourcePromotionId) {
        await this.markSuperseded(entries, record.sourcePromotionId, record.promotionId);
      }
      if (record.stage === "production" && candidate.kind === "memory") await new MemoryLifecycleStore(this.workspaceId, this.workspaceRoot, this.now).register(record, candidate);
      return record;
    });
  }

  async rollback(commandId: string, promotionId: string, approvedBy: { type: "human" | "system"; id: string }): Promise<PromotionRecord> {
    return this.exclusive(async () => {
      const entries = await readLines<PromotionEntry>(workspaceEvolutionPromotionsFile(this.workspaceRoot));
      const replay = entries.find((entry) => entry.commandId === commandId);
      const fingerprint = hash(JSON.stringify({ commandId, promotionId, approvedBy }));
      if (replay) {
        if (replay.action !== "rollback" || replay.fingerprint !== fingerprint) throw conflict("Rollback command idempotency conflict");
        const replayCandidate = await this.candidates.get(replay.record.candidateId);
        await new EvolutionReleaseRegistry(this.workspaceRoot, this.now).rollback(replay.record, replayCandidate);
        if (replay.record.stage === "production" && replayCandidate.kind === "memory") await applyMemoryRollback(this.workspaceId, this.workspaceRoot, replay.record, replayCandidate, this.now);
        return replay.record;
      }
      const promoted = projectPromotions(entries).find((item) => item.promotionId === promotionId);
      if (!promoted) throw new HttpError(404, "Evolution promotion not found", "EVOLUTION_PROMOTION_NOT_FOUND");
      if (promoted.status !== "active") throw conflict(`Evolution promotion is already ${promoted.status.replace("_", " ")}`);
      const record: PromotionRecord = { ...promoted, approvedBy, status: "rolled_back", rolledBackAt: this.now().toISOString() };
      await appendLine(workspaceEvolutionPromotionsFile(this.workspaceRoot), { commandId, record, action: "rollback", fingerprint } satisfies PromotionEntry);
      const rollbackCandidate = await this.candidates.get(record.candidateId);
      await new EvolutionReleaseRegistry(this.workspaceRoot, this.now).rollback(record, rollbackCandidate);
      if (record.stage === "production" && rollbackCandidate.kind === "memory") await applyMemoryRollback(this.workspaceId, this.workspaceRoot, record, rollbackCandidate, this.now);
      return record;
    });
  }

  async listPromotions(): Promise<PromotionRecord[]> {
    return projectPromotions(await readLines<PromotionEntry>(workspaceEvolutionPromotionsFile(this.workspaceRoot)));
  }

  private async markSuperseded(entries: PromotionEntry[], sourcePromotionId: string, productionPromotionId: string): Promise<void> {
    const source = projectPromotions(entries).find((item) => item.promotionId === sourcePromotionId);
    if (!source || source.status === "superseded") return;
    if (source.status !== "active" || source.stage !== "canary") throw conflict("Production source canary is no longer active");
    const commandId = `supersede:${sourcePromotionId}:${productionPromotionId}`;
    const record: PromotionRecord = {
      ...source,
      status: "superseded",
      supersededAt: this.now().toISOString(),
      supersededByPromotionId: productionPromotionId,
    };
    await appendLine(workspaceEvolutionPromotionsFile(this.workspaceRoot), {
      commandId, record, action: "supersede", fingerprint: hash(commandId),
    } satisfies PromotionEntry);
    entries.push({ commandId, record, action: "supersede", fingerprint: hash(commandId) });
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const key = path.resolve(this.workspaceRoot, ".autoagent", "evolution").toLowerCase();
    const previous = queues.get(key) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(operation);
    const settled = pending.then(() => undefined, () => undefined);
    queues.set(key, settled);
    return pending.finally(() => { if (queues.get(key) === settled) queues.delete(key); });
  }
}

function projectPromotions(entries: PromotionEntry[]): PromotionRecord[] {
  const projected = new Map<string, PromotionRecord>();
  for (const entry of entries) projected.set(entry.record.promotionId, entry.record);
  return [...projected.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.promotionId.localeCompare(right.promotionId));
}

function validateEvaluationInput(input: RecordEvaluationInput, workspaceId: string): void {
  if (!input.commandId?.trim() || !input.candidateId || !/^[a-f0-9]{64}$/.test(input.expectedContentHash)) throw invalid("Evaluation identity is invalid");
  if (!input.suiteRef?.id || !input.suiteRef.version || !input.suiteRef.contentHash || !input.baselineRef?.id || !input.runtimeSnapshotRef) throw invalid("Evaluation version snapshot is incomplete");
  if (input.grader?.type !== "deterministic" || !input.grader.id || !input.grader.version) throw invalid("Evaluation grader is invalid");
  if (!input.evaluatorPrincipal?.id || !["human", "system", "agent"].includes(input.evaluatorPrincipal.type)) throw invalid("Evaluation principal is invalid");
  const groups = new Set(input.caseResults?.map((item) => item.group));
  if (!["target", "regression", "safety"].every((group) => groups.has(group as EvaluationCaseResult["group"]))) throw invalid("Evaluation requires target, regression, and safety cases");
  for (const result of input.caseResults) {
    if (!result.caseId || !result.evidenceRefs.length || result.evidenceRefs.some((ref) => ref.workspaceId !== workspaceId)) throw invalid("Evaluation case evidence is invalid");
    for (const observation of [result.baseline, result.candidate]) {
      if (typeof observation?.success !== "boolean" || typeof observation.costMeasured !== "boolean" || ![observation.qualityScore, observation.costUsd, observation.latencyMs, observation.toolFailures, observation.policyViolations, observation.safetyViolations].every((value) => Number.isFinite(value) && value >= 0)) throw invalid("Evaluation observation is invalid");
      if (!optionalObservationMetricsValid(observation)) throw invalid("Evaluation optional observation metrics are invalid");
    }
  }
}

function optionalObservationMetricsValid(observation: EvaluationCaseResult["baseline"]): boolean {
  return [observation.inputTokens, observation.outputTokens, observation.totalTokens, observation.qaReturns, observation.repeatedToolCalls, observation.humanInterventions, observation.evidenceCompleteness]
    .every((value) => value === undefined || (Number.isFinite(value) && value >= 0))
    && (observation.evidenceCompleteness ?? 0) <= 1;
}

async function validateEvaluationEvidence(workspaceRoot: string, cases: EvaluationCaseResult[]): Promise<void> {
  const evidenceIds = [...new Set(cases.flatMap((item) => item.evidenceRefs.filter((ref) => ref.kind === "evidence").map((ref) => ref.ref)))];
  if (!evidenceIds.length) throw invalid("Evaluation cases require Evidence Ledger facts");
  const facts = await new EvidenceLedger(workspaceRoot).getMany(evidenceIds);
  const missing = evidenceIds.filter((id) => !facts.has(id));
  if (missing.length) throw invalid(`Evaluation evidence is missing: ${missing.join(", ")}`);
}

function scoreEvaluation(candidate: EvolutionCandidate, cases: EvaluationCaseResult[]): MetricResult[] {
  return scoreMetricExpectations(withMandatoryEvolutionMetrics(candidate.expectedMetrics), cases);
}

function evaluationDecision(cases: EvaluationCaseResult[], metrics: MetricResult[]): EvaluationRun["decision"] {
  const target = cases.filter((item) => item.group === "target");
  const regression = cases.filter((item) => item.group === "regression");
  const safety = cases.filter((item) => item.group === "safety");
  const targetNotWorse = target.every((item) => Number(item.candidate.success) >= Number(item.baseline.success) && item.candidate.qualityScore >= item.baseline.qualityScore);
  const regressionSafe = regression.every((item) => Number(item.candidate.success) >= Number(item.baseline.success) && item.candidate.qualityScore + 0.01 >= item.baseline.qualityScore);
  const safetySafe = safety.every((item) => item.candidate.safetyViolations === 0 && item.candidate.policyViolations <= item.baseline.policyViolations);
  return targetNotWorse && regressionSafe && safetySafe && metrics.length > 0 && metrics.every((metric) => metric.passed) ? "pass" : "fail";
}

function samePrincipal(candidate: EvolutionCandidate, principal: RecordEvaluationInput["evaluatorPrincipal"]): boolean { return candidate.proposedBy.type === principal.type && candidate.proposedBy.id === principal.id; }
function sameVersionedRef(left: { id: string; version: string; contentHash: string }, right: { id: string; version: string; contentHash: string }): boolean { return left.id === right.id && left.version === right.version && left.contentHash === right.contentHash; }
function enforceApproval(candidate: EvolutionCandidate, stage: PromoteEvolutionCandidateInput["stage"], principal: PromoteEvolutionCandidateInput["approvedBy"]): void {
  if (stage === "shadow") return;
  const systemEligible = candidate.kind === "memory" && candidate.riskLevel === "low";
  if (principal.type !== "human" && !systemEligible) throw new HttpError(403, `${stage} promotion requires human approval for this artifact risk`, "EVOLUTION_APPROVAL_REQUIRED");
}
async function applyMemoryRollback(workspaceId: string, workspaceRoot: string, record: PromotionRecord, candidate: EvolutionCandidate, now: () => Date): Promise<void> {
  const lifecycle = new MemoryLifecycleStore(workspaceId, workspaceRoot, now);
  await lifecycle.transition(`rollback:${record.promotionId}:archive`, record.toRelease.id, "archived", "Production release rolled back", record.approvedBy);
  if (record.fromRelease && await lifecycle.get(record.fromRelease.id)) {
    await lifecycle.transition(`rollback:${record.promotionId}:restore`, record.fromRelease.id, "active", "Previous production release restored", record.approvedBy);
  }
}
function evaluationFingerprint(input: RecordEvaluationInput): string { return hash(JSON.stringify(input)); }
function evaluationRunFingerprint(run: EvaluationRun, commandId: string): string { return hash(JSON.stringify({ commandId, candidateId: run.candidateId, expectedContentHash: run.candidateHash, suiteRef: run.suiteRef, baselineRef: run.baselineRef, runtimeSnapshotRef: run.runtimeSnapshotRef, caseResults: run.caseResults, evaluatorPrincipal: run.evaluatorPrincipal, grader: run.grader })); }
function stableId(prefix: string, ...parts: string[]): string { return `${prefix}_${hash(parts.join("\0")).slice(0, 32)}`; }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function invalid(message: string): HttpError { return new HttpError(400, message, "INVALID_EVOLUTION_EVALUATION"); }
function conflict(message: string): HttpError { return new HttpError(409, message, "EVOLUTION_CONFLICT"); }
async function appendLine(file: string, value: unknown) { await mkdir(path.dirname(file), { recursive: true }); await appendFile(file, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600, flush: true }); }
async function readLines<T>(file: string): Promise<T[]> { try { return (await readFile(file, "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as T); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; } }
