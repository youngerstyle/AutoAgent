import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ensureCoreTeam } from "../../src/server/agents/roster";
import { ContextAssembler } from "../../src/server/context/context-assembler";
import { ContextStore } from "../../src/server/context/context-store";
import { estimateTokens, truncateToTokenBudget } from "../../src/server/context/token-budget";
import { SessionStore } from "../../src/server/storage/session-store";
import type { Ticket, Workspace } from "../../src/shared/types";

describe("context budget and store", () => {
  it("estimates token budget from characters and marks truncated content", () => {
    expect(estimateTokens("12345678")).toBe(2);

    const result = truncateToTokenBudget("a".repeat(100), 10, "测试段落");

    expect(result.text).toContain("测试段落截断");
    expect(result.text).toContain("原始长度 100 字符");
    expect(estimateTokens(result.text)).toBeLessThanOrEqual(40);
  });

  it("stores derived context state and workspace-agent memory separately from agent sessions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-context-"));
    const store = new ContextStore();

    await store.writeState(root, "wa_dev", "tr_1", {
      id: "tr_1",
      workspaceAgentId: "wa_dev",
      taskRunId: "tr_1",
      checkpoints: [{
        id: "ctx_1",
        reason: "threshold",
        summary: "旧上下文摘要",
        replacementHistory: [],
        originalChars: 20000,
        summaryChars: 120,
        createdAt: "2026-07-07T00:00:00.000Z"
      }],
      updatedAt: "2026-07-07T00:00:00.000Z"
    });
    await store.writeMemory(root, "wa_dev", {
      workspaceAgentId: "wa_dev",
      durableFacts: ["项目使用 Vite"],
      projectConventions: ["测试用 npm.cmd run test:run"],
      knownCommands: ["npm.cmd run build"],
      recentLessons: ["不要把 session 原文直接塞进 prompt"],
      updatedAt: "2026-07-07T00:00:00.000Z"
    });

    await new SessionStore().appendTurn(root, "wa_dev", "tr_1", {
      user: "完整原始 prompt",
      assistant: "完整模型返回",
      toolResults: []
    });

    await expect(store.readState(root, "wa_dev", "tr_1")).resolves.toMatchObject({
      checkpoints: [{ summary: "旧上下文摘要" }]
    });
    await expect(store.readMemory(root, "wa_dev")).resolves.toMatchObject({
      durableFacts: ["项目使用 Vite"]
    });
    await expect(new SessionStore().read(root, "wa_dev", "tr_1")).resolves.toMatchObject({
      messages: [{ content: "完整原始 prompt" }, { content: "完整模型返回" }]
    });
  });
});

describe("ContextAssembler", () => {
  it("assembles bounded prompt sections without directly replaying raw previous prompts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-context-"));
    const workspace = testWorkspace(root);
    const [_boss, pm] = await ensureCoreTeam(workspace);
    const sessionStore = new SessionStore();
    const contextStore = new ContextStore();
    const assembler = new ContextAssembler(contextStore);
    const longPreviousPrompt = `PREVIOUS_PROMPT_START\n${"历史 prompt 内容 ".repeat(6000)}\nPREVIOUS_PROMPT_END`;

    await sessionStore.appendTurn(root, pm.id, "tr_1", {
      user: longPreviousPrompt,
      assistant: "{\"action\":\"create_change_set\",\"tickets\":[]}",
      toolResults: []
    });
    await contextStore.writeMemory(root, pm.id, {
      workspaceAgentId: pm.id,
      durableFacts: ["用户希望工单系统像真实 PM 系统一样流转"],
      projectConventions: [],
      knownCommands: [],
      recentLessons: ["session 历史只能通过 context assembler 有界进入 prompt"],
      updatedAt: "2026-07-07T00:00:00.000Z"
    });

    const session = await sessionStore.read(root, pm.id, "tr_1");
    const assembled = await assembler.assemble({
      workspace,
      agent: pm,
      sessionId: "tr_1",
      taskRunId: "tr_1",
      goal: "规划上下文系统",
      type: "pm_plan",
      brief: "拆解上下文和记忆架构",
      expectedArtifact: "执行计划",
      context: { latestHumanFollowup: { message: "继续" } },
      session,
      toolResults: [{ tool: "readFile", path: "huge.ts", content: `FILE_START\n${"源码 ".repeat(8000)}\nFILE_END`, ok: true }]
    });

    expect(assembled.prompt.indexOf("灵魂特质")).toBeLessThan(assembled.prompt.indexOf("当前任务"));
    expect(assembled.prompt.indexOf("当前任务")).toBeLessThan(assembled.prompt.indexOf("工作区记忆"));
    expect(assembled.prompt.indexOf("工作区记忆")).toBeLessThan(assembled.prompt.indexOf("近期会话"));
    expect(assembled.prompt).toContain("用户希望工单系统像真实 PM 系统一样流转");
    expect(assembled.prompt).toContain("历史 assembled prompt 已过滤");
    expect(assembled.prompt).not.toContain("PREVIOUS_PROMPT_START");
    expect(assembled.prompt).not.toContain("PREVIOUS_PROMPT_END");
    expect(assembled.prompt).toContain("工具结果截断");
    expect(assembled.prompt).toContain("FILE_START");
    expect(assembled.prompt).not.toContain("FILE_END");
    expect(assembled.report.sections.map((section) => section.name)).toEqual([
      "stable_prompt",
      "current_assignment",
      "workspace_memory",
      "session_summary",
      "recent_turns",
      "tool_observations",
      "dynamic_context"
    ]);
    expect(assembled.report.originalSessionChars).toBeGreaterThan(40_000);
    expect(assembled.report.injectedChars).toBeLessThan(40_000);
    expect(assembled.report.sections.some((section) => section.truncated)).toBe(true);
  });

  it("does not inject direct human chat projections through dynamic context", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-context-"));
    const workspace = testWorkspace(root);
    const [_boss, _pm, _architect, dev] = await ensureCoreTeam(workspace);
    const sessionStore = new SessionStore();
    const assembler = new ContextAssembler(new ContextStore());

    await sessionStore.appendTurn(root, dev.id, "tr_direct", {
      user: "已有开发任务上下文",
      assistant: "{\"status\":\"working\"}",
      toolResults: []
    });

    const assembled = await assembler.assemble({
      workspace,
      agent: dev,
      sessionId: "tr_direct",
      taskRunId: "tr_direct",
      goal: "继续开发",
      type: "implementation",
      brief: "实现功能",
      expectedArtifact: "可运行交付物",
      context: {
        agentDirectMessages: [{ message: "旁路不该进入 prompt" }],
        latestAgentDirectMessage: { message: "旁路不该进入 prompt" }
      },
      session: await sessionStore.read(root, dev.id, "tr_direct"),
      toolResults: []
    });

    expect(assembled.prompt).not.toContain("旁路不该进入 prompt");
  });

  it("backfills replacement history for legacy checkpoints with the same id", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-context-"));
    const workspace = testWorkspace(root);
    const [_boss, pm] = await ensureCoreTeam(workspace);
    const sessionStore = new SessionStore();
    const contextStore = new ContextStore();
    const assembler = new ContextAssembler(contextStore);

    for (let index = 0; index < 5; index += 1) {
      await sessionStore.appendTurn(root, pm.id, "tr_legacy", {
        user: `历史用户 ${index}\n${"旧上下文 ".repeat(10000)}`,
        assistant: `历史助手 ${index}\n${"旧结论 ".repeat(10000)}`,
        toolResults: []
      });
    }

    const session = await sessionStore.read(root, pm.id, "tr_legacy");
    await assembler.assemble({
      workspace,
      agent: pm,
      sessionId: "tr_legacy",
      taskRunId: "tr_legacy",
      goal: "迁移旧 checkpoint",
      type: "pm_plan",
      brief: "补齐 replacement history",
      expectedArtifact: "执行计划",
      session
    });
    const state = await contextStore.readState(root, pm.id, "tr_legacy");
    const checkpoint = state.checkpoints[0];
    expect(checkpoint.replacementHistory.length).toBeGreaterThan(0);

    await contextStore.writeState(root, pm.id, "tr_legacy", {
      ...state,
      checkpoints: [{ ...checkpoint, replacementHistory: [] }]
    });

    await assembler.assemble({
      workspace,
      agent: pm,
      sessionId: "tr_legacy",
      taskRunId: "tr_legacy",
      goal: "迁移旧 checkpoint",
      type: "pm_plan",
      brief: "补齐 replacement history",
      expectedArtifact: "执行计划",
      session
    });

    const migrated = await contextStore.readState(root, pm.id, "tr_legacy");
    expect(migrated.checkpoints[0].id).toBe(checkpoint.id);
    expect(migrated.checkpoints[0].replacementHistory.length).toBeGreaterThan(1);
    expect(migrated.checkpoints[0].replacementHistory[0].metadata).toMatchObject({
      contextCompaction: true
    });
  });

  it("only requires ticketGraph for root PM planning tickets", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-context-"));
    const workspace = testWorkspace(root);
    const [_boss, pm] = await ensureCoreTeam(workspace);
    const sessionStore = new SessionStore();
    const assembler = new ContextAssembler(new ContextStore());
    const session = await sessionStore.read(root, pm.id, "tr_pm_rules");

    const rootPm = await assembler.assemble({
      workspace,
      agent: pm,
      sessionId: "tr_pm_rules",
      taskRunId: "tr_pm_rules",
      goal: "做一个坦克大战",
      type: "pm_plan",
      brief: "拆解项目执行 DAG",
      expectedArtifact: "执行计划",
      currentTicket: ticket({ id: "tk_root", brief: "计划拆解" }),
      session
    });

    const pmWork = await assembler.assemble({
      workspace,
      agent: pm,
      sessionId: "tr_pm_rules",
      taskRunId: "tr_pm_rules",
      goal: "做一个坦克大战",
      type: "pm_plan",
      brief: "竞品参考与机制确认",
      expectedArtifact: "核心机制确认文档",
      currentTicket: ticket({ id: "tk_pm_ref", brief: "竞品参考与机制确认", plannedByTicketId: "tk_root" }),
      session
    });

    expect(rootPm.prompt).toContain("产品/项目根规划工单必须优先返回 ticketGraph 数组");
    expect(rootPm.prompt).toContain("根规划 ticketGraph 不能包含 human_action");
    expect(rootPm.prompt).toContain("工单：计划拆解（PM 根规划票）");
    expect(pmWork.prompt).not.toContain("根规划工单必须优先返回 ticketGraph");
    expect(pmWork.prompt).not.toContain("根规划 ticketGraph 不能包含 human_action");
    expect(pmWork.prompt).toContain("这是 PM 已拆出的普通 PM 工作工单");
    expect(pmWork.prompt).toContain("工单：竞品参考与机制确认（PM 工作票）");
  });

  it("only exposes command tools to agents with command permission", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-context-"));
    const workspace = testWorkspace(root);
    const [_boss, pm, _architect, dev] = await ensureCoreTeam(workspace);
    const sessionStore = new SessionStore();
    const assembler = new ContextAssembler(new ContextStore());

    const pmPrompt = await assembler.assemble({
      workspace,
      agent: pm,
      sessionId: "tr_pm_tools",
      taskRunId: "tr_pm_tools",
      goal: "拆解一个 Vite 项目修复任务",
      type: "pm_plan",
      brief: "计划拆解",
      expectedArtifact: "执行计划",
      currentTicket: ticket({ id: "tk_pm_tools", brief: "计划拆解" }),
      session: await sessionStore.read(root, pm.id, "tr_pm_tools")
    });

    const devPrompt = await assembler.assemble({
      workspace,
      agent: dev,
      sessionId: "tr_dev_tools",
      taskRunId: "tr_dev_tools",
      goal: "修复 Vite 项目",
      type: "implementation",
      brief: "开发执行",
      expectedArtifact: "可运行交付物",
      session: await sessionStore.read(root, dev.id, "tr_dev_tools")
    });

    expect(pmPrompt.prompt).toContain("当前没有启用命令类工具");
    expect(pmPrompt.prompt).toContain("docs/notes.md");
    expect(pmPrompt.prompt).not.toContain("\"tool\":\"shell\"");
    expect(pmPrompt.prompt).not.toContain("\"tool\":\"startService\"");
    expect(pmPrompt.prompt).not.toContain("\"tool\":\"pollProcess\"");
    expect(devPrompt.prompt).toContain("\"tool\":\"shell\"");
    expect(devPrompt.prompt).toContain("\"tool\":\"startService\"");
    expect(devPrompt.prompt).toContain("\"tool\":\"pollProcess\"");
  });
});

function testWorkspace(root: string): Workspace {
  return {
    id: "ws_1",
    name: "测试工作区",
    rootPath: root,
    policyProfile: "production",
    createdAt: "2026-07-07T00:00:00.000Z"
  };
}

function ticket(input: { id: string; brief: string; plannedByTicketId?: string }): Ticket {
  return {
    id: input.id,
    workspaceId: "ws_1",
    taskId: "task_1",
    taskRunId: "tr_pm_rules",
    type: "pm_plan",
    status: "pending",
    brief: input.brief,
    expectedArtifact: "执行计划",
    targetRole: "pm",
    priority: 0,
    attempt: 0,
    plannedByTicketId: input.plannedByTicketId,
    createdAt: "2026-07-08T00:00:00.000Z",
    updatedAt: "2026-07-08T00:00:00.000Z"
  };
}
