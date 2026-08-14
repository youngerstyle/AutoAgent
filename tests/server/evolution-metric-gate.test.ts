import { describe, expect, it } from "vitest";
import { scoreMetricExpectations, withMandatoryEvolutionMetrics } from "../../src/server/evolution/metric-gate.js";

describe("evolution metric gate", () => {
  it("fails closed instead of treating an unmeasured runtime cost as zero", () => {
    const observation = {
      success: true, qualityScore: 1, costUsd: 0, costMeasured: false,
      latencyMs: 100, toolFailures: 0, policyViolations: 0, safetyViolations: 0,
    };
    expect(scoreMetricExpectations(
      [{ metric: "cost_usd", direction: "maintain", maximumRegression: 0 }],
      [{ baseline: observation, candidate: observation }],
    )).toEqual([{ metric: "cost_usd", baseline: 0, candidate: 0, delta: 0, passed: false, measured: false }]);
  });

  it("scores token usage only when both cohorts have measured totals", () => {
    const base = { success: true, qualityScore: 1, costUsd: 0, costMeasured: true, latencyMs: 100, toolFailures: 0, policyViolations: 0, safetyViolations: 0 };
    expect(scoreMetricExpectations(
      [{ metric: "token_count", direction: "decrease", minimumDelta: 10 }],
      [{ baseline: { ...base, totalTokens: 100 }, candidate: { ...base, totalTokens: 80 } }],
    )).toEqual([{ metric: "token_count", baseline: 100, candidate: 80, delta: -20, passed: true }]);
  });

  it("adds non-bypassable cost and latency gates to every candidate", () => {
    expect(withMandatoryEvolutionMetrics([{ metric: "task_success_rate", direction: "increase" }])).toEqual([
      { metric: "task_success_rate", direction: "increase" },
      { metric: "cost_usd", direction: "maintain", maximumRegression: 0.01 },
      { metric: "latency_ms", direction: "maintain", maximumRegression: 250 },
    ]);
  });

  it("supports QA, human intervention, evidence completeness, and sealed-holdout generalization metrics", () => {
    const baseline = { success: false, qualityScore: 0, costUsd: 1, costMeasured: true, latencyMs: 100, toolFailures: 0, policyViolations: 0, safetyViolations: 0, qaReturns: 1, humanInterventions: 2, evidenceCompleteness: 0.5 };
    const candidate = { ...baseline, success: true, qaReturns: 0, humanInterventions: 0, evidenceCompleteness: 1 };
    const results = scoreMetricExpectations([
      { metric: "qa_return_rate", direction: "decrease", minimumDelta: 1 },
      { metric: "human_intervention_count", direction: "decrease", minimumDelta: 2 },
      { metric: "evidence_completeness", direction: "increase", minimumDelta: 0.5 },
      { metric: "generalized_success_rate", direction: "increase", minimumDelta: 1 },
    ], [{ baseline, candidate, partition: "sealed_holdout" }]);
    expect(results.every((result) => result.passed)).toBe(true);
  });
});
