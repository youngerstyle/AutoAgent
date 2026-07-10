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

function stableId(prefix: string, value: string): string {
  return `${prefix}_${createHash("sha256").update(value).digest("base64url")}`;
}
