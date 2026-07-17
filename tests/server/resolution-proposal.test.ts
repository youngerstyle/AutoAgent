import { describe, expect, it } from "vitest";
import { createHumanInputProposal, parseResolutionProposal } from "../../src/server/agent-engine/resolution-proposal.js";

describe("parseResolutionProposal", () => {
  it("creates a blocked Goal proposal from the explicit human-input control tool", () => {
    const goal = {
      version: 3,
      spec: {
        id: "goal",
        threadId: "thread",
        objective: "在真实浏览器中验证游戏",
        successCriteria: ["完成一局人工测试"],
        contextRefs: [],
        createdAt: "2026-07-16T00:00:00.000Z",
      },
    } as any;

    expect(createHumanInputProposal(goal, "turn", {
      kind: "manual_test",
      description: "请在浏览器中完成一局",
      details: { testFile: "index.html", steps: ["打开游戏", "完成一局"] },
    }, "2026-07-16T00:01:00.000Z")).toMatchObject({
      goalId: "goal",
      expectedGoalVersion: 3,
      status: "blocked",
      summary: "请在浏览器中完成一局",
      humanInputRequest: {
        kind: "manual_test",
        description: "请在浏览器中完成一局",
      },
    });
    expect(createHumanInputProposal(goal, "turn", {
      kind: "manual_test",
      description: "请在浏览器中完成一局",
    }, "2026-07-16T00:01:00.000Z")).not.toHaveProperty("domainOutcome");
  });

  it("does not allow goal_resolution to submit blocked", () => {
    const goal = {
      version: 1,
      spec: { id: "goal", threadId: "thread", objective: "工作", successCriteria: [], contextRefs: [], createdAt: "now" },
    } as any;

    expect(parseResolutionProposal({
      status: "blocked",
      summary: "等待人类",
      evidence: [],
      criterionResults: [],
      residualRisks: [],
    }, goal, "turn", "now")).toEqual({
      ok: false,
      reason: "status 必须是 completed 或 failed；需要 human 输入时调用 request_human_input",
    });
  });
  it("reports the exact missing success-criterion indexes", () => {
    const goal = {
      version: 1,
      spec: {
        id: "goal",
        threadId: "thread",
        objective: "完成工作",
        successCriteria: ["第一项", "第二项", "第三项"],
        contextRefs: [],
        createdAt: "2026-07-16T00:00:00.000Z",
      },
    } as any;

    const result = parseResolutionProposal({
      status: "completed",
      summary: "完成",
      evidence: [],
      criterionResults: [{ criterionIndex: 1, status: "satisfied", evidence: [] }],
      residualRisks: [],
      domainOutcome: { result: "done" },
    }, goal, "turn", "2026-07-16T00:01:00.000Z");

    expect(result).toEqual({
      ok: false,
      reason: "completed 必须逐项回应全部成功标准；当前缺少 criterionIndex: 0, 2",
    });
  });

  it("allows a completed review to report unmet criteria for a correction outcome", () => {
    const goal = {
      version: 1,
      spec: {
        id: "goal",
        threadId: "thread",
        objective: "检查上游交付",
        successCriteria: ["形成验证结论", "记录缺陷"],
        contextRefs: [],
        createdAt: "2026-07-16T00:00:00.000Z",
      },
    } as any;

    const result = parseResolutionProposal({
      status: "completed",
      summary: "检查完成，结论不通过",
      evidence: [],
      criterionResults: [
        { criterionIndex: 0, status: "not_satisfied", evidence: [] },
        { criterionIndex: 1, status: "satisfied", evidence: [] },
      ],
      residualRisks: [],
      domainOutcome: { disposition: "correction_required", targetTicketId: "upstream", reason: "存在缺陷" },
    }, goal, "turn", "2026-07-16T00:01:00.000Z");

    expect(result).toMatchObject({
      ok: true,
      value: { status: "completed", domainOutcome: { disposition: "correction_required" } },
    });
  });
});
