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

  it("hides stale run.completed events after a later run.blocked correction without rewriting the reason", () => {
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
      phase: "boss_acceptance",
      startedAt: "2026-06-30T00:00:00.000Z"
    };
    const events: AutoAgentEvent[] = [
      event("task.created", { task, taskRun }),
      event("assignment.completed", {
        assignmentId: "as_dev",
        assignment: { type: "implementation" },
        toolResults: []
      }, "开发已完成开发执行"),
      event("run.completed", { task: { ...task, status: "completed" }, taskRun: { ...taskRun, status: "completed", phase: "completed" } }),
      event("run.blocked", { task: { ...task, status: "blocked" }, taskRun: { ...taskRun, status: "blocked" }, reason: "需求不清" }, "任务受阻：需求不清")
    ];

    const snapshot = projectWorkspaceState(workspace, events);

    expect(snapshot.status).toBe("blocked");
    expect(snapshot.recentEvents.map((item) => item.type)).toEqual(["task.created", "assignment.completed", "run.blocked"]);
    expect(snapshot.recentEvents.find((item) => item.type === "run.blocked")?.summary).toBe("任务受阻：需求不清");
  });

  it("hides downstream stale events when the first assignment already blocked the flow", () => {
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
      phase: "boss_intake",
      startedAt: "2026-06-30T00:00:00.000Z"
    };
    const events: AutoAgentEvent[] = [
      event("task.created", { task, taskRun }),
      event("assignment.completed", {
        assignmentId: "as_boss",
        assignment: { type: "boss_intake" },
        result: { decision: "暂不执行，需澄清", action: "check_project_files", reason: "目标缺少交付边界" }
      }, "老板已完成需求接收"),
      event("assignment.completed", {
        assignmentId: "as_dev",
        assignment: { type: "implementation" },
        toolResults: []
      }, "开发已完成开发执行"),
      event("run.blocked", { task: { ...task, status: "blocked" }, taskRun: { ...taskRun, status: "blocked" }, reason: "需求不清" })
    ];

    const snapshot = projectWorkspaceState(workspace, events);

    expect(snapshot.recentEvents.map((item) => item.summary)).toEqual([
      "task.created",
      "老板已完成需求接收",
      "任务受阻：需求接收没有通过"
    ]);
    expect(snapshot.recentEvents.find((item) => item.type === "run.blocked")?.payload).toMatchObject({
      reason: "需求接收没有通过；后面的阶段运行是旧流程 bug 产生的无效后续，不代表团队已经交付。原因：目标缺少交付边界"
    });
  });
});

function event(type: AutoAgentEvent["type"], payload: Record<string, unknown>, summary: string = type): AutoAgentEvent {
  return {
    id: `evt_${type}`,
    workspaceId: "ws_1",
    taskId: "task_1",
    taskRunId: "tr_1",
    type,
    summary,
    payload,
    timestamp: "2026-06-30T00:00:00.000Z"
  };
}
