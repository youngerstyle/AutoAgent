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
    expect(first.status).toBe("waiting");
    expect(await fixture.engine.getGoal("goal")).toMatchObject({ status: "active" });

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
});

class QueueProvider implements AgentProviderAdapter {
  constructor(private readonly results: AgentTurnResult[]) {}
  async run(_input: AgentProviderRequest): Promise<AgentTurnResult> {
    const next = this.results.shift();
    if (!next) throw new Error("No provider result queued");
    return next;
  }
}

function result(text: string, structured: Record<string, unknown>): AgentTurnResult {
  return { text, structured, events: [] };
}

async function createFixture(results: AgentTurnResult[], maxToolCallsPerSlice = 20) {
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
  const loop = new AgentToolLoop(
    engine,
    new AgentContextAssembler(store),
    new QueueProvider(results),
    new AgentToolRuntime(policy, [...(policy.enabledTools ?? [])]),
    traces,
    { maxToolCallsPerSlice, now: () => new Date("2026-07-10T00:01:00.000Z") },
  );
  return {
    root,
    engine,
    traces,
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
