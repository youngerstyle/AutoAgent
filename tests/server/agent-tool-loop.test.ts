import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentContextAssembler } from "../../src/server/agent-engine/context-assembler.js";
import { AgentEngine } from "../../src/server/agent-engine/agent-engine.js";
import type { AgentProviderAdapter, AgentProviderRequest } from "../../src/server/agent-engine/provider-adapter.js";
import { AgentStore } from "../../src/server/agent-engine/agent-store.js";
import { AgentToolLoop } from "../../src/server/agent-engine/tool-loop.js";
import { AgentToolRuntime } from "../../src/server/agent-engine/tool-runtime.js";
import { AgentTraceStore } from "../../src/server/agent-engine/trace-store.js";
import type { AgentModelTurnResult } from "../../src/server/providers/types.js";
import { ProviderError } from "../../src/server/providers/types.js";
import type { EffectivePolicy } from "../../src/server/policy/policy.js";
import type { AgentProfile, WorkspaceAgent } from "../../src/shared/types.js";

describe("AgentToolLoop", () => {
  it("treats JSON-looking assistant text as speech and never as a control command", async () => {
    const text = JSON.stringify({
      toolIntents: [{ tool: "writeFile", path: "unsafe.txt", content: "bad" }],
      goalResolution: { status: "completed", summary: "not real" },
    });
    const fixture = await createFixture([{ items: [{ type: "assistant_message", content: text }] }]);

    const turn = await fixture.loop.runSlice(fixture.input);

    expect(turn.status).toBe("waiting");
    expect(turn.toolCalls).toBe(0);
    await expect(readFile(path.join(fixture.root, "unsafe.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fixture.engine.getGoal("goal")).toMatchObject({ status: "active" });
  });

  it("returns native tool results to the provider inside the same turn before resolving the goal", async () => {
    const fixture = await createFixture([
      {
        items: [
          { type: "assistant_message", content: "我先写入交付物。" },
          { type: "tool_call", callId: "call-write", name: "writeFile", arguments: { path: "done.txt", content: "ok" } },
        ],
      },
      {
        items: [{
          type: "tool_call",
          callId: "call-resolve",
          name: "goal_resolution",
          arguments: {
            status: "completed",
            summary: "已完成",
            evidence: [{ kind: "file", ref: "done.txt" }],
            criterionResults: completedCriteria(),
            residualRisks: [],
            domainOutcome: { artifact: "done.txt" },
          },
        }],
      },
    ]);

    const turn = await fixture.loop.runSlice(fixture.input);

    expect(turn).toMatchObject({ status: "resolution_proposed", toolCalls: 1 });
    expect(await readFile(path.join(fixture.root, "done.txt"), "utf8")).toBe("ok");
    expect(fixture.provider.requests).toHaveLength(2);
    expect(fixture.provider.requests[1].history.slice(-2)).toEqual([
      { type: "tool_call", callId: "call-write", name: "writeFile", arguments: { path: "done.txt", content: "ok" } },
      expect.objectContaining({ type: "tool_result", callId: "call-write", isError: false }),
    ]);
    const thread = await fixture.engine.getThread(fixture.input.threadId);
    const payloads = await fixture.engine.getPayloads(thread.items.map((item) => item.payloadRef));
    expect([...payloads.values()]).toContainEqual(expect.objectContaining({
      type: "tool_result",
      callId: "call-resolve",
      isError: false,
    }));
    expect(await fixture.engine.getGoal("goal")).toMatchObject({ status: "completed" });
  });

  it("continues beyond twenty successful tool calls while the turn is still making progress", async () => {
    const toolRounds: AgentModelTurnResult[] = Array.from({ length: 25 }, (_, index) => ({
      items: [{
        type: "tool_call" as const,
        callId: `write-${index + 1}`,
        name: "writeFile",
        arguments: { path: `progress-${index + 1}.txt`, content: String(index + 1) },
      }],
    }));
    const fixture = await createFixture([
      ...toolRounds,
      {
        items: [{
          type: "tool_call",
          callId: "resolve-after-progress",
          name: "goal_resolution",
          arguments: {
            status: "completed",
            summary: "连续工作完成",
            evidence: [{ kind: "file", ref: "progress-25.txt" }],
            criterionResults: completedCriteria(),
            residualRisks: [],
            domainOutcome: { artifact: "progress-25.txt" },
          },
        }],
      },
    ]);

    const turn = await fixture.loop.runSlice(fixture.input);

    expect(turn).toMatchObject({ status: "resolution_proposed", toolCalls: 25 });
    expect(fixture.provider.requests).toHaveLength(26);
    expect(await readFile(path.join(fixture.root, "progress-25.txt"), "utf8")).toBe("25");
  });

  it("returns invalid native tool arguments as a correlated error instead of executing or parsing text", async () => {
    const fixture = await createFixture([
      { items: [{ type: "tool_call", callId: "bad-write", name: "writeFile", arguments: { content: "missing path" } }] },
      { items: [{ type: "assistant_message", content: "我需要修正工具参数。" }] },
    ]);

    const turn = await fixture.loop.runSlice(fixture.input);

    expect(turn).toMatchObject({ status: "waiting", toolCalls: 1 });
    expect(fixture.provider.requests[1].history.at(-1)).toMatchObject({
      type: "tool_result",
      callId: "bad-write",
      isError: true,
    });
    expect(await fixture.engine.getGoal("goal")).toMatchObject({ status: "active" });
  });

  it("asks the model to repair a missing domain outcome inside the same turn", async () => {
    const fixture = await createFixture([
      { items: [{ type: "tool_call", callId: "resolve-missing-outcome", name: "goal_resolution", arguments: { status: "completed", summary: "完成", evidence: [], criterionResults: completedCriteria(), residualRisks: [] } }] },
      { items: [{ type: "tool_call", callId: "resolve-with-outcome", name: "goal_resolution", arguments: { status: "completed", summary: "完成", evidence: [], criterionResults: completedCriteria(), residualRisks: [], domainOutcome: { artifact: "done" } } }] },
    ]);

    const turn = await fixture.loop.runSlice(fixture.input);

    expect(turn.status).toBe("resolution_proposed");
    expect(fixture.provider.requests).toHaveLength(2);
    expect(fixture.provider.requests[1].history).toContainEqual(expect.objectContaining({
      type: "tool_result",
      callId: "resolve-missing-outcome",
      isError: true,
      content: expect.stringContaining("domainOutcome"),
    }));
  });

  it("does not accept completed until every success criterion is reported as satisfied", async () => {
    const fixture = await createFixture([
      { items: [{ type: "tool_call", callId: "missing-criteria", name: "goal_resolution", arguments: { status: "completed", summary: "完成", evidence: [], criterionResults: [], residualRisks: [], domainOutcome: { artifact: "done" } } }] },
      { items: [{ type: "tool_call", callId: "verified-criteria", name: "goal_resolution", arguments: { status: "completed", summary: "完成", evidence: [], criterionResults: completedCriteria(), residualRisks: [], domainOutcome: { artifact: "done" } } }] },
    ]);

    const turn = await fixture.loop.runSlice(fixture.input);

    expect(turn.status).toBe("resolution_proposed");
    expect(fixture.provider.requests[1].history).toContainEqual(expect.objectContaining({
      type: "tool_result",
      callId: "missing-criteria",
      isError: true,
      content: expect.stringContaining("逐项回应全部成功标准"),
    }));
  });

  it("normalizes the resolution summary from the domain outcome", async () => {
    const fixture = await createFixture([
      { items: [{
        type: "tool_call",
        callId: "resolve-with-domain-summary",
        name: "goal_resolution",
        arguments: {
          status: "completed",
          evidence: [],
          criterionResults: completedCriteria(),
          residualRisks: [],
          domainOutcome: { summary: "架构方案已完成", artifact: "architecture.md" },
        },
      }] },
    ]);

    const turn = await fixture.loop.runSlice(fixture.input);

    expect(turn.status).toBe("resolution_proposed");
    expect(await fixture.engine.getGoal("goal")).toMatchObject({ status: "completed" });
  });

  it("returns the exact invalid goal resolution field to the model", async () => {
    const fixture = await createFixture([
      {
        items: [{
          type: "tool_call",
          callId: "resolve-invalid-evidence",
          name: "goal_resolution",
          arguments: {
            status: "completed",
            summary: "完成",
            evidence: ["workspace listing"],
            criterionResults: completedCriteria(),
            residualRisks: [],
            domainOutcome: { artifact: "done" },
          },
        }],
      },
      { items: [{ type: "assistant_message", content: "我会按字段要求修正。" }] },
    ]);

    const turn = await fixture.loop.runSlice(fixture.input);

    expect(turn.status).toBe("waiting");
    expect(fixture.provider.requests[1].history).toContainEqual(expect.objectContaining({
      type: "tool_result",
      callId: "resolve-invalid-evidence",
      isError: true,
      content: expect.stringContaining("evidence[0] 必须是包含 kind 和 ref 字符串的对象"),
    }));
  });

  it("pauses after the same failed tool outcome repeats without progress", async () => {
    const invalidArguments = {
      status: "completed",
      summary: "完成",
      evidence: ["workspace listing"],
      criterionResults: completedCriteria(),
      residualRisks: [],
      domainOutcome: { artifact: "done" },
    };
    const fixture = await createFixture([
      { items: [{ type: "tool_call", callId: "invalid-1", name: "goal_resolution", arguments: invalidArguments }] },
      { items: [{ type: "tool_call", callId: "invalid-2", name: "goal_resolution", arguments: invalidArguments }] },
      { items: [{ type: "assistant_message", content: "不应继续调用模型" }] },
    ]);

    const turn = await fixture.loop.runSlice(fixture.input);

    expect(turn).toMatchObject({ status: "execution_blocked", blockReason: "no_progress" });
    expect(fixture.provider.requests).toHaveLength(2);
    expect(await fixture.engine.getGoal("goal")).toMatchObject({ status: "active" });
    const thread = await fixture.engine.getThread(fixture.input.threadId);
    const payloads = await fixture.engine.getPayloads(thread.items.map((item) => item.payloadRef));
    expect([...payloads.values()]).toContainEqual(expect.objectContaining({
      reason: "repeated_tool_error",
      status: "execution_blocked",
    }));
  });

  it("persists assistant, tool call and tool result in strict response order", async () => {
    const fixture = await createFixture([
      {
        items: [
          { type: "assistant_message", content: "读取前先说明。" },
          { type: "tool_call", callId: "call-list", name: "listFiles", arguments: { path: "." } },
          { type: "tool_call", callId: "call-read", name: "readFile", arguments: { path: "missing.txt" } },
        ],
      },
      { items: [{ type: "assistant_message", content: "读取完成。" }] },
    ]);

    await fixture.loop.runSlice(fixture.input);

    const thread = await fixture.engine.getThread(fixture.input.threadId);
    const payloads = await fixture.engine.getPayloads(thread.items.map((item) => item.payloadRef));
    const turnPayloads = thread.items
      .filter((item) => ["model", "tool", "observation"].includes(item.kind))
      .map((item) => payloads.get(item.payloadRef));
    expect(turnPayloads).toEqual([
      expect.objectContaining({ type: "assistant_message", content: "读取前先说明。" }),
      expect.objectContaining({ type: "tool_call", callId: "call-list" }),
      expect.objectContaining({ type: "tool_call", callId: "call-read" }),
      expect.objectContaining({ type: "tool_result", callId: "call-list", isError: false }),
      expect.objectContaining({ type: "tool_result", callId: "call-read", isError: true }),
      expect.objectContaining({ type: "assistant_message", content: "读取完成。" }),
    ]);
  });

  it("closes the turn without replaying a provider failure", async () => {
    const fixture = await createFixture([]);
    fixture.provider.error = new ProviderError("402 Insufficient Balance", false, "OPENAI_ERROR");

    const slice = await fixture.loop.runSlice(fixture.input);

    expect(slice).toMatchObject({ status: "execution_blocked", toolCalls: 0 });
    expect(fixture.provider.requests).toHaveLength(1);
    expect(await fixture.engine.getGoal("goal")).toMatchObject({ status: "active" });
  });

  it("does not accept goal resolution in the same response as unfinished workspace tools", async () => {
    const fixture = await createFixture([
      {
        items: [
          { type: "tool_call", callId: "write-first", name: "writeFile", arguments: { path: "mixed.txt", content: "ok" } },
          { type: "tool_call", callId: "resolve-too-early", name: "goal_resolution", arguments: { status: "completed", summary: "完成", evidence: [], criterionResults: completedCriteria(), residualRisks: [], domainOutcome: { artifact: "mixed.txt" } } },
        ],
      },
      {
        items: [{ type: "tool_call", callId: "resolve-after-result", name: "goal_resolution", arguments: { status: "completed", summary: "完成", evidence: [{ kind: "file", ref: "mixed.txt" }], criterionResults: completedCriteria(), residualRisks: [], domainOutcome: { artifact: "mixed.txt" } } }],
      },
    ]);

    const turn = await fixture.loop.runSlice(fixture.input);

    expect(turn.status).toBe("resolution_proposed");
    expect(fixture.provider.requests).toHaveLength(2);
    expect(fixture.provider.requests[1].history).toContainEqual(expect.objectContaining({
      type: "tool_result",
      callId: "resolve-too-early",
      isError: true,
    }));
  });

  it("stops before another provider call when the token window is exhausted inside a turn", async () => {
    const fixture = await createFixture([
      {
        items: [{ type: "tool_call", callId: "read-once", name: "listFiles", arguments: { path: "." } }],
        usage: { inputTokens: 45, outputTokens: 15, totalTokens: 60 },
      },
      { items: [{ type: "assistant_message", content: "不应再调用" }] },
    ], { maxTokensPerGoalWindow: 50 });

    const turn = await fixture.loop.runSlice(fixture.input);

    expect(turn).toMatchObject({ status: "execution_blocked", blockReason: "usage_limit" });
    expect(fixture.provider.requests).toHaveLength(1);
    expect(await fixture.engine.getGoal("goal")).toMatchObject({ status: "active" });
  });

  it("persists semantic replacement history before running an oversized thread", async () => {
    const fixture = await createFixture([
      { items: [{ type: "assistant_message", content: "已读取 config.json，确认开发服务端口为 4321；后续无需重复读取，除非文件发生变化。" }] },
      { items: [{ type: "assistant_message", content: "我会继续处理当前目标。" }] },
      { items: [{ type: "assistant_message", content: "继续使用既有事实处理。" }] },
    ], { maxContextTokens: 220 });
    for (let index = 0; index < 10; index += 1) {
      await fixture.engine.sendMessage({
        messageId: `history-${index}`,
        threadId: fixture.input.threadId,
        goalId: fixture.input.goalId,
        senderPrincipalId: "human",
        content: `历史消息 ${index} ${"内容".repeat(8)}`,
        createdAt: `2026-07-13T00:${String(index).padStart(2, "0")}:00.000Z`,
      });
    }
    await fixture.engine.sendMessage({
      messageId: "latest-human",
      threadId: fixture.input.threadId,
      goalId: fixture.input.goalId,
      senderPrincipalId: "human",
      content: "最新要求：修复后先运行测试。",
      createdAt: "2026-07-13T00:10:30.000Z",
    });

    const turn = await fixture.loop.runSlice(fixture.input);

    expect(turn.status).toBe("waiting");
    expect(fixture.provider.requests).toHaveLength(2);
    expect(fixture.provider.requests[0]).toMatchObject({ tools: [] });
    expect(fixture.provider.requests[0].instructions).toContain("上下文压缩");
    expect(fixture.provider.requests[1].history).toContainEqual({
      type: "user_message",
      content: "[历史摘要]\n已读取 config.json，确认开发服务端口为 4321；后续无需重复读取，除非文件发生变化。",
    });
    expect(fixture.provider.requests[1].history).toContainEqual({
      type: "user_message",
      content: "最新要求：修复后先运行测试。",
    });
    expect(JSON.stringify(fixture.provider.requests[1].history)).not.toContain("历史消息 0");
    const thread = await fixture.engine.getThread(fixture.input.threadId);
    expect(thread.items).toContainEqual(expect.objectContaining({ kind: "compaction" }));

    await fixture.loop.runSlice(fixture.input);

    expect(fixture.provider.requests).toHaveLength(3);
    expect(fixture.provider.requests[2].instructions).not.toContain("上下文压缩");
    expect(fixture.provider.requests[2].history).toContainEqual({
      type: "user_message",
      content: "[历史摘要]\n已读取 config.json，确认开发服务端口为 4321；后续无需重复读取，除非文件发生变化。",
    });
  });

  it("uses 90 percent of the selected model context window as the input budget", async () => {
    const fixture = await createFixture([
      { items: [{ type: "assistant_message", content: "保留目标和最新事实。" }] },
      { items: [{ type: "assistant_message", content: "继续" }] },
    ]);
    Object.assign(fixture.input, { contextWindowTokens: 1_000 });
    for (let index = 0; index < 12; index += 1) {
      await fixture.engine.sendMessage({
        messageId: `configured-window-${index}`,
        threadId: fixture.input.threadId,
        goalId: fixture.input.goalId,
        senderPrincipalId: "human",
        content: `历史消息 ${index} ${"需要保留的事实".repeat(20)}`,
        createdAt: `2026-07-13T01:${String(index).padStart(2, "0")}:00.000Z`,
      });
    }

    await fixture.loop.runSlice(fixture.input);

    const compactionRequest = fixture.provider.requests.find((request) => request.instructions.includes("上下文压缩"));
    expect(compactionRequest).toBeDefined();
    expect(JSON.stringify(compactionRequest!.history).length).toBeLessThanOrEqual(Math.floor(1_000 * 0.9 * 0.85) * 4);
  });

  it("rejects an oversized compaction summary instead of persisting a self-expanding checkpoint", async () => {
    const fixture = await createFixture([
      { items: [{ type: "assistant_message", content: "过长摘要".repeat(100) }] },
    ], { maxContextTokens: 220 });
    for (let index = 0; index < 10; index += 1) {
      await fixture.engine.sendMessage({
        messageId: `oversized-history-${index}`,
        threadId: fixture.input.threadId,
        senderPrincipalId: "human",
        content: `历史消息 ${index}：${"需要压缩的事实".repeat(8)}`,
        createdAt: `2026-07-13T00:2${index}:00.000Z`,
      });
    }

    const turn = await fixture.loop.runSlice(fixture.input);

    expect(turn).toMatchObject({ status: "execution_blocked", blockReason: "provider_protocol" });
    expect(fixture.provider.requests).toHaveLength(1);
    expect(fixture.provider.requests[0].instructions).toContain("摘要不得超过");
    expect((await fixture.engine.getThread(fixture.input.threadId)).items).not.toContainEqual(
      expect.objectContaining({ kind: "compaction" }),
    );
  });
});

function completedCriteria() {
  return [{ criterionIndex: 0, status: "satisfied", evidence: [] }];
}

class QueueProvider implements AgentProviderAdapter {
  error?: Error;
  requests: AgentProviderRequest[] = [];

  constructor(private readonly results: AgentModelTurnResult[]) {}

  async run(input: AgentProviderRequest): Promise<AgentModelTurnResult> {
    this.requests.push(structuredClone(input));
    if (this.error) throw this.error;
    const next = this.results.shift();
    if (!next) throw new Error("No provider result queued");
    return next;
  }
}

async function createFixture(
  results: AgentModelTurnResult[],
  options: { maxTokensPerGoalWindow?: number; maxContextTokens?: number } = {},
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-loop-native-"));
  const store = new AgentStore(root, "dev");
  const engine = new AgentEngine(store, undefined, { now: () => new Date("2026-07-13T00:00:00.000Z") });
  const thread = await engine.ensureThread({ agentId: "dev", scopeId: "ws", idempotencyKey: "thread" });
  await engine.startGoal({
    agentId: "dev",
    threadId: thread.threadId,
    idempotencyKey: "goal",
    spec: {
      id: "goal",
      threadId: thread.threadId,
      objective: "交付文件",
      successCriteria: ["文件存在"],
      contextRefs: [],
      createdAt: "2026-07-13T00:00:00.000Z",
    },
  });
  const policy: EffectivePolicy = {
    profile: "development",
    workspaceRoot: root,
    canReadWorkspace: true,
    canWriteWorkspace: true,
    canExecuteCommands: true,
    enabledTools: ["listFiles", "readFile", "writeFile", "shell"],
  };
  const traces = new AgentTraceStore(root, "dev");
  const provider = new QueueProvider(results);
  const loop = new AgentToolLoop(
    engine,
    new AgentContextAssembler(store, options.maxContextTokens),
    provider,
    new AgentToolRuntime(policy, [...(policy.enabledTools ?? [])]),
    traces,
    { maxTokensPerGoalWindow: options.maxTokensPerGoalWindow, now: () => new Date("2026-07-13T00:01:00.000Z") },
  );
  return {
    root,
    engine,
    traces,
    provider,
    loop,
    input: {
      threadId: thread.threadId,
      goalId: "goal",
      profile,
      agent,
      policy,
      provider: "mock" as const,
      model: "mock",
      ...(options.maxContextTokens === undefined
        ? {}
        : { contextWindowTokens: Math.ceil(options.maxContextTokens / 0.9) }),
    },
  };
}

const profile: AgentProfile = {
  id: "profile-dev",
  name: "开发",
  role: "dev",
  soul: "求证",
  identity: "工程师",
  agentMd: "使用工具完成目标。",
  capabilities: ["编码"],
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
