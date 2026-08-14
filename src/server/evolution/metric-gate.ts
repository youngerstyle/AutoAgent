import type { EvaluationObservation, MetricExpectation, MetricResult } from "../../shared/contracts/evolution.js";

export interface ObservationPair { baseline: EvaluationObservation; candidate: EvaluationObservation; partition?: "historical" | "sealed_holdout" }

const MANDATORY_EXPECTATIONS: MetricExpectation[] = [
  { metric: "cost_usd", direction: "maintain", maximumRegression: 0.01 },
  { metric: "latency_ms", direction: "maintain", maximumRegression: 250 },
];

export function withMandatoryEvolutionMetrics(expectations: MetricExpectation[]): MetricExpectation[] {
  const declared = new Set(expectations.map((item) => item.metric));
  return [...expectations, ...MANDATORY_EXPECTATIONS.filter((item) => !declared.has(item.metric))];
}

export function scoreMetricExpectations(expectations: MetricExpectation[], pairs: ObservationPair[]): MetricResult[] {
  if (!pairs.length) return expectations.map((item) => ({ metric: item.metric, baseline: 0, candidate: 0, delta: 0, passed: false }));
  const metrics = new Map<string, { baseline: number; candidate: number } | undefined>([
    ["task_success_rate", averages(pairs, (item) => item.success ? 1 : 0)],
    ["quality_score", averages(pairs, (item) => item.qualityScore)],
    ["cost_usd", pairs.every((pair) => pair.baseline.costMeasured === true && pair.candidate.costMeasured === true)
      ? averages(pairs, (item) => item.costUsd)
      : undefined],
    ["token_count", pairs.every((pair) => Number.isFinite(pair.baseline.totalTokens) && Number.isFinite(pair.candidate.totalTokens))
      ? averages(pairs, (item) => item.totalTokens!)
      : undefined],
    ["latency_ms", averages(pairs, (item) => item.latencyMs)],
    ["tool_failure_rate", averages(pairs, (item) => item.toolFailures)],
    ["qa_return_rate", measuredAverage(pairs, (item) => item.qaReturns)],
    ["repeated_tool_call_rate", measuredAverage(pairs, (item) => item.repeatedToolCalls)],
    ["human_intervention_count", measuredAverage(pairs, (item) => item.humanInterventions)],
    ["evidence_completeness", measuredAverage(pairs, (item) => item.evidenceCompleteness)],
    ["generalized_success_rate", generalizedSuccess(pairs)],
    ["policy_violation_rate", averages(pairs, (item) => item.policyViolations)],
    ["safety_violation_rate", averages(pairs, (item) => item.safetyViolations)],
  ]);
  return expectations.map((expectation) => metricResult(expectation, metrics.get(expectation.metric)));
}

function measuredAverage(pairs: ObservationPair[], select: (value: EvaluationObservation) => number | undefined) {
  return pairs.every((pair) => Number.isFinite(select(pair.baseline)) && Number.isFinite(select(pair.candidate)))
    ? averages(pairs, (item) => select(item)!)
    : undefined;
}

function generalizedSuccess(pairs: ObservationPair[]) {
  const holdout = pairs.filter((pair) => pair.partition === "sealed_holdout");
  return holdout.length ? averages(holdout, (item) => item.success ? 1 : 0) : undefined;
}

function metricResult(expectation: MetricExpectation, observed?: { baseline: number; candidate: number }): MetricResult {
  if (!observed) return { metric: expectation.metric, baseline: 0, candidate: 0, delta: 0, passed: false, measured: false };
  const delta = observed.candidate - observed.baseline;
  const passed = expectation.direction === "increase"
    ? delta >= (expectation.minimumDelta ?? 0)
    : expectation.direction === "decrease"
      ? -delta >= (expectation.minimumDelta ?? 0)
      : Math.abs(delta) <= (expectation.maximumRegression ?? 0);
  return { metric: expectation.metric, ...observed, delta, passed };
}

function averages(pairs: ObservationPair[], select: (value: EvaluationObservation) => number) {
  return {
    baseline: pairs.reduce((sum, item) => sum + select(item.baseline), 0) / pairs.length,
    candidate: pairs.reduce((sum, item) => sum + select(item.candidate), 0) / pairs.length,
  };
}
