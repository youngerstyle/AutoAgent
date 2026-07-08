import { describe, expect, it } from "vitest";
import { compactSessionIfNeeded } from "../../src/server/context/session-compactor";
import type { AgentSession } from "../../src/server/storage/session-store";

describe("SessionCompactor", () => {
  it("creates a checkpoint from old message groups without mutating session messages", () => {
    const session = sessionWithLargeHistory();
    const originalMessages = session.messages.map((message) => message.content);

    const result = compactSessionIfNeeded(session, {
      maxRecentGroups: 1,
      triggerTokens: 400,
      compactToTokens: 120
    });

    expect(session.messages.map((message) => message.content)).toEqual(originalMessages);
    expect(result.compacted).toBe(true);
    expect(result.checkpoint?.summary).toContain("压缩了 2 个历史消息组");
    expect(result.checkpoint?.summary).toContain("读取文件");
    expect(result.recentMessages.map((message) => message.content)).toEqual([
      "最新用户任务",
      "最新助手结论"
    ]);
    expect(result.checkpoint?.originalChars).toBeGreaterThan(result.checkpoint?.summaryChars ?? 0);
    expect(result.checkpoint?.replacementHistory.map((message) => message.content)).toEqual([
      expect.stringContaining("历史会话已压缩"),
      "最新用户任务",
      "最新助手结论"
    ]);
    expect(result.checkpoint?.replacementHistory[0].metadata).toMatchObject({
      contextCompaction: true,
      checkpointId: result.checkpoint?.id
    });
  });

  it("keeps tool observations grouped with their owning turn", () => {
    const session = sessionWithLargeHistory();

    const result = compactSessionIfNeeded(session, {
      maxRecentGroups: 2,
      triggerTokens: 10,
      compactToTokens: 200
    });

    expect(result.recentMessages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "user", "assistant"]);
    expect(result.recentMessages.map((message) => message.content)).toContain("{\"tool\":\"readFile\",\"path\":\"index.html\",\"ok\":true}");
  });

  it("does not compact when estimated active history is below threshold", () => {
    const session: AgentSession = {
      id: "tr_1",
      workspaceAgentId: "wa_dev",
      messages: [
        { role: "user", content: "短任务", timestamp: "2026-07-07T00:00:00.000Z" },
        { role: "assistant", content: "短回答", timestamp: "2026-07-07T00:00:01.000Z" }
      ],
      updatedAt: "2026-07-07T00:00:01.000Z"
    };

    const result = compactSessionIfNeeded(session, {
      maxRecentGroups: 2,
      triggerTokens: 400,
      compactToTokens: 100
    });

    expect(result.compacted).toBe(false);
    expect(result.checkpoint).toBeUndefined();
    expect(result.recentMessages).toHaveLength(2);
  });
});

function sessionWithLargeHistory(): AgentSession {
  return {
    id: "tr_1",
    workspaceAgentId: "wa_dev",
    messages: [
      { role: "user", content: `第一轮用户\n${"旧需求 ".repeat(1000)}`, timestamp: "2026-07-07T00:00:00.000Z" },
      { role: "assistant", content: `第一轮助手\n${"旧结论 ".repeat(1000)}`, timestamp: "2026-07-07T00:00:01.000Z" },
      { role: "user", content: "读取文件", timestamp: "2026-07-07T00:00:02.000Z" },
      { role: "assistant", content: "{\"toolIntents\":[{\"tool\":\"readFile\",\"path\":\"index.html\"}]}", timestamp: "2026-07-07T00:00:03.000Z" },
      { role: "tool", content: "{\"tool\":\"readFile\",\"path\":\"index.html\",\"ok\":true}", timestamp: "2026-07-07T00:00:04.000Z" },
      { role: "user", content: "最新用户任务", timestamp: "2026-07-07T00:00:05.000Z" },
      { role: "assistant", content: "最新助手结论", timestamp: "2026-07-07T00:00:06.000Z" }
    ],
    updatedAt: "2026-07-07T00:00:06.000Z"
  };
}
