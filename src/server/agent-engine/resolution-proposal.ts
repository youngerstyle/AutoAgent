import { createHash } from "node:crypto";
import type { AgentGoal, AgentHumanInputRequest, GoalResolutionProposal } from "../../shared/contracts/agent-engine.js";

export function parseResolutionProposal(
  value: unknown,
  goal: AgentGoal,
  turnId: string,
  createdAt: string,
): { ok: true; value: GoalResolutionProposal } | { ok: false; reason: string } {
  if (!isRecord(value)) return { ok: false, reason: "顶层参数必须是对象" };
  if (!new Set(["completed", "failed"]).has(String(value.status))) {
    return { ok: false, reason: "status 必须是 completed 或 failed；需要 human 输入时调用 request_human_input" };
  }
  const summary = resolutionSummary(value);
  if (!summary) return { ok: false, reason: "summary 必须是非空字符串" };
  if (value.evidence !== undefined && !Array.isArray(value.evidence)) {
    return { ok: false, reason: "evidence 必须是数组" };
  }
  const criterionEvidence = collectCriterionEvidence(value.criterionResults);
  const submittedEvidence = Array.isArray(value.evidence) ? value.evidence : criterionEvidence;
  if (goal.spec.outputContract?.evidenceMode === "none" && (submittedEvidence.length > 0 || criterionEvidence.length > 0)) {
    return {
      ok: false,
      reason: "当前输出契约不允许最终验收直接提交 evidence；请只在 domainOutcome.missionResolution.criterionResults 中选择 assuranceTicketIds，由平台装配验收事实",
    };
  }
  for (const [index, item] of submittedEvidence.entries()) {
    if (!isEvidence(item)) return { ok: false, reason: `evidence[${index}] 必须是包含 evidenceId 字符串的对象` };
  }
  if (!Array.isArray(value.criterionResults)) {
    return { ok: false, reason: "criterionResults 必须是数组" };
  }
  if (value.criterionResults !== undefined && !Array.isArray(value.criterionResults)) {
    return { ok: false, reason: "criterionResults 必须是数组" };
  }

  const criterionResults: GoalResolutionProposal["criterionResults"] = [];
  const seen = new Set<number>();
  for (const [index, item] of (Array.isArray(value.criterionResults) ? value.criterionResults : []).entries()) {
    if (!isRecord(item)
      || !Number.isInteger(item.criterionIndex)
      || !new Set(["satisfied", "not_satisfied", "not_verified"]).has(String(item.status))
      || !Array.isArray(item.evidence)) {
      return { ok: false, reason: `criterionResults[${index}] 结构无效` };
    }
    const criterionIndex = item.criterionIndex as number;
    if (criterionIndex < 0 || criterionIndex >= goal.spec.successCriteria.length || seen.has(criterionIndex)) {
      const expected = goal.spec.successCriteria.map((_criterion, expectedIndex) => expectedIndex);
      return {
        ok: false,
        reason: `criterionResults[${index}].criterionIndex 无效或重复；顶层 criterionResults 只对应当前 Goal 的成功标准，必须分别使用索引 ${expected.join(", ")} 且每个索引只出现一次；领域交付物内部的验收项请放入 domainOutcome`,
      };
    }
    seen.add(criterionIndex);
    if (item.evidence.some((entry) => !isEvidence(entry))) {
      return { ok: false, reason: `criterionResults[${index}].evidence 结构无效` };
    }
    criterionResults.push({
      criterionIndex,
      status: item.status as "satisfied" | "not_satisfied" | "not_verified",
      evidence: item.evidence.map((entry) => ({ evidenceId: entry.evidenceId as string })),
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
  }

  return {
    ok: true,
    value: {
      proposalId: stableId("proposal", goal.spec.id, String(goal.version), turnId),
      turnId,
      goalId: goal.spec.id,
      expectedGoalVersion: goal.version,
      resolvingGoalVersion: goal.version + 1,
      status: value.status as "completed" | "failed",
      summary,
      evidence: submittedEvidence.map((item) => ({ evidenceId: item.evidenceId as string })),
      criterionResults,
      residualRisks: [...value.residualRisks] as string[],
      domainOutcome: value.domainOutcome,
      createdAt,
    },
  };
}

function collectCriterionEvidence(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  const unique = new Map<string, unknown>();
  for (const criterion of value) {
    if (!isRecord(criterion) || !Array.isArray(criterion.evidence)) continue;
    for (const evidence of criterion.evidence) {
      if (!isEvidence(evidence)) continue;
      unique.set(evidence.evidenceId, evidence);
    }
  }
  return [...unique.values()];
}

export function createHumanInputProposal(
  goal: AgentGoal,
  turnId: string,
  request: AgentHumanInputRequest,
  createdAt: string,
): GoalResolutionProposal<"blocked"> {
  return {
    proposalId: stableId("proposal", goal.spec.id, String(goal.version), turnId),
    turnId,
    goalId: goal.spec.id,
    expectedGoalVersion: goal.version,
    resolvingGoalVersion: goal.version + 1,
    status: "blocked",
    summary: request.description,
    evidence: [],
    criterionResults: [],
    residualRisks: [],
    humanInputRequest: structuredClone(request),
    createdAt,
  };
}

function resolutionSummary(value: Record<string, unknown>): string | undefined {
  const outcome = isRecord(value.domainOutcome) ? value.domainOutcome : undefined;
  const result = outcome && isRecord(outcome.result) ? outcome.result : undefined;
  return [value.summary, outcome?.summary, result?.summary, outcome?.reason]
    .find((candidate): candidate is string => typeof candidate === "string" && Boolean(candidate.trim()))
    ?.trim();
}

function isEvidence(value: unknown): value is Record<string, unknown> & { evidenceId: string } {
  return isRecord(value) && typeof value.evidenceId === "string" && Boolean(value.evidenceId.trim());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash("sha256").update(JSON.stringify(parts)).digest("base64url")}`;
}
