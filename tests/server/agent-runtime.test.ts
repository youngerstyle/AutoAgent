import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentRuntime, type ProviderRunner } from "../../src/server/agents/agent-runtime";
import { ensureCoreTeam } from "../../src/server/agents/roster";
import { EventLedger } from "../../src/server/storage/event-ledger";
import { workspaceAgentSessionsDir } from "../../src/server/storage/paths";
import { SessionStore } from "../../src/server/storage/session-store";
import type { AgentTurnInput, AgentTurnResult } from "../../src/server/providers/types";
import type { Workspace } from "../../src/shared/types";

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

function testWorkspace(rootPath: string): Workspace {
  return {
    id: "ws_1",
    name: "Test Workspace",
    rootPath,
    policyProfile: "development",
    createdAt: new Date().toISOString()
  };
}
