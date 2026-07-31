import { describe, expect, it } from "vitest";
import {
  appendCurrentAgentPrompt,
  buildAgentThreadBubbles,
  beginChatSubmission,
  chatComposerKeyAction,
  scrollChatThreadToLatest,
  splitReasoningFromAnswer,
} from "../../src/client/agent-thread";
import type { AgentThreadEvent } from "../../src/shared/types";

describe("agent thread view", () => {
  it("projects chronological agent thread events into readable bubbles", () => {
    const events: AgentThreadEvent[] = [
      threadEvent(2, "evt_claimed", "platform", "ticket_claimed", {
        ticketType: "implementation",
        brief: "修复跨域启动问题"
      }),
      threadEvent(1, "evt_human", "human", "human_message", {
        message: "继续处理这个报错。"
      }),
      threadEvent(3, "evt_agent", "agent", "agent_message", {
        message: "我会先检查启动脚本和入口文件。"
      }),
      threadEvent(4, "evt_done", "platform", "ticket_outcome", {
        status: "acked",
        result: { summary: "已修复启动脚本" }
      })
    ];

    expect(buildAgentThreadBubbles(events)).toEqual([
      expect.objectContaining({ id: "evt_human", role: "human", body: "继续处理这个报错。" }),
      expect.objectContaining({ id: "evt_claimed", role: "system", title: "开始处理工单", collapsed: true, body: "修复跨域启动问题\nimplementation" }),
      expect.objectContaining({ id: "evt_agent", role: "agent", body: "我会先检查启动脚本和入口文件。" }),
      expect.objectContaining({ id: "evt_done", role: "platform", title: "工单处理完成", body: "已修复启动脚本\nacked" })
    ]);
  });

  it("keeps the Agent answer visible while folding reasoning and internal activity", () => {
    const bubbles = buildAgentThreadBubbles([
      threadEvent(1, "evt_thinking_1", "agent", "agent_message", {
        content: "<thinking>Reading current artifacts and baseline</thinking>",
      }),
      threadEvent(2, "evt_tool", "tool", "tool_observation", {
        name: "readFile",
        path: "src/index.ts",
        summary: "读取入口文件完成",
      }),
      threadEvent(3, "evt_thinking_2", "agent", "agent_message", {
        content: "<thinking>Checking the implementation</thinking>\n已完成检查，当前实现可以继续。",
      }),
    ]);

    expect(bubbles).toEqual([
      expect.objectContaining({
        role: "system",
        title: "运行细节",
        collapsed: true,
        summary: "3 条内部记录 · 思考、工具与系统信息",
      }),
      expect.objectContaining({
        id: "evt_thinking_2",
        role: "agent",
        body: "已完成检查，当前实现可以继续。",
      }),
    ]);
    expect(JSON.stringify(bubbles[0])).toContain("Reading current artifacts and baseline");
    expect(JSON.stringify(bubbles[0])).toContain("读取入口文件完成");
  });

  it("splits tagged reasoning from a user-facing answer", () => {
    expect(splitReasoningFromAnswer(
      "<thinking>**Inspecting files**</thinking>\n\n这里是最终结论。",
    )).toEqual({
      reasoning: ["Inspecting files"],
      answer: "这里是最终结论。",
    });
  });

  it("folds untagged intermediate model commentary by turn structure", () => {
    const bubbles = buildAgentThreadBubbles([
      threadEvent(1, "evt_progress_1", "agent", "agent_message", {
        content: "**Capturing movement-after screenshot**",
      }, "turn_1"),
      threadEvent(2, "evt_tool_1", "tool", "tool_observation", {
        name: "browser",
        summary: "screenshot captured",
      }, "turn_1"),
      threadEvent(3, "evt_progress_2", "agent", "agent_message", {
        content: "**Inspecting movement evidence screenshot**",
      }, "turn_1"),
      threadEvent(4, "evt_tool_2", "tool", "tool_observation", {
        name: "browser",
        summary: "inspection completed",
      }, "turn_1"),
      threadEvent(5, "evt_answer", "agent", "agent_message", {
        content: "Browser verification is complete.",
      }, "turn_1"),
    ]);

    expect(bubbles).toEqual([
      expect.objectContaining({
        role: "system",
        collapsed: true,
      }),
      expect.objectContaining({
        id: "evt_answer",
        role: "agent",
        body: "Browser verification is complete.",
      }),
    ]);
    expect(bubbles[0]?.body).toContain("Capturing movement-after screenshot");
    expect(bubbles[0]?.body).toContain("Inspecting movement evidence screenshot");
  });

  it("renders a received Goal as an understandable work brief and labels internal constraints", () => {
    const bubbles = buildAgentThreadBubbles([
      threadEvent(1, "evt_goal", "platform", "ticket_received", {
        brief: "实现坦克移动与射击",
        successCriteria: ["方向键可移动", "空格键可射击"],
        expectedArtifact: "delivery-v1",
      }),
      threadEvent(2, "evt_system", "system", "system_note", { content: "必须提交结构化结果" }),
    ]);

    expect(bubbles).toEqual([
      expect.objectContaining({
        title: "收到工单",
        body: "实现坦克移动与射击\n\n成功标准：\n- 方向键可移动\n- 空格键可射击\n\n交付格式：delivery-v1",
      }),
      expect.objectContaining({
        title: "Agent 工作规则",
        collapsed: true,
        summary: "平台提供给 Agent 的内部规则，通常无需处理",
        body: "必须提交结构化结果",
      }),
    ]);
  });

  it("renders persisted runtime content fields and does not duplicate the current prompt", () => {
    const bubbles = buildAgentThreadBubbles([
      threadEvent(1, "evt_human", "human", "human_message", { content: "按现有信息继续。" }),
      threadEvent(2, "evt_agent", "agent", "agent_message", { content: "我会采用合理默认值推进。" })
    ]);

    expect(bubbles).toEqual([
      expect.objectContaining({ role: "human", body: "按现有信息继续。" }),
      expect.objectContaining({ role: "agent", body: "我会采用合理默认值推进。" })
    ]);
    expect(appendCurrentAgentPrompt(bubbles, "我会采用合理默认值推进。")).toHaveLength(2);
    expect(appendCurrentAgentPrompt(bubbles, "需要你确认生产部署授权。")).toEqual([
      ...bubbles,
      expect.objectContaining({ role: "agent", body: "需要你确认生产部署授权。" })
    ]);
  });

  it("explains transient provider backoff without asking the human to resume", () => {
    const bubbles = buildAgentThreadBubbles([
      threadEvent(1, "evt_provider_wait", "system", "system_note", {
        status: "external_service_waiting",
        retryAt: "2026-07-24T06:30:00.000Z",
      }),
    ]);

    expect(bubbles).toEqual([
      expect.objectContaining({
        role: "platform",
        title: "模型服务暂时不可用",
        body: expect.stringContaining("不需要人工操作"),
      }),
    ]);
  });

  it("renders the Agent's blocked resolution as a readable chat message", () => {
    const bubbles = buildAgentThreadBubbles([
      threadEvent(1, "evt_resolution", "system", "system_note", {
        name: "request_human_input",
        arguments: {
          kind: "authorization",
          description: "生产环境发布授权和审批记录",
        },
      }),
    ]);

    expect(bubbles).toEqual([
      expect.objectContaining({
        role: "agent",
        title: "为什么停下来",
        body: "生产环境发布授权和审批记录",
      }),
    ]);
  });

  it("falls back to legacy direct messages only when no thread events exist", () => {
    const bubbles = buildAgentThreadBubbles([], [{
      id: "hm_1",
      agentId: "wa_dev",
      taskId: "task_1",
      taskRunId: "tr_1",
      message: "旧私聊",
      createdBy: "human",
      createdAt: "2026-07-09T00:00:00.000Z",
      response: "旧回复"
    }]);

    expect(bubbles).toEqual([
      expect.objectContaining({ id: "hm_1", role: "human", body: "旧私聊" }),
      expect.objectContaining({ id: "hm_1:response", role: "agent", body: "旧回复" })
    ]);
  });

  it("folds reasoning found in legacy direct-message responses", () => {
    const bubbles = buildAgentThreadBubbles([], [{
      id: "hm_reasoning",
      agentId: "wa_dev",
      taskId: "task_1",
      taskRunId: "tr_1",
      message: "继续",
      createdBy: "human",
      createdAt: "2026-07-09T00:00:00.000Z",
      response: "<thinking>Checking files</thinking>\n处理完成",
    }]);

    expect(bubbles).toHaveLength(3);
    expect(bubbles[0]).toMatchObject({ role: "human", body: "继续" });
    expect(bubbles[1]).toMatchObject({ role: "system", collapsed: true, title: "处理过程" });
    expect(bubbles[2]).toMatchObject({ role: "agent", body: "处理完成" });
  });

  it("sends on Enter while preserving Shift+Enter and IME composition", () => {
    expect(chatComposerKeyAction({ key: "Enter", shiftKey: false, isComposing: false })).toBe("submit");
    expect(chatComposerKeyAction({ key: "Enter", shiftKey: true, isComposing: false })).toBe("newline");
    expect(chatComposerKeyAction({ key: "Enter", shiftKey: false, isComposing: true })).toBe("ignore");
    expect(chatComposerKeyAction({ key: "a", shiftKey: false, isComposing: false })).toBe("ignore");
  });

  it("clears a non-empty chat draft as soon as submission begins", () => {
    expect(beginChatSubmission("  继续处理  ")).toEqual({
      message: "继续处理",
      nextDraft: "",
    });
    expect(beginChatSubmission("   ")).toEqual({ message: "", nextDraft: "   " });
  });

  it("positions a chat thread at its latest message", () => {
    const container = { scrollTop: 0, scrollHeight: 1280 };

    scrollChatThreadToLatest(container);

    expect(container.scrollTop).toBe(1280);
  });
});

function threadEvent(
  sequence: number,
  id: string,
  source: AgentThreadEvent["source"],
  kind: AgentThreadEvent["kind"],
  payload: Record<string, unknown>,
  turnId?: string,
): AgentThreadEvent {
  return {
    id,
    ...(turnId ? { turnId } : {}),
    taskId: "task_1",
    taskRunId: "tr_1",
    workspaceAgentId: "wa_dev",
    sequence,
    timestamp: `2026-07-09T00:00:0${sequence}.000Z`,
    source,
    kind,
    visibility: "timeline",
    payload
  };
}
