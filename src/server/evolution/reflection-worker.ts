import type { EvolutionPracticeDraft, ExperienceAttribution } from "../../shared/contracts/evolution.js";
import { EvolutionSignalStore } from "./evolution-signal-store.js";
import { ExperienceStore } from "./experience-store.js";
import { PracticeDraftStore } from "./practice-draft-store.js";

export class EvolutionReflectionWorker {
  constructor(
    private readonly workspaceId: string,
    private readonly workspaceRoot: string,
    private readonly signals = new EvolutionSignalStore(workspaceId, workspaceRoot),
    private readonly experience = new ExperienceStore(workspaceId, workspaceRoot),
    private readonly drafts = new PracticeDraftStore(workspaceId, workspaceRoot),
  ) {}

  async runNext(workerId: string): Promise<{ signalId: string; drafts: EvolutionPracticeDraft[] } | undefined> {
    const signal = await this.signals.claim(workerId);
    if (!signal) return undefined;
    try {
      const episodes = await this.experience.listEpisodes();
      const episode = signal.episodeId ? episodes.find((item) => item.episodeId === signal.episodeId) : undefined;
      if (!episode && signal.episodeId) throw new Error(`Evolution signal episode is missing: ${signal.episodeId}`);
      const attributions = signal.episodeId ? (await this.experience.listAttributions()).filter((item) => item.episodeId === signal.episodeId && item.component !== "unknown" && item.confidence >= 0.8) : [];
      const created: EvolutionPracticeDraft[] = [];
      for (const attribution of attributions) created.push(await this.drafts.create(draftFrom(signal.signalId, episode!.profileId, episode!.episodeId, attribution)));
      await this.signals.succeed(signal.signalId, signal.lease!.token);
      return { signalId: signal.signalId, drafts: created };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.signals.fail(signal.signalId, signal.lease!.token, { category: message.startsWith("Evolution signal episode is missing:") ? "terminal" : "transient", message });
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
