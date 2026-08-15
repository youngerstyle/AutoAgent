import { createHash } from "node:crypto";
import type { CompanyTrialObservation, EvaluationObservation, ExperienceAttribution, ExperienceEpisode } from "../../shared/contracts/evolution.js";
import type { Workspace } from "../../shared/types.js";
import { EvidenceLedger } from "../agent-engine/evidence-ledger.js";
import { AgentTraceStore, type AgentTraceRecord } from "../agent-engine/trace-store.js";
import { CompanyIdentityStore } from "../storage/company-identity-store.js";
import { EvolutionActivationStore } from "./activation-store.js";
import { CompanyTrialEvidenceStore } from "./company-trial-evidence-store.js";
import { CompanyTrialStore } from "./company-trial-store.js";
import { ExperienceStore } from "./experience-store.js";
import { ScopePromotionStore } from "./scope-promotion-store.js";
import { CompanyTrialReleaseRegistry } from "./company-trial-registry.js";

interface AssignmentTrace { trace: AgentTraceRecord; selected: boolean; releaseId: string }
interface GoalUsage { inputTokens: number; outputTokens: number; totalTokens: number }

/** Converts completed target-project Episodes into authoritative selected/control trial evidence. */
export class CompanyTrialReconciler {
  constructor(private readonly homeDir: string, private readonly workspace: Workspace, private readonly now: () => Date = () => new Date()) {}

  async reconcile(): Promise<{ evidenceRecorded: number }> {
    const identity = await new CompanyIdentityStore(this.homeDir, this.now).getOrCreate();
    const proposals = new ScopePromotionStore(this.homeDir, identity.companyId, this.now);
    const trials = new CompanyTrialStore(this.homeDir, identity.companyId, this.now);
    const active = (await trials.list()).filter((item) => item.target.workspaceId === this.workspace.id && item.status === "deployed");
    if (!active.length) return { evidenceRecorded: 0 };
    const experience = new ExperienceStore(this.workspace.id, this.workspace.rootPath);
    const episodes = await experience.listEpisodes(); const attributions = await experience.listAttributions();
    let evidenceRecorded = 0;
    for (const trial of active) {
      const { assignments, usage } = await traceIndex(this.workspace.rootPath, trial.target.agentId, trial.trialId);
      const proofs = await new EvolutionActivationStore(this.workspace.rootPath).listProofs();
      const observations: CompanyTrialObservation[] = [];
      const usedEpisodes: ExperienceEpisode[] = [];
      for (const episode of episodes.filter((item) => item.agentId === trial.target.agentId && item.profileId === trial.target.profileId && Date.parse(item.endedAt) >= Date.parse(trial.createdAt))) {
        const assignment = assignments.get(episode.goalId); if (!assignment) continue;
        const proof = assignment.selected ? proofs.find((item) => item.traceRef?.ref === assignment.trace.traceId && item.releaseRef.id === trial.trialReleaseRef.id && item.releaseRef.contentHash === trial.trialReleaseRef.contentHash) : undefined;
        if (assignment.selected && !proof) continue;
        const evidenceId = stableId("evidence_company_trial_episode", trial.trialId, episode.episodeId);
        const ledger = new EvidenceLedger(this.workspace.rootPath);
        if (!await ledger.get(evidenceId)) await ledger.append({ evidenceId, agentId: episode.agentId, threadId: assignment.trace.threadId, goalId: episode.goalId, attemptId: episode.attemptId, turnId: assignment.trace.turnId, toolCallId: stableId("company_trial_episode", episode.episodeId), toolName: "company-trial-reconciler", kind: "tool", capture: { status: "recorded" }, observation: { status: "observed", result: { episodeId: episode.episodeId, trialId: trial.trialId, selected: assignment.selected } }, workspaceRoot: this.workspace.rootPath, createdAt: episode.endedAt, input: { trialReleaseId: trial.trialReleaseRef.id } });
        observations.push({
          observationId: stableId("company_trial_observation", trial.trialId, episode.episodeId), assignmentKey: `${assignment.trace.threadId}:${assignment.trace.goalId ?? episode.goalId}`,
          arm: assignment.selected ? "selected" : "control",
          traceRef: { kind: "trace", ref: assignment.trace.traceId, workspaceId: this.workspace.id, agentId: trial.target.agentId, profileId: trial.target.profileId, taskRunId: episode.attemptId },
          ...(proof ? { inheritanceProofRef: proof.proofId } : {}),
          evidenceRefs: [{ kind: "evidence", ref: evidenceId, workspaceId: this.workspace.id, agentId: trial.target.agentId, profileId: trial.target.profileId }],
          result: observation(episode, attributions, usage),
        });
        usedEpisodes.push(episode);
      }
      const selected = observations.filter((item) => item.arm === "selected").length; const control = observations.length - selected;
      if (selected < trial.assignment.minimumSamplesPerArm || control < trial.assignment.minimumSamplesPerArm) continue;
      const evidence = await new CompanyTrialEvidenceStore(this.homeDir, identity.companyId, trials, proposals, this.now).record({
        commandId: `company-trial-reconcile:${trial.trialId}:${hash(observations.map((item) => item.observationId).sort().join("\0"))}`,
        trialId: trial.trialId, targetWorkspaceRoot: this.workspace.rootPath, observations,
        startedAt: usedEpisodes.reduce((value, episode) => earlier(value, episode.startedAt), usedEpisodes[0]!.startedAt),
        endedAt: usedEpisodes.reduce((value, episode) => later(value, episode.endedAt), usedEpisodes[0]!.endedAt),
      });
      await new CompanyTrialReleaseRegistry(this.homeDir, identity.companyId, proposals, trials, this.now).close(trial.trialId, this.workspace.rootPath);
      if (evidence) evidenceRecorded += 1;
    }
    return { evidenceRecorded };
  }
}

async function traceIndex(root: string, agentId: string, trialId: string): Promise<{ assignments: Map<string, AssignmentTrace>; usage: Map<string, GoalUsage> }> {
  const assignments = new Map<string, AssignmentTrace>(); const usage = new Map<string, GoalUsage>();
  for (const trace of await new AgentTraceStore(root, agentId).list()) {
    if (!trace.goalId) continue;
    if (trace.kind === "context" && isRecord(trace.data) && Array.isArray(trace.data.evolutionCanaryAssignments)) {
      const item = trace.data.evolutionCanaryAssignments.find((value) => isRecord(value) && value.promotionId === trialId && typeof value.releaseId === "string" && typeof value.selected === "boolean");
      if (isRecord(item)) assignments.set(trace.goalId, { trace, selected: item.selected as boolean, releaseId: item.releaseId as string });
    }
    if (trace.kind === "provider_response" && isRecord(trace.data) && [trace.data.inputTokens, trace.data.outputTokens, trace.data.totalTokens].every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)) {
      const current = usage.get(trace.goalId) ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      usage.set(trace.goalId, { inputTokens: current.inputTokens + Number(trace.data.inputTokens), outputTokens: current.outputTokens + Number(trace.data.outputTokens), totalTokens: current.totalTokens + Number(trace.data.totalTokens) });
    }
  }
  return { assignments, usage };
}
function observation(episode: ExperienceEpisode, attributions: ExperienceAttribution[], usage: Map<string, GoalUsage>): EvaluationObservation { const related = attributions.filter((item) => item.episodeId === episode.episodeId); const tokens = usage.get(episode.goalId); return { success: episode.outcome === "succeeded", qualityScore: episode.outcome === "succeeded" ? 1 : episode.outcome === "returned" ? 0.25 : 0, costUsd: 0, costMeasured: false, ...(tokens ?? {}), latencyMs: Math.max(0, Date.parse(episode.endedAt) - Date.parse(episode.startedAt)), toolFailures: related.filter((item) => item.component === "tool").length, policyViolations: related.filter((item) => item.component === "policy").length, safetyViolations: related.filter((item) => item.component === "policy" && item.confidence >= 0.9).length, qaReturns: episode.outcome === "returned" ? 1 : 0, humanInterventions: episode.sourceRefs.filter((ref) => ref.kind === "human_feedback").length, evidenceCompleteness: episode.sourceRefs.length ? 1 : 0 }; }
function stableId(prefix: string, ...parts: string[]): string { return `${prefix}_${hash(parts.join("\0")).slice(0, 32)}`; }
function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function earlier(a: string, b: string): string { return Date.parse(a) <= Date.parse(b) ? a : b; }
function later(a: string, b: string): string { return Date.parse(a) >= Date.parse(b) ? a : b; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
