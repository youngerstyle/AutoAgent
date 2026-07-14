import { createHash } from "node:crypto";
import type { AgentGoal, AgentThreadSnapshot, GoalResolutionProposal } from "../../shared/contracts/agent-engine.js";
import type { AgentProfile, WorkspaceAgent, WorkspaceToolName } from "../../shared/types.js";
import { DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS, effectiveInputTokenBudget } from "../../shared/model-context.js";
import type { EffectivePolicy } from "../policy/policy.js";
import {
  ProviderError,
  type AgentModelHistoryItem,
  type AgentModelOutputItem,
  type AgentModelTurnResult,
  type AgentToolDefinition,
} from "../providers/types.js";
import type { AgentEngine } from "./agent-engine.js";
import type { AgentContextAssembler } from "./context-assembler.js";
import type { AgentProviderAdapter } from "./provider-adapter.js";
import type { AgentTraceStore } from "./trace-store.js";
import { AgentToolRuntime, type AgentToolIntent } from "./tool-runtime.js";

export interface AgentExecutionSliceInput {
  threadId: string;
  turnId?: string;
  triggerMessageId?: string;
  goalId?: string;
  profile: AgentProfile;
  agent: WorkspaceAgent;
  policy: EffectivePolicy;
  provider: AgentProfile["defaultProvider"];
  model: string;
  contextWindowTokens?: number;
}

export interface AgentExecutionSliceResult {
  turnId: string;
  status: "yielded" | "waiting" | "resolution_proposed" | "execution_blocked";
  toolCalls: number;
  goal?: AgentGoal;
  blockReason?: "provider_error" | "provider_protocol" | "usage_limit";
}

export class AgentToolLoop {
  private readonly maxToolCallsPerTurn: number;
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
    this.maxToolCallsPerTurn = options.maxToolCallsPerSlice ?? 20;
    if (!Number.isInteger(this.maxToolCallsPerTurn) || this.maxToolCallsPerTurn < 1) {
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
    const pendingTurn = pendingMessageTurn(thread);
    const turnId = input.turnId ?? pendingTurn?.turnId ?? stableId("turn", input.threadId, String(thread.version + 1), this.now().toISOString());
    const triggerMessageId = input.triggerMessageId ?? (pendingTurn?.turnId === turnId ? pendingTurn.messageId : undefined);
    const usageBlock = await this.usageBlock(goal, turnId, input);
    if (usageBlock) return usageBlock;
    const maxInputTokens = effectiveInputTokenBudget(
      input.contextWindowTokens ?? DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS,
    );

    await this.engine.appendToolItem({
      itemId: `${turnId}:started`,
      turnId,
      threadId: input.threadId,
      goalId: input.goalId,
      kind: "control",
      value: { turnId, ...(triggerMessageId ? { triggerMessageId } : {}), status: "running" },
      createdAt: this.now().toISOString(),
    });
    const compactionFailure = await this.compactIfNeeded(turnId, input, goal, maxInputTokens);
    if (compactionFailure) return compactionFailure;
    const assembled = await this.contextAssembler.assemble({
      profile: input.profile,
      agent: input.agent,
      policy: input.policy,
      thread: await this.engine.getThread(input.threadId),
      goal,
    }, maxInputTokens);
    await this.trace(turnId, input, "context", { prompt: assembled.prompt, report: assembled.report });

    const history = [...assembled.history];
    const toolDefinitions = [
      ...this.tools.definitions(),
      ...(goal ? [goalResolutionTool()] : []),
    ];
    let toolCalls = 0;
    let modelToolCalls = 0;
    let round = 0;
    while (true) {
      round += 1;
      let result;
      try {
        result = await this.provider.run({
          provider: input.provider,
          model: input.model,
          instructions: assembled.instructions,
          history,
          tools: toolDefinitions,
        });
      } catch (error) {
        if (!(error instanceof ProviderError)) throw error;
        return this.providerFailure(turnId, input, error, toolCalls);
      }
      await this.trace(turnId, input, "provider_response", { round, result });
      await this.recordUsage(turnId, input, goal, round, result.usage);
      if (!result.items.length) return this.protocolFailure(turnId, input, "Provider returned no response items", toolCalls);

      let needsFollowUp = false;
      let proposal: {
        value: GoalResolutionProposal;
        callId: string;
        index: number;
      } | undefined;
      const followUpItems: AgentModelHistoryItem[] = [];
      const pendingToolCalls: Array<{
        index: number;
        item: Extract<AgentModelOutputItem, { type: "tool_call" }>;
        overLimit: boolean;
      }> = [];
      const hasWorkspaceToolCall = result.items.some((item) => item.type === "tool_call" && item.name !== "goal_resolution");
      for (const [index, item] of result.items.entries()) {
        history.push(item);
        if (item.type === "assistant_message") {
          await this.engine.appendModelItem({
            itemId: `${turnId}:round:${round}:item:${index + 1}`,
            turnId,
            threadId: input.threadId,
            goalId: input.goalId,
            content: item.content,
            createdAt: this.now().toISOString(),
          });
          continue;
        }

        await this.recordToolCall(turnId, input, round, index, item);
        modelToolCalls += 1;
        pendingToolCalls.push({ index, item, overLimit: modelToolCalls > this.maxToolCallsPerTurn });
      }

      let toolLimitTriggered = false;
      for (const { index, item, overLimit } of pendingToolCalls) {
        if (overLimit) {
          const limited = toolError(item.callId, `单个 turn 的工具调用保险丝已触发（${this.maxToolCallsPerTurn}）`);
          await this.recordToolResult(turnId, input, round, index, limited, { error: limited.content });
          followUpItems.push(limited);
          toolLimitTriggered = true;
          continue;
        }
        if (item.name === "goal_resolution") {
          if (hasWorkspaceToolCall) {
            const premature = toolError(item.callId, "同一响应仍有待执行的工作区工具；请读取工具结果后再提交 goal_resolution");
            await this.recordToolResult(turnId, input, round, index, premature, { error: premature.content });
            followUpItems.push(premature);
            needsFollowUp = true;
            continue;
          }
          const value = goal ? resolutionProposal(item.arguments, goal, turnId, this.now().toISOString()) : undefined;
          if (value) proposal = { value, callId: item.callId, index };
          if (!value) {
            const invalid = toolError(item.callId, "goal_resolution 参数无效");
            await this.recordToolResult(turnId, input, round, index, invalid, { error: invalid.content });
            followUpItems.push(invalid);
            needsFollowUp = true;
          }
          continue;
        }

        toolCalls += 1;
        const observation = await this.executeTool(item);
        const toolResult: AgentModelHistoryItem = {
          type: "tool_result",
          callId: item.callId,
          content: JSON.stringify(observation),
          isError: observation.ok !== true,
        };
        await this.recordToolResult(turnId, input, round, index, toolResult, observation);
        followUpItems.push(toolResult);
        needsFollowUp = true;
      }

      history.push(...followUpItems);
      if (toolLimitTriggered) return this.yieldForToolLimit(turnId, input, toolCalls, goal);

      if (proposal) {
        const submitted: AgentModelHistoryItem = {
          type: "tool_result",
          callId: proposal.callId,
          content: JSON.stringify({ proposalSubmitted: true, proposalId: proposal.value.proposalId }),
          isError: false,
        };
        await this.recordToolResult(turnId, input, round, proposal.index, submitted, {
          proposalSubmitted: true,
          proposalId: proposal.value.proposalId,
        });
        const attempted = await this.engine.proposeGoalResolution(proposal.value);
        await this.trace(turnId, input, "settlement", attempted);
        return { turnId, status: "resolution_proposed", toolCalls, goal: attempted.goal };
      }
      if (needsFollowUp) {
        const blocked = await this.usageBlock(goal, turnId, input);
        if (blocked) return { ...blocked, toolCalls };
        continue;
      }

      await this.engine.appendToolItem({
        itemId: `${turnId}:waiting`,
        turnId,
        threadId: input.threadId,
        goalId: input.goalId,
        kind: "control",
        value: { turnId, status: "waiting" },
        createdAt: this.now().toISOString(),
      });
      return { turnId, status: "waiting", toolCalls, goal: input.goalId ? await this.engine.getGoal(input.goalId) : undefined };
    }
  }

  private async compactIfNeeded(
    turnId: string,
    input: AgentExecutionSliceInput,
    goal: AgentGoal | undefined,
    maxInputTokens: number,
  ): Promise<AgentExecutionSliceResult | undefined> {
    const plan = await this.contextAssembler.planCompaction(
      await this.engine.getThread(input.threadId),
      maxInputTokens,
    );
    if (!plan) return undefined;
    let result: AgentModelTurnResult;
    try {
      result = await this.provider.run({
        provider: input.provider,
        model: input.model,
        instructions: [
          "你正在执行 Agent Thread 上下文压缩。",
          "将历史整理为可供同一个 Agent 后续继续工作的语义摘要。",
          "必须保留 human 的目标与约束、已经确认的事实和决策、读取过的文件及关键结论、工具执行结果、未完成工作和阻塞原因。",
          `摘要不得超过 ${plan.maxSummaryChars} 个字符；在预算内优先保留仍会影响后续行动的事实。`,
          "不要声称完成当前 Goal，不要输出工具调用，只返回摘要正文。",
        ].join("\n"),
        history: plan.history,
        tools: [],
      });
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      return this.providerFailure(turnId, input, error, 0);
    }
    await this.trace(turnId, input, "provider_response", { phase: "compaction", result });
    await this.recordUsage(turnId, input, goal, "compaction", result.usage);
    const summary = result.items
      .filter((item): item is Extract<AgentModelOutputItem, { type: "assistant_message" }> => item.type === "assistant_message")
      .map((item) => item.content.trim())
      .filter(Boolean)
      .join("\n");
    if (!summary || result.items.some((item) => item.type === "tool_call")) {
      return this.protocolFailure(turnId, input, "上下文压缩没有返回纯文本摘要", 0);
    }
    if (summary.length > plan.maxSummaryChars) {
      return this.protocolFailure(
        turnId,
        input,
        `上下文压缩摘要超过预算（${summary.length}/${plan.maxSummaryChars} 字符）`,
        0,
      );
    }
    const checkpointItemId = stableId(
      "compaction",
      input.threadId,
      String(plan.replacedThroughSequence),
      String(plan.threadVersion),
    );
    await this.engine.appendCompaction({
      itemId: checkpointItemId,
      turnId,
      threadId: input.threadId,
      replacedThroughSequence: plan.replacedThroughSequence,
      replacementHistory: [{ type: "user_message", content: `[历史摘要]\n${summary}` }],
      originalItemCount: plan.originalItemCount,
      createdAt: this.now().toISOString(),
    });
    await this.trace(turnId, input, "context", {
      phase: "compaction",
      checkpointItemId,
      replacedThroughSequence: plan.replacedThroughSequence,
      originalItemCount: plan.originalItemCount,
      summaryChars: summary.length,
    });
    return undefined;
  }

  private async executeTool(item: Extract<AgentModelOutputItem, { type: "tool_call" }>) {
    const intent = toolIntent(item.name, item.arguments);
    if (!intent) return { tool: item.name, ok: false, error: "工具名称或参数无效" };
    return this.tools.execute(intent);
  }

  private recordToolCall(
    turnId: string,
    input: AgentExecutionSliceInput,
    round: number,
    index: number,
    item: Extract<AgentModelOutputItem, { type: "tool_call" }>,
  ): Promise<void> {
    return this.engine.appendToolItem({
      itemId: `${turnId}:round:${round}:tool:${index + 1}`,
      turnId,
      threadId: input.threadId,
      goalId: input.goalId,
      kind: "tool",
      value: { ...item, ...(input.goalId ? { goalId: input.goalId } : {}) },
      createdAt: this.now().toISOString(),
    });
  }

  private async recordToolResult(
    turnId: string,
    input: AgentExecutionSliceInput,
    round: number,
    index: number,
    result: AgentModelHistoryItem,
    observation: unknown,
  ): Promise<void> {
    if (result.type !== "tool_result") return;
    await this.trace(turnId, input, "tool", { callId: result.callId, observation });
    await this.engine.appendToolItem({
      itemId: `${turnId}:round:${round}:result:${index + 1}`,
      turnId,
      threadId: input.threadId,
      goalId: input.goalId,
      kind: "observation",
      value: { type: "tool_result", callId: result.callId, content: observation, isError: result.isError },
      createdAt: this.now().toISOString(),
    });
  }

  private async recordUsage(
    turnId: string,
    input: AgentExecutionSliceInput,
    goal: AgentGoal | undefined,
    usageKey: number | string,
    usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined,
  ): Promise<void> {
    const totalTokens = usage?.totalTokens ?? (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
    if (!goal || totalTokens <= 0) return;
    await this.engine.appendToolItem({
      itemId: `${turnId}:usage:${usageKey}`,
      turnId,
      threadId: input.threadId,
      goalId: input.goalId,
      kind: "control",
      value: { type: "provider_usage", goalId: goal.spec.id, turnId, totalTokens, usage },
      createdAt: this.now().toISOString(),
    });
  }

  private async usageBlock(
    goal: AgentGoal | undefined,
    turnId: string,
    input: AgentExecutionSliceInput,
  ): Promise<AgentExecutionSliceResult | undefined> {
    if (!goal || this.maxTokensPerGoalWindow === undefined) return undefined;
    const usedTokens = await this.engine.tokenUsageSinceLastHumanMessage(goal.spec.id);
    if (usedTokens < this.maxTokensPerGoalWindow) return undefined;
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
      turnId,
      threadId: input.threadId,
      goalId: input.goalId,
      kind: "control",
      value: failure,
      createdAt: this.now().toISOString(),
    });
    return { turnId, status: "execution_blocked", toolCalls: 0, goal, blockReason: "usage_limit" };
  }

  private async providerFailure(
    turnId: string,
    input: AgentExecutionSliceInput,
    error: ProviderError,
    toolCalls: number,
  ): Promise<AgentExecutionSliceResult> {
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
      turnId,
      threadId: input.threadId,
      goalId: input.goalId,
      kind: "control",
      value: failure,
      createdAt: this.now().toISOString(),
    });
    return { turnId, status: "execution_blocked", toolCalls, goal: input.goalId ? await this.engine.getGoal(input.goalId) : undefined, blockReason: "provider_error" };
  }

  private async protocolFailure(
    turnId: string,
    input: AgentExecutionSliceInput,
    message: string,
    toolCalls: number,
  ): Promise<AgentExecutionSliceResult> {
    const failure = { turnId, status: "execution_blocked", reason: "provider_protocol", message } as const;
    await this.trace(turnId, input, "error", failure);
    await this.engine.appendToolItem({
      itemId: `${turnId}:protocol-error`,
      turnId,
      threadId: input.threadId,
      goalId: input.goalId,
      kind: "control",
      value: failure,
      createdAt: this.now().toISOString(),
    });
    return { turnId, status: "execution_blocked", toolCalls, goal: input.goalId ? await this.engine.getGoal(input.goalId) : undefined, blockReason: "provider_protocol" };
  }

  private async yieldForToolLimit(
    turnId: string,
    input: AgentExecutionSliceInput,
    toolCalls: number,
    goal: AgentGoal | undefined,
  ): Promise<AgentExecutionSliceResult> {
    await this.engine.appendToolItem({
      itemId: `${turnId}:yielded`,
      turnId,
      threadId: input.threadId,
      goalId: input.goalId,
      kind: "control",
      value: { turnId, status: "yielded", reason: "tool_call_safety_fuse" },
      createdAt: this.now().toISOString(),
    });
    return { turnId, status: "yielded", toolCalls, goal };
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

function goalResolutionTool(): AgentToolDefinition {
  return {
    name: "goal_resolution",
    description: "提交当前 Goal 的完成、受阻或失败结论。普通回复不会改变 Goal 状态。",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["completed", "blocked", "failed"] },
        summary: { type: "string" },
        evidence: {
          type: "array",
          items: {
            type: "object",
            properties: { kind: { type: "string" }, ref: { type: "string" } },
            required: ["kind", "ref"],
            additionalProperties: false,
          },
        },
        domainOutcome: {},
      },
      required: ["status", "summary", "evidence"],
      additionalProperties: false,
    },
  };
}

function toolIntent(name: string, value: unknown): AgentToolIntent | undefined {
  if (!isRecord(value) || !isWorkspaceToolName(name)) return undefined;
  return {
    tool: name,
    path: typeof value.path === "string" ? value.path : undefined,
    content: typeof value.content === "string" ? value.content : undefined,
    command: typeof value.command === "string" ? value.command : undefined,
    serviceId: typeof value.serviceId === "string" ? value.serviceId : undefined,
  };
}

function resolutionProposal(
  value: unknown,
  goal: AgentGoal,
  turnId: string,
  createdAt: string,
): GoalResolutionProposal | undefined {
  if (!isRecord(value)) return undefined;
  if (!new Set(["completed", "blocked", "failed"]).has(String(value.status))) return undefined;
  if (typeof value.summary !== "string" || !value.summary.trim() || !Array.isArray(value.evidence)) return undefined;
  const evidence = value.evidence.flatMap((item) => {
    if (!isRecord(item) || typeof item.kind !== "string" || typeof item.ref !== "string") return [];
    return [{ kind: item.kind, ref: item.ref }];
  });
  if (evidence.length !== value.evidence.length) return undefined;
  return {
    proposalId: stableId("proposal", goal.spec.id, turnId),
    turnId,
    goalId: goal.spec.id,
    expectedGoalVersion: goal.version,
    resolvingGoalVersion: goal.version + 1,
    status: value.status as "completed" | "blocked" | "failed",
    summary: value.summary,
    evidence,
    domainOutcome: value.domainOutcome,
    createdAt,
  };
}

function toolError(
  callId: string,
  content: string,
): Extract<AgentModelHistoryItem, { type: "tool_result" }> {
  return { type: "tool_result", callId, content, isError: true };
}

function isWorkspaceToolName(value: string): value is WorkspaceToolName {
  return new Set(["listFiles", "readFile", "writeFile", "shell", "startService", "pollProcess"]).has(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash("sha256").update(JSON.stringify(parts)).digest("base64url")}`;
}

function pendingMessageTurn(thread: AgentThreadSnapshot): { turnId: string; messageId: string } | undefined {
  const message = [...thread.items].reverse().find((item) => item.kind === "message" && item.turnId);
  if (!message?.turnId) return undefined;
  const started = thread.items.some((item) => item.turnId === message.turnId && item.kind !== "message");
  return started ? undefined : { turnId: message.turnId, messageId: message.itemId };
}
