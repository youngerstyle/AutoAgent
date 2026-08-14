import { createHash } from "node:crypto";
import type { ExperienceAttribution, EvolutionCandidate, EvolutionSourceRef } from "../../shared/contracts/evolution.js";
import { EvolutionStore } from "./evolution-store.js";
import { ExperienceStore } from "./experience-store.js";

export interface MemoryConsolidationResult {
  inspectedAttributions: number;
  eligibleClusters: number;
  conflictedClusters: number;
  candidates: EvolutionCandidate[];
}

export class MemoryConsolidator {
  constructor(
    private readonly workspaceId: string,
    private readonly experience: ExperienceStore,
    private readonly candidates: EvolutionStore,
  ) {}

  async consolidate(minimumEpisodes = 2): Promise<MemoryConsolidationResult> {
    if (!Number.isSafeInteger(minimumEpisodes) || minimumEpisodes < 2 || minimumEpisodes > 100) throw new Error("Memory consolidation threshold must be between 2 and 100");
    const attributions = await this.experience.listAttributions();
    const clusters = clusterAttributions(attributions.filter((item) => item.component !== "unknown" && item.confidence >= 0.8));
    const supported = [...clusters.values()].filter((items) => new Set(items.map((item) => item.episodeId)).size >= minimumEpisodes);
    const conflicted = supported.filter((items) => items.some((item) => item.counterEvidenceRefs.length > 0));
    const eligible = supported.filter((items) => items.every((item) => item.counterEvidenceRefs.length === 0));
    const created: EvolutionCandidate[] = [];
    for (const items of eligible) {
      const representative = items[0];
      if (representative.scope.workspaceId !== this.workspaceId || items.some((item) => item.scope.workspaceId !== this.workspaceId)) throw new Error("Memory consolidation crossed its workspace boundary");
      const episodeIds = [...new Set(items.map((item) => item.episodeId))].sort();
      const evidence = uniqueRefs(items.flatMap((item) => item.sourceRefs));
      if (!evidence.length) continue;
      const clusterHash = hash(JSON.stringify({ component: representative.component, cause: normalized(representative.cause), episodeIds }));
      const target = `experience.${representative.component}.${clusterHash.slice(0, 12)}`;
      created.push(await this.candidates.create({
        commandId: `memory-consolidation:${clusterHash}`,
        kind: "memory",
        target,
        title: `Repeated ${representative.component} failure: ${short(representative.symptom, 80)}`,
        rationale: `${episodeIds.length} independent episodes share the same evidence-backed cause. This candidate records a scoped operational lesson; it does not claim the Skill is defective.`,
        hypothesis: "Reusing this scoped operational lesson will improve task success without increasing policy or safety violations.",
        artifactContent: memoryArtifact(representative, episodeIds, evidence),
        sourceRefs: evidence,
        scope: structuredClone(representative.scope),
        expectedMetrics: [{ metric: representative.component === "tool" ? "tool_failure_rate" : "task_success_rate", direction: representative.component === "tool" ? "decrease" : "increase", minimumDelta: 0.01 }],
        riskLevel: representative.component === "policy" ? "high" : "low",
        proposedBy: { type: "system", id: "memory-consolidator/v1" },
      }));
    }
    return { inspectedAttributions: attributions.length, eligibleClusters: eligible.length, conflictedClusters: conflicted.length, candidates: created };
  }
}

function clusterAttributions(items: ExperienceAttribution[]): Map<string, ExperienceAttribution[]> {
  const clusters = new Map<string, ExperienceAttribution[]>();
  for (const item of items) {
    const key = `${item.scope.workspaceId}\0${item.component}\0${normalized(item.cause)}`;
    const bucket = clusters.get(key) ?? [];
    bucket.push(item);
    clusters.set(key, bucket);
  }
  return clusters;
}

function memoryArtifact(item: ExperienceAttribution, episodeIds: string[], refs: EvolutionSourceRef[]): string {
  return [
    "# Scoped operational memory", "", `Component: ${item.component}`, `Scope: workspace:${item.scope.workspaceId}`,
    `Observed symptom: ${item.symptom}`, `Evidence-backed cause: ${item.cause}`, "",
    "## Reuse rule", "", "Apply this lesson only when the current task matches the scope and the cited cause is observed again. Verify current evidence before acting; do not generalize it into a Skill defect.", "",
    "## Support", "", `Independent episodes: ${episodeIds.join(", ")}`, `Source facts: ${refs.map((ref) => `${ref.kind}:${ref.ref}`).join(", ")}`, "",
  ].join("\n");
}

function uniqueRefs(refs: EvolutionSourceRef[]): EvolutionSourceRef[] {
  return [...new Map(refs.map((ref) => [`${ref.kind}:${ref.workspaceId}:${ref.ref}`, structuredClone(ref)])).values()]
    .sort((left, right) => `${left.kind}:${left.ref}`.localeCompare(`${right.kind}:${right.ref}`));
}
function normalized(value: string): string { return value.trim().toLowerCase().replace(/\s+/g, " "); }
function short(value: string, length: number): string { return value.length <= length ? value : `${value.slice(0, length - 1)}…`; }
function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
