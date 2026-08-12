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
    expect(instruction).toContain("像负责人写 TodoList 一样");
    expect(instruction).toContain("不要生成 capability、tool、schemaRef");
    expect(instruction).toContain('todos:[{kind:"architecture"|"implementation",title,objective,successCriteria}]');
    expect(instruction).not.toContain("dependencyAdditions");
    expect(instruction).not.toContain("requiredTerminalRefs");
  });

  it("compiles flat todos using the authoritative snapshot", () => {
    const normalized = normalizeMissionPlanCriterionIndexes(outcome, plan.missionBaseline) as typeof outcome;
    expect(normalized).toEqual(outcome);
    expect(validateMissionTicketOutcome("plan-intent-v1", "completed", normalized, undefined, plan)).toEqual({ valid: true });

    const command = proposalToCompiledPlanCommand(proposal(normalized), link, 4, NOW, plan);
    expect(command?.payload).toMatchObject({
      type: "apply_change",
      expectedPlanVersion: 4,
      change: {
        dependencyAdditions: expect.arrayContaining([
          { from: { ticketId: link.ticketId }, to: { clientRef: "todo-01" } },
          { from: { clientRef: "todo-01" }, to: { clientRef: "assurance" } },
          { from: { clientRef: "assurance" }, to: { clientRef: "acceptance" } },
        ]),
        requiredTerminalRefs: [{ clientRef: "acceptance" }],
      },
    });
  });

  it("returns the exact malformed semantic work field", () => {
    const malformed = structuredClone(outcome) as unknown as Record<string, unknown>;
    const intent = malformed.intent as { todos: Array<Record<string, unknown>> };
    intent.todos[0]!.kind = "qa";

    expect(validateMissionTicketOutcome("plan-intent-v1", "completed", malformed, undefined, plan)).toEqual({
      valid: false,
      reason: "intent.todos[0].kind must be architecture or implementation",
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
  requiredTerminalCapabilities: ["delivery:accept"],
  teamMembers: [
    { principalId: "principal:dev", name: "Dev", capabilities: ["delivery:implement"], enabledTools: ["listFiles", "readFile", "writeFile", "shell"] },
    { principalId: "principal:qa", name: "QA", capabilities: ["delivery:verify"], enabledTools: ["listFiles", "readFile", "shell", "browser"] },
    { principalId: "principal:boss", name: "Boss", capabilities: ["delivery:accept"], enabledTools: ["listFiles", "readFile"] },
  ],
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
    todos: [{
      kind: "implementation", title: "Build", objective: "Build it", successCriteria: ["built"],
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
