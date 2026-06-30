import { describe, expect, it } from "vitest";
import { buildAgentCatalogProfiles, buildAgentNodes, buildAgentProfiles, taskControlMode } from "../../src/client/view-model";
import type { AgentProfile, WorkspaceSnapshot } from "../../src/shared/types";

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

  it("projects agents as platform profiles with identity, soul, tools, model, and memory", () => {
    const profiles = buildAgentProfiles(snapshot("running"));
    const dev = profiles.find((profile) => profile.role === "dev");

    expect(dev?.identity.title).toBe("开发");
    expect(dev?.soul).toContain("交付");
    expect(dev && "loopSteps" in dev).toBe(false);
    expect(dev?.toolGroups.map((group) => group.label)).toEqual(expect.arrayContaining(["文件", "命令", "浏览器/MCP"]));
    expect(dev?.model.providerLabel).toBe("模拟服务");
    expect(dev?.memory.sessionLabel).toBe("项目会话隔离");
  });

  it("uses editable global agent definitions for catalog and project team projections", () => {
    const definitions: AgentProfile[] = [{
      id: "prof_dev",
      name: "全栈工程师",
      role: "dev",
      identity: "负责把任务变成可运行变更",
      soul: "先读上下文，再用证据交付。",
      capabilities: ["TypeScript", "验证"],
      defaultProvider: "mock",
      defaultModel: "mock-dev",
      defaultPolicy: { canReadWorkspace: true, canWriteWorkspace: true, canExecuteCommands: true }
    }];

    const catalog = buildAgentCatalogProfiles(definitions);
    const team = buildAgentProfiles(snapshot("running"), definitions);

    expect(catalog[0].identity.title).toBe("全栈工程师");
    expect(team.find((profile) => profile.role === "dev")?.soul).toBe("先读上下文，再用证据交付。");
    expect(team.find((profile) => profile.role === "dev") && "loopSteps" in team.find((profile) => profile.role === "dev")!).toBe(false);
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
