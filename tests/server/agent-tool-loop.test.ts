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
import type { AgentTurnResult } from "../../src/server/providers/types.js";
import { ProviderError } from "../../src/server/providers/types.js";
import type { AgentProfile, WorkspaceAgent } from "../../src/shared/types.js";
import type { EffectivePolicy } from "../../src/server/policy/policy.js";

describe("AgentToolLoop", () => {
  it("keeps normal replies active, yields for tools, then completes only from an explicit proposal", async () => {
    const fixture = await createFixture([
      result("我先分析。", { message: "analysis" }),
      result("写入修复。", { toolIntents: [{ tool: "writeFile", path: "done.txt", content: "ok" }] }),
      result("目标完成。", { goalResolution: { status: "completed", summary: "已完成", evidence: [{ kind: "file", ref: "done.txt" }] } }),
    ]);

    const first = await fixture.loop.runSlice(fixture.input);
    expect(first.status).toBe("yielded");
    expect(await fixture.engine.getGoal("goal")).toMatchObject({ status: "active" });
    const firstTail = (await fixture.engine.getThread(fixture.input.threadId)).items.at(-1)!;
    expect(await fixture.engine.getPayload(firstTail.payloadRef)).toMatchObject({
      status: "yielded",
      reason: "active_goal_unresolved"
    });

    const second = await fixture.loop.runSlice(fixture.input);
    expect(second).toMatchObject({ status: "yielded", toolCalls: 1 });
    expect(await readFile(path.join(fixture.root, "done.txt"), "utf8")).toBe("ok");
    expect(await fixture.engine.getGoal("goal")).toMatchObject({ status: "active" });

    const third = await fixture.loop.runSlice(fixture.input);
    expect(third.status).toBe("resolution_proposed");
    expect(await fixture.engine.getGoal("goal")).toMatchObject({ status: "completed" });
    expect((await fixture.traces.list()).some((trace) => trace.kind === "context")).toBe(true);
  });

  it("turns a slice budget into yield without failing or completing the goal", async () => {
    const fixture = await createFixture([
      result("多个工具", { toolIntents: [
        { tool: "writeFile", path: "one.txt", content: "1" },
        { tool: "writeFile", path: "two.txt", content: "2" },
      ] }),
    ], 1);

    expect(await fixture.loop.runSlice(fixture.input)).toMatchObject({ status: "yielded", toolCalls: 1 });
    expect(await fixture.engine.getGoal("goal")).toMatchObject({ status: "active" });
  });

  it("stores the structured human-facing message instead of raw protocol JSON", async () => {
    const structured = {
      message: "已完成交付。",
      goalResolution: { status: "completed", summary: "交付完成", evidence: [] }
    };
    const fixture = await createFixture([{ text: JSON.stringify(structured), structured, events: [] }]);

    await fixture.loop.runSlice(fixture.input);

    const thread = await fixture.engine.getThread(fixture.input.threadId);
    const model = [...thread.items].reverse().find((item) => item.kind === "model")!;
    expect(await fixture.engine.getPayload(model.payloadRef)).toMatchObject({ content: "已完成交付。" });
  });

  it("closes the turn and suspends execution when the provider rejects a non-retryable request", async () => {
    const fixture = await createFixture([]);
    fixture.provider.error = new ProviderError("402 Insufficient Balance", false, "OPENAI_ERROR");

    const slice = await fixture.loop.runSlice(fixture.input);

    expect(slice).toMatchObject({ status: "execution_blocked", toolCalls: 0 });
    const thread = await fixture.engine.getThread(fixture.input.threadId);
    const tail = thread.items.at(-1)!;
    expect(tail.kind).toBe("control");
    expect(await fixture.engine.getPayload(tail.payloadRef)).toMatchObject({
      status: "execution_blocked",
      reason: "provider_error",
      retryable: false,
      code: "OPENAI_ERROR",
      message: "402 Insufficient Balance",
    });
    expect((await fixture.traces.list()).at(-1)).toMatchObject({ kind: "error" });
  });

  it("stops before exceeding the configured token window and lets a new human message reopen it", async () => {
    const working = result("继续工作", { toolIntents: [{ tool: "writeFile", path: "progress.txt", content: "ok" }] });
    working.usage = { inputTokens: 25, outputTokens: 10, totalTokens: 35 };
    const fixture = await createFixture([structuredClone(working), structuredClone(working), structuredClone(working)], 20, 50);

    await fixture.loop.runSlice(fixture.input);
    await fixture.loop.runSlice(fixture.input);
    expect(await fixture.loop.runSlice(fixture.input)).toMatchObject({ status: "execution_blocked", toolCalls: 0 });
    expect(fixture.provider.calls).toBe(2);

    await fixture.engine.sendMessage({
      messageId: "human-reopens-usage-window",
      threadId: fixture.input.threadId,
      goalId: fixture.input.goalId,
      senderPrincipalId: "human",
      content: "我确认继续",
      createdAt: "2026-07-10T00:02:00.000Z",
    });
    expect(await fixture.loop.runSlice(fixture.input)).toMatchObject({ status: "yielded" });
    expect(fixture.provider.calls).toBe(3);
  });
});

class QueueProvider implements AgentProviderAdapter {
  error?: Error;
  calls = 0;
  constructor(private readonly results: AgentTurnResult[]) {}
  async run(_input: AgentProviderRequest): Promise<AgentTurnResult> {
    this.calls += 1;
    if (this.error) throw this.error;
    const next = this.results.shift();
    if (!next) throw new Error("No provider result queued");
    return next;
  }
}

function result(text: string, structured: Record<string, unknown>): AgentTurnResult {
  return { text, structured, events: [] };
}

async function createFixture(results: AgentTurnResult[], maxToolCallsPerSlice = 20, maxTokensPerGoalWindow?: number) {
  const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-loop-v2-"));
  const store = new AgentStore(root, "dev");
  const engine = new AgentEngine(store, undefined, { now: () => new Date("2026-07-10T00:00:00.000Z") });
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
      createdAt: "2026-07-10T00:00:00.000Z",
    },
  });
  const policy: EffectivePolicy = {
    profile: "development" as const,
    workspaceRoot: root,
    canReadWorkspace: true,
    canWriteWorkspace: true,
    canExecuteCommands: true,
    enabledTools: ["readFile", "writeFile", "shell"],
  };
  const traces = new AgentTraceStore(root, "dev");
  const provider = new QueueProvider(results);
  const loop = new AgentToolLoop(
    engine,
    new AgentContextAssembler(store),
    provider,
    new AgentToolRuntime(policy, [...(policy.enabledTools ?? [])]),
    traces,
    { maxToolCallsPerSlice, maxTokensPerGoalWindow, now: () => new Date("2026-07-10T00:01:00.000Z") },
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
