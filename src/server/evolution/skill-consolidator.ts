import { createHash } from "node:crypto";
import type { ExperienceAttribution, EvolutionCandidate, EvolutionSourceRef } from "../../shared/contracts/evolution.js";
import { EvolutionStore } from "./evolution-store.js";
import { ExperienceStore } from "./experience-store.js";

export interface SkillConsolidationResult {
  inspectedAttributions: number;
  eligibleClusters: number;
  conflictedClusters: number;
  candidates: EvolutionCandidate[];
}

/** Build a reusable Skill only when authoritative facts explicitly blame Skill behavior. */
export class SkillConsolidator {
  constructor(
    private readonly workspaceId: string,
    private readonly experience: ExperienceStore,
    private readonly candidates: EvolutionStore,
  ) {}

  async consolidate(minimumEpisodes = 2): Promise<SkillConsolidationResult> {
    if (!Number.isSafeInteger(minimumEpisodes) || minimumEpisodes < 2 || minimumEpisodes > 100) throw new Error("Skill consolidation threshold must be between 2 and 100");
    const attributions = await this.experience.listAttributions();
    const clusters = cluster(attributions.filter((item) => item.component === "skill" && item.confidence >= 0.8));
    const supported = [...clusters.values()].filter((items) => new Set(items.map((item) => item.episodeId)).size >= minimumEpisodes);
    const conflicted = supported.filter((items) => items.some((item) => item.counterEvidenceRefs.length > 0));
    const eligible = supported.filter((items) => items.every((item) => item.counterEvidenceRefs.length === 0));
    const created: EvolutionCandidate[] = [];
    for (const items of eligible) {
      const representative = items[0]!;
      if (representative.scope.workspaceId !== this.workspaceId || items.some((item) => item.scope.workspaceId !== this.workspaceId)) throw new Error("Skill consolidation crossed its workspace boundary");
      const episodeIds = [...new Set(items.map((item) => item.episodeId))].sort();
      const evidence = uniqueRefs(items.flatMap((item) => item.sourceRefs));
      if (!evidence.length) continue;
      const clusterHash = hash(JSON.stringify({ component: "skill", cause: normalize(representative.cause), episodeIds }));
      const target = `evolved-${clusterHash.slice(0, 16)}`;
      created.push(await this.candidates.create({
        commandId: `skill-consolidation:${clusterHash}`, kind: "skill", target,
        title: `Repeated Skill defect: ${short(representative.symptom, 80)}`,
        rationale: `${episodeIds.length} independent terminal Episodes explicitly classify the same reusable capability defect. The generated Skill remains a Candidate until static scan, evaluation, and human approval pass.`,
        hypothesis: "Applying this scoped Skill procedure will improve task success and reduce repeated capability failures without increasing safety violations.",
        artifactContent: skillArtifact(target, representative, episodeIds, evidence), sourceRefs: evidence,
        scope: structuredClone(representative.scope),
        expectedMetrics: [{ metric: "task_success_rate", direction: "increase", minimumDelta: 0.01 }, { metric: "tool_failure_rate", direction: "decrease" }],
        riskLevel: "medium", proposedBy: { type: "system", id: "skill-consolidator/v1" },
      }));
    }
    return { inspectedAttributions: attributions.length, eligibleClusters: eligible.length, conflictedClusters: conflicted.length, candidates: created };
  }
}

function skillArtifact(name: string, item: ExperienceAttribution, episodeIds: string[], refs: EvolutionSourceRef[]): string {
  return [
    "---", `name: ${name}`, `description: Evidence-backed procedure for ${plain(item.symptom, 120)}`, "---",
    `# ${name}`, "", "## Activation rule", "",
    `Use this Skill only when current evidence demonstrates: ${item.cause}`, "",
    "## Procedure", "",
    `1. Confirm the current symptom matches: ${item.symptom}`,
    "2. Cite the current authoritative trace or evidence before changing behavior.",
    "3. Apply the smallest correction that addresses the demonstrated cause.",
    "4. Verify the result against target, regression, and safety expectations.",
    "5. If counter-evidence appears, stop using this procedure and request refinement.", "",
    "## Provenance", "", `Independent Episodes: ${episodeIds.join(", ")}`,
    `Source facts: ${refs.map((ref) => `${ref.kind}:${ref.ref}`).join(", ")}`, "",
  ].join("\n");
}
function cluster(items: ExperienceAttribution[]): Map<string, ExperienceAttribution[]> {
  const values = new Map<string, ExperienceAttribution[]>();
  for (const item of items) {
    const key = `${item.scope.workspaceId}\0${normalize(item.cause)}`;
    values.set(key, [...(values.get(key) ?? []), item]);
  }
  return values;
}
function uniqueRefs(refs: EvolutionSourceRef[]): EvolutionSourceRef[] {
  return [...new Map(refs.map((ref) => [`${ref.kind}:${ref.workspaceId}:${ref.ref}`, structuredClone(ref)])).values()]
    .sort((a, b) => `${a.kind}:${a.ref}`.localeCompare(`${b.kind}:${b.ref}`));
}
function normalize(value: string): string { return value.trim().toLowerCase().replace(/\s+/g, " "); }
function plain(value: string, length: number): string { return short(value.replace(/[\r\n]+/g, " ").replace(/[:#]/g, " "), length); }
function short(value: string, length: number): string { return value.length <= length ? value : `${value.slice(0, length - 1)}…`; }
function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
