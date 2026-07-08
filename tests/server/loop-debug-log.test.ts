import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildLoopDebugLog } from "../../src/server/mission/loop-debug-log";
import { LoopTraceStore } from "../../src/server/storage/loop-trace-store";
import { workspaceAgentDir } from "../../src/server/storage/paths";
import type { AutoAgentEvent, MissionPhase, Workspace, WorkspaceAgent } from "../../src/shared/types";

describe("loop debug log", () => {
  it("merges flow events and loop trace records into a chronological full-loop log", async () => {
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
    await mkdir(workspaceAgentDir(root, agent.id), { recursive: true });
    await writeFile(path.join(workspaceAgentDir(root, agent.id), "agent.json"), JSON.stringify(agent), "utf8");
    const traceStore = new LoopTraceStore();
    await traceStore.append(root, "task_1", "tr_1", {
      kind: "prompt",
      timestamp: "2026-07-03T00:00:01.000Z",
      agentId: agent.id,
      actor: "测试",
      title: "Prompt",
      content: "完整 prompt",
      turn: 1,
      metadata: {
        contextReport: {
          originalSessionChars: 50000,
          injectedChars: 8000,
          estimatedTokens: 2000,
          sections: [
            { name: "stable_prompt", originalChars: 1000, injectedChars: 1000, estimatedTokens: 250, truncated: false },
            { name: "recent_turns", originalChars: 48000, injectedChars: 1200, estimatedTokens: 300, truncated: true }
          ],
          compaction: { compacted: true, checkpointId: "ctx_1" }
        }
      }
    });
    await traceStore.append(root, "task_1", "tr_1", {
      kind: "llm",
      timestamp: "2026-07-03T00:00:02.000Z",
      agentId: agent.id,
      actor: "测试",
      title: "LLM 返回",
      content: "{\"toolIntents\":[{\"tool\":\"readFile\",\"path\":\"index.html\"}]}",
      turn: 1
    });
    await traceStore.append(root, "task_1", "tr_1", {
      kind: "tool",
      timestamp: "2026-07-03T00:00:03.000Z",
      agentId: agent.id,
      actor: "测试",
      title: "工具结果",
      content: "{\"tool\":\"readFile\",\"path\":\"index.html\",\"ok\":true}",
      detail: "tool: readFile",
      turn: 1,
      metadata: { tool: "readFile" }
    });

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
    expect(log.entries[1].detail).toContain("上下文 8000 字");
    expect(log.entries[1].metadata?.contextReport).toMatchObject({
      injectedChars: 8000,
      sections: expect.arrayContaining([
        expect.objectContaining({ name: "recent_turns", truncated: true })
      ])
    });
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
