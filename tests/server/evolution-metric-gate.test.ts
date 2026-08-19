import { describe, expect, it } from "vitest";
import { canaryGuardrailMetrics, isSupportedEvolutionMetric, scoreMetricExpectations, withMandatoryEvolutionMetrics } from "../../src/server/evolution/metric-gate.js";

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

  it("adds non-bypassable measured resource and latency gates to every candidate", () => {
    expect(withMandatoryEvolutionMetrics([{ metric: "task_success_rate", direction: "increase" }])).toEqual([
      { metric: "task_success_rate", direction: "increase" },
      { metric: "resource_cost", direction: "maintain", maximumRegression: 0.01 },
      { metric: "latency_ms", direction: "maintain", maximumRegression: 250 },
    ]);
  });

  it("uses lifecycle-scale budgets for workflow trials while retaining measured gates", () => {
    expect(withMandatoryEvolutionMetrics([{ metric: "task_success_rate", direction: "increase" }], "workflow")).toEqual([
      { metric: "task_success_rate", direction: "increase" },
      { metric: "resource_cost", direction: "maintain", maximumRegression: 1 },
      { metric: "latency_ms", direction: "maintain", maximumRegression: 600_000 },
    ]);
  });

  it("uses offline efficacy as an online Canary non-regression guardrail", () => {
    expect(canaryGuardrailMetrics([
      { metric: "quality_score", direction: "increase", minimumDelta: 0.1 },
    ], "workflow")).toEqual([
      { metric: "quality_score", direction: "maintain", maximumRegression: 0 },
      { metric: "resource_cost", direction: "maintain", maximumRegression: 1 },
      { metric: "latency_ms", direction: "maintain", maximumRegression: 600_000 },
    ]);
  });

  it("does not let a candidate weaken the platform resource ceiling", () => {
    expect(withMandatoryEvolutionMetrics([
      { metric: "resource_cost", direction: "maintain", maximumRegression: 100 },
      { metric: "latency_ms", direction: "decrease", minimumDelta: 0 },
    ], "workflow")).toEqual([
      { metric: "resource_cost", direction: "maintain", maximumRegression: 1 },
      { metric: "latency_ms", direction: "decrease", minimumDelta: 0 },
    ]);
  });

  it("publishes the exact measurable metric registry", () => {
    expect(isSupportedEvolutionMetric("evidence_completeness")).toBe(true);
    expect(isSupportedEvolutionMetric("documents announced to everyone")).toBe(false);
  });

  it("allows an improvement for a maintain ceiling and rejects only regression beyond the budget", () => {
    const observation = { success: true, qualityScore: 1, costUsd: 0, costMeasured: true, latencyMs: 1_000, toolFailures: 0, policyViolations: 0, safetyViolations: 0 };
    const expectation = [{ metric: "latency_ms", direction: "maintain" as const, maximumRegression: 250 }];
    expect(scoreMetricExpectations(expectation, [{ baseline: observation, candidate: { ...observation, latencyMs: 500 } }])[0]?.passed).toBe(true);
    expect(scoreMetricExpectations(expectation, [{ baseline: observation, candidate: { ...observation, latencyMs: 1_251 } }])[0]?.passed).toBe(false);
  });

  it("interprets maintain regression in the metric's good direction", () => {
    const observation = { success: true, qualityScore: 0.8, costUsd: 0, costMeasured: true, latencyMs: 1_000, toolFailures: 0, policyViolations: 0, safetyViolations: 0 };
    const expectation = [{ metric: "quality_score", direction: "maintain" as const, maximumRegression: 0.05 }];
    expect(scoreMetricExpectations(expectation, [{ baseline: observation, candidate: { ...observation, qualityScore: 0.9 } }])[0]?.passed).toBe(true);
    expect(scoreMetricExpectations(expectation, [{ baseline: observation, candidate: { ...observation, qualityScore: 0.74 } }])[0]?.passed).toBe(false);
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
