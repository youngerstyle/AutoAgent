import { describe, expect, it } from "vitest";
import type { GoalResolutionProposal } from "../../src/shared/contracts/agent-engine.js";
import type { ActiveMissionLink } from "../../src/shared/contracts/mission-control.js";
import type { TicketCommandResult, TicketId, WorkflowId } from "../../src/shared/contracts/ticket-engine.js";
import {
  missionOutcomeInstruction,
  proposalToTicketCommand,
  ticketResultToGoalDecision,
  validateMissionTicketOutcome,
  type MissionTicketOutcome,
} from "../../src/server/mission-process/ticket-agent-adapter.js";

describe("Ticket Agent resolution adapter", () => {
  it("translates a pure ticket-graph-v2 domain outcome into the internal Ticket command", () => {
    const domainOutcome = {
      result: { plan: "implementation then verification" },
      graph: {
        schemaVersion: 2 as const,
        nodes: [],
        dependencyEdges: [],
      },
      completionPolicy: {
        requiredTerminalKeys: [],
        failurePolicy: "require_resolution" as const,
        blockedPolicy: "wait" as const,
      },
    };

    const command = proposalToTicketCommand(
      proposal("completed", domainOutcome as never),
      link,
      "ticket-graph-v2",
      4,
      NOW,
    );

    expect(command.payload).toMatchObject({
      type: "complete_with_graph",
      result: domainOutcome.result,
      graph: domainOutcome.graph,
      completionPolicy: domainOutcome.completionPolicy,
    });
  });

  it("describes only the Agent domain output and never exposes Ticket command names", () => {
    const instruction = missionOutcomeInstruction("ticket-graph-v2", ["implementation", "quality:verify"]);

    expect(instruction).toContain("ticket-graph-v2");
    expect(instruction).not.toContain("complete_with_graph");
    expect(instruction).not.toContain("return_to_parent");
    expect(instruction).not.toContain("cancelTicketIds");
  });

  it.each([
    ["completed", { ok: true }, "complete"],
    ["blocked", { requiredInput: "credential" }, "block"],
    ["failed", { diagnostic: "broken" }, "fail"],
  ] as const)("maps %s and %s without role or phase inference", (status, outcome, commandType) => {
    const command = proposalToTicketCommand(proposal(status, outcome), link, "delivery-v1", 4, NOW);
    expect(command.payload.type).toBe(commandType);
    expect(command.executionRef).toBe("goal-a");
  });

  it("rejects incomplete outcomes before they reach Ticket Engine", () => {
    expect(validateMissionTicketOutcome("boss-intake-v1", "failed", {})).toEqual({ valid: true });
    expect(validateMissionTicketOutcome("ticket-graph-v2", "completed", { result: {} })).toEqual({
      valid: false,
      reason: "ticket-graph-v2 需要 result、graph 和 completionPolicy",
    });
    expect(validateMissionTicketOutcome("ticket-graph-v2", "completed", {
      result: {},
      graph: { schemaVersion: 2, nodes: [], dependencyEdges: [] },
      completionPolicy: { failurePolicy: "require_resolution", blockedPolicy: "wait" },
    })).toEqual({
      valid: false,
      reason: "completionPolicy.requiredTerminalKeys 必须是字符串数组",
    });
  });

  it.each([
    [{ accepted: false, commandId: "c", proposalId: "p", code: "stale_authority", reason: "stale" }, "stale_claim"],
    [{ accepted: false, commandId: "c", proposalId: "p", code: "workflow_terminal", reason: "done" }, "workflow_terminal"],
    [{ accepted: false, commandId: "c", proposalId: "p", code: "version_conflict", reason: "retry" }, "correctable"],
  ] as Array<[TicketCommandResult, string]>)("maps Ticket rejection to a normative decision", (result, disposition) => {
    expect(ticketResultToGoalDecision(proposal("completed", { ok: true }), result))
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
