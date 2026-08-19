import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { EvaluationCaseResult } from "../../src/shared/contracts/evolution.js";
import type { EvolutionEvaluationStore } from "../../src/server/evolution/evaluation-store.js";
import { EvolutionPairedTrialRunner } from "../../src/server/evolution/paired-trial-runner.js";
import { EvolutionPairedTrialStore } from "../../src/server/evolution/paired-trial-store.js";
import type { EvolutionTrialPort } from "../../src/server/evolution/trial-port.js";
import { fixtureRequest } from "./evolution-paired-trial-store.test.js";

describe("Evolution paired trial runner", () => {
  it("dispatches through the port and records a later real result as an independent EvaluationRun", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-paired-runner-"));
    const trials = new EvolutionPairedTrialStore("workspace-a", root, () => new Date("2026-08-19T03:00:00.000Z"));
    const trial = await trials.enqueue("paired-runner", fixtureRequest("workspace-a"));
    const results = fixtureResults("workspace-a");
    let dispatched = false;
    const port: EvolutionTrialPort = {
      async available() { return true; },
      async dispatch() { dispatched = true; return { dispatchRef: "mission-pair-a" }; },
      async observe() { return { status: "succeeded", caseResults: results }; },
    };
    const recordEvaluation = vi.fn(async () => ({ evaluationId: "evaluation-a", decision: "pass" }));
    const evaluations = { recordEvaluation } as unknown as EvolutionEvaluationStore;
    const runner = new EvolutionPairedTrialRunner("workspace-a", trials, evaluations, port);

    expect(await runner.run()).toBe(1);
    expect(dispatched).toBe(true);
    expect(await trials.get(trial.trialId)).toMatchObject({ status: "dispatched", attempts: 1, dispatchRef: "mission-pair-a" });

    expect(await runner.run()).toBe(1);
    expect(recordEvaluation).toHaveBeenCalledWith(expect.objectContaining({ commandId: `paired-trial-evaluation:${trial.trialId}`, caseResults: results }));
    expect(await trials.get(trial.trialId)).toMatchObject({ status: "succeeded", caseResults: results });
  });

  it("keeps a transient dispatch failure retryable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-paired-retry-"));
    const trials = new EvolutionPairedTrialStore("workspace-a", root, () => new Date("2026-08-19T03:00:00.000Z"));
    const trial = await trials.enqueue("paired-retry", fixtureRequest("workspace-a"));
    const port: EvolutionTrialPort = {
      async available() { return true; },
      async dispatch() { throw new Error("Provider temporarily unavailable"); },
      async observe() { return { status: "pending" }; },
    };
    const runner = new EvolutionPairedTrialRunner("workspace-a", trials, {} as EvolutionEvaluationStore, port);
    expect(await runner.run()).toBe(1);
    expect(await trials.get(trial.trialId)).toMatchObject({ status: "retry_wait", lastError: { category: "transient" } });
  });
});

function fixtureResults(workspaceId: string): EvaluationCaseResult[] {
  const observation = { success: true, qualityScore: 1, costUsd: 0, costMeasured: false, latencyMs: 10, toolFailures: 0, policyViolations: 0, safetyViolations: 0 };
  return (["target", "regression", "safety"] as const).map((group) => ({
    caseId: group, group, partition: group === "target" ? "historical" : "sealed_holdout",
    baseline: { ...observation, success: false, qualityScore: 0 }, candidate: observation,
    evidenceRefs: [{ kind: "evidence" as const, ref: `evidence-${group}`, workspaceId }],
  }));
}
