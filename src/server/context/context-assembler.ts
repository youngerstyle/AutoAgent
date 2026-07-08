import type { AgentProfile, Assignment, Workspace, WorkspaceAgent } from "../../shared/types.js";
import { assignmentLabel, roleLabel } from "../../shared/labels.js";
import { profileForRole } from "../agents/roster.js";
import { resolvePolicy } from "../policy/policy.js";
import type { AgentSession, AgentSessionMessage } from "../storage/session-store.js";
import { compactSessionIfNeeded } from "./session-compactor.js";
import { DEFAULT_CONTEXT_BUDGET, estimateTokens, truncateToTokenBudget, type ContextBudget } from "./token-budget.js";
import { ContextStore } from "./context-store.js";
import type { ContextCheckpoint, ContextReport, ContextSectionReport } from "./types.js";

export interface ContextAssemblerInput {
  workspace: Workspace;
  agent: WorkspaceAgent;
  profile?: AgentProfile;
  assignment?: Assignment;
  sessionId: string;
  taskRunId: string;
  goal: string;
  type: Assignment["type"];
  brief: string;
  expectedArtifact: string;
  context?: Record<string, unknown>;
  session: AgentSession;
  toolResults?: Array<Record<string, unknown>>;
}

export interface AssembledContext {
  prompt: string;
  report: ContextReport;
}

export class ContextAssembler {
  constructor(
    private readonly store = new ContextStore(),
    private readonly budget: ContextBudget = DEFAULT_CONTEXT_BUDGET
  ) {}

  async assemble(input: ContextAssemblerInput): Promise<AssembledContext> {
    const profile = input.profile ?? profileForRole(input.agent.roleInWorkspace);
    const contextState = await this.store.readState(input.workspace.rootPath, input.agent.id, input.taskRunId);
    const memory = await this.store.readMemory(input.workspace.rootPath, input.agent.id);
    const compaction = compactSessionIfNeeded(input.session, {
      maxRecentGroups: 3,
      triggerTokens: Math.floor((this.budget.maxInputTokens - this.budget.reservedOutputTokens) * 0.75),
      compactToTokens: this.budget.sessionSummaryTokens,
      reason: "threshold"
    });
    const checkpoints = compaction.checkpoint
      ? upsertCheckpoint(contextState.checkpoints, compaction.checkpoint)
      : contextState.checkpoints;
    const latestSummary = compaction.checkpoint?.summary ?? contextState.checkpoints.at(-1)?.summary ?? contextState.summary?.text ?? "无";
    const recentTurns = recentTurnsSection(compaction.recentMessages);
    const toolObservations = toolObservationSection(input.toolResults ?? []);
    const sections: Array<{ name: string; text: string; budget: number; label: string; originalChars?: number; preTruncated?: boolean }> = [
      { name: "stable_prompt", text: stablePromptSection(input, profile), budget: this.budget.staticPromptTokens, label: "稳定提示词" },
      { name: "current_assignment", text: currentAssignmentSection(input), budget: this.budget.ticketTokens, label: "当前任务" },
      { name: "workspace_memory", text: workspaceMemorySection(memory), budget: this.budget.memoryTokens, label: "工作区记忆" },
      { name: "session_summary", text: `会话摘要：\n${latestSummary}`, budget: this.budget.sessionSummaryTokens, label: "会话摘要" },
      { name: "recent_turns", text: recentTurns.text, budget: this.budget.recentTurnTokens, label: "近期会话", originalChars: recentTurns.originalChars, preTruncated: recentTurns.truncated },
      { name: "tool_observations", text: toolObservations.text, budget: this.budget.toolObservationTokens, label: "工具结果", originalChars: toolObservations.originalChars, preTruncated: toolObservations.truncated },
      { name: "dynamic_context", text: dynamicContextSection(input.context), budget: this.budget.dynamicContextTokens, label: "动态上下文" }
    ];

    const sectionReports: ContextSectionReport[] = [];
    const prompt = sections.map((section) => {
      const truncated = truncateToTokenBudget(section.text, section.budget, section.label);
      sectionReports.push({
        name: section.name,
        originalChars: section.originalChars ?? truncated.originalChars,
        injectedChars: truncated.injectedChars,
        estimatedTokens: truncated.estimatedTokens,
        truncated: truncated.truncated || Boolean(section.preTruncated)
      });
      return `## ${section.label}\n${truncated.text}`;
    }).join("\n\n");
    const report: ContextReport = {
      originalSessionChars: input.session.messages.reduce((sum, message) => sum + message.content.length, 0),
      injectedChars: prompt.length,
      estimatedTokens: estimateTokens(prompt),
      sections: sectionReports,
      compaction: {
        compacted: compaction.compacted,
        checkpointId: compaction.checkpoint?.id,
        reason: compaction.checkpoint?.reason,
        originalChars: compaction.checkpoint?.originalChars,
        summaryChars: compaction.checkpoint?.summaryChars,
        replacementHistoryMessages: compaction.checkpoint?.replacementHistory.length
      }
    };

    await this.store.writeState(input.workspace.rootPath, input.agent.id, input.taskRunId, {
      ...contextState,
      checkpoints,
      summary: compaction.checkpoint ? { text: compaction.checkpoint.summary, updatedAt: compaction.checkpoint.createdAt } : contextState.summary,
      lastAssembled: report,
      updatedAt: new Date().toISOString()
    });

    return { prompt, report };
  }
}

function upsertCheckpoint(
  checkpoints: ContextCheckpoint[],
  checkpoint: ContextCheckpoint
): ContextCheckpoint[] {
  const existingIndex = checkpoints.findIndex((item) => item.id === checkpoint.id);
  if (existingIndex === -1) return [...checkpoints, checkpoint];
  const existing = checkpoints[existingIndex];
  if (existing.replacementHistory?.length) return checkpoints;
  return checkpoints.map((item, index) => index === existingIndex ? checkpoint : item);
}

function stablePromptSection(input: ContextAssemblerInput, profile: AgentProfile): string {
  const policy = resolvePolicy(input.workspace, input.agent);
  const isTicketResumeReview = isTicketResumeReviewContext(input.context);
  return [
    `你是${profile.name}，角色是${roleLabel(profile.role)}。`,
    profile.soul ? `灵魂特质：${profile.soul}` : undefined,
    profile.identity ? `岗位契约：${profile.identity}` : undefined,
    profile.agentMd ? `能力手册：\n${profile.agentMd}` : undefined,
    `能力：${profile.capabilities.join("、")}`,
    `当前工具权限：读项目=${yesNo(policy.canReadWorkspace)}，写项目=${yesNo(policy.canWriteWorkspace)}，执行命令=${yesNo(policy.canExecuteCommands)}，访问本机=${yesNo(Boolean(policy.allowHostAccess))}。`,
    policy.canWriteWorkspace ? undefined : "文档交付边界：即使写项目=否，老板/产品/架构/测试仍可在 docs/、reports/、plans/ 下写 .md/.txt 文档；不能写源码、HTML、配置或可运行交付物。",
    "工具协议：需要访问真实项目文件或执行命令时，只能返回 JSON：{\"toolIntents\":[{\"tool\":\"listFiles\",\"path\":\".\"}]}、{\"toolIntents\":[{\"tool\":\"readFile\",\"path\":\"package.json\"}]}、{\"toolIntents\":[{\"tool\":\"writeFile\",\"path\":\"README.md\",\"content\":\"...\"}]} 或 {\"toolIntents\":[{\"tool\":\"shell\",\"command\":\"npm test\"}]}。",
    "只能请求当前工具权限允许的工具；禁止编造文件列表、命令输出、测试结果或交付物。",
    "如果任务需要浏览器交互验收而当前工具无法打开浏览器，必须返回 {\"status\":\"manual_test_required\",\"report\":\"...\"}，并在 report 中原样写清楚缺少浏览器能力、需要人工测试的文件路径和具体测试项。",
    "如果发现需要返工的缺陷，必须返回 {\"passed\":false,\"defects\":[...],\"reason\":\"...\"}；如果需要回到特定阶段，必须显式返回 target_phase，可选值为 pm_plan、architect_plan、implementation、qa、boss_acceptance。",
    "如果需要澄清、授权或暂停，必须使用结构化字段，例如 status: need_clarification、status: await_human_authorization、clarification_required: true；平台不会从普通说明文字里猜你的意图。",
    input.type === "pm_plan" && !isTicketResumeReview ? "产品/项目拆解任务必须优先返回 ticketGraph 数组，描述真实工单 DAG、依赖、目标角色和验收产物。发现前置输入缺失时，要在自己的工单结果里明确 blocked/need_clarification，而不是伪造下游完成。" : undefined
  ].filter(Boolean).join("\n");
}

function isTicketResumeReviewContext(context?: Record<string, unknown>): boolean {
  return Boolean(context?.ticketResumeReview && typeof context.humanFollowup === "string");
}

function currentAssignmentSection(input: ContextAssemblerInput): string {
  return [
    `项目：${input.workspace.name}，路径：${input.workspace.rootPath}。`,
    `目标：${input.goal}`,
    `任务类型：${assignmentLabel(input.type)}`,
    `任务说明：${input.brief}`,
    `预期产物：${input.expectedArtifact}`
  ].join("\n");
}

function workspaceMemorySection(memory: Awaited<ReturnType<ContextStore["readMemory"]>>): string {
  return [
    listSection("长期事实", memory.durableFacts),
    listSection("项目约定", memory.projectConventions),
    listSection("已知命令", memory.knownCommands),
    listSection("近期经验", memory.recentLessons)
  ].join("\n");
}

function recentTurnsSection(messages: AgentSessionMessage[]): { text: string; originalChars: number; truncated: boolean } {
  if (messages.length === 0) return { text: "近期会话：无", originalChars: 0, truncated: false };
  let truncated = false;
  const text = messages.map((message) => {
    const sanitized = sanitizeRecentMessage(message.content);
    if (sanitized !== message.content) truncated = true;
    const compact = compactRecentMessage(sanitized);
    if (compact.length !== sanitized.length) truncated = true;
    return `${message.role}: ${compact}`;
  }).join("\n");
  return {
    text,
    originalChars: messages.reduce((sum, message) => sum + message.content.length, 0),
    truncated
  };
}

function toolObservationSection(toolResults: Array<Record<string, unknown>>): { text: string; originalChars: number; truncated: boolean } {
  if (toolResults.length === 0) return { text: "工具观察：无", originalChars: 0, truncated: false };
  const original = JSON.stringify(toolResults);
  const text = JSON.stringify(toolResults.map((result) => compactToolObservationValue(result)));
  return { text, originalChars: original.length, truncated: text.length !== original.length };
}

function dynamicContextSection(context?: Record<string, unknown>): string {
  if (!context) return "{}";
  const entries = Object.entries(context)
    .filter(([key]) => !["toolResults", "contextReport"].includes(key))
    .map(([key, value]) => [key, compactDynamicContextValue(value)] as const);
  return JSON.stringify(Object.fromEntries(entries));
}

function listSection(title: string, values: string[]): string {
  if (values.length === 0) return `${title}：无`;
  return `${title}：\n${values.map((value) => `- ${value}`).join("\n")}`;
}

function yesNo(value: boolean): string {
  return value ? "是" : "否";
}

const TOOL_OBSERVATION_STRING_CHARS = 12_000;
const RECENT_MESSAGE_STRING_CHARS = 1_200;
const DYNAMIC_CONTEXT_STRING_CHARS = 2_000;

function sanitizeRecentMessage(value: string): string {
  if (!looksLikeAssembledPrompt(value)) return value;
  return `历史 assembled prompt 已过滤，原始长度 ${value.length} 字符。完整原始内容请查看 loop trace；下一轮模型上下文只保留可见摘要。`;
}

function looksLikeAssembledPrompt(value: string): boolean {
  return value.includes("## 稳定提示词")
    || value.includes("PREVIOUS_PROMPT_START")
    || value.includes("PREVIOUS_PROMPT_END");
}

function compactRecentMessage(value: string): string {
  if (value.length <= RECENT_MESSAGE_STRING_CHARS) return value;
  return `${value.slice(0, RECENT_MESSAGE_STRING_CHARS)}\n...[近期会话截断，原始长度 ${value.length} 字符]`;
}

function compactToolObservationValue(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.length <= TOOL_OBSERVATION_STRING_CHARS) return value;
    return `${value.slice(0, TOOL_OBSERVATION_STRING_CHARS)}\n...[工具结果截断，原始长度 ${value.length} 字符]`;
  }
  if (Array.isArray(value)) return value.map(compactToolObservationValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, compactToolObservationValue(item)]));
  }
  return value;
}

function compactDynamicContextValue(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.length <= DYNAMIC_CONTEXT_STRING_CHARS) return value;
    return `${value.slice(0, DYNAMIC_CONTEXT_STRING_CHARS)}\n...[动态上下文截断，原始长度 ${value.length} 字符]`;
  }
  if (Array.isArray(value)) return value.slice(0, 50).map(compactDynamicContextValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .slice(0, 50)
      .map(([key, item]) => [key, compactDynamicContextValue(item)]));
  }
  return value;
}
