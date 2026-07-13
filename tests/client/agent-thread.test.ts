import { describe, expect, it } from "vitest";
import {
  appendCurrentAgentPrompt,
  buildAgentThreadBubbles,
  beginChatSubmission,
  chatComposerKeyAction,
  scrollChatThreadToLatest,
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
      expect.objectContaining({ id: "evt_claimed", role: "platform", title: "开始处理工单", body: "修复跨域启动问题\nimplementation" }),
      expect.objectContaining({ id: "evt_agent", role: "agent", body: "我会先检查启动脚本和入口文件。" }),
      expect.objectContaining({ id: "evt_done", role: "platform", title: "工单处理完成", body: "已修复启动脚本\nacked" })
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
  payload: Record<string, unknown>
): AgentThreadEvent {
  return {
    id,
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
