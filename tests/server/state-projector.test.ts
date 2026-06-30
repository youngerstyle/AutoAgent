import { describe, expect, it } from "vitest";
import { projectWorkspaceState } from "../../src/server/storage/state-projector";
import type { Assignment, AutoAgentEvent, Task, TaskRun, Workspace, WorkspaceAgent } from "../../src/shared/types";

describe("projectWorkspaceState", () => {
  it("reconstructs current phase, agents, assignments, and QA feedback loop", () => {
    const workspace: Workspace = {
      id: "ws_1",
      name: "Demo",
      rootPath: "C:/demo",
      policyProfile: "production",
      createdAt: "2026-06-30T00:00:00.000Z"
    };
    const task: Task = {
      id: "task_1",
      workspaceId: "ws_1",
      title: "Build demo",
      goal: "Build demo",
      status: "running",
      createdBy: "user",
      activeTaskRunId: "tr_1"
    };
    const taskRun: TaskRun = {
      id: "tr_1",
      taskId: "task_1",
      workspaceId: "ws_1",
      status: "running",
      phase: "qa",
      startedAt: "2026-06-30T00:00:00.000Z"
    };
    const dev: WorkspaceAgent = {
      id: "wa_dev",
      workspaceId: "ws_1",
      profileId: "prof_dev",
      roleInWorkspace: "dev",
      agentDir: "agents/wa_dev",
      status: "waiting"
    };
    const assignment: Assignment = {
      id: "as_1",
      taskId: "task_1",
      taskRunId: "tr_1",
      ownerWorkspaceAgentId: "wa_dev",
      type: "implementation",
      brief: "Implement",
      expectedArtifact: "Working code",
      status: "waiting"
    };
    const events: AutoAgentEvent[] = [
      event("task.created", { task, taskRun }),
      event("agent.joined_workspace", { agent: dev }),
      event("assignment.created", { assignment }),
      event("agent.step_started", { agentId: "wa_dev", step: "Editing src/App.tsx" }),
      event("qa.failed", { feedback: "Tests failed" })
    ];

    const snapshot = projectWorkspaceState(workspace, events);

    expect(snapshot.phase).toBe("implementation");
    expect(snapshot.status).toBe("running");
    expect(snapshot.agents[0].currentStep).toBe("Editing src/App.tsx");
    expect(snapshot.assignments[0].id).toBe("as_1");
  });
});

function event(type: AutoAgentEvent["type"], payload: Record<string, unknown>): AutoAgentEvent {
  return {
    id: `evt_${type}`,
    workspaceId: "ws_1",
    taskId: "task_1",
    taskRunId: "tr_1",
    type,
    summary: type,
    payload,
    timestamp: "2026-06-30T00:00:00.000Z"
  };
}
