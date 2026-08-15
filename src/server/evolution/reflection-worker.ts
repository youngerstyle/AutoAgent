import type { EvolutionPracticeDraft, ExperienceAttribution } from "../../shared/contracts/evolution.js";
import { EvolutionSignalStore } from "./evolution-signal-store.js";
import { ExperienceStore } from "./experience-store.js";
import { PracticeDraftStore } from "./practice-draft-store.js";
import { EvolutionPhaseJobStore } from "./phase-job-store.js";
import { EvidenceLedger } from "../evidence/evidence-ledger.js";
import type { PracticeReflector } from "./practice-reflector.js";

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
      for (const attribution of attributions) created.push(await this.drafts.create(draftFrom(signal.signalId, episode!.profileId, episode!.episodeId, attribution)));
      if (episode && !attributions.length && this.reflector && await this.reflector.available()) {
        const ledger = new EvidenceLedger(this.workspaceRoot); const sourceFacts = [];
        for (const ref of episode.sourceRefs.filter((item) => item.kind === "evidence" || item.kind === "human_feedback")) { const fact = await ledger.get(ref.ref); if (fact) sourceFacts.push(fact); }
        const hypotheses = await this.reflector.reflect(episode, sourceFacts);
        for (const [index, hypothesis] of hypotheses.entries()) created.push(await this.drafts.create({
          commandId: `provider-reflection:${signal.signalId}:${index}`, signalId: signal.signalId, ...hypothesis,
          applicability: { ownerLevel: "agent_project", workspaceId: this.workspaceId, profileId: episode.profileId },
          sourceEpisodeRefs: [episode.episodeId], sourceRefs: structuredClone(episode.sourceRefs),
        }));
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
