import { describe, expect, it } from "vitest";
import type { GoalResolutionProposal } from "../../src/shared/contracts/agent-engine.js";
import type { ActiveMissionLink } from "../../src/shared/contracts/mission-control.js";
import type { PlanId, TicketId } from "../../src/shared/contracts/ticket-engine.js";
import {
  missionOutcomeInstruction,
  normalizeMissionPlanCriterionIndexes,
  proposalToCompiledPlanCommand,
  validateMissionTicketOutcome,
  type SharedPlanContext,
} from "../../src/server/mission-process/ticket-agent-adapter.js";

describe("plan-intent-v1 adapter", () => {
  it("does not expose platform graph internals to the planner", () => {
    const instruction = missionOutcomeInstruction("plan-intent-v1", ["code:write", "test:verify"], [], link.ticketId, plan);
    expect(instruction).toContain("只描述业务交付意图");
    expect(instruction).toContain("不得生成 Ticket UUID");
    expect(instruction).not.toContain("dependencyAdditions");
    expect(instruction).not.toContain("requiredTerminalRefs");
  });

  it("maps criterion indexes then compiles intent using the authoritative snapshot", () => {
    const normalized = normalizeMissionPlanCriterionIndexes(outcome, plan.missionBaseline) as typeof outcome;
    expect(normalized.intent.increments[0]?.workItems[0]?.missionContribution).toEqual({ missionCriterionIds: ["criterion-a"] });
    expect(validateMissionTicketOutcome("plan-intent-v1", "completed", normalized, undefined, plan)).toEqual({ valid: true });

    const command = proposalToCompiledPlanCommand(proposal(normalized), link, 4, NOW, plan);
    expect(command?.payload).toMatchObject({
      type: "apply_change",
      expectedPlanVersion: 4,
      change: {
        dependencyAdditions: expect.arrayContaining([
          { from: { ticketId: link.ticketId }, to: { clientRef: "build" } },
          { from: { clientRef: "build" }, to: { clientRef: "qa" } },
          { from: { clientRef: "qa" }, to: { clientRef: "accept" } },
        ]),
        requiredTerminalRefs: [{ clientRef: "accept" }],
      },
    });
  });

  it("returns the exact malformed semantic work field", () => {
    const malformed = structuredClone(outcome) as unknown as Record<string, unknown>;
    const intent = malformed.intent as { increments: Array<{ workItems: Array<Record<string, unknown>> }> };
    intent.increments[0]!.workItems[0]!.outputContract = "reference-baseline-v2";

    expect(validateMissionTicketOutcome("plan-intent-v1", "completed", malformed, undefined, plan)).toEqual({
      valid: false,
      reason: "intent.increments[0].workItems[0].outputContract must be an object with schemaRef",
    });
  });

  it("rejects workflow dispositions before interpreting semantic intent", () => {
    expect(validateMissionTicketOutcome("plan-intent-v1", "completed", {
      ...outcome,
      disposition: "correction_required",
    }, undefined, plan)).toEqual({
      valid: false,
      reason: "plan-intent-v1 的 goal_resolution 只能省略 disposition 或使用 complete；纠错和计划变更必须调用独立工作流工具",
    });
  });
});

const NOW = "2026-08-07T00:00:00.000Z";
const link: ActiveMissionLink = {
  dispatchId: "dispatch",
  missionId: "mission",
  planId: "plan-a" as PlanId,
  ticketId: "planner-ticket" as TicketId,
  ticketVersion: 2,
  agentId: "pm",
  agentPrincipalId: "planner",
  claimRequestId: "claim",
  goalStartKey: "start",
  updatedAt: NOW,
  status: "resolving",
  authority: { kind: "claim", claimId: "claim", fencingToken: 1 },
  agentThreadId: "thread",
  agentGoalId: "goal",
};
const plan: SharedPlanContext = {
  planId: "plan-a",
  version: 4,
  tickets: [],
  dependencyEdges: [],
  requiredTerminalTicketIds: [],
  teamMembers: [],
  missionBaseline: {
    baselineId: "baseline-a",
    version: 1,
    objective: "deliver",
    criteria: [{
      criterionId: "criterion-a",
      text: "works",
      verification: { anchors: [{ observableOutcome: "works", evidenceRequirements: ["browser evidence"] }] },
    }],
    constraints: [], assumptions: [], exclusions: [],
    establishedByTicketId: "intake" as TicketId,
    establishedAt: NOW,
  },
};
const outcome = {
  intent: {
    rationale: "deliver and verify",
    increments: [{
      intentRef: "delivery",
      title: "Delivery",
      objective: "Build and verify",
      workItems: [
        {
          intentRef: "build", title: "Build", objective: "Build it", successCriteria: ["built"],
          assignment: { requiredCapabilities: ["code:write"] }, outputContract: { schemaRef: "result-v1" },
          missionContribution: { missionCriterionIndexes: [0] },
        },
        {
          intentRef: "qa", title: "QA", objective: "Verify it", successCriteria: ["verified"],
          assignment: { requiredCapabilities: ["test:verify"] }, outputContract: { schemaRef: "mission-assurance-v1" },
          dependsOn: ["build"], assurance: { missionCriterionIndexes: [0] },
        },
        {
          intentRef: "accept", title: "Accept", objective: "Accept it", successCriteria: ["accepted"],
          assignment: { requiredCapabilities: ["mission:accept"] }, outputContract: { schemaRef: "result-v1" },
          dependsOn: ["qa"], permissions: { settleMission: true },
        },
      ],
    }],
  },
};

function proposal(domainOutcome: unknown): GoalResolutionProposal<"completed", Record<string, unknown>> {
  return {
    proposalId: "proposal-a",
    goalId: "goal",
    expectedGoalVersion: 1,
    resolvingGoalVersion: 1,
    turnId: "turn",
    status: "completed",
    summary: "planned",
    evidence: [],
    criterionResults: [],
    residualRisks: [],
    domainOutcome: domainOutcome as Record<string, unknown>,
    createdAt: NOW,
  };
}
