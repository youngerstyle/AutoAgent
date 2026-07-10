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
    const stable = stableSection(input);
    const goal = goalSection(input.goal);
    const history = await this.threadSection(input.thread);
    const original = [stable, goal, history].join("\n\n");
    const budgeted = truncateToTokenBudget(original, this.maxInputTokens, "Agent 上下文");
    return {
      prompt: budgeted.text,
      report: {
        injectedChars: budgeted.injectedChars,
        estimatedTokens: estimateTokens(budgeted.text),
        threadItems: input.thread.items.length,
        truncated: budgeted.truncated,
        sections: [
          { name: "stable", chars: stable.length },
          { name: "goal", chars: goal.length },
          { name: "thread", chars: history.length },
        ],
      },
    };
  }

  private async threadSection(thread: AgentThreadSnapshot): Promise<string> {
    const lines: string[] = ["## Thread（严格时间序）"];
    for (const item of [...thread.items].sort((left, right) => left.sequence - right.sequence)) {
      if (item.kind === "goal") continue;
      const payload = await this.store.payload(item.payloadRef);
      lines.push(`[${item.sequence}] ${item.kind}: ${projectPayload(payload)}`);
    }
    if (lines.length === 1) lines.push("无历史消息");
    return lines.join("\n");
  }
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
    "## Tools",
    toolProtocolFor(input.policy, input.agent.roleInWorkspace),
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
    "显式提案格式：{\"goalResolution\":{\"status\":\"completed|blocked|failed\",\"summary\":\"...\",\"evidence\":[{\"kind\":\"...\",\"ref\":\"...\"}],\"domainOutcome\":{...}}}。没有足够事实时继续对话或调用工具，不要提交提案。",
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

function sanitize(value: string): string {
  if (value.includes("## Soul") && value.includes("## Thread（严格时间序）")) {
    return `[已过滤历史组装提示词，原始长度 ${value.length} 字符]`;
  }
  return value;
}
