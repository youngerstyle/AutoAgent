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

export interface EvolutionCompactionObservation {
  agentId: string;
  profileId: string;
  threadId: string;
  itemId: string;
  sequence: number;
  occurredAt: string;
}

export interface EvolutionRuntimeTelemetryObservation {
  agentId: string;
  traceId: string;
  threadId: string;
  turnId: string;
  goalId: string;
  assignments: Array<{ target: string; promotionId: string; releaseId: string; selected: boolean }>;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
}

/**
 * Anti-corruption boundary between Evol and operational frameworks. Evol owns
 * these normalized observations and never reads Ticket, Mission, or Agent stores.
 */
export interface EvolutionObservationPort {
  collectEpisodeFacts(): Promise<EvolutionEpisodeObservationBatch>;
  collectMemoryUsage(episodes: ExperienceEpisode[]): Promise<EvolutionMemoryUsageObservation[]>;
  collectCompactions(afterSequences: Record<string, number>): Promise<EvolutionCompactionObservation[]>;
  collectRuntimeTelemetry(agentId?: string): Promise<EvolutionRuntimeTelemetryObservation[]>;
  verifyRuntimeAssignment(input: { agentId: string; traceId: string; promotionId: string; releaseId: string; selected: boolean }): Promise<boolean>;
}

export const EMPTY_EVOLUTION_OBSERVATION_PORT: EvolutionObservationPort = {
  async collectEpisodeFacts() { return { inspectedWorkItems: 0, skippedWorkItems: 0, facts: [] }; },
  async collectMemoryUsage() { return []; },
  async collectCompactions() { return []; },
  async collectRuntimeTelemetry() { return []; },
  async verifyRuntimeAssignment() { return false; },
};
