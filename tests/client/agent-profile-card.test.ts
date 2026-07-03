import { describe, expect, it } from "vitest";
import { agentProfileCardSummary } from "../../src/client/agent-profile-card";

describe("agent profile card summary", () => {
  it("uses compact capabilities instead of long identity or soul text", () => {
    const summary = agentProfileCardSummary({
      capabilities: ["代码库理解", "技术方案", "架构边界", "接口设计", "风险评估", "能力缺口判断"],
      soul: "先读项目事实，再给技术判断。不得凭空发明不存在的框架、接口、文件或能力；方案必须能被开发执行，能被 QA 验证，并显式写出风险、依赖和取舍。"
    });

    expect(summary).toBe("代码库理解、技术方案、架构边界、接口设计");
    expect(summary).not.toContain("不得凭空发明");
  });
});
