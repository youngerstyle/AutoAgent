import { createHash } from "node:crypto";
import type { AgentGoal, GoalResolutionProposal } from "../../shared/contracts/agent-engine.js";
import { isKnownToolName } from "../../shared/tool-catalog.js";
import type { AgentProfile, WorkspaceAgent } from "../../shared/types.js";
import type { EffectivePolicy } from "../policy/policy.js";
import { ProviderError, type AgentTurnResult } from "../providers/types.js";
import type { AgentEngine } from "./agent-engine.js";
import type { AgentContextAssembler } from "./context-assembler.js";
import type { AgentProviderAdapter } from "./provider-adapter.js";
import type { AgentTraceStore } from "./trace-store.js";
import { AgentToolRuntime, type AgentToolIntent } from "./tool-runtime.js";

export interface AgentExecutionSliceInput {
  threadId: string;
  goalId?: string;
  profile: AgentProfile;
  agent: WorkspaceAgent;
  policy: EffectivePolicy;
  provider: AgentProfile["defaultProvider"];
  model: string;
}

export interface AgentExecutionSliceResult {
  turnId: string;
  status: "yielded" | "waiting" | "resolution_proposed" | "execution_blocked";
  toolCalls: number;
  goal?: AgentGoal;
  blockReason?: "provider_error" | "usage_limit";
}

export class AgentToolLoop {
  private readonly maxToolCallsPerSlice: number;
  private readonly maxTokensPerGoalWindow?: number;
  private readonly now: () => Date;

  constructor(
    private readonly engine: AgentEngine<any>,
    private readonly contextAssembler: AgentContextAssembler,
    private readonly provider: AgentProviderAdapter,
    private readonly tools: AgentToolRuntime,
    private readonly traces: AgentTraceStore,
    options: { maxToolCallsPerSlice?: number; maxTokensPerGoalWindow?: number; now?: () => Date } = {},
  ) {
    this.maxToolCallsPerSlice = options.maxToolCallsPerSlice ?? 20;
    if (!Number.isInteger(this.maxToolCallsPerSlice) || this.maxToolCallsPerSlice < 1) {
      throw new Error("maxToolCallsPerSlice must be positive");
    }
    this.maxTokensPerGoalWindow = options.maxTokensPerGoalWindow;
    if (this.maxTokensPerGoalWindow !== undefined
      && (!Number.isFinite(this.maxTokensPerGoalWindow) || this.maxTokensPerGoalWindow <= 0)) {
      throw new Error("maxTokensPerGoalWindow must be positive");
    }
    this.now = options.now ?? (() => new Date());
  }

  async runSlice(input: AgentExecutionSliceInput): Promise<AgentExecutionSliceResult> {
    const goal = input.goalId ? await this.engine.getGoal(input.goalId) : undefined;
    if (input.goalId && !goal) throw new Error("Goal does not exist");
    if (goal && !new Set(["active", "resolving"]).has(goal.status)) {
      throw new Error(`Goal ${goal.spec.id} is not runnable: ${goal.status}`);
    }
    const thread = await this.engine.getThread(input.threadId);
    const turnId = stableId("turn", input.threadId, String(thread.version + 1), this.now().toISOString());
    if (goal && this.maxTokensPerGoalWindow !== undefined) {
      const usedTokens = await this.engine.tokenUsageSinceLastHumanMessage(goal.spec.id);
      if (usedTokens >= this.maxTokensPerGoalWindow) {
        const failure = {
          turnId,
          status: "execution_blocked",
          reason: "usage_limit",
          usedTokens,
          maxTokens: this.maxTokensPerGoalWindow,
        } as const;
        await this.trace(turnId, input, "error", failure);
        await this.engine.appendToolItem({
          itemId: `${turnId}:usage-limited`,
          threadId: input.threadId,
          goalId: input.goalId,
          kind: "control",
          value: failure,
          createdAt: this.now().toISOString(),
        });
        return { turnId, status: "execution_blocked", toolCalls: 0, goal, blockReason: "usage_limit" };
      }
    }
    await this.engine.appendToolItem({
      itemId: `${turnId}:started`,
      threadId: input.threadId,
      goalId: input.goalId,
      kind: "control",
      value: { turnId, status: "running" },
      createdAt: this.now().toISOString(),
    });
    const assembled = await this.contextAssembler.assemble({
      profile: input.profile,
      agent: input.agent,
      policy: input.policy,
      thread: await this.engine.getThread(input.threadId),
      goal,
    });
    await this.trace(turnId, input, "context", { prompt: assembled.prompt, report: assembled.report });
    let result: AgentTurnResult;
    try {
      result = await this.provider.run({
        provider: input.provider,
        model: input.model,
        systemPrompt: [
          "你是一个通用、自主、可使用工具的 Agent。遵守提供的 Soul、Identity、Agent、Tools 与 Goal。",
          "每轮必须只返回一个 JSON 对象，不要使用 Markdown 代码块，也不要在 JSON 前后添加文字。",
          "JSON 的 message 字段用于给 human 展示自然语言进展；机器控制字段只能使用 toolIntents 和 goalResolution。",
          "存在活动 Goal 时，本轮必须通过非空 toolIntents 继续执行，或通过 goalResolution 明确提交 completed、blocked、failed 之一；不能只回复 message 后停止。",
        ].join("\n"),
        prompt: assembled.prompt,
      });
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      const failure = {
        turnId,
        status: "execution_blocked",
        reason: "provider_error",
        retryable: error.retryable,
        code: error.code,
        message: error.message,
      } as const;
      await this.trace(turnId, input, "error", failure);
      await this.engine.appendToolItem({
        itemId: `${turnId}:execution-blocked`,
        threadId: input.threadId,
        goalId: input.goalId,
        kind: "control",
        value: failure,
        createdAt: this.now().toISOString(),
      });
      return { turnId, status: "execution_blocked", toolCalls: 0, goal, blockReason: "provider_error" };
    }
    await this.trace(turnId, input, "provider_response", result);
    const totalTokens = result.usage?.totalTokens
      ?? (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0);
    if (goal && totalTokens > 0) {
      await this.engine.appendToolItem({
        itemId: `${turnId}:usage`,
        threadId: input.threadId,
        goalId: input.goalId,
        kind: "control",
        value: { type: "provider_usage", goalId: goal.spec.id, turnId, totalTokens, usage: result.usage },
        createdAt: this.now().toISOString(),
      });
    }
    await this.engine.appendModelItem({
      itemId: `${turnId}:model`,
      threadId: input.threadId,
      goalId: input.goalId,
      content: visibleModelMessage(result),
      createdAt: this.now().toISOString(),
    });

    const intents = toolIntents(result.structured);
    let toolCalls = 0;
    for (const [index, intent] of intents.slice(0, this.maxToolCallsPerSlice).entries()) {
      const observation = await this.tools.execute(intent);
      toolCalls += 1;
      await this.trace(turnId, input, "tool", { intent, observation });
      await this.engine.appendToolItem({
        itemId: `${turnId}:tool:${index + 1}`,
        threadId: input.threadId,
        goalId: input.goalId,
        kind: "observation",
        value: observation,
        createdAt: this.now().toISOString(),
      });
    }
    if (intents.length) {
      const exhausted = intents.length > this.maxToolCallsPerSlice;
      await this.engine.appendToolItem({
        itemId: `${turnId}:yielded`,
        threadId: input.threadId,
        goalId: input.goalId,
        kind: "control",
        value: {
          turnId,
          status: "yielded",
          reason: exhausted ? "execution_slice_budget" : "tool_observations_ready",
          remainingRequestedTools: Math.max(0, intents.length - toolCalls),
        },
        createdAt: this.now().toISOString(),
      });
      return { turnId, status: "yielded", toolCalls, goal: input.goalId ? await this.engine.getGoal(input.goalId) : undefined };
    }

    const proposal = goal ? resolutionProposal(result.structured, goal, turnId, this.now().toISOString()) : undefined;
    if (proposal) {
      const attempted = await this.engine.proposeGoalResolution(proposal);
      await this.trace(turnId, input, "settlement", attempted);
      return { turnId, status: "resolution_proposed", toolCalls, goal: attempted.goal };
    }
    const hasActiveGoal = goal?.status === "active";
    await this.engine.appendToolItem({
      itemId: `${turnId}:${hasActiveGoal ? "yielded" : "waiting"}`,
      threadId: input.threadId,
      goalId: input.goalId,
      kind: "control",
      value: hasActiveGoal
        ? {
            turnId,
            status: "yielded",
            reason: "active_goal_unresolved",
            guidance: "当前 Goal 尚未结算。下一轮继续工作；完成、受阻或失败时必须提交 goalResolution。",
          }
        : { turnId, status: "waiting" },
      createdAt: this.now().toISOString(),
    });
    return { turnId, status: hasActiveGoal ? "yielded" : "waiting", toolCalls, goal };
  }

  private trace(
    turnId: string,
    input: AgentExecutionSliceInput,
    kind: "context" | "provider_response" | "tool" | "settlement" | "error",
    data: unknown,
  ): Promise<void> {
    const createdAt = this.now().toISOString();
    return this.traces.append({
      traceId: stableId("trace", turnId, kind, createHash("sha256").update(JSON.stringify(data)).digest("hex")),
      agentId: input.agent.id,
      threadId: input.threadId,
      goalId: input.goalId,
      turnId,
      kind,
      createdAt,
      data,
    });
  }
}

function visibleModelMessage(result: AgentTurnResult): string {
  const message = result.structured?.message;
  if (typeof message === "string" && message.trim()) return message.trim();
  const resolution = result.structured?.goalResolution;
  if (resolution && typeof resolution === "object" && !Array.isArray(resolution)) {
    const summary = (resolution as Record<string, unknown>).summary;
    if (typeof summary === "string" && summary.trim()) return summary.trim();
  }
  return result.text;
}

function toolIntents(value?: Record<string, unknown>): AgentToolIntent[] {
  if (!Array.isArray(value?.toolIntents)) return [];
  return value.toolIntents.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    if (typeof record.tool !== "string" || !isKnownToolName(record.tool)) return [];
    return [{
      tool: record.tool,
      path: typeof record.path === "string" ? record.path : undefined,
      content: typeof record.content === "string" ? record.content : undefined,
      command: typeof record.command === "string" ? record.command : undefined,
      serviceId: typeof record.serviceId === "string" ? record.serviceId : undefined,
    }];
  });
}

function resolutionProposal(
  structured: Record<string, unknown> | undefined,
  goal: AgentGoal,
  turnId: string,
  createdAt: string,
): GoalResolutionProposal | undefined {
  const value = structured?.goalResolution;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!new Set(["completed", "blocked", "failed"]).has(String(record.status))) return undefined;
  if (typeof record.summary !== "string" || !record.summary.trim()) return undefined;
  const evidence = Array.isArray(record.evidence)
    ? record.evidence.flatMap((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const evidenceRecord = item as Record<string, unknown>;
        return typeof evidenceRecord.kind === "string" && typeof evidenceRecord.ref === "string"
          ? [{ kind: evidenceRecord.kind, ref: evidenceRecord.ref }]
          : [];
      })
    : [];
  return {
    proposalId: stableId("proposal", goal.spec.id, turnId),
    goalId: goal.spec.id,
    expectedGoalVersion: goal.version,
    resolvingGoalVersion: goal.version + 1,
    status: record.status as "completed" | "blocked" | "failed",
    summary: record.summary,
    evidence,
    domainOutcome: record.domainOutcome,
    createdAt,
  };
}

function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash("sha256").update(JSON.stringify(parts)).digest("base64url")}`;
}
