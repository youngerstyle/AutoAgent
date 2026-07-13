import type { AgentGoal, AgentThreadSnapshot } from "../../shared/contracts/agent-engine.js";
import type { AgentPolicy, AgentProfile, WorkspaceAgent } from "../../shared/types.js";
import { toolProtocolFor } from "../../shared/tool-catalog.js";
import { estimateTokens, truncateToTokenBudget } from "../context/token-budget.js";
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
    const stable = truncateToTokenBudget(stableSection(input), Math.floor(this.maxInputTokens * 0.45), "SIA 与工具配置");
    const goal = truncateToTokenBudget(goalSection(input.goal), Math.floor(this.maxInputTokens * 0.2), "当前 Goal");
    const history = await this.threadSection(input.thread, Math.max(1, Math.floor(this.maxInputTokens * 0.35)));
    const prompt = [stable.text, goal.text, history.text].join("\n\n");
    return {
      prompt,
      report: {
        injectedChars: prompt.length,
        estimatedTokens: estimateTokens(prompt),
        threadItems: input.thread.items.length,
        compactedThreadItems: history.compactedItems,
        recentThreadItems: history.recentItems,
        truncated: stable.truncated || goal.truncated || history.compactedItems > 0,
        sections: [
          { name: "stable", chars: stable.text.length },
          { name: "goal", chars: goal.text.length },
          { name: "thread", chars: history.text.length },
        ],
      },
    };
  }

  private async threadSection(thread: AgentThreadSnapshot, maxTokens: number): Promise<{ text: string; compactedItems: number; recentItems: number }> {
    const entries: Array<{ sequence: number; kind: string; line: string }> = [];
    const items = [...thread.items].sort((left, right) => left.sequence - right.sequence);
    const payloads = await this.store.payloads(items.map((item) => item.payloadRef));
    for (const item of items) {
      if (item.kind === "goal") continue;
      const payload = payloads.get(item.payloadRef);
      if (item.kind === "control" && !isGoalResolutionDecision(payload)) continue;
      entries.push({ sequence: item.sequence, kind: item.kind, line: `[${item.sequence}] ${item.kind}: ${projectPayload(payload)}` });
    }
    if (entries.length === 0) return { text: "## Thread（严格时间序）\n无历史消息", compactedItems: 0, recentItems: 0 };

    const maxChars = Math.max(1, maxTokens * 4);
    const header = "## Thread（严格时间序）";
    const summaryReserve = Math.min(480, Math.max(120, Math.floor(maxChars * 0.12)));
    const recent: string[] = [];
    let used = header.length + 1;
    let firstRecentIndex = entries.length;
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const available = maxChars - used - (index > 0 ? summaryReserve : 0);
      if (available <= 0) break;
      const line = entries[index].line;
      if (line.length + 1 <= available) {
        recent.unshift(line);
        used += line.length + 1;
        firstRecentIndex = index;
        continue;
      }
      if (recent.length === 0) {
        const compacted = compactSingleItem(line, available);
        recent.unshift(compacted);
        used += compacted.length + 1;
        firstRecentIndex = index;
      }
      break;
    }
    const old = entries.slice(0, firstRecentIndex);
    const lines = [header];
    if (old.length > 0) lines.push(compactionSummary(old));
    lines.push(...recent);
    return { text: lines.join("\n"), compactedItems: old.length, recentItems: recent.length };
  }
}

function compactionSummary(entries: Array<{ sequence: number; kind: string }>): string {
  const counts = new Map<string, number>();
  for (const entry of entries) counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + 1);
  const kinds = [...counts.entries()].map(([kind, count]) => `${kind} ${count}`).join("、");
  return `[历史已压缩：序号 ${entries[0].sequence}-${entries.at(-1)?.sequence}，${kinds}。完整原始记录仍保存在 Agent Thread。]`;
}

function compactSingleItem(line: string, available: number): string {
  if (line.length <= available) return line;
  const marker = "\n...[单条消息按上下文预算压缩]...\n";
  if (available <= marker.length + 16) return line.slice(0, Math.max(0, available));
  const content = available - marker.length;
  const head = Math.ceil(content * 0.6);
  return `${line.slice(0, head)}${marker}${line.slice(-(content - head))}`;
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
    "只有缺少系统无法替代的输入（例如凭证、明确授权、不可逆外部操作确认或真实安全边界）时，才允许阻塞等待 human。偏好、范围细节和实现选择应由团队先给出默认方案。",
    "## Tools",
    toolProtocolFor(input.policy),
    "只能使用已配置且已授权的工具；不得编造工具结果。",
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
    "普通回复、工具调用或一次执行切片结束都不代表目标完成；只有显式提交 GoalResolutionProposal 才能请求改变目标结果。",
    "显式提案格式：{\"goalResolution\":{\"status\":\"completed|blocked|failed\",\"summary\":\"...\",\"evidence\":[{\"kind\":\"...\",\"ref\":\"...\"}],\"domainOutcome\":{...}}}。缺少事实时先查项目和工具；可用合理假设解决时继续并标注假设。只有缺少不可替代输入时才提交 blocked。",
  ].filter(Boolean).join("\n");
}

function projectPayload(value: unknown): string {
  if (typeof value === "string") return sanitize(value);
  if (!value || typeof value !== "object") return JSON.stringify(value);
  const record = value as Record<string, unknown>;
  if (typeof record.content === "string") {
    const sender = typeof record.senderPrincipalId === "string" ? `${record.senderPrincipalId}: ` : "";
    return `${sender}${sanitize(record.content)}`;
  }
  return sanitize(JSON.stringify(value));
}

function isGoalResolutionDecision(value: unknown): boolean {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && (value as Record<string, unknown>).type === "goal_resolution_decision";
}

function sanitize(value: string): string {
  if (value.includes("## Soul") && value.includes("## Thread（严格时间序）")) {
    return `[已过滤历史组装提示词，原始长度 ${value.length} 字符]`;
  }
  return value;
}
