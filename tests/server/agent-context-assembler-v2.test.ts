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
    expect(assembled.prompt.indexOf("human: 先检查报错")).toBeLessThan(assembled.prompt.indexOf("我会读取文件"));
    expect(assembled.prompt.indexOf("我会读取文件")).toBeLessThan(assembled.prompt.indexOf("[3] observation"));
    expect(assembled.prompt).not.toContain("taskRunId");
    expect(assembled.prompt).not.toContain("ticketGraph");
    expect(assembled.report.threadItems).toBe(4);
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
