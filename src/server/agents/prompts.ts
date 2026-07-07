import type { AgentProfile, Assignment, Workspace, WorkspaceAgent } from "../../shared/types.js";
import { assignmentLabel, roleLabel } from "../../shared/labels.js";
import type { AgentSession, AgentSessionMessage } from "../storage/session-store.js";
import { profileForRole } from "./roster.js";
import { resolvePolicy } from "../policy/policy.js";

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
  const policy = resolvePolicy(input.workspace, input.agent);
  const recent = input.session?.messages.slice(-6).map(recentSessionLine).join("\n") ?? "";
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
    `当前工具权限：读项目=${yesNo(policy.canReadWorkspace)}，写项目=${yesNo(policy.canWriteWorkspace)}，执行命令=${yesNo(policy.canExecuteCommands)}，访问本机=${yesNo(Boolean(policy.allowHostAccess))}。`,
    policy.canWriteWorkspace ? undefined : "文档交付边界：即使写项目=否，老板/产品/架构/测试仍可在 docs/、reports/、plans/ 下写 .md/.txt 文档；不能写源码、HTML、配置或可运行交付物。",
    recent ? `近期会话：\n${recent}` : "近期会话：无",
    input.context ? `上下文：${JSON.stringify(input.context)}` : "上下文：{}",
    "工具协议：需要访问真实项目文件或执行命令时，只能返回 JSON：{\"toolIntents\":[{\"tool\":\"listFiles\",\"path\":\".\"}]}、{\"toolIntents\":[{\"tool\":\"readFile\",\"path\":\"package.json\"}]}、{\"toolIntents\":[{\"tool\":\"writeFile\",\"path\":\"README.md\",\"content\":\"...\"}]} 或 {\"toolIntents\":[{\"tool\":\"shell\",\"command\":\"npm test\"}]}。",
    "只能请求当前工具权限允许的工具；如果任务需要写文件但你没有写项目权限，不要返回 writeFile，而要返回 blocked/need_clarification，并说明应交给开发或具备写权限的 Agent。",
    "禁止把未执行的工具结果写进普通 JSON；禁止编造文件列表、命令输出、测试结果或交付物。",
    "如果任务需要浏览器交互验收而当前工具无法打开浏览器，必须返回 {\"status\":\"manual_test_required\",\"report\":\"...\"}，并在 report 中原样写清楚缺少浏览器能力、需要人工测试的文件路径和具体测试项。",
    "如果发现需要返工的缺陷，必须返回 {\"passed\":false,\"defects\":[...],\"reason\":\"...\"}；如果需要回到特定阶段，必须显式返回 target_phase，可选值为 pm_plan、architect_plan、implementation、qa、boss_acceptance。不要只在 reason/report 里用自然语言暗示流向。",
    "如果需要澄清、授权或暂停，必须使用结构化字段，例如 status: need_clarification、status: await_human_authorization、clarification_required: true；平台不会从普通说明文字里猜你的意图。",
    input.assignment.type === "pm_plan" ? "产品/项目拆解任务必须优先返回 ticketGraph 数组：[{\"key\":\"implementation\",\"type\":\"implementation\",\"brief\":\"...\",\"expectedArtifact\":\"...\",\"targetRole\":\"dev\"},{\"key\":\"qa\",\"type\":\"qa\",\"brief\":\"...\",\"expectedArtifact\":\"...\",\"targetRole\":\"qa\",\"dependsOn\":[\"implementation\"]},{\"key\":\"acceptance\",\"type\":\"boss_acceptance\",\"brief\":\"...\",\"expectedArtifact\":\"...\",\"targetRole\":\"boss\",\"dependsOn\":[\"qa\"]}]。只有确实需要架构判断时才加入 type=architect_plan；不要为了流程好看强行加入角色。如果你在计划拆解中发现实现文件、源码、配置或可运行交付物缺失/损坏，返回 blocked 时必须显式带上 target_phase:\"implementation\"，不要让 PM 自己反复拆解同一个实现问题。" : undefined,
    "完成时返回简洁的结构化结果；无法继续时返回 blocked/need_clarification 并说明缺少的事实。"
  ].filter(Boolean).join("\n");
}

function yesNo(value: boolean): string {
  return value ? "是" : "否";
}

const RECENT_SESSION_MESSAGE_CHARS = 1_200;

function recentSessionLine(message: AgentSessionMessage): string {
  const content = message.content.length <= RECENT_SESSION_MESSAGE_CHARS
    ? message.content
    : `${message.content.slice(0, RECENT_SESSION_MESSAGE_CHARS)}\n...[近期会话截断，原始长度 ${message.content.length} 字符]`;
  return `${message.role}: ${content}`;
}
