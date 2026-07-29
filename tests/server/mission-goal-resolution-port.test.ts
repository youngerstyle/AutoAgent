import { describe, expect, it, vi } from "vitest";
import type { AgentGoal, GoalResolutionProposal } from "../../src/shared/contracts/agent-engine.js";
import { MissionGoalResolutionPort } from "../../src/server/mission-process/mission-goal-resolution-port.js";

describe("MissionGoalResolutionPort", () => {
  it("rejects a normal successful outcome when a criterion is not satisfied", async () => {
    const wake = vi.fn();
    const port = new MissionGoalResolutionPort(wake, "qa");
    const result = await port.resolve(goal(), proposal({ disposition: "complete" }));

    expect(result).toMatchObject({
      settle: true,
      decision: { accepted: false, disposition: "correctable" },
    });
    expect(wake).not.toHaveBeenCalled();
  });

  it("accepts an agent-completed correction outcome with unmet criteria", async () => {
    const wake = vi.fn();
    const port = new MissionGoalResolutionPort(wake, "qa");
    const result = await port.resolve(goal(), proposal({
      disposition: "correction_required",
      targetTicketId: "upstream-ticket",
      reason: "验收不通过",
    }));

    expect(result).toMatchObject({ settle: false, pending: "retry_later" });
    expect(wake).toHaveBeenCalledOnce();
  });

  it("rejects a correction disposition nested inside the successful settlement payload", async () => {
    const wake = vi.fn();
    const port = new MissionGoalResolutionPort(wake, "boss");
    const result = await port.resolve(goal(), proposal({
      missionResolution: {
        disposition: "correction_required",
        targetTicketId: "upstream-ticket",
        reason: "evidence changed",
      },
    }));

    expect(result).toMatchObject({
      settle: true,
      decision: {
        accepted: false,
        disposition: "correctable",
        reason: expect.stringContaining("domainOutcome"),
      },
    });
    expect(wake).not.toHaveBeenCalled();
  });

  it("defers plan index normalization and Mission validation to the manager", async () => {
    const wake = vi.fn();
    const port = new MissionGoalResolutionPort(wake, "pm");
    const planGoal = goal();
    planGoal.spec.outputContract = { schemaRef: "plan-change-set-v3" };
    const planProposal = proposal({
      result: { summary: "可执行计划" },
      change: {
        additions: [{
          clientRef: "dev",
          title: "开发",
          objective: "实现交付物",
          successCriteria: ["产物可运行"],
          missionContribution: { missionCriterionIndexes: [0] },
          assurance: { missionCriterionIndexes: [0] },
        }],
      },
    });
    planProposal.criterionResults = [{ criterionIndex: 0, status: "satisfied", evidence: [] }];

    const result = await port.resolve(planGoal, planProposal);

    expect(result).toMatchObject({ settle: false, pending: "retry_later" });
    expect(wake).toHaveBeenCalledOnce();
  });
});

function goal(): AgentGoal {
  return {
    spec: {
      id: "goal",
      threadId: "thread",
      objective: "检查交付",
      successCriteria: ["产品满足验收要求"],
      contextRefs: [],
      outputContract: { schemaRef: "result-v1" },
      createdAt: "2026-07-17T00:00:00.000Z",
    },
    version: 1,
    status: "active",
    updatedAt: "2026-07-17T00:00:00.000Z",
  };
}

function proposal(domainOutcome: Record<string, unknown>): GoalResolutionProposal<"completed", Record<string, unknown>> {
  return {
    proposalId: "proposal",
    turnId: "turn",
    goalId: "goal",
    expectedGoalVersion: 1,
    resolvingGoalVersion: 2,
    status: "completed",
    summary: "检查完成，结论不通过",
    evidence: [],
    criterionResults: [{ criterionIndex: 0, status: "not_satisfied", evidence: [] }],
    residualRisks: [],
    domainOutcome,
    createdAt: "2026-07-17T00:01:00.000Z",
  };
}
