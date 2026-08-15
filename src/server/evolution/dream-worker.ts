import type { EvolutionPracticeDraft, MetricExpectation } from "../../shared/contracts/evolution.js";
import { PracticeDraftStore } from "./practice-draft-store.js";
import { PracticeStore } from "./practice-store.js";

export interface DreamResult { draftsInspected: number; clustersEligible: number; clustersConflicted: number; practicesProduced: number }

export class EvolutionDreamWorker {
  constructor(
    private readonly workspaceId: string,
    private readonly drafts: PracticeDraftStore,
    private readonly practices: PracticeStore,
  ) {}

  async run(minimumIndependentEpisodes = 2): Promise<DreamResult> {
    if (!Number.isSafeInteger(minimumIndependentEpisodes) || minimumIndependentEpisodes < 2) throw new Error("Dream evidence threshold must be at least two independent episodes");
    const pending = (await this.drafts.list()).filter((draft) => draft.status === "draft");
    const clusters = new Map<string, EvolutionPracticeDraft[]>();
    for (const draft of pending) {
      const key = clusterKey(draft); const values = clusters.get(key) ?? []; values.push(draft); clusters.set(key, values);
    }
    let eligible = 0; let conflicted = 0; let produced = 0;
    for (const cluster of clusters.values()) {
      const episodeRefs = unique(cluster.flatMap((draft) => draft.sourceEpisodeRefs));
      if (episodeRefs.length < minimumIndependentEpisodes) continue;
      if (cluster.some((draft) => draft.contraindications.length > 0)) { conflicted += 1; continue; }
      eligible += 1;
      const ordered = [...cluster].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.draftId.localeCompare(b.draftId));
      const exemplar = ordered[0]!;
      await this.practices.createCandidate({
        commandId: `dream:${this.workspaceId}:${ordered.map((draft) => draft.draftId).sort().join(":")}`,
        statement: exemplar.statement,
        trigger: exemplar.trigger,
        procedure: exemplar.procedure,
        expectedOutcome: uniqueMetrics(ordered.flatMap((draft) => draft.expectedOutcome)),
        observedComponents: unique(ordered.flatMap((draft) => draft.observedComponents ?? [])),
        applicability: structuredClone(exemplar.applicability),
        contraindications: [],
        sourceDraftRefs: ordered.map((draft) => draft.draftId),
        sourceEpisodeRefs: episodeRefs,
        sourceRefs: uniqueByJson(ordered.flatMap((draft) => draft.sourceRefs)),
      });
      await this.drafts.markConsolidated(ordered.map((draft) => draft.draftId));
      produced += 1;
    }
    return { draftsInspected: pending.length, clustersEligible: eligible, clustersConflicted: conflicted, practicesProduced: produced };
  }
}

function clusterKey(draft: EvolutionPracticeDraft): string {
  const scope = draft.applicability;
  return [scope.ownerLevel, scope.workspaceId ?? "", scope.profileId ?? "", normalize(draft.statement), normalize(draft.trigger)].join("\u001f");
}
function normalize(value: string): string { return value.trim().toLocaleLowerCase().replace(/\s+/g, " "); }
function unique<T extends string>(values: T[]): T[] { return [...new Set(values)].sort(); }
function uniqueMetrics(values: MetricExpectation[]): MetricExpectation[] { return uniqueByJson(values); }
function uniqueByJson<T>(values: T[]): T[] { return [...new Map(values.map((value) => [JSON.stringify(value), structuredClone(value)])).values()]; }
