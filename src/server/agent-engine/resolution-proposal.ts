import { createHash } from "node:crypto";
import type { AgentGoal, GoalResolutionProposal } from "../../shared/contracts/agent-engine.js";

export function parseResolutionProposal(
  value: unknown,
  goal: AgentGoal,
  turnId: string,
  createdAt: string,
): { ok: true; value: GoalResolutionProposal } | { ok: false; reason: string } {
  if (!isRecord(value)) return { ok: false, reason: "顶层参数必须是对象" };
  if (!new Set(["completed", "blocked", "failed"]).has(String(value.status))) {
    return { ok: false, reason: "status 必须是 completed、blocked 或 failed" };
  }
  const summary = resolutionSummary(value);
  if (!summary) return { ok: false, reason: "summary 必须是非空字符串" };
  if (!Array.isArray(value.evidence)) return { ok: false, reason: "evidence 必须是数组" };
  for (const [index, item] of value.evidence.entries()) {
    if (!isEvidence(item)) return { ok: false, reason: `evidence[${index}] 必须是包含 kind 和 ref 字符串的对象` };
  }
  if (!Array.isArray(value.criterionResults)) return { ok: false, reason: "criterionResults 必须是数组" };

  const criterionResults: GoalResolutionProposal["criterionResults"] = [];
  const seen = new Set<number>();
  for (const [index, item] of value.criterionResults.entries()) {
    if (!isRecord(item)
      || !Number.isInteger(item.criterionIndex)
      || !new Set(["satisfied", "not_satisfied", "not_verified"]).has(String(item.status))
      || !Array.isArray(item.evidence)) {
      return { ok: false, reason: `criterionResults[${index}] 结构无效` };
    }
    const criterionIndex = item.criterionIndex as number;
    if (criterionIndex < 0 || criterionIndex >= goal.spec.successCriteria.length || seen.has(criterionIndex)) {
      return { ok: false, reason: `criterionResults[${index}].criterionIndex 无效或重复` };
    }
    seen.add(criterionIndex);
    if (item.evidence.some((entry) => !isEvidence(entry))) {
      return { ok: false, reason: `criterionResults[${index}].evidence 结构无效` };
    }
    criterionResults.push({
      criterionIndex,
      status: item.status as "satisfied" | "not_satisfied" | "not_verified",
      evidence: item.evidence.map((entry) => ({ kind: entry.kind as string, ref: entry.ref as string })),
      ...(typeof item.note === "string" ? { note: item.note } : {}),
    });
  }
  if (!Array.isArray(value.residualRisks) || value.residualRisks.some((item) => typeof item !== "string")) {
    return { ok: false, reason: "residualRisks 必须是字符串数组" };
  }
  if (value.status === "completed") {
    if (criterionResults.length !== goal.spec.successCriteria.length) {
      const missing = goal.spec.successCriteria
        .map((_criterion, criterionIndex) => criterionIndex)
        .filter((criterionIndex) => !seen.has(criterionIndex));
      return {
        ok: false,
        reason: `completed 必须逐项回应全部成功标准；当前缺少 criterionIndex: ${missing.join(", ")}`,
      };
    }
    if (criterionResults.some((item) => item.status !== "satisfied")) {
      return { ok: false, reason: "存在未满足或未验证的成功标准，不能提交 completed" };
    }
  }

  return {
    ok: true,
    value: {
      proposalId: stableId("proposal", goal.spec.id, turnId),
      turnId,
      goalId: goal.spec.id,
      expectedGoalVersion: goal.version,
      resolvingGoalVersion: goal.version + 1,
      status: value.status as "completed" | "blocked" | "failed",
      summary,
      evidence: value.evidence.map((item) => ({ kind: item.kind as string, ref: item.ref as string })),
      criterionResults,
      residualRisks: [...value.residualRisks] as string[],
      domainOutcome: value.domainOutcome,
      createdAt,
    },
  };
}

function resolutionSummary(value: Record<string, unknown>): string | undefined {
  const outcome = isRecord(value.domainOutcome) ? value.domainOutcome : undefined;
  const result = outcome && isRecord(outcome.result) ? outcome.result : undefined;
  return [value.summary, outcome?.summary, result?.summary, outcome?.reason]
    .find((candidate): candidate is string => typeof candidate === "string" && Boolean(candidate.trim()))
    ?.trim();
}

function isEvidence(value: unknown): value is Record<string, unknown> & { kind: string; ref: string } {
  return isRecord(value) && typeof value.kind === "string" && typeof value.ref === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash("sha256").update(JSON.stringify(parts)).digest("base64url")}`;
}
