import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentRuntime, type ProviderRunner } from "../../src/server/agents/agent-runtime";
import { ensureCoreTeam } from "../../src/server/agents/roster";
import { EventLedger } from "../../src/server/storage/event-ledger";
import { workspaceAgentSessionsDir } from "../../src/server/storage/paths";
import { SessionStore } from "../../src/server/storage/session-store";
import type { AgentTurnInput, AgentTurnResult } from "../../src/server/providers/types";
import type { AgentProfile, Workspace } from "../../src/shared/types";

describe("AgentRuntime", () => {
  it("runs an assignment through provider events, tools, event ledger, and an agent session", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-runtime-"));
    const workspace = testWorkspace(root);
    const [boss, _pm, _architect, dev] = await ensureCoreTeam(workspace);
    expect(boss.id).toBe("wa_boss");
    const ledger = new EventLedger();
    const runtime = new AgentRuntime(ledger, new StaticProvider());

    const result = await runtime.runAssignment({
      workspace,
      agent: dev,
      taskId: "task_1",
      taskRunId: "tr_1",
      goal: "Ship a demo",
      type: "implementation",
      brief: "Create a result file",
      expectedArtifact: "AUTOAGENT_RESULT.md"
    });

    expect(result.assignmentRun.status).toBe("completed");
    await expect(readFile(path.join(root, "AUTOAGENT_RESULT.md"), "utf8")).resolves.toContain("done");
    const events = await ledger.read(root, "task_1", "tr_1");
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining([
      "assignment.created",
      "agent.step_started",
      "provider.completed",
      "tool.completed",
      "assignment.completed"
    ]));
    expect(events.find((event) => event.type === "assignment.created")?.summary).toBe("已创建开发执行任务");
    expect(events.find((event) => event.type === "provider.completed")?.summary).toBe("开发的模型调用已完成");
    expect(events.find((event) => event.type === "assignment.completed")?.summary).toBe("开发已完成开发执行");
    const session = await new SessionStore().read(root, dev.id, "tr_1");
    expect(session.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"]);
  });

  it("treats legacy action JSON as a real tool request and follows up with true tool results", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-runtime-"));
    const workspace = testWorkspace(root);
    const [_boss, _pm, _architect, dev] = await ensureCoreTeam(workspace);
    const provider = new LegacyActionProvider();
    const runtime = new AgentRuntime(new EventLedger(), provider);

    const result = await runtime.runAssignment({
      workspace,
      agent: dev,
      taskId: "task_1",
      taskRunId: "tr_1",
      goal: "Build a browser game",
      type: "implementation",
      brief: "Inspect files and create the game",
      expectedArtifact: "Playable files"
    });

    expect(result.assignmentRun.status).toBe("completed");
    expect(provider.calls).toBe(2);
    expect(result.toolResults[0]).toMatchObject({ tool: "listFiles", path: "." });
    expect(result.toolResults[0]).not.toMatchObject({ files: ["fake.js"] });
    await expect(readFile(path.join(root, "index.html"), "utf8")).resolves.toContain("real game");
  });

  it("feeds missing observation files back to the same agent instead of failing the assignment", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-runtime-"));
    const workspace = testWorkspace(root);
    const [_boss, pm] = await ensureCoreTeam(workspace);
    const provider = new MissingReadThenPlanProvider();
    const ledger = new EventLedger();
    const runtime = new AgentRuntime(ledger, provider);

    const result = await runtime.runAssignment({
      workspace,
      agent: pm,
      taskId: "task_1",
      taskRunId: "tr_1",
      goal: "Plan from an empty project",
      type: "pm_plan",
      brief: "Inspect package.json and plan",
      expectedArtifact: "Plan"
    });

    expect(result.assignmentRun.status).toBe("completed");
    expect(provider.calls).toBe(2);
    expect(provider.sawMissingFile).toBe(true);
    expect(result.providerResult.structured).toMatchObject({ plan: "从空项目创建 Web Canvas MVP" });
    expect(result.toolResults[0]).toMatchObject({ tool: "readFile", path: "package.json", ok: false });
    expect(String(result.toolResults[0].error)).toContain("ENOENT");
    const events = await ledger.read(root, "task_1", "tr_1");
    expect(events.map((event) => event.type)).toContain("tool.denied");
    expect(events.map((event) => event.type)).toContain("assignment.completed");
    expect(events.map((event) => event.type)).not.toContain("assignment.failed");
  });

  it("keeps each workspace agent session history isolated under its own agent directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-runtime-"));
    const workspace = testWorkspace(root);
    const [_boss, pm, _architect, dev] = await ensureCoreTeam(workspace);
    const ledger = new EventLedger();
    const runtime = new AgentRuntime(ledger, new StaticProvider());

    await runtime.runAssignment({
      workspace,
      agent: pm,
      taskId: "task_1",
      taskRunId: "tr_1",
      goal: "Plan",
      type: "pm_plan",
      brief: "Plan work",
      expectedArtifact: "Plan"
    });
    await runtime.runAssignment({
      workspace,
      agent: dev,
      taskId: "task_1",
      taskRunId: "tr_1",
      goal: "Build",
      type: "implementation",
      brief: "Build work",
      expectedArtifact: "Code"
    });

    const pmSessionPath = path.join(workspaceAgentSessionsDir(root, pm.id), "tr_1.json");
    const devSessionPath = path.join(workspaceAgentSessionsDir(root, dev.id), "tr_1.json");
    const pmSession = JSON.parse(await readFile(pmSessionPath, "utf8"));
    const devSession = JSON.parse(await readFile(devSessionPath, "utf8"));

    expect(pmSession.workspaceAgentId).toBe(pm.id);
    expect(devSession.workspaceAgentId).toBe(dev.id);
    expect(pmSession.messages[0].content).toContain("Plan work");
    expect(devSession.messages[0].content).toContain("Build work");
  });

  it("does not recursively inject full previous prompts from the agent session", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-runtime-"));
    const workspace = testWorkspace(root);
    const [_boss, pm] = await ensureCoreTeam(workspace);
    const provider = new CapturingProvider();
    const ledger = new EventLedger();
    const runtime = new AgentRuntime(ledger, provider);
    const longPreviousPrompt = `PREVIOUS_PROMPT_START\n${"历史 prompt 内容 ".repeat(5000)}\nPREVIOUS_PROMPT_END`;
    await new SessionStore().appendTurn(root, pm.id, "tr_1", {
      user: longPreviousPrompt,
      assistant: "{\"action\":\"create_change_set\",\"tickets\":[]}",
      providerEvents: [],
      toolResults: []
    });

    await runtime.runAssignment({
      workspace,
      agent: pm,
      taskId: "task_1",
      taskRunId: "tr_1",
      goal: "Plan without prompt recursion",
      type: "pm_plan",
      brief: "Plan work",
      expectedArtifact: "Plan"
    });

    const prompt = provider.lastInput?.prompt ?? "";
    expect(prompt.length).toBeLessThan(20_000);
    expect(prompt).toContain("近期会话截断");
    expect(prompt).toContain("PREVIOUS_PROMPT_START");
    expect(prompt).not.toContain("PREVIOUS_PROMPT_END");
    expect(provider.lastInput?.context?.contextReport).toMatchObject({
      sections: expect.arrayContaining([
        expect.objectContaining({ name: "recent_turns", truncated: true })
      ])
    });
    const session = await new SessionStore().read(root, pm.id, "tr_1");
    expect(session.messages.at(-2)?.metadata?.contextReport).toMatchObject({
      originalSessionChars: expect.any(Number),
      sections: expect.arrayContaining([
        expect.objectContaining({ name: "stable_prompt" }),
        expect.objectContaining({ name: "recent_turns", truncated: true })
      ])
    });
    const events = await ledger.read(root, "task_1", "tr_1");
    expect(events.map((event) => event.type)).toContain("context.assembled");
  });

  it("does not send unbounded file observations in tool follow-up prompts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-runtime-"));
    await writeFile(path.join(root, "huge.txt"), `FILE_START\n${"大文件内容 ".repeat(10_000)}\nFILE_END`, "utf8");
    const workspace = testWorkspace(root);
    const [_boss, _pm, _architect, dev] = await ensureCoreTeam(workspace);
    const provider = new HugeFileObservationProvider();
    const runtime = new AgentRuntime(new EventLedger(), provider);

    await runtime.runAssignment({
      workspace,
      agent: dev,
      taskId: "task_1",
      taskRunId: "tr_1",
      goal: "Inspect a large file",
      type: "implementation",
      brief: "Read huge.txt and decide",
      expectedArtifact: "Decision"
    });

    expect(provider.prompts).toHaveLength(2);
    const followUpPrompt = provider.prompts[1] ?? "";
    expect(followUpPrompt.length).toBeLessThan(30_000);
    expect(followUpPrompt).toContain("工具结果截断");
    expect(followUpPrompt).toContain("FILE_START");
    expect(followUpPrompt).not.toContain("FILE_END");
  });

  it("uses workspace agent provider and model overrides during assignment execution", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-runtime-"));
    const workspace = testWorkspace(root);
    const [_boss, _pm, _architect, dev] = await ensureCoreTeam(workspace);
    dev.provider = "anthropic";
    dev.model = "claude-test-model";
    const provider = new CapturingProvider();
    const runtime = new AgentRuntime(new EventLedger(), provider);

    await runtime.runAssignment({
      workspace,
      agent: dev,
      taskId: "task_1",
      taskRunId: "tr_1",
      goal: "Use configured model",
      type: "implementation",
      brief: "Build work",
      expectedArtifact: "Code"
    });

    expect(provider.lastInput?.provider).toBe("anthropic");
    expect(provider.lastInput?.model).toBe("claude-test-model");
  });

  it("labels editable soul as a human-like soul trait in the model prompt", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-runtime-"));
    const workspace = testWorkspace(root);
    const [_boss, pm] = await ensureCoreTeam(workspace);
    const provider = new CapturingProvider();
    const runtime = new AgentRuntime(new EventLedger(), provider);
    const profile: AgentProfile & { agentMd: string } = {
      id: "prof_pm",
      name: "项目经理",
      role: "pm",
      identity: "把模糊目标拆成真实团队可执行、可交接、可验收的工作包。",
      soul: "他对混乱和返工高度敏感，习惯把模糊意图压成清楚路径。压力下会优先收敛范围，并要求交接对象知道下一步怎么做。",
      agentMd: "# PM 能力手册\n- 输出可交付的任务包\n- 标明依赖、验收和变更风险",
      capabilities: ["需求澄清", "任务拆解", "范围控制"],
      defaultProvider: "mock",
      defaultModel: "mock-pm",
      defaultPolicy: { canReadWorkspace: true, canWriteWorkspace: false, canExecuteCommands: false }
    };

    await runtime.runAssignment({
      workspace,
      agent: pm,
      profile,
      taskId: "task_1",
      taskRunId: "tr_1",
      goal: "Use editable profile",
      type: "pm_plan",
      brief: "Plan work",
      expectedArtifact: "Plan"
    });

    const prompt = provider.lastInput?.prompt ?? "";
    expect(prompt).toContain(profile.identity);
    expect(prompt).toContain("灵魂特质：");
    expect(prompt).toContain("岗位契约：");
    expect(prompt).toContain("能力手册：");
    expect(prompt).toContain(profile.soul);
    expect(prompt).not.toContain("人格边界：");
    expect(prompt).not.toContain("身份定义：");
    expect(prompt).not.toContain("agent.md");
    expect(prompt.indexOf("灵魂特质：")).toBeLessThan(prompt.indexOf("岗位契约："));
    expect(prompt.indexOf("岗位契约：")).toBeLessThan(prompt.indexOf("能力手册："));
    expect(prompt).toContain(profile.agentMd);
    expect(provider.lastInput?.prompt).toContain("需求澄清、任务拆解、范围控制");
  });
});

class StaticProvider implements ProviderRunner {
  async runWithRetry(input: AgentTurnInput): Promise<AgentTurnResult> {
    return {
      text: `completed ${input.assignmentType}`,
      structured: {
        ok: true,
        toolIntents: input.assignmentType === "implementation"
          ? [{ tool: "writeFile", path: "AUTOAGENT_RESULT.md", content: "done\n" }]
          : []
      },
      events: [{ type: "text", text: "ok" }],
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 }
    };
  }
}

class CapturingProvider extends StaticProvider {
  lastInput?: AgentTurnInput;

  async runWithRetry(input: AgentTurnInput): Promise<AgentTurnResult> {
    this.lastInput = input;
    return super.runWithRetry(input);
  }
}

class LegacyActionProvider implements ProviderRunner {
  calls = 0;

  async runWithRetry(): Promise<AgentTurnResult> {
    this.calls += 1;
    if (this.calls === 1) {
      return {
        text: JSON.stringify({ action: "listFiles", path: ".", status: "success", files: ["fake.js"] }),
        structured: { action: "listFiles", path: ".", status: "success", files: ["fake.js"] },
        events: [{ type: "text", text: "list files" }],
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
      };
    }
    return {
      text: JSON.stringify({ toolIntents: [{ tool: "writeFile", path: "index.html", content: "real game" }] }),
      structured: { toolIntents: [{ tool: "writeFile", path: "index.html", content: "real game" }] },
      events: [{ type: "text", text: "write file" }],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
    };
  }
}

class HugeFileObservationProvider implements ProviderRunner {
  prompts: string[] = [];

  async runWithRetry(input: AgentTurnInput): Promise<AgentTurnResult> {
    this.prompts.push(input.prompt);
    if (this.prompts.length === 1) {
      return {
        text: JSON.stringify({ toolIntents: [{ tool: "readFile", path: "huge.txt" }] }),
        structured: { toolIntents: [{ tool: "readFile", path: "huge.txt" }] },
        events: [{ type: "text", text: "read huge file" }],
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
      };
    }
    return {
      text: JSON.stringify({ action: "complete", summary: "done" }),
      structured: { action: "complete", summary: "done" },
      events: [{ type: "text", text: "done" }],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
    };
  }
}

class MissingReadThenPlanProvider implements ProviderRunner {
  calls = 0;
  sawMissingFile = false;

  async runWithRetry(input: AgentTurnInput): Promise<AgentTurnResult> {
    this.calls += 1;
    const toolResults = (input.context?.toolResults as Array<Record<string, unknown>> | undefined) ?? [];
    this.sawMissingFile = toolResults.some((result) => result.tool === "readFile" && result.ok === false && String(result.error).includes("ENOENT"));
    if (!this.sawMissingFile) {
      return {
        text: JSON.stringify({ toolIntents: [{ tool: "readFile", path: "package.json" }] }),
        structured: { toolIntents: [{ tool: "readFile", path: "package.json" }] },
        events: [{ type: "text", text: "read package" }],
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
      };
    }
    return {
      text: JSON.stringify({ plan: "从空项目创建 Web Canvas MVP" }),
      structured: { plan: "从空项目创建 Web Canvas MVP" },
      events: [{ type: "text", text: "plan empty project" }],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
    };
  }
}

function testWorkspace(rootPath: string): Workspace {
  return {
    id: "ws_1",
    name: "Test Workspace",
    rootPath,
    policyProfile: "development",
    createdAt: new Date().toISOString()
  };
}
