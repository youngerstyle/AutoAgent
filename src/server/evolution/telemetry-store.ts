import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createId } from "../../shared/ids.js";
import type { RecordReleaseTelemetryInput, ReleaseTelemetry } from "../../shared/contracts/evolution.js";
import { EvidenceLedger } from "../evidence/evidence-ledger.js";
import { HttpError } from "../errors.js";
import { workspaceEvolutionTelemetryFile } from "../storage/paths.js";
import type { EvolutionStore } from "./evolution-store.js";
import type { EvolutionEvaluationStore } from "./evaluation-store.js";
import { canaryGuardrailMetrics, scoreMetricExpectations } from "./metric-gate.js";

interface TelemetryEntry { commandId: string; fingerprint: string; telemetry: ReleaseTelemetry }
const queues = new Map<string, Promise<void>>();

export class EvolutionTelemetryStore {
  constructor(
    private readonly workspaceId: string,
    private readonly workspaceRoot: string,
    private readonly candidates: EvolutionStore,
    private readonly promotions: EvolutionEvaluationStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async record(input: RecordReleaseTelemetryInput): Promise<ReleaseTelemetry> {
    return this.exclusive(async () => {
      validateInput(input, this.workspaceId);
      const fingerprint = hash(JSON.stringify(input));
      const entries = await readEntries(workspaceEvolutionTelemetryFile(this.workspaceRoot));
      const replay = entries.find((entry) => entry.commandId === input.commandId);
      if (replay) {
        if (replay.fingerprint !== fingerprint) throw conflict("Telemetry command idempotency conflict");
        return replay.telemetry;
      }
      const promotion = (await this.promotions.listPromotions()).find((item) => item.promotionId === input.promotionId);
      if (!promotion || promotion.stage !== "canary" || promotion.status !== "active") throw conflict("Telemetry requires an active canary promotion");
      const candidate = await this.candidates.get(promotion.candidateId);
      const evidenceIds = [...new Set(input.samples.flatMap((sample) => sample.evidenceRefs.filter((ref) => ref.kind === "evidence").map((ref) => ref.ref)))];
      if (!evidenceIds.length) throw invalid("Canary telemetry requires Evidence Ledger facts");
      const evidence = await new EvidenceLedger(this.workspaceRoot).getMany(evidenceIds);
      const missing = evidenceIds.filter((id) => !evidence.has(id));
      if (missing.length) throw invalid(`Canary telemetry evidence is missing: ${missing.join(", ")}`);
      const aggregateMetrics = scoreMetricExpectations(canaryGuardrailMetrics(candidate.expectedMetrics, candidate.kind), input.samples.map((sample) => ({ baseline: sample.baseline, candidate: sample.release })));
      const safe = input.samples.every((sample) => sample.release.safetyViolations === 0 && sample.release.policyViolations <= sample.baseline.policyViolations);
      const noRegression = input.samples.every((sample) => Number(sample.release.success) >= Number(sample.baseline.success) && sample.release.qualityScore + 0.01 >= sample.baseline.qualityScore);
      const hasUnknownMetric = aggregateMetrics.some((metric) => metric.measured === false);
      const decision = !safe || !noRegression
        ? "fail"
        : hasUnknownMetric
          ? "inconclusive"
          : aggregateMetrics.length > 0 && aggregateMetrics.every((metric) => metric.passed) ? "pass" : "fail";
      const telemetry: ReleaseTelemetry = {
        telemetryId: createId("telemetry"), releaseRef: promotion.toRelease, candidateId: candidate.candidateId,
        candidateHash: candidate.contentHash, stage: "canary", sampleSize: input.samples.length,
        samples: structuredClone(input.samples), aggregateMetrics, decision, recorder: structuredClone(input.recorder),
        startedAt: input.startedAt, endedAt: input.endedAt, createdAt: this.now().toISOString(),
      };
      await appendEntry(workspaceEvolutionTelemetryFile(this.workspaceRoot), { commandId: input.commandId, fingerprint, telemetry });
      return telemetry;
    });
  }

  async get(telemetryId: string): Promise<ReleaseTelemetry | undefined> {
    return (await readEntries(workspaceEvolutionTelemetryFile(this.workspaceRoot))).find((entry) => entry.telemetry.telemetryId === telemetryId)?.telemetry;
  }

  async list(candidateId?: string): Promise<ReleaseTelemetry[]> {
    return (await readEntries(workspaceEvolutionTelemetryFile(this.workspaceRoot))).map((entry) => entry.telemetry)
      .filter((item) => !candidateId || item.candidateId === candidateId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.telemetryId.localeCompare(right.telemetryId));
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const key = path.resolve(workspaceEvolutionTelemetryFile(this.workspaceRoot)).toLowerCase();
    const previous = queues.get(key) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(operation);
    const settled = pending.then(() => undefined, () => undefined);
    queues.set(key, settled);
    return pending.finally(() => { if (queues.get(key) === settled) queues.delete(key); });
  }
}

function validateInput(input: RecordReleaseTelemetryInput, workspaceId: string): void {
  if (!input.commandId?.trim() || !input.promotionId || input.recorder?.type !== "system" || !input.recorder.id) throw invalid("Telemetry identity or recorder is invalid");
  if (!Array.isArray(input.samples) || input.samples.length < 5) throw invalid("Canary telemetry requires at least five independent samples");
  if (!Number.isFinite(Date.parse(input.startedAt)) || !Number.isFinite(Date.parse(input.endedAt)) || Date.parse(input.startedAt) >= Date.parse(input.endedAt)) throw invalid("Telemetry window is invalid");
  const ids = new Set<string>();
  const usedEvidence = new Set<string>();
  for (const sample of input.samples) {
    if (!sample.sampleId || ids.has(sample.sampleId) || !sample.evidenceRefs.length || sample.evidenceRefs.some((ref) => ref.workspaceId !== workspaceId)) throw invalid("Telemetry sample identity or evidence is invalid");
    ids.add(sample.sampleId);
    const sampleEvidence = sample.evidenceRefs.filter((ref) => ref.kind === "evidence").map((ref) => ref.ref);
    if (!sampleEvidence.length || sampleEvidence.some((id) => usedEvidence.has(id))) throw invalid("Canary telemetry samples require distinct Evidence Ledger facts");
    sampleEvidence.forEach((id) => usedEvidence.add(id));
    for (const observation of [sample.baseline, sample.release]) {
      if (typeof observation?.success !== "boolean" || typeof observation.costMeasured !== "boolean" || ![observation.qualityScore, observation.costUsd, observation.latencyMs, observation.toolFailures, observation.policyViolations, observation.safetyViolations].every((value) => Number.isFinite(value) && value >= 0)) throw invalid("Telemetry observation is invalid");
      if (![observation.inputTokens, observation.outputTokens, observation.totalTokens, observation.qaReturns, observation.repeatedToolCalls, observation.humanInterventions, observation.evidenceCompleteness]
        .every((value) => value === undefined || (Number.isFinite(value) && value >= 0)) || (observation.evidenceCompleteness ?? 0) > 1) throw invalid("Telemetry optional observation metrics are invalid");
    }
  }
}
async function appendEntry(file: string, entry: TelemetryEntry): Promise<void> { await mkdir(path.dirname(file), { recursive: true }); await appendFile(file, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600, flush: true }); }
async function readEntries(file: string): Promise<TelemetryEntry[]> {
  let raw: string; try { raw = await readFile(file, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  return raw.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { const entry = JSON.parse(line) as TelemetryEntry; if (!entry?.commandId || !entry.fingerprint || !entry.telemetry?.telemetryId) throw new Error("invalid entry"); return entry; }
    catch (error) { throw new Error(`Evolution telemetry ledger is corrupt at line ${index + 1}: ${(error as Error).message}`); }
  });
}
function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function invalid(message: string): HttpError { return new HttpError(400, message, "INVALID_EVOLUTION_TELEMETRY"); }
function conflict(message: string): HttpError { return new HttpError(409, message, "EVOLUTION_TELEMETRY_CONFLICT"); }
