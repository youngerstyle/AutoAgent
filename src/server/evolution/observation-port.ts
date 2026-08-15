import type { AuthoritativeEpisodeFacts, EvolutionSourceRef, ExperienceEpisode, ExperienceOutcome } from "../../shared/contracts/evolution.js";

export interface EvolutionEpisodeObservationBatch {
  inspectedWorkItems: number;
  skippedWorkItems: number;
  facts: AuthoritativeEpisodeFacts[];
}

export interface EvolutionMemoryUsageObservation {
  episodeId: string;
  outcome: ExperienceOutcome;
  occurredAt: string;
  sourceRefs: EvolutionSourceRef[];
  loadedMemories: Array<{ releaseId: string; traceRef: EvolutionSourceRef }>;
}

/**
 * Anti-corruption boundary between Evol and operational frameworks. Evol owns
 * these normalized observations and never reads Ticket, Mission, or Agent stores.
 */
export interface EvolutionObservationPort {
  collectEpisodeFacts(): Promise<EvolutionEpisodeObservationBatch>;
  collectMemoryUsage(episodes: ExperienceEpisode[]): Promise<EvolutionMemoryUsageObservation[]>;
}

export const EMPTY_EVOLUTION_OBSERVATION_PORT: EvolutionObservationPort = {
  async collectEpisodeFacts() { return { inspectedWorkItems: 0, skippedWorkItems: 0, facts: [] }; },
  async collectMemoryUsage() { return []; },
};
