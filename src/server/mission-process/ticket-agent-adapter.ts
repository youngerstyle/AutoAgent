import { createHash } from "node:crypto";
import type { GoalResolutionDecision, GoalResolutionProposal, GoalResolutionStatus } from "../../shared/contracts/agent-engine.js";
import type { ActiveMissionLink } from "../../shared/contracts/mission-control.js";
import type { PlanChangeSet, PlanCommandEnvelope, TicketCommandEnvelope, TicketCommandPayload, TicketCommandResult, TicketEvidenceRef } from "../../shared/contracts/ticket-engine.js";

export type MissionTicketOutcome = Record<string, unknown>;
export interface PlanChangeSetOutcome extends MissionTicketOutcome { result: unknown; change: PlanChangeSet }

export function validateMissionTicketOutcome(schemaRef: string | undefined, status: GoalResolutionStatus, value: unknown): { valid: true } | { valid: false; reason: string } {
  if (status !== "completed") return { valid: true };
  if (!isRecord(value)) return { valid: false, reason: `输出契约 ${schemaRef ?? "未定义"} 要求结构化领域结果` };
  if (schemaRef === "plan-change-set-v3") {
    if (!("result" in value) || !isRecord(value.change)) return { valid: false, reason: "plan-change-set-v3 需要 result 和 change" };
    const error = validateChangeSet(value.change);
    if (error) return { valid: false, reason: error };
  }
  return { valid: true };
}

export function missionOutcomeInstruction(schemaRef: string, availableCapabilities: readonly string[] = []): string {
  const base = "完成当前 Goal 时必须使用 goalResolution；domainOutcome 只提交输出契约要求的领域交付物，Ticket 和 Plan 状态由平台提交。";
  if (schemaRef === "plan-change-set-v3") {
    const capabilities = availableCapabilities.length ? availableCapabilities.join("、") : "当前团队真实拥有的能力";
    return `${base} 输出契约 plan-change-set-v3：domainOutcome 包含 result 和 change。change 包含 additions、dependencyAdditions、cancelTicketIds、requiredTerminalRefs；additions 的 clientRef 只在本次变更内有效，平台会生成真实 Ticket UUID；引用当前 Plan 已有 Ticket 时必须使用上下文提供的 ticketId。requiredCapabilities 只能使用：${capabilities}。变更后 DAG 必须无环并包含可验证终点。`;
  }
  return `${base} completed 时提交实际交付结果；blocked 时说明缺少的不可替代输入；failed 时说明有证据的失败原因。`;
}

export function proposalToPlanChangeCommand(proposal: GoalResolutionProposal<GoalResolutionStatus, MissionTicketOutcome>, link: ActiveMissionLink, planVersion: number, issuedAt: string): PlanCommandEnvelope | undefined {
  const outcome = proposal.domainOutcome;
  if (proposal.status !== "completed" || !outcome || !isRecord(outcome.change)) return undefined;
  return {
    commandId: stableId("plan_change", JSON.stringify([link.planId, link.ticketId, proposal.proposalId, planVersion])), planId: link.planId,
    actorPrincipalId: link.agentPrincipalId, issuedAt,
    payload: { type: "apply_change", expectedPlanVersion: planVersion, sourceTicketId: link.ticketId, sourceAuthority: link.authority, change: outcome.change as unknown as PlanChangeSet },
  };
}

export function proposalToTicketCommand(proposal: GoalResolutionProposal<GoalResolutionStatus, MissionTicketOutcome>, link: ActiveMissionLink, issuedAt: string): TicketCommandEnvelope {
  const evidence: TicketEvidenceRef[] = proposal.evidence.map((item) => ({ kind: item.kind, ref: item.ref }));
  let payload: TicketCommandPayload;
  if (proposal.status === "completed") payload = { type: "complete", result: proposal.domainOutcome, evidence };
  else if (proposal.status === "blocked") payload = { type: "block", reason: proposal.summary, requiredInput: isRecord(proposal.domainOutcome) && typeof proposal.domainOutcome.requiredInput === "string" ? proposal.domainOutcome.requiredInput : undefined };
  else payload = { type: "fail", reason: proposal.summary, evidence };
  return { commandId: stableId("ticket_command", JSON.stringify([link.planId, link.ticketId, proposal.proposalId, link.ticketVersion])), proposalId: proposal.proposalId, planId: link.planId, ticketId: link.ticketId, expectedTicketVersion: link.ticketVersion, actorPrincipalId: link.agentPrincipalId, executionRef: link.agentGoalId, authority: link.authority, issuedAt, payload };
}

export function ticketResultToGoalDecision<TStatus extends GoalResolutionStatus>(proposal: GoalResolutionProposal<TStatus>, result: TicketCommandResult): GoalResolutionDecision<TStatus> | undefined {
  if (result.accepted) return { accepted: true, committedState: proposal.status, domainResult: result };
  if (result.code === "version_conflict") return undefined;
  if (result.code === "stale_authority") return { accepted: false, disposition: "stale_claim", reason: result.reason };
  if (result.code === "plan_terminal") return { accepted: false, disposition: "plan_terminal", reason: result.reason };
  if (result.code === "policy_violation" || result.code === "idempotency_conflict") return { accepted: false, disposition: "host_error", reason: result.reason, incidentId: stableId("mission_incident", `${result.commandId}:${result.code}`) };
  return { accepted: false, disposition: "correctable", reason: result.reason };
}

function validateChangeSet(value: Record<string, unknown>): string | undefined {
  if (!Array.isArray(value.additions) || !Array.isArray(value.dependencyAdditions) || !Array.isArray(value.cancelTicketIds) || !Array.isArray(value.requiredTerminalRefs)) return "change 必须包含 additions、dependencyAdditions、cancelTicketIds、requiredTerminalRefs 数组";
  for (const [index, addition] of value.additions.entries()) {
    if (!isRecord(addition) || !isNonEmptyString(addition.clientRef) || !isNonEmptyString(addition.title) || !isNonEmptyString(addition.objective) || !isStringArray(addition.successCriteria) || !isRecord(addition.assignment) || !isRecord(addition.outputContract) || !isNonEmptyString(addition.outputContract.schemaRef)) return `change.additions[${index}] 无效`;
  }
  return undefined;
}
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function isNonEmptyString(value: unknown): value is string { return typeof value === "string" && Boolean(value.trim()); }
function isStringArray(value: unknown): value is string[] { return Array.isArray(value) && value.every(isNonEmptyString); }
function stableId(prefix: string, value: string): string { return `${prefix}_${createHash("sha256").update(value).digest("base64url")}`; }
