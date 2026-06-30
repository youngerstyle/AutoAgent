import type { Assignment, Workspace, WorkspaceAgent } from "../../shared/types.js";
import { assignmentLabel, roleLabel } from "../../shared/labels.js";
import type { AgentSession } from "../storage/session-store.js";
import { profileForRole } from "./roster.js";

export function buildAgentPrompt(input: {
  workspace: Workspace;
  agent: WorkspaceAgent;
  assignment: Assignment;
  goal: string;
  context?: Record<string, unknown>;
  session?: AgentSession;
}): string {
  const profile = profileForRole(input.agent.roleInWorkspace);
  const recent = input.session?.messages.slice(-6).map((message) => `${message.role}: ${message.content}`).join("\n") ?? "";
  return [
    `你是${profile.name}，角色是${roleLabel(profile.role)}。`,
    `项目：${input.workspace.name}，路径：${input.workspace.rootPath}。`,
    `目标：${input.goal}`,
    `任务类型：${assignmentLabel(input.assignment.type)}`,
    `任务说明：${input.assignment.brief}`,
    `预期产物：${input.assignment.expectedArtifact}`,
    `能力：${profile.capabilities.join("、")}`,
    recent ? `近期会话：\n${recent}` : "近期会话：无",
    input.context ? `上下文：${JSON.stringify(input.context)}` : "上下文：{}",
    "返回简洁的结构化结果。需要调用工具时，可使用 writeFile、readFile、listFiles 或 shell。"
  ].join("\n");
}
