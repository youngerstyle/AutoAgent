import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  AuthStorage,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  createAgentSession,
  defineTool,
  type AgentSession,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { AgentGoal, GoalResolutionProposal } from "../../shared/contracts/agent-engine.js";
import type { ProviderName, WorkspaceToolName } from "../../shared/types.js";
import type { ProviderRegistry } from "../providers/provider-registry.js";
import type { AgentModelHistoryItem, AgentModelTurnResult } from "../providers/types.js";
import type { AgentEngine } from "./agent-engine.js";
import type { AgentContextAssembler } from "./context-assembler.js";
import type { AgentStore } from "./agent-store.js";
import type { AgentExecutionRuntime, AgentExecutionSliceInput, AgentExecutionSliceResult } from "./runtime.js";
import { parseResolutionProposal } from "./resolution-proposal.js";
import type { AgentTraceStore } from "./trace-store.js";
import { AgentToolRuntime, type AgentToolIntent } from "./tool-runtime.js";

interface SessionState {
  session: AgentSession;
  goalIds: Set<string>;
  resolution: ResolutionBinding;
  safety: RunSafetyBinding;
}

interface ResolutionBinding {
  goal?: AgentGoal;
  turnId?: string;
  onProposal?: (proposal: GoalResolutionProposal) => void;
  mock?: boolean;
}

interface ResolutionToolDetails {
  ok: boolean;
  reason: string;
  proposal: GoalResolutionProposal | null;
}

interface RunSafetyBinding {
  failures: Map<string, number>;
  lastToolBatchFingerprint?: string;
  repeatedToolBatchCount: number;
  consecutiveIdleResponses: number;
  blockedReason?: string;
}

export class PiAgentRuntime implements AgentExecutionRuntime {
  private readonly sessions = new Map<string, Promise<SessionState>>();
  private readonly now: () => Date;

  constructor(
    private readonly workspaceRoot: string,
    private readonly engine: AgentEngine<any>,
    private readonly store: AgentStore,
    private readonly contextAssembler: AgentContextAssembler,
    private readonly providers: ProviderRegistry,
    private readonly tools: AgentToolRuntime,
    private readonly traces: AgentTraceStore,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async runSlice(input: AgentExecutionSliceInput): Promise<AgentExecutionSliceResult> {
    const goal = input.goalId ? await this.engine.getGoal(input.goalId) : undefined;
    if (input.goalId && !goal) throw new Error("Goal does not exist");
    const thread = await this.engine.getThread(input.threadId);
    const pending = await pendingThreadInput(thread, this.store);
    const turnId = input.turnId ?? pending?.turnId
      ?? stableId("turn", input.threadId, String(thread.version + 1), this.now().toISOString());
    const triggerMessageId = input.triggerMessageId ?? (pending?.kind === "message" ? pending.itemId : undefined);
    const state = await this.requireSession({ ...input, triggerMessageId });
    let toolCalls = 0;
    let proposal: GoalResolutionProposal | undefined;
    let eventSequence = 0;
    const toolInputs = new Map<string, { name: string; args: unknown }>();
    let eventWrites: Promise<void> = Promise.resolve();
    const persistEvent = (operation: () => Promise<unknown>): void => {
      eventWrites = eventWrites.then(async () => { await operation(); });
    };

    await this.engine.appendToolItem({
      itemId: `${turnId}:started`, turnId, threadId: input.threadId, goalId: input.goalId,
      kind: "control", value: { turnId, ...(triggerMessageId ? { triggerMessageId } : {}), status: "running" },
      createdAt: this.now().toISOString(),
    });

    const unsubscribe = state.session.subscribe((event) => {
      eventSequence += 1;
      const sequence = eventSequence;
      if (event.type === "tool_execution_start") {
        toolCalls += 1;
        toolInputs.set(event.toolCallId, { name: event.toolName, args: event.args });
        persistEvent(() => this.engine.appendToolItem({
          itemId: `${turnId}:pi:${sequence}:tool-call`, turnId, threadId: input.threadId, goalId: input.goalId,
          kind: "tool", value: { type: "tool_call", callId: event.toolCallId, name: event.toolName, arguments: event.args }, createdAt: this.now().toISOString(),
        }));
      }
      if (event.type === "tool_execution_end") {
        const toolInput = toolInputs.get(event.toolCallId);
        if (event.isError) {
          const fingerprint = createHash("sha256").update(JSON.stringify({
            name: toolInput?.name ?? event.toolName,
            args: toolInput?.args,
            result: event.result,
          })).digest("hex");
          const count = (state.safety.failures.get(fingerprint) ?? 0) + 1;
          state.safety.failures.set(fingerprint, count);
          if (count >= 3 && !state.safety.blockedReason) {
            state.safety.blockedReason = `同一个工具错误已连续出现 ${count} 次，当前 turn 已暂停以避免空转。`;
            void state.session.abort();
          }
        } else {
          state.safety.failures.clear();
          state.safety.lastToolBatchFingerprint = undefined;
          state.safety.repeatedToolBatchCount = 0;
        }
        persistEvent(() => this.engine.appendToolItem({
          itemId: `${turnId}:pi:${sequence}:tool-result`, turnId, threadId: input.threadId, goalId: input.goalId,
          kind: "observation", value: {
            type: "tool_result",
            callId: event.toolCallId,
            name: event.toolName,
            content: toolResultText(event.result),
            details: event.result,
            isError: event.isError,
          }, createdAt: this.now().toISOString(),
        }));
      }
      if (event.type === "message_end" && event.message.role === "assistant") {
        const toolBatch = event.message.content.flatMap((item) => item.type === "toolCall"
          ? [{ name: item.name, arguments: item.arguments }]
          : []);
        if (toolBatch.length > 0) {
          const fingerprint = createHash("sha256").update(JSON.stringify(toolBatch)).digest("hex");
          if (fingerprint === state.safety.lastToolBatchFingerprint) {
            state.safety.repeatedToolBatchCount += 1;
          } else {
            state.safety.lastToolBatchFingerprint = fingerprint;
            state.safety.repeatedToolBatchCount = 1;
          }
          if (state.safety.repeatedToolBatchCount >= 3 && !state.safety.blockedReason) {
            state.safety.blockedReason = "模型连续三次提交完全相同的工具调用且没有取得进展，当前 turn 已暂停。";
            void state.session.abort();
          }
        }
        const content = event.message.content.flatMap((item) => item.type === "text" ? [item.text] : []).join("\n").trim();
        if (content) persistEvent(() => this.engine.appendModelItem({
          itemId: `${turnId}:pi:${sequence}:assistant`, turnId, threadId: input.threadId, goalId: input.goalId,
          content, createdAt: this.now().toISOString(),
        }));
      }
    });

    state.resolution.goal = goal;
    state.resolution.turnId = turnId;
    state.resolution.onProposal = (value) => { proposal = value; };
    state.resolution.mock = input.provider === "mock";
    state.safety.failures.clear();
    state.safety.lastToolBatchFingerprint = undefined;
    state.safety.repeatedToolBatchCount = 0;
    state.safety.consecutiveIdleResponses = 0;
    state.safety.blockedReason = undefined;
    const activeTools = [...this.tools.definitions().map((tool) => tool.name), ...(goal ? ["goal_resolution"] : [])];
    state.session.setActiveToolsByName(activeTools);

    try {
      let prompt = await this.nextPrompt(input, goal, state, pending, triggerMessageId);
      let continuation = 0;
      let toolCallsBeforePrompt = toolCalls;
      while (true) {
        await this.trace(turnId, input, "context", {
          sessionId: state.session.sessionId,
          promptChars: prompt.length,
          persistent: Boolean(state.session.sessionFile),
          continuation,
        });
        await state.session.prompt(prompt, { expandPromptTemplates: false, streamingBehavior: "followUp", source: "rpc" });
        await state.session.waitForIdle();
        await eventWrites;
        if (state.safety.blockedReason) {
          return this.block(turnId, input, toolCalls, goal, "no_progress", state.safety.blockedReason);
        }
        if (proposal) {
          const attempted = await this.engine.proposeGoalResolution(proposal);
          await this.trace(turnId, input, "settlement", attempted);
          return { turnId, status: "resolution_proposed", toolCalls, goal: attempted.goal };
        }
        const error = state.session.state.errorMessage;
        if (error) return this.block(turnId, input, toolCalls, goal, "provider_error", error);
        if (!goal) {
          await this.engine.appendToolItem({
            itemId: `${turnId}:waiting`, turnId, threadId: input.threadId, goalId: input.goalId,
            kind: "control", value: { turnId, status: "waiting" }, createdAt: this.now().toISOString(),
          });
          return { turnId, status: "waiting", toolCalls, goal };
        }

        state.safety.consecutiveIdleResponses = toolCalls === toolCallsBeforePrompt
          ? state.safety.consecutiveIdleResponses + 1
          : 0;
        if (state.safety.consecutiveIdleResponses >= 3) {
          return this.block(
            turnId,
            input,
            toolCalls,
            goal,
            "no_progress",
            "Agent 连续三轮没有调用工具或提交 Goal 结论，当前 turn 已暂停以避免无进展消耗。",
          );
        }
        toolCallsBeforePrompt = toolCalls;
        continuation += 1;
        prompt = unresolvedGoalPrompt(goal);
      }
    } catch (error) {
      if (state.safety.blockedReason) {
        return this.block(turnId, input, toolCalls, goal, "no_progress", state.safety.blockedReason);
      }
      return this.block(turnId, input, toolCalls, goal, "provider_error", (error as Error).message);
    } finally {
      state.resolution.goal = undefined;
      state.resolution.turnId = undefined;
      state.resolution.onProposal = undefined;
      state.resolution.mock = undefined;
      unsubscribe();
    }
  }

  dispose(): void {
    for (const pending of this.sessions.values()) void pending.then(({ session }) => session.dispose());
    this.sessions.clear();
  }

  private requireSession(input: AgentExecutionSliceInput): Promise<SessionState> {
    const key = input.threadId;
    const existing = this.sessions.get(key);
    if (existing) return existing;
    const pending = this.createSession(input);
    this.sessions.set(key, pending);
    return pending;
  }

  private async createSession(input: AgentExecutionSliceInput): Promise<SessionState> {
    const sessionDir = path.join(this.workspaceRoot, ".autoagent", "pi-sessions", safeKey(input.agent.id), safeKey(input.threadId));
    await mkdir(sessionDir, { recursive: true });
    const sessionManager = SessionManager.continueRecent(this.workspaceRoot, sessionDir);
    const auth = AuthStorage.inMemory();
    const registry = ModelRegistry.inMemory(auth);
    const model = await configureModel(registry, auth, this.providers, input.provider, input.model, input.contextWindowTokens ?? 128_000);
    const settings = SettingsManager.inMemory({
      compaction: { enabled: true },
      retry: input.provider === "mock"
        ? { enabled: false, maxRetries: 0, baseDelayMs: 0 }
        : { enabled: true, maxRetries: 3, baseDelayMs: 2_000 },
      shellPath: process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : undefined,
    }, { projectTrusted: true });
    const loader = new DefaultResourceLoader({
      cwd: this.workspaceRoot,
      agentDir: input.agent.agentDir,
      settingsManager: settings,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: stableSystemPrompt(input),
    });
    await loader.reload();
    if (!sessionManager.getEntries().some((entry) => entry.type === "message" || entry.type === "compaction")) {
      const thread = await this.engine.getThread(input.threadId);
      const triggerIndex = input.triggerMessageId
        ? thread.items.findIndex((item) => item.itemId === input.triggerMessageId)
        : -1;
      const historyThread = triggerIndex >= 0
        ? { ...thread, items: thread.items.slice(0, triggerIndex), version: Math.max(0, thread.items[triggerIndex]!.sequence - 1) }
        : thread;
      const goal = input.goalId ? await this.engine.getGoal(input.goalId) : undefined;
      const assembled = await this.contextAssembler.assemble({
        profile: input.profile,
        agent: input.agent,
        policy: input.policy,
        thread: historyThread,
        goal,
      });
      restoreSessionHistory(sessionManager, assembled.history, model);
    }
    const resolution: ResolutionBinding = {};
    const safety: RunSafetyBinding = { failures: new Map(), repeatedToolBatchCount: 0, consecutiveIdleResponses: 0 };
    const customTools = [...workspaceTools(this.tools), goalTool(resolution, this.now)];
    const { session } = await createAgentSession({
      cwd: this.workspaceRoot,
      agentDir: input.agent.agentDir,
      authStorage: auth,
      modelRegistry: registry,
      model,
      resourceLoader: loader,
      settingsManager: settings,
      sessionManager,
      noTools: "builtin",
      customTools,
      tools: customTools.map((tool) => tool.name),
    });
    session.setAutoCompactionEnabled(true);
    const goalIds = new Set(sessionManager.getEntries()
      .flatMap((entry) => entry.type === "custom" && entry.customType === "autoagent_goal" ? [entry.data] : [])
      .map((data) => (data as { goalId?: string } | undefined)?.goalId)
      .filter((value): value is string => Boolean(value)));
    return { session, goalIds, resolution, safety };
  }

  private async nextPrompt(
    input: AgentExecutionSliceInput,
    goal: AgentGoal | undefined,
    state: SessionState,
    pending: PendingThreadInput | undefined,
    triggerMessageId: string | undefined,
  ): Promise<string> {
    const isNewGoal = Boolean(goal && !state.goalIds.has(goal.spec.id));
    if (goal && isNewGoal) {
      state.session.sessionManager.appendCustomEntry("autoagent_goal", { goalId: goal.spec.id });
      state.goalIds.add(goal.spec.id);
    }
    if (triggerMessageId) {
      const thread = await this.engine.getThread(input.threadId);
      const item = thread.items.find((candidate) => candidate.itemId === triggerMessageId);
      const payload = item ? (await this.store.payloads([item.payloadRef])).get(item.payloadRef) : undefined;
      const content = isRecord(payload) && typeof payload.content === "string" ? payload.content.trim() : "";
      if (content) {
        if (!isNewGoal) return content;
        return `${activeGoalPrompt(goal!)}\n\n## 本轮按时间序收到的消息\n${content}`;
      }
    }
    if (pending?.kind === "correction") return `Host 对目标结算的决定：${pending.content}`;
    throw new Error("Agent turn 没有新的按时间序输入");
  }

  private async block(
    turnId: string, input: AgentExecutionSliceInput, toolCalls: number, goal: AgentGoal | undefined,
    blockReason: AgentExecutionSliceResult["blockReason"], message: string,
  ): Promise<AgentExecutionSliceResult> {
    const value = { turnId, status: "execution_blocked", reason: blockReason, message };
    await this.engine.appendToolItem({
      itemId: `${turnId}:execution-blocked`, turnId, threadId: input.threadId, goalId: input.goalId,
      kind: "control", value, createdAt: this.now().toISOString(),
    });
    await this.trace(turnId, input, "error", value);
    return { turnId, status: "execution_blocked", toolCalls, goal, blockReason };
  }

  private trace(turnId: string, input: AgentExecutionSliceInput, kind: "context" | "settlement" | "error", data: unknown): Promise<void> {
    return this.traces.append({
      traceId: stableId("trace", turnId, kind, JSON.stringify(data)), agentId: input.agent.id,
      threadId: input.threadId, goalId: input.goalId, turnId, kind, createdAt: this.now().toISOString(), data,
    });
  }
}

interface PendingThreadInput {
  kind: "message" | "correction";
  itemId: string;
  turnId?: string;
  content: string;
}

function unresolvedGoalPrompt(goal: AgentGoal): string {
  return [
    "当前 Goal 仍处于 active，上一轮普通回复没有结案。",
    "请直接继续执行可推进的工作，不要等待 human 重复确认可逆的实现选择，也不要仅说明下一步计划。",
    "如果已有足够授权，请使用工具创建、修改并验证真实交付物。",
    "完成、受阻或失败时必须调用 goal_resolution 提交结论；只有缺少不可替代的外部输入时才能提交 blocked。",
    `Goal：${goal.spec.objective}`,
  ].join("\n");
}

function activeGoalPrompt(goal: AgentGoal): string {
  return [
    "## Goal",
    "开始处理以下当前 Goal。触发本轮的最新消息是工作上下文的一部分，不得忽略或用角色说明替代。",
    `目标：${goal.spec.objective}`,
    `成功标准：\n${goal.spec.successCriteria.map((item) => `- ${item}`).join("\n") || "- 未定义"}`,
    goal.spec.outputContract ? `输出契约：${goal.spec.outputContract.schemaRef}` : undefined,
    goal.spec.contextRefs.length
      ? `上下文引用：\n${goal.spec.contextRefs.map((item) => `- ${item.kind}: ${item.ref}`).join("\n")}`
      : undefined,
    "完成、受阻或失败时使用 goal_resolution 提交真实结论。",
  ].filter(Boolean).join("\n");
}

async function pendingThreadInput(
  thread: Awaited<ReturnType<AgentEngine<any>["getThread"]>>,
  store: AgentStore,
): Promise<PendingThreadInput | undefined> {
  const payloads = await store.payloads(thread.items.map((item) => item.payloadRef));
  for (let index = thread.items.length - 1; index >= 0; index -= 1) {
    const item = thread.items[index]!;
    const payload = payloads.get(item.payloadRef);
    if (item.kind === "message" && isRecord(payload) && typeof payload.content === "string") {
      const turnId = item.turnId ?? stableId("turn", thread.threadId, item.itemId);
      const consumed = thread.items.slice(index + 1).some((candidate) => {
        if (candidate.turnId === turnId && candidate.kind !== "message") return true;
        const candidatePayload = payloads.get(candidate.payloadRef);
        return isRecord(candidatePayload) && candidatePayload.triggerMessageId === item.itemId;
      });
      if (!consumed) return { kind: "message", itemId: item.itemId, turnId, content: payload.content };
    }
    if (item.kind === "control" && isCorrectableDecision(payload)) {
      const consumed = thread.items.slice(index + 1).some((candidate) => candidate.kind === "control"
        && isRunningPayload(payloads.get(candidate.payloadRef)));
      if (!consumed) return { kind: "correction", itemId: item.itemId, content: JSON.stringify(payload.decision) };
    }
  }
  return undefined;
}

function isCorrectableDecision(value: unknown): value is Record<string, unknown> & { decision: unknown } {
  return isRecord(value) && value.type === "goal_resolution_decision" && value.status === "correctable" && "decision" in value;
}

function isRunningPayload(value: unknown): boolean {
  return isRecord(value) && value.status === "running";
}

function workspaceTools(runtime: AgentToolRuntime): ToolDefinition[] {
  return runtime.definitions().map((definition) => defineTool({
    name: definition.name,
    label: definition.name,
    description: definition.description,
    parameters: toolParameters(definition.name as WorkspaceToolName),
    async execute(_callId, params) {
      const result = await runtime.execute({ tool: definition.name as WorkspaceToolName, ...(params as Omit<AgentToolIntent, "tool">) });
      if (!result.ok) throw new Error(failureMessage(result));
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  }));
}

function goalTool(binding: ResolutionBinding, now: () => Date): ToolDefinition {
  return defineTool({
    name: "goal_resolution",
    label: "提交工作结论",
    description: "提交当前 Goal 的完成、受阻或失败提案。这是领域交付物的唯一提交入口：将输出契约要求的结果直接放入 domainOutcome；Host 会校验提案并提交 Ticket/Plan。不要寻找或写入另一个提交文件、接口或平台内部状态。普通回复不会改变 Goal 或 Ticket 状态。",
    parameters: Type.Object({
      status: Type.Union([Type.Literal("completed"), Type.Literal("blocked"), Type.Literal("failed")]),
      summary: Type.Optional(Type.String()),
      evidence: Type.Array(Type.Object({ kind: Type.String(), ref: Type.String() })),
      criterionResults: Type.Array(Type.Object({
        criterionIndex: Type.Integer({ minimum: 0 }),
        status: Type.Union([Type.Literal("satisfied"), Type.Literal("not_satisfied"), Type.Literal("not_verified")]),
        evidence: Type.Array(Type.Object({ kind: Type.String(), ref: Type.String() })),
        note: Type.Optional(Type.String()),
      })),
      residualRisks: Type.Array(Type.String()),
      domainOutcome: Type.Unknown(),
    }),
    async execute(_callId, params) {
      if (!binding.goal || !binding.turnId || !binding.onProposal) {
        const details: ResolutionToolDetails = { ok: false, reason: "当前没有可结算的 Goal", proposal: null };
        throw new Error(details.reason);
      }
      const submitted = binding.mock
        ? {
            ...params,
            criterionResults: binding.goal.spec.successCriteria.map((_criterion, criterionIndex) => ({
              criterionIndex,
              status: "satisfied" as const,
              evidence: [],
            })),
          }
        : params;
      const parsed = parseResolutionProposal(submitted, binding.goal, binding.turnId, now().toISOString());
      if (!parsed.ok) {
        if (process.env.AUTOAGENT_DEBUG_PI === "1") console.error("Pi goal_resolution rejected", parsed.reason, params);
        const details: ResolutionToolDetails = { ok: false, reason: parsed.reason, proposal: null };
        throw new Error(details.reason);
      }
      binding.onProposal(parsed.value);
      const details: ResolutionToolDetails = { ok: true, reason: "", proposal: parsed.value };
      return {
        content: [{ type: "text", text: JSON.stringify({ proposalSubmitted: true, proposalId: parsed.value.proposalId }) }],
        details,
        terminate: true,
      };
    },
  });
}

function failureMessage(details: unknown): string {
  if (isRecord(details)) {
    if (typeof details.reason === "string" && details.reason.trim()) return details.reason;
    if (typeof details.error === "string" && details.error.trim()) return details.error;
    if (typeof details.message === "string" && details.message.trim()) return details.message;
  }
  return JSON.stringify(details);
}

function toolParameters(name: WorkspaceToolName) {
  if (name === "writeFile") return Type.Object({ path: Type.String(), content: Type.String() });
  if (name === "readFile" || name === "listFiles") return Type.Object({ path: Type.Optional(Type.String()) });
  if (name === "pollProcess") return Type.Object({ serviceId: Type.String() });
  return Type.Object({ command: Type.String() });
}

async function configureModel(
  registry: ModelRegistry,
  auth: AuthStorage,
  providers: ProviderRegistry,
  provider: ProviderName,
  modelId: string,
  contextWindow: number,
): Promise<Model<any>> {
  if (provider === "mock") {
    const model = mockModel(modelId, contextWindow);
    registry.registerProvider("mock", {
      api: "openai-completions",
      baseUrl: "http://mock.invalid",
      apiKey: "mock",
      models: [modelConfig(model)] as any,
      streamSimple: mockStream(providers, modelId) as any,
    });
    return registry.find("mock", modelId)!;
  }
  const config = await providers.runtimeConfig(provider, modelId);
  if (!config.apiKey) throw new Error(`${provider} 未配置 API Key`);
  auth.setRuntimeApiKey(provider, config.apiKey);
  const builtIn = registry.find(provider, modelId);
  if (builtIn && !config.baseUrl) return builtIn;
  const api = provider === "anthropic" ? "anthropic-messages" : "openai-completions";
  registry.registerProvider(provider, {
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    models: [{ id: modelId, name: modelId, api, baseUrl: config.baseUrl, reasoning: false, input: ["text"], cost: zeroCost(), contextWindow, maxTokens: Math.min(32_768, Math.max(4_096, Math.floor(contextWindow / 4))) }] as any,
  });
  const configured = registry.find(provider, modelId);
  if (!configured) throw new Error(`Pi 无法加载模型 ${provider}/${modelId}`);
  return configured;
}

function mockStream(providers: ProviderRegistry, modelId: string) {
  return (_model: Model<any>, context: Context, options?: { signal?: AbortSignal }) => {
    const stream = createAssistantMessageEventStream();
    queueMicrotask(async () => {
      try {
        if (options?.signal?.aborted) {
          const message = legacyAbortedMessage(modelId);
          stream.push({ type: "start", partial: message });
          stream.push({ type: "error", reason: "aborted", error: message });
          return;
        }
        const instructions = [context.systemPrompt ?? "", ...context.messages.flatMap(messageText)].filter(Boolean).join("\n\n");
        if (process.env.AUTOAGENT_DEBUG_PI === "1") console.error("Pi mock instructions", instructions.slice(-2_000));
        const result = await providers.runModelTurnWithRetry({
          provider: "mock",
          model: modelId,
          instructions,
          history: context.messages.flatMap(toLegacyHistory),
          tools: (context.tools ?? []).map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters as any })),
        });
        if (options?.signal?.aborted) {
          const message = legacyAbortedMessage(modelId);
          stream.push({ type: "start", partial: message });
          stream.push({ type: "error", reason: "aborted", error: message });
          return;
        }
        const message = legacyResultMessage(result, modelId);
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
      } catch (error) {
        const message = legacyErrorMessage((error as Error).message, modelId);
        stream.push({ type: "start", partial: message });
        stream.push({ type: "error", reason: "error", error: message });
      }
    });
    return stream;
  };
}

function toLegacyHistory(message: Context["messages"][number]): AgentModelHistoryItem[] {
  if (message.role === "user") return [{ type: "user_message", content: typeof message.content === "string" ? message.content : message.content.flatMap((item) => item.type === "text" ? [item.text] : []).join("\n") }];
  if (message.role === "toolResult") return [{ type: "tool_result", callId: message.toolCallId, content: message.content.flatMap((item) => item.type === "text" ? [item.text] : []).join("\n"), isError: message.isError }];
  return message.content.flatMap((item): AgentModelHistoryItem[] => item.type === "text"
    ? [{ type: "assistant_message", content: item.text }]
    : item.type === "toolCall" ? [{ type: "tool_call", callId: item.id, name: item.name, arguments: item.arguments }] : []);
}

function messageText(message: Context["messages"][number]): string[] {
  if (message.role === "user") return [typeof message.content === "string" ? message.content : message.content.flatMap((item) => item.type === "text" ? [item.text] : []).join("\n")];
  if (message.role === "toolResult") return message.content.flatMap((item) => item.type === "text" ? [item.text] : []);
  return message.content.flatMap((item) => item.type === "text" ? [item.text] : []);
}

function restoreSessionHistory(
  sessionManager: SessionManager,
  history: AgentModelHistoryItem[],
  model: Model<any>,
): void {
  const toolNames = new Map<string, string>();
  const startedAt = Date.now() - history.length;
  history.forEach((item, index) => {
    const timestamp = startedAt + index;
    if (item.type === "user_message") {
      sessionManager.appendMessage({ role: "user", content: item.content, timestamp });
      return;
    }
    if (item.type === "assistant_message") {
      sessionManager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: item.content }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: usage(),
        stopReason: "stop",
        timestamp,
      });
      return;
    }
    if (item.type === "tool_call") {
      toolNames.set(item.callId, item.name);
      sessionManager.appendMessage({
        role: "assistant",
        content: [{
          type: "toolCall",
          id: item.callId,
          name: item.name,
          arguments: isRecord(item.arguments) ? item.arguments : { value: item.arguments },
        }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: usage(),
        stopReason: "toolUse",
        timestamp,
      });
      return;
    }
    sessionManager.appendMessage({
      role: "toolResult",
      toolCallId: item.callId,
      toolName: toolNames.get(item.callId) ?? "unknown_tool",
      content: [{ type: "text", text: item.content }],
      isError: item.isError,
      timestamp,
    });
  });
}

function toolResultText(result: unknown): string {
  if (isRecord(result) && Array.isArray(result.content)) {
    const text = result.content.flatMap((item) => isRecord(item) && item.type === "text" && typeof item.text === "string"
      ? [item.text]
      : []);
    if (text.length > 0) return text.join("\n");
  }
  return JSON.stringify(result);
}

function legacyResultMessage(result: AgentModelTurnResult, modelId: string): AssistantMessage {
  const content = result.items.map((item) => item.type === "assistant_message"
    ? ({ type: "text", text: item.content } as const)
    : ({ type: "toolCall", id: item.callId, name: item.name, arguments: item.arguments as Record<string, any> } as const));
  return { role: "assistant", content, api: "openai-completions", provider: "mock", model: modelId, usage: usage(result), stopReason: content.some((item) => item.type === "toolCall") ? "toolUse" : "stop", timestamp: Date.now() };
}

function legacyErrorMessage(message: string, modelId: string): AssistantMessage {
  return { role: "assistant", content: [], api: "openai-completions", provider: "mock", model: modelId, usage: usage(), stopReason: "error", errorMessage: message, timestamp: Date.now() };
}

function legacyAbortedMessage(modelId: string): AssistantMessage {
  return { role: "assistant", content: [], api: "openai-completions", provider: "mock", model: modelId, usage: usage(), stopReason: "aborted", timestamp: Date.now() };
}

function usage(result?: AgentModelTurnResult) {
  const input = result?.usage?.inputTokens ?? 0;
  const output = result?.usage?.outputTokens ?? 0;
  return { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: zeroCost() };
}

function mockModel(id: string, contextWindow: number) {
  return { id, name: id, api: "openai-completions", provider: "mock", baseUrl: "http://mock.invalid", reasoning: false, input: ["text"], cost: zeroCost(), contextWindow, maxTokens: 16_384 } as Model<any>;
}

function modelConfig(model: Model<any>) {
  return { id: model.id, name: model.name, api: model.api, reasoning: false, input: ["text"], cost: zeroCost(), contextWindow: model.contextWindow, maxTokens: model.maxTokens, baseUrl: model.baseUrl };
}

function zeroCost() { return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }; }

function stableSystemPrompt(input: AgentExecutionSliceInput): string {
  return [
    input.profile.soul ? `## 个性\n${input.profile.soul}` : "",
    input.profile.identity ? `## 岗位\n${input.profile.identity}` : "",
    input.profile.agentMd ? `## 能力与工作方式\n${input.profile.agentMd}` : "",
    input.policy.canWriteWorkspace
      ? "## 新建交付物\n当 Goal 要求创建新的代码、文档、配置或其他交付物时，空工作区、尚无源码、尚无构建入口都不是缺少 human 输入，也不是 blocked 条件。你已经获得工作区写入授权，必须采用可逆的专业默认值，从零创建必要目录和文件，并使用可用工具持续实现与验证。不得仅因没有现成项目文件而要求 human 提供仓库、源码根目录或运行入口。"
      : "",
    "你是一个持续工作的通用 Agent。当前 Ticket 是你的 Goal。根据岗位、成功标准和输出契约完成工作；仅在工作本身需要时使用文件或命令工具，不要为了证明认知型交付物而寻找不存在的项目文件。完成、受阻或失败时必须调用 goal_resolution，把输出契约要求的领域交付物直接放入 domainOutcome。该调用只是向 Host 提交提案，Ticket 和 Plan 状态仍由 Host 校验并提交。不要寻找或写入另一个提交文件、接口或平台内部状态，普通回复也不代表 Goal 完成。",
  ].filter(Boolean).join("\n\n");
}

function safeKey(value: string): string { return createHash("sha256").update(value).digest("base64url"); }
function stableId(prefix: string, ...parts: string[]): string { return `${prefix}_${createHash("sha256").update(JSON.stringify(parts)).digest("base64url")}`; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
