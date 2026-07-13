import type { AgentGoal, AgentThreadSnapshot } from "../../shared/contracts/agent-engine.js";
import type { AgentModelHistoryItem } from "../providers/types.js";
import type { AgentPolicy, AgentProfile, WorkspaceAgent } from "../../shared/types.js";
import type { AgentStore } from "./agent-store.js";

export interface AgentContextAssemblerInput {
  profile: AgentProfile;
  agent: WorkspaceAgent;
  policy: AgentPolicy;
  thread: AgentThreadSnapshot;
  goal?: AgentGoal;
}

export interface AgentContextReport {
  injectedChars: number;
  estimatedTokens: number;
  threadItems: number;
  compactedThreadItems: number;
  recentThreadItems: number;
  truncated: boolean;
  sections: Array<{ name: string; chars: number }>;
}

export interface AgentAssembledContext {
  instructions: string;
  history: AgentModelHistoryItem[];
  prompt: string;
  report: AgentContextReport;
}

export class AgentContextAssembler {
  constructor(
    private readonly store: AgentStore,
    private readonly maxInputTokens = 64_000,
  ) {}

  async assemble(input: AgentContextAssemblerInput): Promise<AgentAssembledContext> {
    if (input.thread.agentId !== input.agent.id || input.agent.id !== this.store.agentId) {
      throw new Error("Agent context partition mismatch");
    }
    if (input.goal && input.goal.spec.threadId !== input.thread.threadId) {
      throw new Error("Goal does not belong to thread");
    }
    const stable = truncateToTokenBudget(stableSection(input), Math.floor(this.maxInputTokens * 0.55), "SIA 与工具配置");
    const goal = truncateToTokenBudget(goalSection(input.goal), Math.floor(this.maxInputTokens * 0.2), "当前 Goal");
    const instructions = [stable.text, goal.text].join("\n\n");
    const projected = await this.projectHistory(input.thread, Math.max(1, Math.floor(this.maxInputTokens * 0.25)));
    const renderedHistory = projected.history.map(renderHistoryItem).join("\n");
    const prompt = `${instructions}\n\n## Thread（严格时间序）\n${renderedHistory || "无历史消息"}`;
    return {
      instructions,
      history: projected.history,
      prompt,
      report: {
        injectedChars: instructions.length + renderedHistory.length,
        estimatedTokens: estimateTokens(instructions) + estimateTokens(renderedHistory),
        threadItems: input.thread.items.length,
        compactedThreadItems: projected.compactedItems,
        recentThreadItems: projected.recentItems,
        truncated: stable.truncated || goal.truncated || projected.compactedItems > 0,
        sections: [
          { name: "stable", chars: stable.text.length },
          { name: "goal", chars: goal.text.length },
          { name: "history", chars: renderedHistory.length },
        ],
      },
    };
  }

  private async projectHistory(
    thread: AgentThreadSnapshot,
    maxTokens: number,
  ): Promise<{ history: AgentModelHistoryItem[]; compactedItems: number; recentItems: number }> {
    const items = [...thread.items].sort((left, right) => left.sequence - right.sequence);
    const payloads = await this.store.payloads(items.map((item) => item.payloadRef));
    const projected = items.flatMap((item) => projectThreadItem(item.kind, payloads.get(item.payloadRef)));
    if (!projected.length) return { history: [], compactedItems: 0, recentItems: 0 };

    const groups = historyGroups(projected);
    const maxChars = Math.max(1, maxTokens * 4);
    const recentGroups: AgentModelHistoryItem[][] = [];
    let used = 0;
    let selectedItems = 0;
    for (let index = groups.length - 1; index >= 0; index -= 1) {
      const groupChars = JSON.stringify(groups[index]).length;
      if (recentGroups.length && used + groupChars > maxChars) break;
      if (!recentGroups.length && groupChars > maxChars) {
        recentGroups.unshift(hasToolInteraction(groups[index]) ? groups[index] : compactGroup(groups[index], maxChars));
        selectedItems += groups[index].length;
        break;
      }
      recentGroups.unshift(groups[index]);
      used += groupChars;
      selectedItems += groups[index].length;
    }
    const compactedItems = projected.length - selectedItems;
    const history = recentGroups.flat();
    if (compactedItems > 0) {
      history.unshift({
        type: "user_message",
        content: `[历史已压缩：${compactedItems} 条较早的 Agent Thread 项未进入本轮上下文，完整记录仍可审计。]`,
      });
    }
    return { history, compactedItems, recentItems: selectedItems };
  }
}

function hasToolInteraction(group: AgentModelHistoryItem[]): boolean {
  return group.some((item) => item.type === "tool_call" || item.type === "tool_result");
}

function projectThreadItem(kind: string, value: unknown): AgentModelHistoryItem[] {
  if (!isRecord(value)) return [];
  if (kind === "message" && typeof value.content === "string") {
    return [{ type: "user_message", content: value.content }];
  }
  if (kind === "model" && typeof value.content === "string") {
    return [{ type: "assistant_message", content: value.content }];
  }
  if (kind === "tool" && value.type === "tool_call"
    && typeof value.callId === "string" && typeof value.name === "string") {
    return [{ type: "tool_call", callId: value.callId, name: value.name, arguments: value.arguments }];
  }
  if (kind === "observation" && value.type === "tool_result" && typeof value.callId === "string") {
    return [{
      type: "tool_result",
      callId: value.callId,
      content: typeof value.content === "string" ? value.content : JSON.stringify(value.content),
      isError: value.isError === true,
    }];
  }
  if (kind === "control" && value.type === "goal_resolution_decision") {
    return [{ type: "user_message", content: `Host 对目标结算的决定：${JSON.stringify(value.decision)}` }];
  }
  return [];
}

function historyGroups(history: AgentModelHistoryItem[]): AgentModelHistoryItem[][] {
  const groups: AgentModelHistoryItem[][] = [];
  for (const item of history) {
    const current = groups.at(-1);
    if (item.type === "tool_call" && current && current.every((entry) => entry.type !== "tool_result")) {
      current.push(item);
    } else if (item.type === "tool_result" && current
      && current.some((entry) => entry.type === "tool_call" && entry.callId === item.callId)) {
      current.push(item);
    } else {
      groups.push([item]);
    }
  }
  return groups;
}

function compactGroup(group: AgentModelHistoryItem[], maxChars: number): AgentModelHistoryItem[] {
  const item = group[0];
  if (item.type !== "user_message" && item.type !== "assistant_message") return [];
  const marker = "\n...[单条消息按上下文预算压缩]...\n";
  const available = Math.max(0, maxChars - marker.length);
  const head = Math.ceil(available * 0.6);
  return [{ ...item, content: `${item.content.slice(0, head)}${marker}${item.content.slice(-(available - head))}` }];
}

function stableSection(input: AgentContextAssemblerInput): string {
  const profile = input.profile;
  return [
    "## Soul",
    profile.soul?.trim() || "未定义",
    "## Identity",
    profile.identity?.trim() || `岗位：${profile.name}`,
    "## Agent",
    profile.agentMd?.trim() || `能力：${profile.capabilities.join("、")}`,
    "## Autonomy",
    "human 提供的是目标和方向，不负责撰写完整规格。优先使用现有项目事实、工具和专业判断补全可操作细节。",
    "对可逆、低风险的不确定项，明确记录合理假设并继续推进；可以提出简短问题用于校准，但不得把回答作为推进前提。",
    "只有缺少系统无法替代的输入时，才允许提交 blocked；偏好、范围细节和实现选择应由 Agent 先给出默认方案。",
    "## Tools",
    "工具以 Provider 原生函数调用提供。只能调用本轮注册且已授权的工具；不得在助手文本中伪造工具调用或工具结果。",
  ].join("\n");
}

function goalSection(goal?: AgentGoal): string {
  if (!goal) return "## Goal\n当前是普通对话，没有活动目标。";
  return [
    "## Goal",
    `目标：${goal.spec.objective}`,
    `状态：${goal.status}`,
    `成功标准：\n${goal.spec.successCriteria.map((item) => `- ${item}`).join("\n") || "- 未定义"}`,
    goal.spec.outputContract ? `输出契约：${goal.spec.outputContract.schemaRef}` : undefined,
    goal.spec.contextRefs.length
      ? `上下文引用：\n${goal.spec.contextRefs.map((item) => `- ${item.kind}: ${item.ref}`).join("\n")}`
      : undefined,
    "普通回复、工具调用或一次 turn 结束都不代表目标完成。只有调用 goal_resolution 工具才能提交 GoalResolutionProposal。",
  ].filter(Boolean).join("\n");
}

function renderHistoryItem(item: AgentModelHistoryItem): string {
  if (item.type === "user_message") return `human: ${item.content}`;
  if (item.type === "assistant_message") return `assistant: ${item.content}`;
  if (item.type === "tool_call") return `tool_call(${item.callId}): ${item.name} ${JSON.stringify(item.arguments)}`;
  return `tool_result(${item.callId}, error=${item.isError}): ${item.content}`;
}

function truncateToTokenBudget(value: string, maxTokens: number, label: string): { text: string; truncated: boolean } {
  const maxChars = Math.max(1, maxTokens * 4);
  if (value.length <= maxChars) return { text: value, truncated: false };
  const marker = `\n...[${label}按上下文预算截断]...\n`;
  const available = Math.max(0, maxChars - marker.length);
  const head = Math.ceil(available * 0.7);
  return { text: `${value.slice(0, head)}${marker}${value.slice(-(available - head))}`, truncated: true };
}

function estimateTokens(value: string): number {
  return Math.ceil(value.length / 4);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
