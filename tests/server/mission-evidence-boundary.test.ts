import path from "node:path";
import { describe, expect, it } from "vitest";
import type { GoalResolutionProposal } from "../../src/shared/contracts/agent-engine.js";
import { validateWorkspaceEvidence } from "../../src/server/mission-process/mission-goal-resolution-port.js";

describe("Mission completion evidence boundary", () => {
  const workspaceRoot = path.resolve("C:/projects/current");

  it("accepts delivery evidence inside the current workspace", () => {
    expect(validateWorkspaceEvidence(workspaceRoot, proposal("src/game.ts"))).toBeUndefined();
    expect(validateWorkspaceEvidence(workspaceRoot, proposal(path.join(workspaceRoot, "dist", "index.html")))).toBeUndefined();
  });

  it("rejects a sibling project's files as completion evidence", () => {
    const error = validateWorkspaceEvidence(workspaceRoot, proposal("../previous-project/dist/index.html"));
    expect(error).toContain("不属于当前项目");
    expect(error).toContain("../previous-project/dist/index.html");
  });

  it("does not treat external evidence URLs as workspace artifacts", () => {
    expect(validateWorkspaceEvidence(workspaceRoot, proposal("https://example.com/reference", "reference"))).toBeUndefined();
  });
});

function proposal(ref: string, kind = "tool"): Pick<GoalResolutionProposal, "evidence" | "criterionResults"> {
  const evidence = [{ kind, ref }];
  return {
    evidence,
    criterionResults: [{ criterionIndex: 0, status: "satisfied", evidence }],
  };
}
