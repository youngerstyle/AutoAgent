import type { AgentProfile, Assignment, Workspace, WorkspaceAgent } from "../../shared/types.js";
import { assignmentLabel, roleLabel } from "../../shared/labels.js";
import type { AgentSession } from "../storage/session-store.js";
import { profileForRole } from "./roster.js";

export function buildAgentPrompt(input: {
  workspace: Workspace;
  agent: WorkspaceAgent;
  assignment: Assignment;
  profile?: AgentProfile;
  goal: string;
  context?: Record<string, unknown>;
  session?: AgentSession;
}): string {
  const profile = input.profile ?? profileForRole(input.agent.roleInWorkspace);
  const recent = input.session?.messages.slice(-6).map((message) => `${message.role}: ${message.content}`).join("\n") ?? "";
  return [
    `你是${profile.name}，角色是${roleLabel(profile.role)}。`,
    profile.soul ? `灵魂特质：${profile.soul}` : undefined,
    profile.identity ? `岗位契约：${profile.identity}` : undefined,
    profile.agentMd ? `能力手册：\n${profile.agentMd}` : undefined,
    `项目：${input.workspace.name}，路径：${input.workspace.rootPath}。`,
    `目标：${input.goal}`,
    `任务类型：${assignmentLabel(input.assignment.type)}`,
    `任务说明：${input.assignment.brief}`,
    `预期产物：${input.assignment.expectedArtifact}`,
    `能力：${profile.capabilities.join("、")}`,
    recent ? `近期会话：\n${recent}` : "近期会话：无",
    input.context ? `上下文：${JSON.stringify(input.context)}` : "上下文：{}",
    "工具协议：需要访问真实项目文件或执行命令时，只能返回 JSON：{\"toolIntents\":[{\"tool\":\"listFiles\",\"path\":\".\"}]}、{\"toolIntents\":[{\"tool\":\"readFile\",\"path\":\"package.json\"}]}、{\"toolIntents\":[{\"tool\":\"writeFile\",\"path\":\"README.md\",\"content\":\"...\"}]} 或 {\"toolIntents\":[{\"tool\":\"shell\",\"command\":\"npm test\"}]}。",
    "禁止把未执行的工具结果写进普通 JSON；禁止编造文件列表、命令输出、测试结果或交付物。",
    "如果任务需要浏览器交互验收而当前工具无法打开浏览器，返回 status: manual_test_required，并在 report 中原样写清楚缺少浏览器能力、需要人工测试的文件路径和具体测试项。",
    "完成时返回简洁的结构化结果；无法继续时返回 blocked/need_clarification 并说明缺少的事实。"
  ].filter(Boolean).join("\n");
}
