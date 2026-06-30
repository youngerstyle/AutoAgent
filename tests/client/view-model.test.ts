import { describe, expect, it } from "vitest";
import { buildAgentNodes, taskControlMode } from "../../src/client/view-model";
import type { WorkspaceSnapshot } from "../../src/shared/types";

describe("client view model", () => {
  it("marks the currently running agent as active and places core roles on canvas", () => {
    const nodes = buildAgentNodes(snapshot("running"));

    expect(nodes.find((node) => node.role === "dev")?.active).toBe(true);
    expect(nodes.find((node) => node.role === "boss")?.y).toBeLessThan(nodes.find((node) => node.role === "dev")!.y);
    expect(nodes.find((node) => node.role === "qa")?.x).toBeGreaterThan(nodes.find((node) => node.role === "dev")!.x);
  });

  it("derives task controls from snapshot status", () => {
    expect(taskControlMode(undefined)).toBe("empty");
    expect(taskControlMode(snapshot("paused"))).toBe("paused");
    expect(taskControlMode(snapshot("completed"))).toBe("terminal");
  });
});

function snapshot(status: WorkspaceSnapshot["status"]): WorkspaceSnapshot {
  return {
    workspace: { id: "ws_1", name: "Workspace", rootPath: "C:/ws", policyProfile: "production", createdAt: "now" },
    activeTask: { id: "task_1", workspaceId: "ws_1", title: "Task", goal: "Goal", status, createdBy: "user", activeTaskRunId: "tr_1" },
    activeTaskRun: { id: "tr_1", taskId: "task_1", workspaceId: "ws_1", status, phase: status === "paused" ? "paused" : "implementation", startedAt: "now" },
    agents: [
      { id: "wa_boss", workspaceId: "ws_1", profileId: "prof_boss", roleInWorkspace: "boss", agentDir: "boss", status: "waiting", name: "Boss" },
      { id: "wa_dev", workspaceId: "ws_1", profileId: "prof_dev", roleInWorkspace: "dev", agentDir: "dev", status: "running", name: "Dev", currentStep: "Editing" },
      { id: "wa_qa", workspaceId: "ws_1", profileId: "prof_qa", roleInWorkspace: "qa", agentDir: "qa", status: "waiting", name: "QA" }
    ],
    assignments: [],
    recentEvents: [],
    phase: status === "paused" ? "paused" : "implementation",
    status
  };
}
