import type { EvolutionPrincipalRef } from "../../shared/contracts/evolution.js";
import type { EvolutionEvaluationStore } from "./evaluation-store.js";
import type { EvolutionPairedTrialStore } from "./paired-trial-store.js";
import type { EvolutionTrialPort } from "./trial-port.js";

export class EvolutionPairedTrialRunner {
  constructor(
    private readonly workspaceId: string,
    private readonly trials: EvolutionPairedTrialStore,
    private readonly evaluations: EvolutionEvaluationStore,
    private readonly port: EvolutionTrialPort,
    private readonly evaluatorPrincipal: EvolutionPrincipalRef = { type: "system", id: "evolution-paired-trial-runner/v1" },
  ) {}

  async run(limit = 4): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Paired trial drain limit is invalid");
    if (!await this.port.available(this.workspaceId)) return 0;
    let processed = 0;
    for (const trial of (await this.trials.list()).filter((item) => item.status === "dispatched").slice(0, limit)) {
      const observed = await this.port.observe({ workspaceId: this.workspaceId, trialId: trial.trialId, dispatchRef: trial.dispatchRef! });
      if (observed.status === "pending" || observed.status === "running") continue;
      if (observed.status === "succeeded") {
        await this.evaluations.recordEvaluation({
          commandId: `paired-trial-evaluation:${trial.trialId}`, candidateId: trial.request.candidateId,
          expectedContentHash: trial.request.expectedContentHash, suiteRef: trial.request.suiteRef,
          baselineRef: trial.request.baselineRef, runtimeSnapshotRef: trial.request.runtimeSnapshotRef,
          caseResults: observed.caseResults, evaluatorPrincipal: this.evaluatorPrincipal,
          grader: { id: "evolution-deterministic-gate", version: "3", type: "deterministic" },
        });
        await this.trials.succeed(trial.trialId, observed.caseResults);
      } else if (observed.status === "failed" || observed.status === "inconclusive") {
        await this.trials.fail(trial.trialId, { status: observed.status, category: observed.category, message: observed.message });
      }
      processed += 1;
      if (processed >= limit) return processed;
    }
    for (const trial of (await this.trials.listDispatchable()).slice(0, limit - processed)) {
      try {
        const dispatched = await this.port.dispatch({ workspaceId: this.workspaceId, trialId: trial.trialId, request: trial.request });
        await this.trials.markDispatched(trial.trialId, dispatched.dispatchRef);
      } catch (error) {
        await this.trials.fail(trial.trialId, { status: "failed", category: "transient", message: error instanceof Error ? error.message : String(error), countAttempt: true });
      }
      processed += 1;
    }
    return processed;
  }
}
