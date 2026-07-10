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
  TicketId,
} from "../../shared/contracts/ticket-engine.js";

export type MissionTicketOutcome =
  | { kind: "complete"; result: unknown }
  | {
      kind: "complete_with_graph";
      result: unknown;
      graph: PlannedTicketGraph;
      completionPolicy: PlannedWorkflowCompletionPolicy;
      cancelTicketIds?: TicketId[];
    }
  | { kind: "block"; reason: string; requiredInput?: string }
  | { kind: "fail"; reason: string }
  | { kind: "return_to_parent"; parentTicketId: TicketId; reason: string };

export function validateMissionTicketOutcome(
  schemaRef: string | undefined,
  status: GoalResolutionStatus,
  value: unknown,
): { valid: true } | { valid: false; reason: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { valid: false, reason: "domainOutcome 必须是结构化 Ticket 结果" };
  }
  const outcome = value as Record<string, unknown>;
  const kind = outcome.kind;
  if (typeof kind !== "string") return { valid: false, reason: "domainOutcome.kind 缺失" };
  if (schemaRef === "ticket-graph-v2" && kind !== "complete_with_graph") {
    return { valid: false, reason: "计划工单必须返回 complete_with_graph" };
  }
  if (status === "completed" && !new Set(["complete", "complete_with_graph", "return_to_parent"]).has(kind)) {
    return { valid: false, reason: `completed 与 Ticket 结果 ${kind} 不一致` };
  }
  if (status === "blocked" && kind !== "block") return { valid: false, reason: "blocked 必须返回 block" };
  if (status === "failed" && kind !== "fail") return { valid: false, reason: "failed 必须返回 fail" };
  if (kind === "complete" && !("result" in outcome)) return { valid: false, reason: "complete.result 缺失" };
  if (kind === "complete_with_graph") {
    if (!("result" in outcome) || !isRecord(outcome.graph) || !isRecord(outcome.completionPolicy)) {
      return { valid: false, reason: "complete_with_graph 需要 result、graph 和 completionPolicy" };
    }
    const graphError = validatePlannedGraph(outcome.graph);
    if (graphError) return { valid: false, reason: graphError };
    const policyError = validateCompletionPolicyShape(outcome.completionPolicy);
    if (policyError) return { valid: false, reason: policyError };
    if (outcome.cancelTicketIds !== undefined && !isStringArray(outcome.cancelTicketIds)) {
      return { valid: false, reason: "cancelTicketIds 必须是字符串数组" };
    }
  } else if (kind === "block" || kind === "fail") {
    if (typeof outcome.reason !== "string" || !outcome.reason.trim()) return { valid: false, reason: `${kind}.reason 缺失` };
  } else if (kind === "return_to_parent") {
    if (typeof outcome.parentTicketId !== "string" || typeof outcome.reason !== "string" || !outcome.reason.trim()) {
      return { valid: false, reason: "return_to_parent 需要 parentTicketId 和 reason" };
    }
  } else if (!new Set(["complete", "complete_with_graph"]).has(kind)) {
    return { valid: false, reason: `未知 Ticket 结果：${kind}` };
  }
  return { valid: true };
}

export function missionOutcomeInstruction(schemaRef: string, availableCapabilities: readonly string[] = []): string {
  const base = "完成当前 Goal 时必须使用 goalResolution；domainOutcome 必须显式描述 Ticket 结果，平台不会从普通文字猜测。";
  if (schemaRef === "ticket-graph-v2") {
    const capabilityRule = availableCapabilities.length
      ? `requiredCapabilities 只能从当前团队能力清单中选择：${availableCapabilities.join("、")}。`
      : "requiredCapabilities 必须使用当前团队真实拥有的能力。";
    return `${base} 本工单必须提交 domainOutcome.kind=complete_with_graph。graph 必须包含 schemaVersion:2、nodes 数组和 dependencyEdges 数组；每个 node 必须包含 key、title、objective、successCriteria:string[]、assignment:{requiredCapabilities?:string[]}、outputContract:{schemaRef:string}；completionPolicy 必须包含 requiredTerminalKeys:string[]、failurePolicy:fail_fast|require_resolution、blockedPolicy:wait。${capabilityRule}节点按能力分配且必须无环。`;
  }
  return `${base} 正常交付使用 kind=complete 和 result；缺少外部输入使用 kind=block、reason、requiredInput；执行本身失败使用 kind=fail；发现上游前置缺失且存在 parentTicketId 时使用 kind=return_to_parent。`;
}

export function proposalToTicketCommand(
  proposal: GoalResolutionProposal<GoalResolutionStatus, MissionTicketOutcome>,
  link: ActiveMissionLink,
  workflowVersion: number,
  issuedAt: string,
): TicketCommandEnvelope {
  const outcome = proposal.domainOutcome;
  if (!outcome) throw new Error("Mission proposal requires domainOutcome");
  validateStatus(proposal.status, outcome.kind);
  const evidence: TicketEvidenceRef[] = proposal.evidence.map((item) => ({ kind: item.kind, ref: item.ref }));
  let payload: TicketCommandPayload;
  if (outcome.kind === "complete") payload = { type: "complete", result: outcome.result, evidence };
  else if (outcome.kind === "complete_with_graph") payload = {
    type: "complete_with_graph",
    result: outcome.result,
    evidence,
    graph: outcome.graph,
    completionPolicy: outcome.completionPolicy,
    cancelTicketIds: outcome.cancelTicketIds ?? [],
    expectedWorkflowVersion: workflowVersion,
  };
  else if (outcome.kind === "block") payload = { type: "block", reason: outcome.reason, requiredInput: outcome.requiredInput };
  else if (outcome.kind === "fail") payload = { type: "fail", reason: outcome.reason, evidence };
  else payload = {
    type: "return_to_parent",
    parentTicketId: outcome.parentTicketId,
    reason: outcome.reason,
    evidence,
    expectedWorkflowVersion: workflowVersion,
  };
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
): GoalResolutionDecision<TStatus> {
  if (result.accepted) return { accepted: true, committedState: proposal.status, domainResult: result };
  if (result.code === "stale_authority") return { accepted: false, disposition: "stale_claim", reason: result.reason };
  if (result.code === "workflow_terminal") return { accepted: false, disposition: "workflow_terminal", reason: result.reason };
  return { accepted: false, disposition: "correctable", reason: result.reason };
}

function validateStatus(status: GoalResolutionStatus, kind: MissionTicketOutcome["kind"]): void {
  const valid = status === "completed"
    ? new Set(["complete", "complete_with_graph", "return_to_parent"]).has(kind)
    : status === "blocked"
      ? kind === "block"
      : kind === "fail";
  if (!valid) throw new Error(`Contradictory Goal status ${status} and Ticket outcome ${kind}`);
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
