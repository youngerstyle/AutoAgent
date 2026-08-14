import { createHash } from "node:crypto";
import type {
  EvaluationObservation, ExperienceAttribution, ExperienceEpisode, ReleaseTelemetry,
} from "../../shared/contracts/evolution.js";
import type { Workspace } from "../../shared/types.js";
import { EvidenceLedger } from "../agent-engine/evidence-ledger.js";
import { AgentTraceStore, type AgentTraceRecord } from "../agent-engine/trace-store.js";
import { listWorkspaceAgents } from "../agents/roster.js";
import { EvolutionStore } from "./evolution-store.js";
import { EvolutionEvaluationStore } from "./evaluation-store.js";
import { EvolutionTelemetryStore } from "./telemetry-store.js";
import { ExperienceStore } from "./experience-store.js";

interface CanaryAssignment {
  target: string;
  promotionId: string;
  releaseId: string;
  selected: boolean;
}
interface GoalUsage { inputTokens: number; outputTokens: number; totalTokens: number }

export class CanaryTelemetryReconciler {
  constructor(private readonly workspace: Workspace, private readonly now: () => Date = () => new Date()) {}

  async reconcile(): Promise<{ recordedTelemetry: ReleaseTelemetry[] }> {
    const candidates = new EvolutionStore(this.workspace.id, this.workspace.rootPath, this.now);
    const promotions = new EvolutionEvaluationStore(this.workspace.id, this.workspace.rootPath, candidates, this.now);
    const activeCanaries = (await promotions.listPromotions()).filter((item) => item.stage === "canary" && item.status === "active");
    if (!activeCanaries.length) return { recordedTelemetry: [] };
    const experience = new ExperienceStore(this.workspace.id, this.workspace.rootPath);
    const episodes = await experience.listEpisodes();
    const attributions = await experience.listAttributions();
    const { assignments, usage } = await this.traceIndex();
    const telemetry = new EvolutionTelemetryStore(this.workspace.id, this.workspace.rootPath, candidates, promotions, this.now);
    const recordedTelemetry: ReleaseTelemetry[] = [];
    for (const promotion of activeCanaries) {
      const eligible = episodes.filter((episode) => Date.parse(episode.endedAt) >= Date.parse(promotion.createdAt))
        .flatMap((episode) => {
          const assignment = assignments.get(`${episode.agentId}:${episode.goalId}`)?.find((item) => item.promotionId === promotion.promotionId);
          return assignment ? [{ episode, assignment }] : [];
        });
      const canary = eligible.filter((item) => item.assignment.selected).map((item) => item.episode);
      const control = eligible.filter((item) => !item.assignment.selected).map((item) => item.episode);
      const pairCount = Math.min(canary.length, control.length);
      if (pairCount < 5) continue;
      const pairs = Array.from({ length: pairCount }, (_, index) => ({ baseline: control[index]!, release: canary[index]! }));
      const samples = [];
      for (const pair of pairs) {
        const evidenceId = stableId("evidence_canary_pair", promotion.promotionId, pair.baseline.episodeId, pair.release.episodeId);
        const ledger = new EvidenceLedger(this.workspace.rootPath);
        if (!await ledger.get(evidenceId)) {
          await ledger.append({
            evidenceId, agentId: "evolution-canary-monitor", threadId: `canary:${promotion.promotionId}`,
            goalId: `canary:${promotion.promotionId}`, attemptId: pair.release.attemptId,
            turnId: pair.release.episodeId, toolCallId: stableId("canary_pair", pair.baseline.episodeId, pair.release.episodeId),
            toolName: "evolution-canary-monitor", kind: "tool", capture: { status: "recorded" },
            observation: { status: "observed", result: { baselineEpisodeId: pair.baseline.episodeId, releaseEpisodeId: pair.release.episodeId } },
            workspaceRoot: this.workspace.rootPath, createdAt: later(pair.baseline.endedAt, pair.release.endedAt),
            input: { promotionId: promotion.promotionId, releaseId: promotion.toRelease.id },
          });
        }
        samples.push({
          sampleId: stableId("canary_sample", pair.baseline.episodeId, pair.release.episodeId),
          baseline: observation(pair.baseline, attributions, usage), release: observation(pair.release, attributions, usage),
          evidenceRefs: [{ kind: "evidence" as const, ref: evidenceId, workspaceId: this.workspace.id }],
        });
      }
      const record = await telemetry.record({
        commandId: `canary-telemetry:${promotion.promotionId}:${hash(samples.map((sample) => sample.sampleId).join("\0"))}`,
        promotionId: promotion.promotionId, samples,
        recorder: { type: "system", id: "evolution-canary-monitor/v1" },
        startedAt: pairs.reduce((value, pair) => earlier(value, pair.baseline.startedAt, pair.release.startedAt), pairs[0]!.baseline.startedAt),
        endedAt: pairs.reduce((value, pair) => later(value, pair.baseline.endedAt, pair.release.endedAt), pairs[0]!.release.endedAt),
      });
      recordedTelemetry.push(record);
      if (record.decision === "fail") {
        await promotions.rollback(
          `automatic-canary-rollback:${promotion.promotionId}:${record.telemetryId}`,
          promotion.promotionId,
          { type: "system", id: "evolution-canary-monitor/v1" },
        );
      }
    }
    return { recordedTelemetry };
  }

  private async traceIndex(): Promise<{ assignments: Map<string, CanaryAssignment[]>; usage: Map<string, GoalUsage> }> {
    const assignments = new Map<string, CanaryAssignment[]>();
    const usage = new Map<string, GoalUsage>();
    for (const agent of await listWorkspaceAgents(this.workspace)) {
      for (const trace of await new AgentTraceStore(this.workspace.rootPath, agent.id).list()) {
        if (!trace.goalId) continue;
        const key = `${agent.id}:${trace.goalId}`;
        const tracedAssignments = traceAssignments(trace);
        if (tracedAssignments.length) assignments.set(key, tracedAssignments);
        const tracedUsage = traceUsage(trace);
        if (tracedUsage) {
          const current = usage.get(key) ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
          usage.set(key, {
            inputTokens: current.inputTokens + tracedUsage.inputTokens,
            outputTokens: current.outputTokens + tracedUsage.outputTokens,
            totalTokens: current.totalTokens + tracedUsage.totalTokens,
          });
        }
      }
    }
    return { assignments, usage };
  }
}

function traceAssignments(trace: AgentTraceRecord): CanaryAssignment[] {
  if (trace.kind !== "context" || !isRecord(trace.data) || !Array.isArray(trace.data.evolutionCanaryAssignments)) return [];
  return trace.data.evolutionCanaryAssignments.filter((item): item is CanaryAssignment => isRecord(item)
    && typeof item.target === "string" && typeof item.promotionId === "string" && typeof item.releaseId === "string" && typeof item.selected === "boolean");
}

function traceUsage(trace: AgentTraceRecord): GoalUsage | undefined {
  if (trace.kind !== "provider_response" || !isRecord(trace.data)) return undefined;
  const values = [trace.data.inputTokens, trace.data.outputTokens, trace.data.totalTokens];
  if (!values.every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)) return undefined;
  return { inputTokens: values[0] as number, outputTokens: values[1] as number, totalTokens: values[2] as number };
}

function observation(episode: ExperienceEpisode, attributions: ExperienceAttribution[], usage: Map<string, GoalUsage>): EvaluationObservation {
  const related = attributions.filter((item) => item.episodeId === episode.episodeId);
  const tokens = usage.get(`${episode.agentId}:${episode.goalId}`);
  return {
    success: episode.outcome === "succeeded",
    qualityScore: episode.outcome === "succeeded" ? 1 : episode.outcome === "returned" ? 0.25 : 0,
    costUsd: 0,
    costMeasured: false,
    ...(tokens ? tokens : {}),
    latencyMs: Math.max(0, Date.parse(episode.endedAt) - Date.parse(episode.startedAt)),
    toolFailures: related.filter((item) => item.component === "tool").length,
    policyViolations: related.filter((item) => item.component === "policy").length,
    safetyViolations: related.filter((item) => item.component === "policy" && item.confidence >= 0.9).length,
    qaReturns: episode.outcome === "returned" ? 1 : 0,
    humanInterventions: new Set([
      ...episode.sourceRefs.filter((ref) => ref.kind === "human_feedback").map((ref) => ref.ref),
      ...related.flatMap((item) => item.sourceRefs.filter((ref) => ref.kind === "human_feedback").map((ref) => ref.ref)),
    ]).size,
    evidenceCompleteness: episode.sourceRefs.length > 0 ? 1 : 0,
  };
}

function stableId(prefix: string, ...parts: string[]): string { return `${prefix}_${hash(parts.join("\0")).slice(0, 32)}`; }
function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function later(...values: string[]): string { return values.reduce((left, right) => Date.parse(left) >= Date.parse(right) ? left : right); }
function earlier(...values: string[]): string { return values.reduce((left, right) => Date.parse(left) <= Date.parse(right) ? left : right); }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
