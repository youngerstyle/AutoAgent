import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildLoopDebugLog } from "../../src/server/mission/loop-debug-log";
import { workspaceAgentDir, workspaceAgentSessionsDir } from "../../src/server/storage/paths";
import type { AgentSession } from "../../src/server/storage/session-store";
import type { AutoAgentEvent, MissionPhase, Workspace, WorkspaceAgent } from "../../src/shared/types";

describe("loop debug log", () => {
  it("merges flow events and agent session turns into a chronological full-loop log", async () => {
    const root = await mkdtempWorkspace();
    const workspace: Workspace = {
      id: "ws_1",
      name: "Demo",
      rootPath: root,
      policyProfile: "development",
      createdAt: "2026-07-03T00:00:00.000Z"
    };
    const agent: WorkspaceAgent = {
      id: "wa_qa",
      workspaceId: workspace.id,
      profileId: "prof_qa",
      roleInWorkspace: "qa",
      agentDir: workspaceAgentDir(root, "wa_qa"),
      status: "waiting"
    };
    await mkdir(workspaceAgentSessionsDir(root, agent.id), { recursive: true });
    await writeFile(path.join(workspaceAgentDir(root, agent.id), "agent.json"), JSON.stringify(agent), "utf8");
    const session: AgentSession = {
      id: "tr_1",
      workspaceAgentId: agent.id,
      updatedAt: "2026-07-03T00:00:05.000Z",
      providerEvents: [{ type: "text", text: "{\"toolIntents\":[{\"tool\":\"readFile\",\"path\":\"index.html\"}]}" }],
      messages: [
        { role: "user", content: "完整 prompt", timestamp: "2026-07-03T00:00:01.000Z" },
        { role: "assistant", content: "{\"toolIntents\":[{\"tool\":\"readFile\",\"path\":\"index.html\"}]}", timestamp: "2026-07-03T00:00:02.000Z" },
        { role: "tool", content: "{\"tool\":\"readFile\",\"path\":\"index.html\",\"ok\":true}", timestamp: "2026-07-03T00:00:03.000Z" }
      ]
    };
    await writeFile(path.join(workspaceAgentSessionsDir(root, agent.id), "tr_1.json"), JSON.stringify(session), "utf8");

    const log = await buildLoopDebugLog({
      workspace,
      task: { id: "task_1", workspaceId: workspace.id, title: "Task", goal: "Goal", status: "running", createdBy: "user" },
      taskRun: { id: "tr_1", taskId: "task_1", workspaceId: workspace.id, status: "running", phase: "qa" as MissionPhase, startedAt: "2026-07-03T00:00:00.000Z" },
      events: [
        event("task.phase_changed", "进入阶段：质量检查", "2026-07-03T00:00:00.500Z", { phase: "qa" })
      ]
    });

    expect(log.entries.map((entry) => entry.kind)).toEqual(["flow", "prompt", "llm", "tool"]);
    expect(log.entries.map((entry) => entry.actor)).toEqual(["任务阶段", "测试", "测试", "测试"]);
    expect(log.entries[1]).toMatchObject({ title: "Prompt", content: "完整 prompt" });
    expect(log.entries[2]).toMatchObject({ title: "LLM 返回" });
    expect(log.entries[3]).toMatchObject({ title: "工具结果" });
  });
});

async function mkdtempWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-loop-log-"));
  await mkdir(root, { recursive: true });
  return root;
}

function event(type: AutoAgentEvent["type"], summary: string, timestamp: string, payload: Record<string, unknown>): AutoAgentEvent {
  return {
    id: `evt_${type}`,
    workspaceId: "ws_1",
    taskId: "task_1",
    taskRunId: "tr_1",
    type,
    summary,
    payload,
    timestamp,
    sequence: 1
  };
}
