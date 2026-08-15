import type { EvolutionSourceRef } from "../../shared/contracts/evolution.js";

/** Evol asks whether an immutable external fact exists; it never opens the owner framework's store. */
export interface EvolutionSourceVerificationPort {
  verify(ref: EvolutionSourceRef): Promise<boolean>;
}

export const REJECTING_EVOLUTION_SOURCE_VERIFIER: EvolutionSourceVerificationPort = {
  async verify() { return false; },
};
