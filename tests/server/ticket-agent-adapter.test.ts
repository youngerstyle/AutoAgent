import { describe, expect, it } from "vitest";
import type { GoalResolutionProposal } from "../../src/shared/contracts/agent-engine.js";
import type { ActiveMissionLink } from "../../src/shared/contracts/mission-control.js";
import type { PlanId, TicketCommandResult, TicketId } from "../../src/shared/contracts/ticket-engine.js";
import { missionOutcomeInstruction, proposalToPlanChangeCommand, proposalToTicketCommand, ticketResultToGoalDecision, validateMissionTicketOutcome, type MissionTicketOutcome } from "../../src/server/mission-process/ticket-agent-adapter.js";

describe("Ticket Agent resolution adapter", () => {
  it("keeps PM domain output separate from Plan and Ticket commands", () => {
    const outcome = { result: { plan: "dev then qa" }, change: { additions: [draft("dev")], dependencyAdditions: [], cancelTicketIds: [], requiredTerminalRefs: [{ clientRef: "dev" }] } };
    const planCommand = proposalToPlanChangeCommand(proposal("completed", outcome), link, 4, NOW);
    const ticketCommand = proposalToTicketCommand(proposal("completed", outcome), link, NOW);
    expect(planCommand?.payload).toMatchObject({ type: "apply_change", change: outcome.change });
    expect(ticketCommand.payload.type).toBe("complete");
  });

  it("uses the aggregate version in command identity so an optimistic conflict can be retried", () => {
    const outcome = { result: {}, change: { additions: [draft("dev")], dependencyAdditions: [], cancelTicketIds: [], requiredTerminalRefs: [{ clientRef: "dev" }] } };
    const proposalValue = proposal("completed", outcome);
    expect(proposalToPlanChangeCommand(proposalValue, link, 4, NOW)?.commandId)
      .not.toBe(proposalToPlanChangeCommand(proposalValue, link, 5, NOW)?.commandId);
    expect(proposalToTicketCommand(proposalValue, link, NOW).commandId)
      .not.toBe(proposalToTicketCommand(proposalValue, { ...link, ticketVersion: link.ticketVersion + 1 }, NOW).commandId);
  });

  it("never exposes internal command names to the Agent", () => {
    const instruction = missionOutcomeInstruction("plan-change-set-v3", ["implementation", "quality:verify"]);
    expect(instruction).toContain("plan-change-set-v3");
    expect(instruction).not.toContain("apply_change");
    expect(instruction).not.toContain("return_to_parent");
  });

  it("validates Plan change shape before invoking Ticket Engine", () => {
    expect(validateMissionTicketOutcome("plan-change-set-v3", "completed", { result: {} })).toMatchObject({ valid: false });
    expect(validateMissionTicketOutcome("plan-change-set-v3", "completed", { result: {}, change: { additions: [draft("dev")], dependencyAdditions: [], cancelTicketIds: [], requiredTerminalRefs: [{ clientRef: "dev" }] } })).toEqual({ valid: true });
  });

  it.each([
    [{ accepted: false, commandId: "c", proposalId: "p", code: "stale_authority", reason: "stale" }, "stale_claim"],
    [{ accepted: false, commandId: "c", proposalId: "p", code: "plan_terminal", reason: "done" }, "plan_terminal"],
    [{ accepted: false, commandId: "c", proposalId: "p", code: "invalid_command", reason: "fix" }, "correctable"],
  ] as Array<[TicketCommandResult, string]>)("maps Ticket rejection to Goal decision", (result, disposition) => {
    expect(ticketResultToGoalDecision(proposal("completed", { ok: true }), result)).toMatchObject({ accepted: false, disposition });
  });
});

const NOW = "2026-07-14T00:00:00.000Z";
function draft(clientRef: string) { return { clientRef, title: clientRef, objective: `完成 ${clientRef}`, successCriteria: ["完成"], assignment: {}, outputContract: { schemaRef: "result-v1" } }; }
function proposal(status: "completed" | "blocked" | "failed", domainOutcome: MissionTicketOutcome): GoalResolutionProposal<any, MissionTicketOutcome> { return { proposalId: "proposal", goalId: "goal", expectedGoalVersion: 1, resolvingGoalVersion: 2, status, summary: "summary", evidence: [], domainOutcome, createdAt: NOW }; }
const link: ActiveMissionLink = { dispatchId: "dispatch", missionId: "mission", planId: "ca24185e-4957-4bb2-973f-ea4d89382557" as PlanId, ticketId: "40614afd-9312-4f9b-97fe-d14e18fe4201" as TicketId, ticketVersion: 2, agentId: "pm", agentPrincipalId: "planner", claimRequestId: "claim", goalStartKey: "start", updatedAt: NOW, status: "resolving", authority: { kind: "claim", claimId: "claim", fencingToken: 1 }, agentThreadId: "thread", agentGoalId: "goal" };
