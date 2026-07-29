import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentContextAssembler } from "../../src/server/agent-engine/context-assembler.js";
import { AgentEngine } from "../../src/server/agent-engine/agent-engine.js";
import { AgentStore } from "../../src/server/agent-engine/agent-store.js";
import type { AgentPolicy, AgentProfile, WorkspaceAgent } from "../../src/shared/types.js";
import { DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS, effectiveInputTokenBudget } from "../../src/shared/model-context.js";

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
    expect(assembled.instructions).toContain("冷静、求证");
    expect(assembled.instructions).toContain("软件工程师");
    expect(assembled.instructions).toContain("读取事实，修改代码，运行验证。");
    expect(assembled.instructions).toContain("默认值只能补充 human 未说明的细节");
    expect(assembled.instructions).toContain("不得把降级交付当作原目标完成");
    expect(assembled.instructions).toContain("完成或失败时调用 goal_resolution");
    expect(assembled.instructions).toContain("缺少不可替代的 human 输入时调用 request_human_input");
    expect(assembled.instructions).not.toContain("先检查报错");
    expect(assembled.prompt).not.toContain(agent.agentDir);
    expect(assembled.prompt).not.toContain("agent.json");
    expect(assembled.history).toEqual([
      { type: "user_message", content: "先检查报错" },
      { type: "assistant_message", content: "我会读取文件。" },
      { type: "tool_call", callId: "call-1", name: "readFile", arguments: { path: "src/main.ts" } },
      { type: "tool_result", callId: "call-1", content: JSON.stringify({ ok: true, content: "source" }), isError: false },
    ]);
    expect(assembled.history.every((item) => JSON.stringify(item).includes("## Soul") === false)).toBe(true);
  });

  it("keeps image references on the same chronological human message", async () => {
    const fixture = await contextFixture();
    const attachment = {
      attachmentId: "a".repeat(64),
      type: "image" as const,
      mimeType: "image/png" as const,
      fileName: "screen.png",
      size: 128,
    };
    await fixture.engine.sendMessage({
      messageId: "human-image",
      threadId: fixture.thread.threadId,
      senderPrincipalId: "human",
      content: "这里布局错了",
      attachments: [attachment],
      createdAt: "2026-07-13T00:00:00.000Z",
    });

    const assembled = await fixture.assembler.assemble({
      profile,
      agent,
      policy,
      thread: await fixture.engine.getThread(fixture.thread.threadId),
    });

    expect(assembled.history).toEqual([{
      type: "user_message",
      content: "这里布局错了",
      attachments: [attachment],
    }]);
    expect(assembled.prompt).toContain("图片附件 1 张");
  });

  it("keeps prior Goal facts auditable but excludes their raw tool history from a new Goal context", async () => {
    const fixture = await contextFixture();
    const priorGoal = await fixture.engine.startGoal({
      agentId: "dev",
      threadId: fixture.thread.threadId,
      idempotencyKey: "prior-goal",
      spec: {
        id: "prior-goal",
        threadId: fixture.thread.threadId,
        objective: "检查旧版本",
        successCriteria: ["旧版本已检查"],
        contextRefs: [],
        createdAt: "2026-07-13T00:00:00.000Z",
      },
    });
    await fixture.engine.appendToolItem({
      itemId: "prior-call",
      turnId: "prior-turn",
      threadId: fixture.thread.threadId,
      goalId: priorGoal.spec.id,
      kind: "tool",
      value: {
        type: "tool_call",
        goalId: priorGoal.spec.id,
        callId: "prior-call",
        name: "readFile",
        arguments: { path: "index.html" },
      },
      createdAt: "2026-07-13T00:01:00.000Z",
    });
    await fixture.engine.appendToolItem({
      itemId: "prior-result",
      turnId: "prior-turn",
      threadId: fixture.thread.threadId,
      goalId: priorGoal.spec.id,
      kind: "observation",
      value: {
        type: "tool_result",
        goalId: priorGoal.spec.id,
        callId: "prior-call",
        content: { evidenceId: "stale-prior-evidence" },
        isError: false,
      },
      createdAt: "2026-07-13T00:02:00.000Z",
    });
    const currentGoal = await fixture.engine.startGoal({
      agentId: "dev",
      threadId: fixture.thread.threadId,
      idempotencyKey: "current-goal",
      spec: {
        id: "current-goal",
        threadId: fixture.thread.threadId,
        objective: "验收新版本",
        successCriteria: ["新版本已验收"],
        contextRefs: [],
        createdAt: "2026-07-13T00:03:00.000Z",
      },
    });
    await fixture.engine.sendMessage({
      messageId: "current-instruction",
      threadId: fixture.thread.threadId,
      goalId: currentGoal.spec.id,
      senderPrincipalId: "mission-process",
      content: "使用正式 handoff 验收当前版本",
      createdAt: "2026-07-13T00:04:00.000Z",
    });

    const assembled = await fixture.assembler.assemble({
      profile,
      agent,
      policy,
      thread: await fixture.engine.getThread(fixture.thread.threadId),
      goal: currentGoal,
    });

    expect(JSON.stringify(assembled.history)).not.toContain("stale-prior-evidence");
    expect(JSON.stringify(assembled.history)).not.toContain("prior-call");
    expect(assembled.history).toContainEqual({
      type: "user_message",
      content: "使用正式 handoff 验收当前版本",
    });
    expect(assembled.history[0]).toMatchObject({
      type: "user_message",
      content: expect.stringContaining("Goal 上下文隔离"),
    });
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

  it("keeps rejected tool calls auditable without replaying recursive arguments to the model", async () => {
    const fixture = await contextFixture(220);
    const recursiveArguments = {
      status: "completed",
      criterionResults: [`bad-${"recursive-payload".repeat(2_000)}`],
    };
    await fixture.engine.appendToolItem({
      itemId: "invalid-call",
      threadId: fixture.thread.threadId,
      kind: "tool",
      value: {
        type: "tool_call",
        callId: "invalid-call",
        name: "goal_resolution",
        arguments: recursiveArguments,
      },
      createdAt: "2026-07-13T01:00:00.000Z",
    });
    await fixture.engine.appendToolItem({
      itemId: "invalid-result",
      threadId: fixture.thread.threadId,
      kind: "observation",
      value: {
        type: "tool_result",
        callId: "invalid-call",
        content: `Validation failed for tool "goal_resolution":\n- criterionResults/0 must be object\n\nReceived arguments:\n${JSON.stringify(recursiveArguments, null, 2)}`,
        isError: true,
      },
      createdAt: "2026-07-13T01:01:00.000Z",
    });

    const assembled = await fixture.assembler.assemble({
      profile,
      agent,
      policy,
      thread: await fixture.engine.getThread(fixture.thread.threadId),
    });

    expect(assembled.history).toContainEqual({
      type: "tool_call",
      callId: "invalid-call",
      name: "goal_resolution",
      arguments: expect.objectContaining({
        rejected: true,
        reason: "schema_validation_failed",
      }),
    });
    expect(JSON.stringify(assembled.history)).toContain("criterionResults/0 must be object");
    expect(JSON.stringify(assembled.history)).not.toContain("recursive-payload");
    expect(JSON.stringify(assembled.history).length).toBeLessThan(5_000);
  });

  it("bounds every semantic compaction request instead of sending the whole oversized prefix", async () => {
    const maxTokens = 220;
    const fixture = await contextFixture(maxTokens);
    for (let index = 0; index < 40; index += 1) {
      await fixture.engine.sendMessage({
        messageId: `large-history-${index}`,
        threadId: fixture.thread.threadId,
        senderPrincipalId: "human",
        content: `历史消息 ${index} ${"需要保留的事实".repeat(40)}`,
        createdAt: `2026-07-13T00:${String(index).padStart(2, "0")}:00.000Z`,
      });
    }

    const plan = await fixture.assembler.planCompaction(
      await fixture.engine.getThread(fixture.thread.threadId),
    );

    expect(plan).toBeDefined();
    expect(JSON.stringify(plan!.history).length).toBeLessThanOrEqual(Math.floor(maxTokens * 0.85) * 4);
    expect(plan!.originalItemCount).toBeGreaterThan(0);
    expect(plan!.originalItemCount).toBeLessThan(40);
  });

  it("reconstructs a restarted thread from persisted replacement history plus the chronological suffix", async () => {
    const fixture = await contextFixture(220);
    await fixture.engine.sendMessage({
      messageId: "old-request",
      threadId: fixture.thread.threadId,
      senderPrincipalId: "human",
      content: "读取 config.json 并记住端口是 4321",
      createdAt: "2026-07-13T00:00:00.000Z",
    });
    await fixture.engine.appendToolItem({
      itemId: "old-call",
      threadId: fixture.thread.threadId,
      kind: "tool",
      value: { type: "tool_call", callId: "old-call", name: "readFile", arguments: { path: "config.json" } },
      createdAt: "2026-07-13T00:01:00.000Z",
    });
    await fixture.engine.appendToolItem({
      itemId: "old-result",
      threadId: fixture.thread.threadId,
      kind: "observation",
      value: { type: "tool_result", callId: "old-call", content: { ok: true, content: "port=4321" }, isError: false },
      createdAt: "2026-07-13T00:02:00.000Z",
    });
    const beforeCompaction = await fixture.engine.getThread(fixture.thread.threadId);
    await fixture.engine.appendCompaction({
      itemId: "checkpoint-1",
      threadId: fixture.thread.threadId,
      replacedThroughSequence: beforeCompaction.items.at(-1)!.sequence,
      replacementHistory: [{
        type: "user_message",
        content: "[历史摘要] 已读取 config.json，确认端口为 4321。",
      }],
      originalItemCount: beforeCompaction.items.length,
      createdAt: "2026-07-13T00:03:00.000Z",
    });
    await fixture.engine.sendMessage({
      messageId: "new-request",
      threadId: fixture.thread.threadId,
      senderPrincipalId: "human",
      content: "继续处理启动问题",
      createdAt: "2026-07-13T00:04:00.000Z",
    });

    const restartedStore = new AgentStore(fixture.root, "dev");
    const restartedEngine = new AgentEngine(restartedStore);
    const assembled = await new AgentContextAssembler(restartedStore, 220).assemble({
      profile,
      agent,
      policy,
      thread: await restartedEngine.getThread(fixture.thread.threadId),
    });

    expect(assembled.history).toEqual([
      { type: "user_message", content: "[历史摘要] 已读取 config.json，确认端口为 4321。" },
      { type: "user_message", content: "继续处理启动问题" },
    ]);
    expect(JSON.stringify(assembled.history)).not.toContain("port=4321\"}");
    expect(assembled.report.compaction).toMatchObject({
      compacted: true,
      checkpointItemId: "checkpoint-1",
      replacedThroughSequence: beforeCompaction.items.at(-1)!.sequence,
    });
  });
});

async function contextFixture(maxTokens = effectiveInputTokenBudget(DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS)) {
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
