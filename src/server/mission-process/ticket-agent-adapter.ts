import { createHash } from "node:crypto";
import type {
  GoalResolutionDecision,
  GoalResolutionProposal,
  GoalResolutionStatus,
} from "../../shared/contracts/agent-engine.js";
import type {
  ActiveMissionLink,
} from "../../shared/contracts/mission-control.js";
import type {
  PlannedTicketGraph,
  PlannedWorkflowCompletionPolicy,
  TicketCommandEnvelope,
  TicketCommandPayload,
  TicketCommandResult,
  TicketEvidenceRef,
} from "../../shared/contracts/ticket-engine.js";

export type MissionTicketOutcome = Record<string, unknown>;

export interface TicketGraphV2Outcome extends MissionTicketOutcome {
  result: unknown;
  graph: PlannedTicketGraph;
  completionPolicy: PlannedWorkflowCompletionPolicy;
}

export function validateMissionTicketOutcome(
  schemaRef: string | undefined,
  status: GoalResolutionStatus,
  value: unknown,
): { valid: true } | { valid: false; reason: string } {
  if (status !== "completed") return { valid: true };
  if (!isRecord(value)) return { valid: false, reason: `输出契约 ${schemaRef ?? "未定义"} 要求结构化领域结果` };
  const outcome = value;
  if (schemaRef === "ticket-graph-v2") {
    if (!("result" in outcome) || !isRecord(outcome.graph) || !isRecord(outcome.completionPolicy)) {
      return { valid: false, reason: "ticket-graph-v2 需要 result、graph 和 completionPolicy" };
    }
    const graphError = validatePlannedGraph(outcome.graph);
    if (graphError) return { valid: false, reason: graphError };
    const policyError = validateCompletionPolicyShape(outcome.completionPolicy);
    if (policyError) return { valid: false, reason: policyError };
  }
  return { valid: true };
}

export function missionOutcomeInstruction(schemaRef: string, availableCapabilities: readonly string[] = []): string {
  const base = "完成当前 Goal 时必须使用 goalResolution；domainOutcome 只提交输出契约要求的领域交付物，工单状态由平台根据 Goal 状态确定。";
  if (schemaRef === "ticket-graph-v2") {
    const capabilityRule = availableCapabilities.length
      ? `requiredCapabilities 只能从当前团队能力清单中选择：${availableCapabilities.join("、")}。`
      : "requiredCapabilities 必须使用当前团队真实拥有的能力。";
    return `${base} 输出契约 ticket-graph-v2：domainOutcome 必须直接包含 result、graph 和 completionPolicy。graph 必须包含 schemaVersion:2、nodes 数组和 dependencyEdges 数组；每个 node 必须包含 key、title、objective、successCriteria:string[]、assignment:{requiredCapabilities?:string[]}、outputContract:{schemaRef:string}；completionPolicy 必须包含 requiredTerminalKeys:string[]、failurePolicy:fail_fast|require_resolution、blockedPolicy:wait。${capabilityRule}节点按能力分配且必须无环。`;
  }
  return `${base} completed 时提交实际交付结果；blocked 时在 summary 中说明缺少的不可替代输入；failed 时在 summary 中说明有证据的失败原因。`;
}

export function proposalToTicketCommand(
  proposal: GoalResolutionProposal<GoalResolutionStatus, MissionTicketOutcome>,
  link: ActiveMissionLink,
  schemaRef: string | undefined,
  workflowVersion: number,
  issuedAt: string,
): TicketCommandEnvelope {
  const outcome = proposal.domainOutcome;
  const evidence: TicketEvidenceRef[] = proposal.evidence.map((item) => ({ kind: item.kind, ref: item.ref }));
  let payload: TicketCommandPayload;
  if (proposal.status === "completed" && schemaRef === "ticket-graph-v2") {
    const graphOutcome = outcome as TicketGraphV2Outcome;
    payload = {
    type: "complete_with_graph",
    result: graphOutcome.result,
    evidence,
    graph: graphOutcome.graph,
    completionPolicy: graphOutcome.completionPolicy,
    cancelTicketIds: [],
    expectedWorkflowVersion: workflowVersion,
    };
  } else if (proposal.status === "completed") payload = { type: "complete", result: outcome, evidence };
  else if (proposal.status === "blocked") payload = {
    type: "block",
    reason: proposal.summary,
    requiredInput: isRecord(outcome) && typeof outcome.requiredInput === "string" ? outcome.requiredInput : undefined,
  };
  else payload = { type: "fail", reason: proposal.summary, evidence };
  return {
    commandId: stableId("ticket_command", proposal.proposalId),
    proposalId: proposal.proposalId,
    workflowId: link.workflowId,
    ticketId: link.ticketId,
    expectedTicketVersion: link.ticketVersion,
    actorPrincipalId: link.agentPrincipalId,
    executionRef: link.agentGoalId,
    authority: link.authority,
    issuedAt,
    payload,
  };
}

export function ticketResultToGoalDecision<TStatus extends GoalResolutionStatus>(
  proposal: GoalResolutionProposal<TStatus>,
  result: TicketCommandResult,
): GoalResolutionDecision<TStatus> | undefined {
  if (result.accepted) return { accepted: true, committedState: proposal.status, domainResult: result };
  if (result.code === "version_conflict") return undefined;
  if (result.code === "stale_authority") return { accepted: false, disposition: "stale_claim", reason: result.reason };
  if (result.code === "workflow_terminal") return { accepted: false, disposition: "workflow_terminal", reason: result.reason };
  if (result.code === "policy_violation" || result.code === "idempotency_conflict") {
    return {
      accepted: false,
      disposition: "host_error",
      reason: result.reason,
      incidentId: stableId("mission_incident", `${result.commandId}:${result.code}`),
    };
  }
  return { accepted: false, disposition: "correctable", reason: result.reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validatePlannedGraph(value: Record<string, unknown>): string | undefined {
  if (value.schemaVersion !== 2 || !Array.isArray(value.nodes) || !Array.isArray(value.dependencyEdges)) {
    return "graph 必须包含 schemaVersion:2、nodes 数组和 dependencyEdges 数组";
  }
  for (const [index, node] of value.nodes.entries()) {
    if (!isRecord(node)) return `graph.nodes[${index}] 必须是对象`;
    if (![node.key, node.title, node.objective].every(isNonEmptyString)) {
      return `graph.nodes[${index}] 缺少 key、title 或 objective`;
    }
    if (!isStringArray(node.successCriteria) || !isRecord(node.assignment) || !isRecord(node.outputContract)
      || !isNonEmptyString(node.outputContract.schemaRef)) {
      return `graph.nodes[${index}] 的 successCriteria、assignment 或 outputContract 无效`;
    }
    if (node.assignment.requiredCapabilities !== undefined && !isStringArray(node.assignment.requiredCapabilities)) {
      return `graph.nodes[${index}].assignment.requiredCapabilities 必须是字符串数组`;
    }
    if (node.parentKey !== undefined && !isNonEmptyString(node.parentKey)) return `graph.nodes[${index}].parentKey 无效`;
    if (node.revisionOfKey !== undefined && !isNonEmptyString(node.revisionOfKey)) return `graph.nodes[${index}].revisionOfKey 无效`;
  }
  for (const [index, edge] of value.dependencyEdges.entries()) {
    if (!isRecord(edge) || !isNonEmptyString(edge.fromKey) || !isNonEmptyString(edge.toKey)) {
      return `graph.dependencyEdges[${index}] 必须包含 fromKey 和 toKey`;
    }
  }
  return undefined;
}

function validateCompletionPolicyShape(value: Record<string, unknown>): string | undefined {
  if (!isStringArray(value.requiredTerminalKeys)) return "completionPolicy.requiredTerminalKeys 必须是字符串数组";
  if (!new Set(["fail_fast", "require_resolution"]).has(String(value.failurePolicy))) {
    return "completionPolicy.failurePolicy 无效";
  }
  if (value.blockedPolicy !== "wait") return "completionPolicy.blockedPolicy 必须是 wait";
  return undefined;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim());
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

function stableId(prefix: string, value: string): string {
  return `${prefix}_${createHash("sha256").update(value).digest("base64url")}`;
}
