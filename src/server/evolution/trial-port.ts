import type { EvaluationCaseResult, EvolutionPairedTrialRequest } from "../../shared/contracts/evolution.js";

export interface EvolutionTrialPort {
  available(workspaceId: string): Promise<boolean>;
  dispatch(input: { workspaceId: string; trialId: string; request: EvolutionPairedTrialRequest }): Promise<{ dispatchRef: string }>;
  observe(input: { workspaceId: string; trialId: string; dispatchRef: string }): Promise<
    | { status: "pending" | "running" }
    | { status: "succeeded"; caseResults: EvaluationCaseResult[] }
    | { status: "failed" | "inconclusive"; category: "transient" | "terminal"; message: string }
  >;
}

/** Evol remains available without an adapter; paired trials stay pending rather than being fabricated. */
export const UNAVAILABLE_EVOLUTION_TRIAL_PORT: EvolutionTrialPort = {
  async available() { return false; },
  async dispatch() { throw new Error("Evolution paired-trial adapter is unavailable"); },
  async observe() { return { status: "pending" }; },
};
