import type { EvolutionPracticeDraft, MetricExpectation } from "../../shared/contracts/evolution.js";
import { PracticeDraftStore } from "./practice-draft-store.js";
import { PracticeStore } from "./practice-store.js";
import { EvolutionPhaseJobStore } from "./phase-job-store.js";

export interface DreamResult { draftsInspected: number; clustersEligible: number; clustersConflicted: number; practicesProduced: number }

/** Stable semantic family for consolidation; exact Provider prose is not a durable identity. */
export function practiceClusterKey(draft: Pick<EvolutionPracticeDraft, "applicability" | "statement" | "trigger" | "conceptKey">): string {
  const scope = draft.applicability;
  const concept = draft.conceptKey?.trim().toLocaleLowerCase() || inferredConceptKey(draft.statement, draft.trigger);
  return [scope.ownerLevel, scope.workspaceId ?? "", scope.profileId ?? "", concept, concept.includes(".") || concept.includes(":") ? "" : normalize(draft.trigger)].join("\u001f");
}

export function hasIndependentDraftCluster(drafts: EvolutionPracticeDraft[], minimumIndependentEpisodes: number): boolean {
  const clusters = new Map<string, Set<string>>();
  for (const draft of drafts) {
    const episodes = clusters.get(practiceClusterKey(draft)) ?? new Set<string>();
    for (const episodeId of draft.sourceEpisodeRefs) episodes.add(episodeId);
    clusters.set(practiceClusterKey(draft), episodes);
  }
  return [...clusters.values()].some((episodes) => episodes.size >= minimumIndependentEpisodes);
}

export class EvolutionDreamWorker {
  constructor(
    private readonly workspaceId: string,
    private readonly drafts: PracticeDraftStore,
    private readonly practices: PracticeStore,
  ) {}

  async runNext(workerId: string, jobs: EvolutionPhaseJobStore, minimumIndependentEpisodes = 2): Promise<DreamResult | undefined> {
    const job = await jobs.claim("consolidation", workerId);
    if (!job) return undefined;
    try {
      const result = await this.run(minimumIndependentEpisodes, job.sourceDraftRefs);
      await jobs.succeed(job.jobId, job.lease!.token);
      return result;
    } catch (error) {
      await jobs.fail(job.jobId, job.lease!.token, { category: "transient", message: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  async run(minimumIndependentEpisodes = 2, sourceDraftRefs?: string[]): Promise<DreamResult> {
    if (!Number.isSafeInteger(minimumIndependentEpisodes) || minimumIndependentEpisodes < 2) throw new Error("Dream evidence threshold must be at least two independent episodes");
    const selected = sourceDraftRefs ? new Set(sourceDraftRefs) : undefined;
    const pending = (await this.drafts.list()).filter((draft) => draft.status === "draft" && (!selected || selected.has(draft.draftId)));
    const clusters = new Map<string, EvolutionPracticeDraft[]>();
    for (const draft of pending) {
      const key = practiceClusterKey(draft); const values = clusters.get(key) ?? []; values.push(draft); clusters.set(key, values);
    }
    let eligible = 0; let conflicted = 0; let produced = 0;
    const existingPractices = await this.practices.list();
    for (const cluster of clusters.values()) {
      const episodeRefs = unique(cluster.flatMap((draft) => draft.sourceEpisodeRefs));
      if (episodeRefs.length < minimumIndependentEpisodes) continue;
      if (cluster.some((draft) => draft.contraindications.length > 0)) { conflicted += 1; continue; }
      eligible += 1;
      const ordered = [...cluster].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.draftId.localeCompare(b.draftId));
      const exemplar = ordered[0]!;
      const prior = existingPractices.filter((practice) => practiceClusterKey(practice) === practiceClusterKey(exemplar)).sort((a, b) => b.version - a.version)[0];
      const practiceInput = {
        commandId: `dream:${this.workspaceId}:${ordered.map((draft) => draft.draftId).sort().join(":")}`,
        statement: exemplar.statement,
        ...(exemplar.conceptKey ? { conceptKey: exemplar.conceptKey } : {}),
        trigger: exemplar.trigger,
        procedure: exemplar.procedure,
        expectedOutcome: uniqueMetrics(ordered.flatMap((draft) => draft.expectedOutcome)),
        observedComponents: unique(ordered.flatMap((draft) => draft.observedComponents ?? [])),
        applicability: structuredClone(exemplar.applicability),
        guardrails: unique(ordered.flatMap((draft) => draft.guardrails ?? [])),
        contraindications: [],
        sourceDraftRefs: ordered.map((draft) => draft.draftId),
        sourceEpisodeRefs: episodeRefs,
        sourceRefs: uniqueByJson(ordered.flatMap((draft) => draft.sourceRefs)),
      };
      if (prior) await this.practices.reviseCandidate({ ...practiceInput, commandId: `dream-revision:${prior.practiceId}:${ordered.map((draft) => draft.draftId).sort().join(":")}`,
        practiceId: prior.practiceId, baseVersion: prior.version, revisionReason: "New independent Episode evidence confirmed the existing Practice",
        sourceDraftRefs: unique([...prior.sourceDraftRefs, ...practiceInput.sourceDraftRefs]), sourceEpisodeRefs: unique([...prior.sourceEpisodeRefs, ...practiceInput.sourceEpisodeRefs]),
        sourceRefs: uniqueByJson([...prior.sourceRefs, ...practiceInput.sourceRefs]), observedComponents: unique([...prior.observedComponents, ...practiceInput.observedComponents]),
      });
      else await this.practices.createCandidate(practiceInput);
      await this.drafts.markConsolidated(ordered.map((draft) => draft.draftId));
      produced += 1;
    }
    return { draftsInspected: pending.length, clustersEligible: eligible, clustersConflicted: conflicted, practicesProduced: produced };
  }
}
function normalize(value: string): string { return value.trim().toLocaleLowerCase().replace(/\s+/g, " "); }
function unique<T extends string>(values: T[]): T[] { return [...new Set(values)].sort(); }
function uniqueMetrics(values: MetricExpectation[]): MetricExpectation[] { return uniqueByJson(values); }
function uniqueByJson<T>(values: T[]): T[] { return [...new Map(values.map((value) => [JSON.stringify(value), structuredClone(value)])).values()]; }

function inferredConceptKey(statement: string, trigger: string): string {
  const value = `${statement} ${trigger}`.toLocaleLowerCase();
  if (/(brief|宣讲|共同理解|确认理解|acknowledg|acceptance|验收标准|范围|risk|风险|evidence|凭证)/.test(value)
    && /(before|在|阶段前|开始|implementation|coding|开发|交接)/.test(value)) return "workflow.pre_implementation_briefing";
  if (/(upstream service|上游服务|provider_retry|暂时不可用|connection error)/.test(value)) return "provider.transient_unavailable";
  return `${normalize(statement)}\u001e${normalize(trigger)}`;
}
