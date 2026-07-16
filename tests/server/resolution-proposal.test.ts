import { describe, expect, it } from "vitest";
import { parseResolutionProposal } from "../../src/server/agent-engine/resolution-proposal.js";

describe("parseResolutionProposal", () => {
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
});
