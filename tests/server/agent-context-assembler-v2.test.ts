import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentContextAssembler } from "../../src/server/agent-engine/context-assembler.js";
import { AgentEngine } from "../../src/server/agent-engine/agent-engine.js";
import { AgentStore } from "../../src/server/agent-engine/agent-store.js";
import type { AgentPolicy, AgentProfile, WorkspaceAgent } from "../../src/shared/types.js";

describe("AgentContextAssembler", () => {
  it("assembles SIA tools, goal and one chronological thread without replaying prompts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-context-v2-"));
    const store = new AgentStore(root, "dev");
    const engine = new AgentEngine(store);
    const thread = await engine.ensureThread({ agentId: "dev", scopeId: "ws", idempotencyKey: "thread" });
    await engine.sendMessage({
      messageId: "human-1",
      threadId: thread.threadId,
      senderPrincipalId: "human",
      content: "先检查报错",
      createdAt: "2026-07-10T00:00:00.000Z",
    });
    await engine.appendModelItem({
      itemId: "model-1",
      threadId: thread.threadId,
      content: "我会读取文件。",
      createdAt: "2026-07-10T00:01:00.000Z",
    });
    await engine.appendToolItem({
      itemId: "tool-1",
      threadId: thread.threadId,
      kind: "observation",
      value: { tool: "readFile", ok: true, path: "src/main.ts" },
      createdAt: "2026-07-10T00:02:00.000Z",
    });
    await engine.appendToolItem({
      itemId: "usage-1",
      threadId: thread.threadId,
      kind: "control",
      value: { type: "provider_usage", goalId: "goal", totalTokens: 12345 },
      createdAt: "2026-07-10T00:02:30.000Z",
    });
    const goal = await engine.startGoal({
      agentId: "dev",
      threadId: thread.threadId,
      idempotencyKey: "goal",
      spec: {
        id: "goal",
        threadId: thread.threadId,
        objective: "修复页面",
        successCriteria: ["测试通过"],
        contextRefs: [],
        createdAt: "2026-07-10T00:03:00.000Z",
      },
    });
    const assembled = await new AgentContextAssembler(store).assemble({
      profile,
      agent,
      policy,
      thread: await engine.getThread(thread.threadId),
      goal,
    });

    expect(assembled.prompt.indexOf("## Soul")).toBeLessThan(assembled.prompt.indexOf("## Identity"));
    expect(assembled.prompt.indexOf("## Identity")).toBeLessThan(assembled.prompt.indexOf("## Agent"));
    expect(assembled.prompt.indexOf("## Agent")).toBeLessThan(assembled.prompt.indexOf("## Tools"));
    expect(assembled.prompt).toContain("human 提供的是目标和方向，不负责撰写完整规格");
    expect(assembled.prompt).toContain("不得把回答作为推进前提");
    expect(assembled.prompt).toContain("只有缺少不可替代输入时才提交 blocked");
    expect(assembled.prompt.indexOf("human: 先检查报错")).toBeLessThan(assembled.prompt.indexOf("我会读取文件"));
    expect(assembled.prompt.indexOf("我会读取文件")).toBeLessThan(assembled.prompt.indexOf("[3] observation"));
    expect(assembled.prompt).not.toContain("taskRunId");
    expect(assembled.prompt).not.toContain("ticketGraph");
    expect(assembled.prompt).not.toContain("provider_usage");
    expect(assembled.prompt).not.toContain("12345");
    expect(assembled.report.threadItems).toBe(5);
  });

  it("compacts the oldest thread items while preserving the newest human turn", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-context-v2-"));
    const store = new AgentStore(root, "dev");
    const engine = new AgentEngine(store);
    const thread = await engine.ensureThread({ agentId: "dev", scopeId: "ws", idempotencyKey: "compact-thread" });
    for (let index = 0; index < 12; index += 1) {
      await engine.sendMessage({
        messageId: `history-${index}`,
        threadId: thread.threadId,
        senderPrincipalId: "human",
        content: `旧消息 ${index} ${"历史内容".repeat(30)}`,
        createdAt: `2026-07-10T00:${String(index).padStart(2, "0")}:00.000Z`,
      });
    }
    await engine.sendMessage({
      messageId: "latest-human",
      threadId: thread.threadId,
      senderPrincipalId: "human",
      content: "这是最新指令，必须进入下一轮上下文",
      createdAt: "2026-07-10T01:00:00.000Z",
    });

    const assembled = await new AgentContextAssembler(store, 1_000).assemble({
      profile,
      agent,
      policy,
      thread: await engine.getThread(thread.threadId),
    });

    expect(assembled.prompt).toContain("历史已压缩");
    expect(assembled.prompt).toContain("这是最新指令，必须进入下一轮上下文");
    expect(assembled.prompt).not.toContain("旧消息 0 历史内容历史内容历史内容");
    expect(assembled.report.compactedThreadItems).toBeGreaterThan(0);
    expect(assembled.report.recentThreadItems).toBeGreaterThan(0);
  });
});

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
