import type { EvolutionPracticeDraft, ExperienceAttribution } from "../../shared/contracts/evolution.js";
import { EvolutionSignalStore } from "./evolution-signal-store.js";
import { ExperienceStore } from "./experience-store.js";
import { PracticeDraftStore } from "./practice-draft-store.js";
import { EvolutionPhaseJobStore } from "./phase-job-store.js";
import type { PracticeReflector } from "./practice-reflector.js";
import { EMPTY_EVOLUTION_OBSERVATION_PORT, type EvolutionObservationPort } from "./observation-port.js";

export class EvolutionReflectionWorker {
  constructor(
    private readonly workspaceId: string,
    private readonly workspaceRoot: string,
    private readonly signals = new EvolutionSignalStore(workspaceId, workspaceRoot),
    private readonly experience = new ExperienceStore(workspaceId, workspaceRoot),
    private readonly drafts = new PracticeDraftStore(workspaceId, workspaceRoot),
    private readonly jobs = new EvolutionPhaseJobStore(workspaceId, workspaceRoot),
    private readonly now: () => Date = () => new Date(),
    private readonly reflector?: PracticeReflector,
    private readonly observations: EvolutionObservationPort = EMPTY_EVOLUTION_OBSERVATION_PORT,
  ) {}

  async runNext(workerId: string): Promise<{ signalId: string; drafts: EvolutionPracticeDraft[] } | undefined> {
    const knownSignalIds = new Set((await this.jobs.list()).filter((item) => item.kind === "reflection").map((item) => item.sourceSignalId));
    for (const signal of (await this.signals.list()).filter((item) => ["pending", "retry_wait", "running"].includes(item.status) && !knownSignalIds.has(item.signalId))) {
      await this.jobs.enqueue({ commandId: `reflection:${signal.signalId}`, kind: "reflection", priority: signal.priority, profileId: signal.profileId,
        sourceSignalId: signal.signalId, sourceDraftRefs: [], scheduleReason: "recovery", availableAt: signal.nextAttemptAt ?? this.now().toISOString() });
    }
    const job = await this.jobs.claim("reflection", workerId);
    if (!job) return undefined;
    const existing = (await this.signals.list()).find((item) => item.signalId === job.sourceSignalId);
    if (existing?.status === "succeeded") { await this.jobs.succeed(job.jobId, job.lease!.token); return { signalId: existing.signalId, drafts: [] }; }
    const signal = await this.signals.claim(workerId, 30_000, job.sourceSignalId);
    if (!signal) {
      await this.jobs.fail(job.jobId, job.lease!.token, { category: existing?.status === "dead_letter" ? "terminal" : "transient", message: `Evolution signal is not claimable: ${job.sourceSignalId}` });
      return undefined;
    }
    try {
      const episodes = await this.experience.listEpisodes();
      const episode = signal.episodeId ? episodes.find((item) => item.episodeId === signal.episodeId) : undefined;
      if (!episode && signal.episodeId) throw new Error(`Evolution signal episode is missing: ${signal.episodeId}`);
      const attributions = signal.episodeId ? (await this.experience.listAttributions()).filter((item) => item.episodeId === signal.episodeId && item.component !== "unknown" && item.confidence >= 0.8) : [];
      const created: EvolutionPracticeDraft[] = [];
      const uniqueAttributions = new Map(attributions.map((item) => [`${item.component}\0${item.symptom}\0${item.cause}`, item]));
      const reflector = this.reflector;
      const canReflect = Boolean(episode && reflector && await reflector.available());
      const sourceFacts = canReflect ? await this.observations.collectReflectionFacts(episode!) : [];
      const processEvidence = sourceFacts.some((fact) => fact.kind === "human_intervention")
        || ["user_correction", "recovered_failure", "manual"].includes(signal.trigger);
      // Successful recoveries need chronological semantic reflection. Turning
      // every transient error into a generic draft loses the intervention that
      // changed the run and floods Dream with low-value duplicates.
      if (episode?.outcome !== "succeeded" || !processEvidence) {
        for (const attribution of uniqueAttributions.values()) created.push(await this.drafts.create(draftFrom(signal.signalId, episode!.profileId, episode!.episodeId, attribution)));
      }
      if (episode && canReflect) {
        if (!attributions.length || processEvidence) {
          const hypotheses = await reflector!.reflect(episode, sourceFacts);
          const sourceRefs = uniqueRefs([...episode.sourceRefs, ...sourceFacts.map((fact) => fact.sourceRef)]);
          for (const [index, hypothesis] of hypotheses.entries()) created.push(await this.drafts.create({
            commandId: `provider-reflection:${signal.signalId}:${index}`, signalId: signal.signalId, ...hypothesis,
            applicability: { ownerLevel: "agent_project", workspaceId: this.workspaceId, profileId: episode.profileId },
            sourceEpisodeRefs: [episode.episodeId], sourceRefs,
          }));
        }
      }
      await this.signals.succeed(signal.signalId, signal.lease!.token);
      await this.jobs.succeed(job.jobId, job.lease!.token);
      return { signalId: signal.signalId, drafts: created };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.signals.fail(signal.signalId, signal.lease!.token, { category: message.startsWith("Evolution signal episode is missing:") ? "terminal" : "transient", message });
      await this.jobs.fail(job.jobId, job.lease!.token, { category: message.startsWith("Evolution signal episode is missing:") ? "terminal" : "transient", message });
      throw error;
    }
  }
}

function uniqueRefs<T>(refs: T[]): T[] { return [...new Map(refs.map((ref) => [JSON.stringify(ref), structuredClone(ref)])).values()]; }

function draftFrom(signalId: string, profileId: string, episodeId: string, item: ExperienceAttribution): Omit<EvolutionPracticeDraft, "draftId" | "provenanceHash" | "status" | "createdAt" | "updatedAt"> {
  return {
    commandId: `reflection:${signalId}:${item.attributionId}`, signalId,
    statement: item.cause, trigger: item.symptom,
    procedure: `When current evidence confirms this cause, apply the smallest correction that addresses it and verify the task outcome; stop if counter-evidence appears.`,
    expectedOutcome: [{ metric: item.component === "tool" ? "tool_failure_rate" : "task_success_rate", direction: item.component === "tool" ? "decrease" : "increase", minimumDelta: 0.01 }],
    observedComponents: [item.component],
    applicability: { ownerLevel: "agent_project", workspaceId: item.scope.workspaceId, profileId },
    contraindications: item.counterEvidenceRefs.map((ref) => `${ref.kind}:${ref.ref}`),
    sourceEpisodeRefs: [episodeId], sourceRefs: structuredClone(item.sourceRefs),
  };
}
