import { describe, expect, it } from "vitest";
import type { GoalResolutionProposal } from "../../src/shared/contracts/agent-engine.js";
import type { ActiveMissionLink } from "../../src/shared/contracts/mission-control.js";
import type { TicketCommandResult, TicketId, WorkflowId } from "../../src/shared/contracts/ticket-engine.js";
import {
  proposalToTicketCommand,
  ticketResultToGoalDecision,
  validateMissionTicketOutcome,
  type MissionTicketOutcome,
} from "../../src/server/mission-process/ticket-agent-adapter.js";

describe("Ticket Agent resolution adapter", () => {
  it.each([
    ["completed", { kind: "complete", result: { ok: true } }, "complete"],
    ["blocked", { kind: "block", reason: "need input" }, "block"],
    ["failed", { kind: "fail", reason: "broken" }, "fail"],
    ["completed", { kind: "return_to_parent", parentTicketId: "parent" as TicketId, reason: "missing prerequisite" }, "return_to_parent"],
  ] as const)("maps %s and %s without role or phase inference", (status, outcome, commandType) => {
    const command = proposalToTicketCommand(proposal(status, outcome), link, 4, NOW);
    expect(command.payload.type).toBe(commandType);
    expect(command.executionRef).toBe("goal-a");
  });

  it("rejects contradictory combinations", () => {
    expect(() => proposalToTicketCommand(
      proposal("completed", { kind: "fail", reason: "bad" }),
      link,
      4,
      NOW,
    )).toThrow("Contradictory");
  });

  it("rejects incomplete outcomes before they reach Ticket Engine", () => {
    expect(validateMissionTicketOutcome("boss-intake-v1", "failed", {})).toEqual({
      valid: false,
      reason: "domainOutcome.kind 缺失",
    });
    expect(validateMissionTicketOutcome("ticket-graph-v2", "completed", { kind: "complete", result: {} })).toEqual({
      valid: false,
      reason: "计划工单必须返回 complete_with_graph",
    });
  });

  it.each([
    [{ accepted: false, commandId: "c", proposalId: "p", code: "stale_authority", reason: "stale" }, "stale_claim"],
    [{ accepted: false, commandId: "c", proposalId: "p", code: "workflow_terminal", reason: "done" }, "workflow_terminal"],
    [{ accepted: false, commandId: "c", proposalId: "p", code: "version_conflict", reason: "retry" }, "correctable"],
  ] as Array<[TicketCommandResult, string]>)("maps Ticket rejection to a normative decision", (result, disposition) => {
    expect(ticketResultToGoalDecision(proposal("completed", { kind: "complete", result: {} }), result))
      .toMatchObject({ accepted: false, disposition });
  });
});

const NOW = "2026-07-10T00:00:00.000Z";

function proposal(status: "completed" | "blocked" | "failed", domainOutcome: MissionTicketOutcome): GoalResolutionProposal<any, MissionTicketOutcome> {
  return {
    proposalId: "proposal-a",
    goalId: "goal-a",
    expectedGoalVersion: 1,
    resolvingGoalVersion: 2,
    status,
    summary: "summary",
    evidence: [],
    domainOutcome,
    createdAt: NOW,
  };
}

const link: ActiveMissionLink = {
  dispatchId: "dispatch-a",
  missionId: "mission-a",
  workflowId: "workflow-a" as WorkflowId,
  ticketId: "ticket-a" as TicketId,
  ticketVersion: 2,
  agentId: "dev",
  agentPrincipalId: "principal-dev",
  claimRequestId: "claim-a",
  goalStartKey: "goal-start-a",
  updatedAt: NOW,
  status: "resolving",
  authority: { kind: "claim", claimId: "claim-a", fencingToken: 1 },
  agentThreadId: "thread-a",
  agentGoalId: "goal-a",
};
