import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentThreadStore } from "../../src/server/storage/agent-thread-store";

describe("AgentThreadStore", () => {
  it("persists chronological direct-chat events and projects legacy chat messages", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-thread-"));
    const store = new AgentThreadStore();

    const human = await store.append(root, "wa_qa", "tr_1", {
      taskId: "task_1",
      taskRunId: "tr_1",
      workspaceAgentId: "wa_qa",
      source: "human",
      kind: "human_message",
      visibility: "chat",
      payload: { message: "继续看这个跨域报错" },
      timestamp: "2026-07-09T01:00:00.000Z"
    });
    await store.append(root, "wa_qa", "tr_1", {
      taskId: "task_1",
      taskRunId: "tr_1",
      workspaceAgentId: "wa_qa",
      source: "agent",
      kind: "agent_message",
      visibility: "chat",
      humanMessageId: human.id,
      payload: { message: "收到，我会继续按 QA 视角判断。" },
      timestamp: "2026-07-09T01:00:01.000Z"
    });

    const events = await store.read(root, "wa_qa", "tr_1");
    expect(events.map((event) => event.kind)).toEqual(["human_message", "agent_message"]);
    expect(events.map((event) => event.sequence)).toEqual([1, 2]);

    expect(store.projectDirectMessages(events)).toEqual([
      expect.objectContaining({
        id: human.id,
        agentId: "wa_qa",
        taskId: "task_1",
        taskRunId: "tr_1",
        message: "继续看这个跨域报错",
        createdBy: "human",
        createdAt: "2026-07-09T01:00:00.000Z",
        handledAt: "2026-07-09T01:00:01.000Z",
        response: "收到，我会继续按 QA 视角判断。"
      })
    ]);
  });

  it("serializes concurrent appends to keep sequence numbers unique", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-thread-"));
    const store = new AgentThreadStore();

    await Promise.all([
      store.append(root, "wa_dev", "tr_1", {
        taskId: "task_1",
        taskRunId: "tr_1",
        workspaceAgentId: "wa_dev",
        source: "human",
        kind: "human_message",
        visibility: "chat",
        payload: { message: "第一条" }
      }),
      store.append(root, "wa_dev", "tr_1", {
        taskId: "task_1",
        taskRunId: "tr_1",
        workspaceAgentId: "wa_dev",
        source: "human",
        kind: "human_message",
        visibility: "chat",
        payload: { message: "第二条" }
      })
    ]);

    const events = await store.read(root, "wa_dev", "tr_1");
    expect(events.map((event) => event.sequence).sort((a, b) => a - b)).toEqual([1, 2]);
  });
});
