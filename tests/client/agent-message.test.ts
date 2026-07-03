import { describe, expect, it } from "vitest";
import { buildAgentMessageView } from "../../src/client/agent-message";

describe("agent message view", () => {
  it("shows readable agent text without rendering JSON fields as chat content", () => {
    const view = buildAgentMessageView(JSON.stringify({
      decision: "暂不执行",
      action: "await_human_reply",
      verification_executable: false,
      static_analysis: {
        code_structure: "完整单HTML文件"
      }
    }));

    expect(view.kind).toBe("json");
    if (view.kind !== "json") return;
    expect(view.paragraphs).toContain("暂不执行");
    expect(view.paragraphs).toContain("完整单HTML文件");
    expect(view.paragraphs).not.toContain("await_human_reply");
    expect(view.paragraphs).not.toContain("false");
    expect(JSON.stringify(view.paragraphs)).not.toContain("verification_executable");
    expect(JSON.stringify(view.paragraphs)).not.toContain("static_analysis");
    expect(JSON.stringify(view.paragraphs)).not.toContain("等待你的回复");
  });

  it("leaves non-json output as raw text", () => {
    const view = buildAgentMessageView("缺少浏览器运行环境，无法实际执行手动测试。");

    expect(view).toEqual({
      kind: "text",
      rawText: "缺少浏览器运行环境，无法实际执行手动测试。"
    });
  });
});
