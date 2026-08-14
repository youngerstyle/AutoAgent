import { createHash } from "node:crypto";
import type { ExperienceAttribution, EvolutionCandidate, EvolutionSourceRef } from "../../shared/contracts/evolution.js";
import { EvolutionStore } from "./evolution-store.js";
import { ExperienceStore } from "./experience-store.js";

export interface PromptConsolidationResult {
  inspectedAttributions: number;
  eligibleClusters: number;
  conflictedClusters: number;
  candidates: EvolutionCandidate[];
}

/** Select the smallest durable asset for explicitly attributed prompt defects. */
export class PromptConsolidator {
  constructor(
    private readonly workspaceId: string,
    private readonly experience: ExperienceStore,
    private readonly candidates: EvolutionStore,
  ) {}

  async consolidate(minimumEpisodes = 2): Promise<PromptConsolidationResult> {
    if (!Number.isSafeInteger(minimumEpisodes) || minimumEpisodes < 2 || minimumEpisodes > 100) throw new Error("Prompt consolidation threshold must be between 2 and 100");
    const attributions = await this.experience.listAttributions();
    const clusters = cluster(attributions.filter((item) => item.component === "prompt" && item.confidence >= 0.8));
    const supported = [...clusters.values()].filter((items) => new Set(items.map((item) => item.episodeId)).size >= minimumEpisodes);
    const conflicted = supported.filter((items) => items.some((item) => item.counterEvidenceRefs.length > 0));
    const eligible = supported.filter((items) => items.every((item) => item.counterEvidenceRefs.length === 0));
    const created: EvolutionCandidate[] = [];
    for (const items of eligible) {
      const representative = items[0]!;
      if (representative.scope.workspaceId !== this.workspaceId || items.some((item) => item.scope.workspaceId !== this.workspaceId)) throw new Error("Prompt consolidation crossed its workspace boundary");
      const episodeIds = [...new Set(items.map((item) => item.episodeId))].sort();
      const evidence = uniqueRefs(items.flatMap((item) => item.sourceRefs));
      if (!evidence.length) continue;
      const clusterHash = hash(JSON.stringify({ component: "prompt", cause: normalize(representative.cause), episodeIds }));
      created.push(await this.candidates.create({
        commandId: `prompt-consolidation:${clusterHash}`,
        kind: "prompt", target: `experience.prompt.${clusterHash.slice(0, 12)}`,
        title: `Repeated prompt failure: ${short(representative.symptom, 80)}`,
        rationale: `${episodeIds.length} independent episodes explicitly attribute the same failure to prompt behavior. The candidate changes only a scoped prompt fragment and still requires evaluation and human approval before activation.`,
        hypothesis: "Adding this evidence-backed prompt constraint will improve task success and evidence completeness without increasing policy violations.",
        artifactContent: promptArtifact(representative, episodeIds, evidence), sourceRefs: evidence,
        scope: structuredClone(representative.scope),
        expectedMetrics: [{ metric: "task_success_rate", direction: "increase", minimumDelta: 0.01 }, { metric: "evidence_completeness", direction: "increase" }],
        riskLevel: "high", proposedBy: { type: "system", id: "prompt-consolidator/v1" },
      }));
    }
    return { inspectedAttributions: attributions.length, eligibleClusters: eligible.length, conflictedClusters: conflicted.length, candidates: created };
  }
}

function cluster(items: ExperienceAttribution[]): Map<string, ExperienceAttribution[]> {
  const values = new Map<string, ExperienceAttribution[]>();
  for (const item of items) {
    const key = `${item.scope.workspaceId}\0${normalize(item.cause)}`;
    values.set(key, [...(values.get(key) ?? []), item]);
  }
  return values;
}
function promptArtifact(item: ExperienceAttribution, episodeIds: string[], refs: EvolutionSourceRef[]): string {
  return [
    "## Evidence-backed behavior constraint", "",
    `When the current task matches workspace ${item.scope.workspaceId} and the observed condition below is present, apply this constraint:`, "",
    `- Observed condition: ${item.cause}`,
    `- Prevent recurrence of: ${item.symptom}`,
    "- Before concluding or acting, cite the current trace/evidence that demonstrates the condition.",
    "- If the condition is absent or counter-evidence exists, do not apply this fragment.", "",
    `Support episodes: ${episodeIds.join(", ")}`,
    `Source facts: ${refs.map((ref) => `${ref.kind}:${ref.ref}`).join(", ")}`, "",
  ].join("\n");
}
function uniqueRefs(refs: EvolutionSourceRef[]): EvolutionSourceRef[] {
  return [...new Map(refs.map((ref) => [`${ref.kind}:${ref.workspaceId}:${ref.ref}`, structuredClone(ref)])).values()]
    .sort((a, b) => `${a.kind}:${a.ref}`.localeCompare(`${b.kind}:${b.ref}`));
}
function normalize(value: string): string { return value.trim().toLowerCase().replace(/\s+/g, " "); }
function short(value: string, length: number): string { return value.length <= length ? value : `${value.slice(0, length - 1)}…`; }
function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
