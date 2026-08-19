import type { EvaluationObservation, EvolutionArtifactKind, MetricExpectation, MetricResult } from "../../shared/contracts/evolution.js";

export interface ObservationPair { baseline: EvaluationObservation; candidate: EvaluationObservation; partition?: "historical" | "sealed_holdout" }

export const EVOLUTION_METRIC_NAMES = [
  "task_success_rate", "quality_score", "cost_usd", "resource_cost", "token_count", "latency_ms",
  "tool_failure_rate", "qa_return_rate", "repeated_tool_call_rate", "human_intervention_count",
  "evidence_completeness", "generalized_success_rate", "policy_violation_rate", "safety_violation_rate",
] as const;

const EVOLUTION_METRIC_NAME_SET = new Set<string>(EVOLUTION_METRIC_NAMES);
const LOWER_IS_BETTER_METRICS = new Set(["cost_usd", "resource_cost", "token_count", "latency_ms", "tool_failure_rate", "qa_return_rate", "repeated_tool_call_rate", "human_intervention_count", "policy_violation_rate", "safety_violation_rate"]);

const MANDATORY_EXPECTATIONS: MetricExpectation[] = [
  { metric: "resource_cost", direction: "maintain", maximumRegression: 0.01 },
  { metric: "latency_ms", direction: "maintain", maximumRegression: 250 },
];

const ARTIFACT_BUDGETS: Partial<Record<EvolutionArtifactKind, MetricExpectation[]>> = {
  memory: [{ metric: "resource_cost", direction: "maintain", maximumRegression: 0.05 }, { metric: "latency_ms", direction: "maintain", maximumRegression: 30_000 }],
  prompt: [{ metric: "resource_cost", direction: "maintain", maximumRegression: 0.05 }, { metric: "latency_ms", direction: "maintain", maximumRegression: 30_000 }],
  skill: [{ metric: "resource_cost", direction: "maintain", maximumRegression: 0.2 }, { metric: "latency_ms", direction: "maintain", maximumRegression: 120_000 }],
  plugin: [{ metric: "resource_cost", direction: "maintain", maximumRegression: 0.2 }, { metric: "latency_ms", direction: "maintain", maximumRegression: 120_000 }],
  agent_profile: [{ metric: "resource_cost", direction: "maintain", maximumRegression: 0.2 }, { metric: "latency_ms", direction: "maintain", maximumRegression: 120_000 }],
  runtime_config: [{ metric: "resource_cost", direction: "maintain", maximumRegression: 0.2 }, { metric: "latency_ms", direction: "maintain", maximumRegression: 120_000 }],
  workflow: [{ metric: "resource_cost", direction: "maintain", maximumRegression: 1 }, { metric: "latency_ms", direction: "maintain", maximumRegression: 600_000 }],
  harness: [{ metric: "resource_cost", direction: "maintain", maximumRegression: 1 }, { metric: "latency_ms", direction: "maintain", maximumRegression: 600_000 }],
};

export function isSupportedEvolutionMetric(metric: string): boolean { return EVOLUTION_METRIC_NAME_SET.has(metric); }
export function isSafeEvolutionMetricDirection(expectation: MetricExpectation): boolean {
  return !LOWER_IS_BETTER_METRICS.has(expectation.metric) || expectation.direction !== "increase";
}

export function withMandatoryEvolutionMetrics(expectations: MetricExpectation[], kind?: EvolutionArtifactKind): MetricExpectation[] {
  const policy = kind ? ARTIFACT_BUDGETS[kind] ?? MANDATORY_EXPECTATIONS : MANDATORY_EXPECTATIONS;
  const result = expectations.map((item) => ({ ...item }));
  for (const ceiling of policy) {
    const index = result.findIndex((item) => item.metric === ceiling.metric);
    if (index < 0) { result.push({ ...ceiling }); continue; }
    const declared = result[index]!;
    if (declared.direction === "maintain") result[index] = {
      ...declared,
      maximumRegression: Math.min(declared.maximumRegression ?? 0, ceiling.maximumRegression ?? 0),
    };
  }
  return result;
}

/**
 * Offline paired trials establish efficacy. A bounded online Canary then
 * validates safety and non-regression on later traffic; requiring the small
 * Canary cohort to reproduce the offline minimum effect would conflate those
 * two gates and reject an equal-quality safe rollout.
 */
export function canaryGuardrailMetrics(expectations: MetricExpectation[], kind?: EvolutionArtifactKind): MetricExpectation[] {
  return withMandatoryEvolutionMetrics(expectations, kind).map((expectation) => expectation.direction === "maintain"
    ? expectation
    : { metric: expectation.metric, direction: "maintain", maximumRegression: 0 });
}

export function scoreMetricExpectations(expectations: MetricExpectation[], pairs: ObservationPair[]): MetricResult[] {
  if (!pairs.length) return expectations.map((item) => ({ metric: item.metric, baseline: 0, candidate: 0, delta: 0, passed: false }));
  const metrics = new Map<string, { baseline: number; candidate: number } | undefined>([
    ["task_success_rate", averages(pairs, (item) => item.success ? 1 : 0)],
    ["quality_score", averages(pairs, (item) => item.qualityScore)],
    ["cost_usd", pairs.every((pair) => pair.baseline.costMeasured === true && pair.candidate.costMeasured === true)
      ? averages(pairs, (item) => item.costUsd)
      : undefined],
    ["resource_cost", resourceCost(pairs)],
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

function resourceCost(pairs: ObservationPair[]) {
  if (pairs.every((pair) => pair.baseline.costMeasured === true && pair.candidate.costMeasured === true)) return averages(pairs, (item) => item.costUsd);
  if (pairs.every((pair) => Number.isFinite(pair.baseline.totalTokens) && Number.isFinite(pair.candidate.totalTokens))) return averages(pairs, (item) => item.totalTokens! / 100_000);
  return undefined;
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
      : LOWER_IS_BETTER_METRICS.has(expectation.metric)
        ? delta <= (expectation.maximumRegression ?? 0)
        : -delta <= (expectation.maximumRegression ?? 0);
  return { metric: expectation.metric, ...observed, delta, passed };
}

function averages(pairs: ObservationPair[], select: (value: EvaluationObservation) => number) {
  return {
    baseline: pairs.reduce((sum, item) => sum + select(item.baseline), 0) / pairs.length,
    candidate: pairs.reduce((sum, item) => sum + select(item.candidate), 0) / pairs.length,
  };
}
