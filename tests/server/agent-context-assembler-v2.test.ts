import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentContextAssembler } from "../../src/server/agent-engine/context-assembler.js";
import { AgentEngine } from "../../src/server/agent-engine/agent-engine.js";
import { AgentStore } from "../../src/server/agent-engine/agent-store.js";
import type { AgentPolicy, AgentProfile, WorkspaceAgent } from "../../src/shared/types.js";

describe("AgentContextAssembler", () => {
  it("separates stable instructions from one chronological structured history", async () => {
    const fixture = await contextFixture();
    await fixture.engine.sendMessage({
      messageId: "human-1",
      threadId: fixture.thread.threadId,
      senderPrincipalId: "human",
      content: "先检查报错",
      createdAt: "2026-07-13T00:00:00.000Z",
    });
    await fixture.engine.appendModelItem({
      itemId: "model-1",
      threadId: fixture.thread.threadId,
      content: "我会读取文件。",
      createdAt: "2026-07-13T00:01:00.000Z",
    });
    await fixture.engine.appendToolItem({
      itemId: "call-1",
      threadId: fixture.thread.threadId,
      kind: "tool",
      value: { type: "tool_call", callId: "call-1", name: "readFile", arguments: { path: "src/main.ts" } },
      createdAt: "2026-07-13T00:02:00.000Z",
    });
    await fixture.engine.appendToolItem({
      itemId: "result-1",
      threadId: fixture.thread.threadId,
      kind: "observation",
      value: { type: "tool_result", callId: "call-1", content: { ok: true, content: "source" }, isError: false },
      createdAt: "2026-07-13T00:03:00.000Z",
    });
    const goal = await fixture.engine.startGoal({
      agentId: "dev",
      threadId: fixture.thread.threadId,
      idempotencyKey: "goal",
      spec: {
        id: "goal",
        threadId: fixture.thread.threadId,
        objective: "修复页面",
        successCriteria: ["测试通过"],
        contextRefs: [],
        createdAt: "2026-07-13T00:04:00.000Z",
      },
    });

    const assembled = await fixture.assembler.assemble({
      profile,
      agent,
      policy,
      thread: await fixture.engine.getThread(fixture.thread.threadId),
      goal,
    });

    expect(assembled.instructions).toContain("## Soul");
    expect(assembled.instructions).toContain("只有调用 goal_resolution 工具");
    expect(assembled.instructions).not.toContain("先检查报错");
    expect(assembled.history).toEqual([
      { type: "user_message", content: "先检查报错" },
      { type: "assistant_message", content: "我会读取文件。" },
      { type: "tool_call", callId: "call-1", name: "readFile", arguments: { path: "src/main.ts" } },
      { type: "tool_result", callId: "call-1", content: JSON.stringify({ ok: true, content: "source" }), isError: false },
    ]);
    expect(assembled.history.every((item) => JSON.stringify(item).includes("## Soul") === false)).toBe(true);
  });

  it("compacts by whole interaction groups and never leaves a tool result without its call", async () => {
    const fixture = await contextFixture(220);
    for (let index = 0; index < 8; index += 1) {
      await fixture.engine.sendMessage({
        messageId: `old-${index}`,
        threadId: fixture.thread.threadId,
        senderPrincipalId: "human",
        content: `旧消息 ${index} ${"历史".repeat(80)}`,
        createdAt: `2026-07-13T00:${String(index).padStart(2, "0")}:00.000Z`,
      });
    }
    await fixture.engine.appendToolItem({
      itemId: "latest-call",
      threadId: fixture.thread.threadId,
      kind: "tool",
      value: { type: "tool_call", callId: "latest", name: "readFile", arguments: { path: "latest.ts" } },
      createdAt: "2026-07-13T01:00:00.000Z",
    });
    await fixture.engine.appendToolItem({
      itemId: "latest-result",
      threadId: fixture.thread.threadId,
      kind: "observation",
      value: { type: "tool_result", callId: "latest", content: { ok: true }, isError: false },
      createdAt: "2026-07-13T01:01:00.000Z",
    });

    const assembled = await fixture.assembler.assemble({
      profile,
      agent,
      policy,
      thread: await fixture.engine.getThread(fixture.thread.threadId),
    });

    expect(assembled.report.compactedThreadItems).toBeGreaterThan(0);
    const resultIndex = assembled.history.findIndex((item) => item.type === "tool_result" && item.callId === "latest");
    const callIndex = assembled.history.findIndex((item) => item.type === "tool_call" && item.callId === "latest");
    expect(callIndex).toBeGreaterThanOrEqual(0);
    expect(resultIndex).toBeGreaterThan(callIndex);
  });
});

async function contextFixture(maxTokens = 64_000) {
  const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-context-native-"));
  const store = new AgentStore(root, "dev");
  const engine = new AgentEngine(store);
  const thread = await engine.ensureThread({ agentId: "dev", scopeId: "ws", idempotencyKey: "thread" });
  return { root, store, engine, thread, assembler: new AgentContextAssembler(store, maxTokens) };
}

const profile: AgentProfile = {
  id: "profile-dev",
  name: "开发",
  role: "dev",
  soul: "冷静、求证",
  identity: "软件工程师",
  agentMd: "读取事实，修改代码，运行验证。",
  capabilities: ["TypeScript"],
  defaultProvider: "mock",
  defaultModel: "mock",
  defaultPolicy: {},
};

const agent: WorkspaceAgent = {
  id: "dev",
  workspaceId: "ws",
  profileId: profile.id,
  roleInWorkspace: "dev",
  agentDir: ".autoagent/agents/dev",
  status: "idle",
};

const policy: AgentPolicy = {
  canReadWorkspace: true,
  canWriteWorkspace: true,
  canExecuteCommands: true,
  enabledTools: ["readFile", "writeFile", "shell"],
};
