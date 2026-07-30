import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath } from "node:fs/promises";
import os from "node:os";
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
  type Skill,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type ImageContent, type Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  AGENT_HUMAN_INPUT_KINDS,
  type AgentGoal,
  type AgentHumanInputKind,
  type AgentHumanInputRequest,
  type AgentThreadSnapshot,
  type GoalResolutionProposal,
} from "../../shared/contracts/agent-engine.js";
import type { ProviderName, WorkspaceToolName } from "../../shared/types.js";
import { effectiveAgentSkills, skillRuntimeAdapterInstructions } from "../agents/skill-config.js";
import type { ProviderRegistry } from "../providers/provider-registry.js";
import { isRetryableProviderFailure } from "../providers/provider-failure.js";
import { isInside } from "../policy/path-policy.js";
import type { AgentModelHistoryItem, AgentModelTurnResult } from "../providers/types.js";
import { AgentEngineConflictError, type AgentEngine } from "./agent-engine.js";
import type { AgentContextAssembler } from "./context-assembler.js";
import type { AgentStore } from "./agent-store.js";
import { AgentGoalTransitionError } from "./goal-state.js";
import type { AgentExecutionRuntime, AgentExecutionSliceInput, AgentExecutionSliceResult } from "./runtime.js";
import { createHumanInputProposal, parseResolutionProposal } from "./resolution-proposal.js";
import type { AgentTraceStore } from "./trace-store.js";
import {
  AgentToolRuntime,
  type AgentToolExecutionContext,
  type AgentToolIntent,
  type AgentToolResult as WorkspaceAgentToolResult,
} from "./tool-runtime.js";
import { AttachmentStore } from "../storage/attachment-store.js";

interface SessionState {
  session: AgentSession;
  goalVersions: Map<string, number>;
  resolution: ResolutionBinding;
  toolExecution: ToolExecutionBinding;
  safety: RunSafetyBinding;
}

type AgentPrompt = string | { text: string; images: ImageContent[] };

interface ResolutionBinding {
  goal?: AgentGoal;
  turnId?: string;
  onProposal?: (proposal: GoalResolutionProposal) => void;
  onInvalid?: (reason: string) => void;
  mock?: boolean;
}

interface ResolutionToolDetails {
  ok: boolean;
  reason: string;
  proposal: GoalResolutionProposal | null;
}

interface ToolExecutionBinding {
  agentId: string;
  threadId: string;
  goalId?: string;
  attemptId?: string;
  turnId?: string;
}

interface RunSafetyBinding {
  failures: Map<string, number>;
  terminalSubmissionFailures: number;
  seenUsefulToolSignatures: Set<string>;
  lastToolBatchFingerprint?: string;
  repeatedToolBatchCount: number;
  consecutiveIdleResponses: number;
  unproductiveToolCalls: number;
  blockReasonKind?: "usage_limit" | "no_progress";
  blockedReason?: string;
}

const MAX_REPEATED_TOOL_FAILURES = envPositiveInteger("AUTOAGENT_MAX_REPEATED_TOOL_FAILURES", 3);
const MAX_TERMINAL_SUBMISSION_FAILURES = envPositiveInteger(
  "AUTOAGENT_MAX_TERMINAL_SUBMISSION_FAILURES",
  4,
);
const MAX_REPEATED_TOOL_BATCHES = envPositiveInteger("AUTOAGENT_MAX_REPEATED_TOOL_BATCHES", 3);
const MAX_IDLE_CONTINUATIONS = envPositiveInteger("AUTOAGENT_MAX_IDLE_CONTINUATIONS", 3);
const MAX_UNPRODUCTIVE_TOOL_CALLS = envPositiveInteger("AUTOAGENT_MAX_UNPRODUCTIVE_TOOL_CALLS", 80);
const MAX_TOOL_CALLS_PER_TURN = envPositiveInteger("AUTOAGENT_MAX_TOOL_CALLS_PER_TURN", 200);
const DEFAULT_TURN_INACTIVITY_TIMEOUT_MS = envPositiveInteger(
  "AUTOAGENT_TURN_INACTIVITY_TIMEOUT_MS",
  5 * 60_000,
);
const DEFAULT_SESSION_ABORT_GRACE_MS = envPositiveInteger(
  "AUTOAGENT_SESSION_ABORT_GRACE_MS",
  2_000,
);

export class PiAgentRuntime implements AgentExecutionRuntime {
  private readonly sessions = new Map<string, Promise<SessionState>>();
  private readonly turnTails = new Map<string, Promise<AgentExecutionSliceResult>>();
  private readonly now: () => Date;
  private readonly turnInactivityTimeoutMs: number;

  constructor(
    private readonly workspaceRoot: string,
    private readonly engine: AgentEngine<any>,
    private readonly store: AgentStore,
    private readonly contextAssembler: AgentContextAssembler,
    private readonly providers: ProviderRegistry,
    private readonly tools: AgentToolRuntime,
    private readonly traces: AgentTraceStore,
    options: { now?: () => Date; turnInactivityTimeoutMs?: number } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.turnInactivityTimeoutMs = options.turnInactivityTimeoutMs ?? DEFAULT_TURN_INACTIVITY_TIMEOUT_MS;
  }

  async pendingHumanTurn(threadId: string): Promise<{ turnId: string; triggerMessageId: string } | undefined> {
    const thread = await this.engine.getThread(threadId);
    const pending = await pendingThreadInput(thread, this.store, true, true);
    return pending?.kind === "message"
      ? { turnId: pending.turnId, triggerMessageId: pending.itemId }
      : undefined;
  }

  runSlice(input: AgentExecutionSliceInput): Promise<AgentExecutionSliceResult> {
    const active = this.turnTails.get(input.threadId);
    const pending = (active ? active.catch(() => undefined) : Promise.resolve())
      .then(async () => {
        const leased = await this.store.withExecutionLease(() => this.runSliceSerial(input));
        if (leased.acquired) return leased.value;
        return {
          turnId: input.turnId ?? stableId("busy-turn", input.threadId, input.goalId ?? "idle"),
          status: "waiting" as const,
          toolCalls: 0,
        };
      });
    const tracked = pending.finally(() => {
      if (this.turnTails.get(input.threadId) === tracked) this.turnTails.delete(input.threadId);
    });
    this.turnTails.set(input.threadId, tracked);
    return tracked;
  }

  private async runSliceSerial(input: AgentExecutionSliceInput): Promise<AgentExecutionSliceResult> {
    const persistedGoal = input.goalId ? await this.engine.getGoal(input.goalId) : undefined;
    if (input.goalId && !persistedGoal) throw new Error("Goal does not exist");
    const goal = persistedGoal?.status === "active" ? persistedGoal : undefined;
    const thread = await this.engine.getThread(input.threadId);
    const pending = await pendingThreadInput(thread, this.store, false, false, input.goalId);
    const turnId = input.turnId ?? (pending?.kind === "message" ? pending.turnId : undefined)
      ?? stableId("turn", input.threadId, String(thread.version + 1), this.now().toISOString());
    const triggerMessageId = input.triggerMessageId ?? (pending?.kind === "message" ? pending.itemId : undefined);
    const state = await this.requireSession({ ...input, triggerMessageId });
    // RuntimeHost owns cross-turn ordering. Pi's follow-up queue is only for
    // steering one in-flight Pi run and must never bridge two Ticket turns.
    await state.session.waitForIdle();
    state.toolExecution.goalId = goal?.spec.id;
    state.toolExecution.attemptId = input.attemptId ?? goal?.spec.attemptId;
    state.toolExecution.turnId = turnId;
    let toolCalls = 0;
    let proposal: GoalResolutionProposal | undefined;
    let eventSequence = 0;
    const toolInputs = new Map<string, { name: string; args: unknown }>();
    let resolveTerminalProviderError: ((message: string) => void) | undefined;
    const terminalProviderError = new Promise<string>((resolve) => {
      resolveTerminalProviderError = resolve;
    });
    let eventWrites: Promise<void> = Promise.resolve();
    let promptWatchdog: PiPromptInactivityWatchdog | undefined;
    const toolBarrier = createPiToolExecutionBarrier();
    const persistEvent = (operation: () => Promise<unknown>): void => {
      eventWrites = eventWrites.then(async () => { await operation(); });
    };

    await this.engine.appendToolItem({
      itemId: `${turnId}:started`, turnId, threadId: input.threadId, goalId: input.goalId,
      kind: "control", value: { turnId, ...(triggerMessageId ? { triggerMessageId } : {}), status: "running" },
      createdAt: this.now().toISOString(),
    });

    const unsubscribe = state.session.subscribe((event) => {
      promptWatchdog?.touch();
      eventSequence += 1;
      const sequence = eventSequence;
      if (event.type === "tool_execution_start") {
        toolBarrier.started(event.toolCallId);
        toolCalls += 1;
        if (toolCalls >= MAX_TOOL_CALLS_PER_TURN && !state.safety.blockedReason) {
          state.safety.blockReasonKind = "usage_limit";
          state.safety.blockedReason = turnToolBudgetMessage(MAX_TOOL_CALLS_PER_TURN);
          void state.session.abort();
        }
        toolInputs.set(event.toolCallId, { name: event.toolName, args: event.args });
        persistEvent(() => this.engine.appendToolItem({
          itemId: `${turnId}:pi:${sequence}:tool-call`, turnId, threadId: input.threadId, goalId: input.goalId,
          kind: "tool", value: { type: "tool_call", callId: event.toolCallId, name: event.toolName, arguments: event.args }, createdAt: this.now().toISOString(),
        }));
      }
      if (event.type === "tool_execution_end") {
        toolBarrier.finished(event.toolCallId);
        const toolInput = toolInputs.get(event.toolCallId);
        const toolName = toolInput?.name ?? event.toolName;
        if (event.isError) {
          if (isTransientInfrastructureToolFailure(event.result) && !state.safety.blockedReason) {
            state.safety.blockReasonKind = "no_progress";
            state.safety.blockedReason = "平台工具连接暂时不可用，当前 Agent Goal 将保持不变并在基础设施恢复后继续。";
            void state.session.abort();
          }
          const fingerprint = toolFailureFingerprint(toolName, toolInput?.args, event.result);
          const count = (state.safety.failures.get(fingerprint) ?? 0) + 1;
          state.safety.failures.set(fingerprint, count);
          if (count >= MAX_REPEATED_TOOL_FAILURES && !state.safety.blockedReason) {
            state.safety.blockReasonKind = "no_progress";
            state.safety.blockedReason = `同一个工具错误已连续出现 ${count} 次，当前 turn 已暂停以避免空转。`;
            void state.session.abort();
          }
          if (isTerminalSubmissionTool(toolName)) {
            state.safety.terminalSubmissionFailures += 1;
            if (state.safety.terminalSubmissionFailures >= MAX_TERMINAL_SUBMISSION_FAILURES
              && !state.safety.blockedReason) {
              state.safety.blockReasonKind = "no_progress";
              state.safety.blockedReason = `终局提交已连续 ${state.safety.terminalSubmissionFailures} 次不符合当前 Goal 的输出契约，当前 turn 已停止。请检查工具返回的字段路径和合法示例后重新执行。`;
              void state.session.abort();
            }
          }
        } else {
          state.safety.failures.clear();
          state.safety.lastToolBatchFingerprint = undefined;
          state.safety.repeatedToolBatchCount = 0;
        }
        if (isUsefulToolProgress(toolName, toolInput?.args, event.result, event.isError, state.safety.seenUsefulToolSignatures)) {
          state.safety.unproductiveToolCalls = 0;
        } else {
          state.safety.unproductiveToolCalls += 1;
          if (state.safety.unproductiveToolCalls >= MAX_UNPRODUCTIVE_TOOL_CALLS && !state.safety.blockedReason) {
            state.safety.blockReasonKind = "no_progress";
            state.safety.blockedReason = `连续 ${state.safety.unproductiveToolCalls} 次工具调用没有产生新的可用进展，当前 turn 已暂停以避免空转。`;
            void state.session.abort();
          }
        }
        persistEvent(() => this.engine.appendToolItem({
          itemId: `${turnId}:pi:${sequence}:tool-result`, turnId, threadId: input.threadId, goalId: input.goalId,
          kind: "observation", value: {
            type: "tool_result",
            callId: event.toolCallId,
            name: event.toolName,
            content: modelFacingToolResultText(event.result, event.isError),
            details: compactPiToolEventDetails(event.result),
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
          if (state.safety.repeatedToolBatchCount >= MAX_REPEATED_TOOL_BATCHES && !state.safety.blockedReason) {
            state.safety.blockReasonKind = "no_progress";
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
      if (event.type === "agent_end" && !event.willRetry) {
        const assistant = [...event.messages].reverse()
          .find((message): message is AssistantMessage => message.role === "assistant");
        if (assistant?.stopReason === "error") {
          resolveTerminalProviderError?.(assistant.errorMessage || "模型调用失败");
        }
      }
    });

    state.resolution.goal = goal;
    state.resolution.turnId = turnId;
    state.resolution.onProposal = (value) => { proposal = value; };
    state.resolution.mock = input.provider === "mock";
    state.safety.failures.clear();
    state.safety.terminalSubmissionFailures = 0;
    state.safety.seenUsefulToolSignatures.clear();
    state.safety.lastToolBatchFingerprint = undefined;
    state.safety.repeatedToolBatchCount = 0;
    state.safety.consecutiveIdleResponses = 0;
    state.safety.unproductiveToolCalls = 0;
    state.safety.blockReasonKind = undefined;
    state.safety.blockedReason = undefined;
    state.resolution.onInvalid = (reason) => {
      state.safety.blockReasonKind ??= "no_progress";
      state.safety.blockedReason ??= reason;
      void state.session.abort();
    };
    const activeTools = activePiToolNames(
      this.tools.definitions().map((tool) => tool.name),
      Boolean(input.supportsImages),
      goal?.spec.outputContract,
    );
    state.session.setActiveToolsByName(activeTools);

    try {
      let prompt = normalizePrompt(await this.nextPrompt(input, goal, state, pending, triggerMessageId));
      if (goal && state.goalVersions.get(goal.spec.id) !== goal.version) {
        state.session.sessionManager.appendCustomEntry("autoagent_goal_prompted", {
          goalId: goal.spec.id,
          goalVersion: goal.version,
        });
        state.goalVersions.set(goal.spec.id, goal.version);
      }
      let continuation = 0;
      let toolCallsBeforePrompt = toolCalls;
      while (true) {
        await this.trace(turnId, input, "context", {
          sessionId: state.session.sessionId,
          promptChars: prompt.text.length,
          imageCount: prompt.images.length,
          persistent: Boolean(state.session.sessionFile),
          continuation,
        });
        promptWatchdog = createPiPromptInactivityWatchdog(
          this.turnInactivityTimeoutMs,
          () => state.session.abort(),
        );
        const promptRun = state.session.prompt(prompt.text, {
          images: prompt.images,
          expandPromptTemplates: false,
          source: "rpc",
        });
        let promptOutcome: Awaited<ReturnType<typeof awaitPiPromptOutcome>>;
        try {
          promptOutcome = await awaitPiPromptOutcome(
          promptRun,
          terminalProviderError,
          async () => {
            await state.session.waitForIdle();
            await toolBarrier.waitForIdle();
          },
          promptWatchdog.timeout,
        );
        } finally {
          promptWatchdog.dispose();
          promptWatchdog = undefined;
        }
        if (promptOutcome.kind === "provider_error") {
          state.session.agent.abort();
          this.sessions.delete(piWorkSessionKey(input.threadId, input.goalId));
          void promptRun.finally(() => state.session.dispose()).catch(() => undefined);
          await eventWrites;
          return this.providerFailure(turnId, input, toolCalls, goal, promptOutcome.message);
        }
        await eventWrites;
        if (state.safety.blockedReason) {
          return this.block(
            turnId,
            input,
            toolCalls,
            goal,
            state.safety.blockReasonKind ?? "no_progress",
            state.safety.blockedReason,
          );
        }
        if (proposal) {
          let attempted: Awaited<ReturnType<AgentEngine<any>["proposeGoalResolution"]>>;
          try {
            attempted = await this.engine.proposeGoalResolution(proposal);
          } catch (error) {
            const staleProposal = error instanceof AgentEngineConflictError
              || (error instanceof AgentGoalTransitionError && error.code === "version_conflict");
            if (!staleProposal) throw error;
            const currentGoal = await this.engine.getGoal(proposal.goalId);
            await this.engine.appendToolItem({
              itemId: `${turnId}:stale-goal`,
              turnId,
              threadId: input.threadId,
              goalId: input.goalId,
              kind: "control",
              value: {
                turnId,
                status: "stale_goal",
                message: "本轮结论基于旧版 Goal，已丢弃；将基于 Host 的最新反馈继续。",
                expectedGoalVersion: proposal.expectedGoalVersion,
                currentGoalVersion: currentGoal?.version,
              },
              createdAt: this.now().toISOString(),
            });
            return { turnId, status: "yielded", toolCalls, goal: currentGoal };
          }
          await this.trace(turnId, input, "settlement", attempted);
          return { turnId, status: "resolution_proposed", toolCalls, goal: attempted.goal };
        }
        const error = state.session.state.errorMessage;
        if (error) return this.providerFailure(turnId, input, toolCalls, goal, error);
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
        if (state.safety.consecutiveIdleResponses >= MAX_IDLE_CONTINUATIONS) {
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
        prompt = { text: unresolvedGoalPrompt(goal), images: [] };
      }
    } catch (error) {
      if (state.safety.blockedReason) {
        return this.block(
          turnId,
          input,
          toolCalls,
          goal,
          state.safety.blockReasonKind ?? "no_progress",
          state.safety.blockedReason,
        );
      }
      throw error;
    } finally {
      promptWatchdog?.dispose();
      state.resolution.goal = undefined;
      state.resolution.turnId = undefined;
      state.resolution.onProposal = undefined;
      state.resolution.onInvalid = undefined;
      state.resolution.mock = undefined;
      unsubscribe();
    }
  }

  async dispose(): Promise<void> {
    const pendingSessions = [...this.sessions.values()];
    this.sessions.clear();
    this.turnTails.clear();
    await Promise.allSettled([
      ...pendingSessions.map(async (pending) => {
        const { session } = await pending;
        try {
          await session.abort();
        } finally {
          session.dispose();
        }
      }),
      this.tools.dispose(),
    ]);
  }

  async releaseGoalResources(input: {
    agentId: string;
    threadId: string;
    goalId: string;
    attemptId?: string;
  }): Promise<void> {
    const key = piWorkSessionKey(input.threadId, input.goalId);
    const pending = this.sessions.get(key);
    this.sessions.delete(key);
    const release = this.tools.releaseExecutionResources(input);
    if (pending) {
      const { session } = await pending;
      const cleanup = Promise.allSettled([
        abortPiSessionPromptly(session, DEFAULT_SESSION_ABORT_GRACE_MS),
        release,
      ]);
      await waitForCleanupPromptly(cleanup, DEFAULT_SESSION_ABORT_GRACE_MS);
      return;
    }
    await waitForCleanupPromptly(release, DEFAULT_SESSION_ABORT_GRACE_MS);
  }

  private requireSession(input: AgentExecutionSliceInput): Promise<SessionState> {
    const key = piWorkSessionKey(input.threadId, input.goalId);
    const existing = this.sessions.get(key);
    if (existing) return existing;
    const pending = this.createSession(input);
    this.sessions.set(key, pending);
    return pending;
  }

  private async createSession(input: AgentExecutionSliceInput): Promise<SessionState> {
    const sessionDir = piWorkSessionDirectory(
      this.workspaceRoot,
      input.agent.id,
      input.threadId,
      input.goalId,
    );
    await mkdir(sessionDir, { recursive: true });
    // AgentThread is the authoritative conversation log. Pi's session file is
    // an execution trace only; rebuilding from AgentThread prevents a stale or
    // rejected Pi tool call from bypassing our context projection after restart.
    const sessionManager = SessionManager.create(this.workspaceRoot, sessionDir);
    const auth = AuthStorage.inMemory();
    const registry = ModelRegistry.inMemory(auth);
    const model = await configureModel(
      registry,
      auth,
      this.providers,
      input.provider,
      input.model,
      input.contextWindowTokens ?? 128_000,
      Boolean(input.supportsReasoning),
      Boolean(input.supportsImages),
    );
    const settings = SettingsManager.inMemory({
      compaction: { enabled: true },
      retry: input.provider === "mock"
        ? { enabled: false, maxRetries: 0, baseDelayMs: 0 }
        : { enabled: true, maxRetries: 3, baseDelayMs: 2_000 },
      shellPath: process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : undefined,
    }, { projectTrusted: true });
    const enabledSkillNames = effectiveAgentSkills(input.profile, input.agent);
    const loader = new DefaultResourceLoader({
      cwd: this.workspaceRoot,
      agentDir: input.agent.agentDir,
      settingsManager: settings,
      additionalSkillPaths: configuredSkillPaths(this.workspaceRoot, enabledSkillNames),
      noExtensions: true,
      noSkills: false,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: stableSystemPrompt(input),
      skillsOverride: (base) => {
        const enabled = new Set(enabledSkillNames);
        return { ...base, skills: base.skills.filter((skill) => enabled.has(skill.name)) };
      },
    });
    await loader.reload();
    const skills = loader.getSkills().skills;
    const skillNames = skills.map((skill) => skill.name);
    const sessionGoal = input.goalId ? await this.engine.getGoal(input.goalId) : undefined;
    const thread = await this.engine.getThread(input.threadId);
    let triggerIndex = input.triggerMessageId
      ? thread.items.findIndex((item) => item.itemId === input.triggerMessageId)
      : -1;
    if (triggerIndex < 0 && input.goalId) {
      const payloads = await this.store.payloads(thread.items.map((item) => item.payloadRef));
      triggerIndex = thread.items.findIndex((item) => {
        const payload = payloads.get(item.payloadRef);
        return item.kind === "message" && isRecord(payload) && payload.goalId === input.goalId;
      });
    }
    const historyThread = triggerIndex >= 0
      ? { ...thread, items: thread.items.slice(0, triggerIndex), version: Math.max(0, thread.items[triggerIndex]!.sequence - 1) }
      : thread;
    const assembled = await this.contextAssembler.assemble({
      profile: input.profile,
      agent: input.agent,
      policy: input.policy,
      thread: historyThread,
      goal: sessionGoal,
    });
    await restoreSessionHistory(sessionManager, assembled.history, model, this.workspaceRoot);
    const resolution: ResolutionBinding = {};
    const toolExecution: ToolExecutionBinding = {
      agentId: input.agent.id,
      threadId: input.threadId,
    };
    const safety: RunSafetyBinding = {
      failures: new Map(),
      terminalSubmissionFailures: 0,
      seenUsefulToolSignatures: new Set(),
      repeatedToolBatchCount: 0,
      consecutiveIdleResponses: 0,
      unproductiveToolCalls: 0,
    };
    const customTools = [
      ...workspaceTools(this.tools, toolExecution),
      piReadTool(this.tools, skills, toolExecution),
      goalTool(resolution, this.now, sessionGoal?.spec.outputContract),
      correctionTool(resolution, this.now, sessionGoal?.spec.outputContract),
      planChangeTool(resolution, this.now, sessionGoal?.spec.outputContract),
      humanInputTool(resolution, this.now),
    ];
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
      thinkingLevel: input.supportsReasoning ? (input.thinkingLevel ?? "medium") : "off",
    });
    session.setAutoCompactionEnabled(true);
    const goalVersions = promptedGoalVersions(sessionManager.getEntries());
    await this.traces.append({
      traceId: piSessionSkillsTraceId(
        input.threadId,
        input.goalId,
        input.turnId,
        skillNames,
      ),
      agentId: input.agent.id,
      threadId: input.threadId,
      goalId: input.goalId,
      turnId: input.turnId ?? stableId("turn", input.threadId, "session-resources"),
      kind: "context",
      createdAt: this.now().toISOString(),
      data: { enabledSkills: skillNames, diagnostics: loader.getSkills().diagnostics },
    });
    return { session, goalVersions, resolution, toolExecution, safety };
  }

  private async nextPrompt(
    input: AgentExecutionSliceInput,
    goal: AgentGoal | undefined,
    state: SessionState,
    pending: PendingThreadInput | undefined,
    triggerMessageId: string | undefined,
  ): Promise<AgentPrompt> {
    const isNewGoalVersion = Boolean(goal && state.goalVersions.get(goal.spec.id) !== goal.version);
    const goalUpdate = goal && isNewGoalVersion
      ? await this.goalUpdatePrompt(input.threadId, goal)
      : undefined;
    if (goal && !isNewGoalVersion && !triggerMessageId && !pending) {
      return "上一轮执行因进程中断而没有形成结论。请基于当前 Goal、已有会话历史和工具结果继续工作；先核对当前工作区事实，再从未完成处推进，不要重复已经完成且已有证据的步骤。";
    }
    if (triggerMessageId) {
      const thread = await this.engine.getThread(input.threadId);
      const item = thread.items.find((candidate) => candidate.itemId === triggerMessageId);
      const payload = item ? (await this.store.payloads([item.payloadRef])).get(item.payloadRef) : undefined;
      const content = isRecord(payload) && typeof payload.content === "string" ? payload.content.trim() : "";
      const attachments = isRecord(payload) && Array.isArray(payload.attachments) ? payload.attachments : [];
      if (attachments.length && !input.supportsImages) {
        throw new Error(`当前模型 ${input.provider}/${input.model} 未配置图片输入能力`);
      }
      const images = await Promise.all(attachments.map(async (value): Promise<ImageContent> => {
        if (!isRecord(value) || typeof value.attachmentId !== "string") throw new Error("图片附件引用无效");
        const stored = await new AttachmentStore(this.workspaceRoot).get(value.attachmentId);
        return { type: "image", data: stored.data.toString("base64"), mimeType: stored.metadata.mimeType };
      }));
      if (images.length) {
        const text = content || "请查看本轮发送的图片。";
        return { text: goalUpdate ? `${goalUpdate}\n\n## 本轮按时间顺序收到的消息\n${text}` : text, images };
      }
      if (content) {
        if (!goalUpdate) return { text: content, images: [] };
        return `${goalUpdate}\n\n## 本轮按时间序收到的消息\n${content}`;
      }
    }
    if (goal && isNewGoalVersion) {
      const thread = await this.engine.getThread(input.threadId);
      const payloads = await this.store.payloads(thread.items.map((item) => item.payloadRef));
      const initial = initialGoalMessage(thread, payloads, goal.spec.id);
      if (initial) {
        return `${goalUpdate}\n\n## 恢复的正式任务消息\n${initial}`;
      }
      return goalUpdate!;
    }
    if (pending?.kind === "correction") return `Host 对目标结算的决定：${pending.content}`;
    throw new Error("Agent turn 没有新的按时间序输入");
  }

  private async goalUpdatePrompt(threadId: string, goal: AgentGoal): Promise<string> {
    const thread = await this.engine.getThread(threadId);
    const payloads = await this.store.payloads(thread.items.map((item) => item.payloadRef));
    const decision = latestCorrectableDecision(thread, payloads, goal.spec.id);
    return [
      activeGoalPrompt(goal),
      decision ? `\n## Host 对上一份结论的最新决定\n${JSON.stringify(decision)}` : undefined,
    ].filter(Boolean).join("\n");
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
    return { turnId, status: "execution_blocked", toolCalls, goal, blockReason, blockedMessage: message };
  }

  private async providerFailure(
    turnId: string,
    input: AgentExecutionSliceInput,
    toolCalls: number,
    goal: AgentGoal | undefined,
    message: string,
  ): Promise<AgentExecutionSliceResult> {
    const retryable = isRetryableProviderFailure(message);
    if (!retryable) return this.block(turnId, input, toolCalls, goal, "provider_error", message);
    const value = {
      turnId,
      status: "provider_retry_wait",
      reason: "provider_error",
      message,
    };
    await this.engine.appendToolItem({
      itemId: `${turnId}:provider-retry-wait`,
      turnId,
      threadId: input.threadId,
      goalId: input.goalId,
      kind: "control",
      value,
      createdAt: this.now().toISOString(),
    });
    await this.trace(turnId, input, "error", value);
    return {
      turnId,
      status: "yielded",
      toolCalls,
      goal,
      blockReason: "provider_error",
      providerRetryable: true,
    };
  }

  private trace(turnId: string, input: AgentExecutionSliceInput, kind: "context" | "settlement" | "error", data: unknown): Promise<void> {
    return this.traces.append({
      traceId: stableId("trace", turnId, kind, JSON.stringify(data)), agentId: input.agent.id,
      threadId: input.threadId, goalId: input.goalId, turnId, kind, createdAt: this.now().toISOString(), data,
    });
  }
}

export async function awaitPiPromptOutcome(
  promptRun: Promise<void>,
  terminalProviderError: Promise<string>,
  waitForIdle: () => Promise<void> = async () => undefined,
  inactivityTimeout?: Promise<string>,
): Promise<{ kind: "settled" } | { kind: "provider_error"; message: string }> {
  type PromptOutcome = { kind: "settled" } | { kind: "provider_error"; message: string };
  const outcomes: Promise<PromptOutcome>[] = [
    promptRun.then(waitForIdle).then(() => ({ kind: "settled" as const })),
    terminalProviderError.then((message) => ({ kind: "provider_error" as const, message })),
  ];
  if (inactivityTimeout) {
    outcomes.push(inactivityTimeout.then((message) => ({ kind: "provider_error" as const, message })));
  }
  return Promise.race(outcomes);
}

export interface PiToolExecutionBarrier {
  started(callId: string): void;
  finished(callId: string): void;
  waitForIdle(): Promise<void>;
}

export function createPiToolExecutionBarrier(): PiToolExecutionBarrier {
  const active = new Set<string>();
  let idle: Promise<void> = Promise.resolve();
  let resolveIdle: (() => void) | undefined;

  return {
    started(callId) {
      if (active.has(callId)) return;
      if (active.size === 0) {
        idle = new Promise<void>((resolve) => {
          resolveIdle = resolve;
        });
      }
      active.add(callId);
    },
    finished(callId) {
      if (!active.delete(callId) || active.size > 0) return;
      resolveIdle?.();
      resolveIdle = undefined;
    },
    waitForIdle() {
      return idle;
    },
  };
}

interface PiPromptInactivityWatchdog {
  timeout: Promise<string>;
  touch(): void;
  dispose(): void;
}

export function createPiPromptInactivityWatchdog(
  inactivityMs: number,
  abort: () => void | Promise<void>,
): PiPromptInactivityWatchdog {
  let timer: NodeJS.Timeout | undefined;
  let settled = false;
  let resolveTimeout!: (message: string) => void;
  const timeout = new Promise<string>((resolve) => {
    resolveTimeout = resolve;
  });
  const arm = () => {
    if (settled) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolveTimeout(`Provider turn produced no events for ${inactivityMs}ms (inactivity timeout)`);
      void Promise.resolve(abort()).catch(() => undefined);
    }, inactivityMs);
    timer.unref?.();
  };
  arm();
  return {
    timeout,
    touch: arm,
    dispose() {
      settled = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}

type PendingThreadInput =
  | { kind: "message"; itemId: string; turnId: string; content: string }
  | { kind: "correction"; itemId: string; content: string };

export function unresolvedGoalPrompt(goal: AgentGoal): string {
  return [
    "当前 Goal 仍处于 active，上一轮普通回复没有结案。",
    `Goal：${goal.spec.objective}`,
    `成功标准：\n${goal.spec.successCriteria.map((item, index) => `${index + 1}. ${item}`).join("\n") || "未定义"}`,
    "继续前先对照上述成功标准盘点已有工具证据：证据已经足够时立即提交结论；只补尚未覆盖的证据缺口，不重复已完成的检查，也不扩展与成功标准无关的探索。",
    "请直接继续执行可推进的工作，不要等待 human 重复确认可逆的实现选择，也不要仅说明下一步计划。",
    "如果已有足够授权，请使用工具创建、修改并验证真实交付物。",
    "正常完成或失败时调用 goal_resolution；发现上游事实错误时调用 report_goal_correction；当前计划本身不足时调用 request_goal_plan_change；只有缺少不可替代的 human 输入时才调用 request_human_input。",
  ].join("\n");
}

function normalizePrompt(prompt: AgentPrompt): { text: string; images: ImageContent[] } {
  return typeof prompt === "string" ? { text: prompt, images: [] } : prompt;
}

function configuredSkillPaths(workspaceRoot: string, names: string[]): string[] {
  return names.flatMap((name) => {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) return [];
    const candidates = [
      path.join(workspaceRoot, ".agents", "skills", name),
      path.join(os.homedir(), ".agents", "skills", name),
    ];
    return candidates.find((candidate) => existsSync(path.join(candidate, "SKILL.md"))) ?? [];
  });
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
    "正常完成或失败时使用 goal_resolution；需要纠正上游时使用 report_goal_correction；需要调整计划时使用 request_goal_plan_change；需要不可替代的 human 输入时使用 request_human_input。",
  ].filter(Boolean).join("\n");
}

export function initialGoalMessage(
  thread: AgentThreadSnapshot,
  payloads: ReadonlyMap<string, unknown>,
  goalId: string,
): string | undefined {
  for (const item of thread.items) {
    if (item.kind !== "message") continue;
    const payload = payloads.get(item.payloadRef);
    if (!isRecord(payload) || payload.goalId !== goalId || typeof payload.content !== "string") continue;
    const content = payload.content.trim();
    if (content) return content;
  }
  return undefined;
}

export function promptedGoalVersions(entries: readonly unknown[]): Map<string, number> {
  const goalVersions = new Map<string, number>();
  for (const entry of entries) {
    if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== "autoagent_goal_prompted") continue;
    if (!isRecord(entry.data) || typeof entry.data.goalId !== "string" || !entry.data.goalId) continue;
    const version = Number.isInteger(entry.data.goalVersion) && Number(entry.data.goalVersion) > 0
      ? Number(entry.data.goalVersion)
      : 0;
    goalVersions.set(entry.data.goalId, version);
  }
  return goalVersions;
}

export function promptedGoalIds(entries: readonly unknown[]): Set<string> {
  return new Set(promptedGoalVersions(entries).keys());
}

async function pendingThreadInput(
  thread: Awaited<ReturnType<AgentEngine<any>["getThread"]>>,
  store: AgentStore,
  humanOnly = false,
  earliest = false,
  goalId?: string,
): Promise<PendingThreadInput | undefined> {
  const payloads = await store.payloads(thread.items.map((item) => item.payloadRef));
  const indexes = earliest
    ? thread.items.map((_, index) => index)
    : thread.items.map((_, index) => thread.items.length - index - 1);
  for (const index of indexes) {
    const item = thread.items[index]!;
    const payload = payloads.get(item.payloadRef);
    if (goalId && (!isRecord(payload) || payload.goalId !== goalId)) continue;
    if (item.kind === "message" && isRecord(payload) && typeof payload.content === "string") {
      if (humanOnly && (payload.senderPrincipalId !== "human" || payload.deliveryKind === "context")) continue;
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

export function latestCorrectableDecision(
  thread: AgentThreadSnapshot,
  payloads: ReadonlyMap<string, unknown>,
  goalId: string,
): unknown {
  for (let index = thread.items.length - 1; index >= 0; index -= 1) {
    const payload = payloads.get(thread.items[index]!.payloadRef);
    if (!isCorrectableDecision(payload) || payload.goalId !== goalId) continue;
    return payload.decision;
  }
  return undefined;
}

function isRunningPayload(value: unknown): boolean {
  return isRecord(value) && value.status === "running";
}

function workspaceTools(runtime: AgentToolRuntime, binding: ToolExecutionBinding): ToolDefinition[] {
  return runtime.definitions().map((definition) => defineTool({
    name: definition.name,
    label: definition.name,
    description: definition.description,
    parameters: toolParameters(definition.name as WorkspaceToolName),
    async execute(callId, params) {
      const result = await runtime.execute(
        { tool: definition.name as WorkspaceToolName, ...(params as Omit<AgentToolIntent, "tool">) },
        toolExecutionContext(binding, callId),
      );
      if (!result.ok) throw new Error(failureMessage(result));
      if (result.tool === "readImage" && typeof result.data === "string" && typeof result.mimeType === "string") {
        return {
          content: [
            { type: "text", text: JSON.stringify({ ok: true, tool: result.tool, path: result.path, size: result.size }) },
            { type: "image", data: result.data, mimeType: result.mimeType },
          ],
          details: { ...result, data: undefined },
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: compactToolResultDetails(result),
      };
    },
  }));
}

function piReadTool(runtime: AgentToolRuntime, skills: Skill[], binding: ToolExecutionBinding): ToolDefinition {
  return defineTool({
    name: "read",
    label: "读取文件或 Skill 文档",
    description: "读取工作区文件，或读取当前 Agent 已启用 Skill 目录中的说明与引用文件。",
    parameters: Type.Object({
      path: Type.String(),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 64_000 })),
    }),
    async execute(callId, params) {
      const { path: requestedPath, offset, limit } = params as { path: string; offset?: number; limit?: number };
      const skillFile = await resolveEnabledSkillFile(requestedPath, skills);
      if (skillFile) {
        const content = await readFile(skillFile, "utf8");
        return {
          content: [{ type: "text", text: content }],
          details: { ok: true, source: "skill", path: skillFile } as Record<string, unknown>,
        };
      }

      const result = await runtime.execute(
        { tool: "readFile", path: requestedPath, offset, limit },
        toolExecutionContext(binding, callId),
      );
      if (!result.ok) throw new Error(failureMessage(result));
      return {
        content: [{
          type: "text",
          text: `${String(result.content ?? "")}\n\n[evidenceId: ${String(result.evidenceId)}]`,
        }],
        details: {
          ok: true,
          source: "workspace",
          path: String(result.path ?? requestedPath),
          offset: result.offset,
          totalChars: result.totalChars,
          truncated: result.truncated,
          nextOffset: result.nextOffset,
        } as Record<string, unknown>,
      };
    },
  });
}

function toolExecutionContext(binding: ToolExecutionBinding, toolCallId: string): AgentToolExecutionContext {
  if (!binding.turnId) throw new Error("Tool execution is not bound to an active turn");
  return {
    agentId: binding.agentId,
    threadId: binding.threadId,
    goalId: binding.goalId,
    attemptId: binding.attemptId,
    turnId: binding.turnId,
    toolCallId,
  };
}

export async function resolveEnabledSkillFile(requestedPath: string, skills: Skill[]): Promise<string | undefined> {
  if (!path.isAbsolute(requestedPath)) return undefined;
  let target: string;
  try {
    target = await realpath(requestedPath);
  } catch {
    return undefined;
  }
  for (const skill of skills) {
    const root = await realpath(skill.baseDir);
    if (isInside(root, target)) return target;
  }
  return undefined;
}

export function activePiToolNames(
  workspaceToolNames: string[],
  supportsImages: boolean,
  outputContractOrHasGoal?: AgentGoal["spec"]["outputContract"] | boolean,
): string[] {
  const hasGoal = Boolean(outputContractOrHasGoal);
  const outputContract = typeof outputContractOrHasGoal === "object"
    ? outputContractOrHasGoal
    : undefined;
  return [...new Set([
    "read",
    ...workspaceToolNames.filter((name) => name !== "readImage" || supportsImages),
    ...(hasGoal ? [
      "goal_resolution",
      ...(outputContract?.correctionOutcomeSchema ? ["report_goal_correction"] : []),
      ...(outputContract?.planChangeOutcomeSchema ? ["request_goal_plan_change"] : []),
      "request_human_input",
    ] : []),
  ])];
}

function goalTool(
  binding: ResolutionBinding,
  now: () => Date,
  outputContract?: AgentGoal["spec"]["outputContract"],
): ToolDefinition {
  const domainOutcomeSchema = outputContract?.completionOutcomeSchema;
  const genericCriterionResults = Type.Array(Type.Object({
    criterionIndex: Type.Integer({ minimum: 0 }),
    status: Type.Union([Type.Literal("satisfied"), Type.Literal("not_satisfied"), Type.Literal("not_verified")]),
    evidence: Type.Array(Type.Object({ evidenceId: Type.String() })),
    note: Type.Optional(Type.String()),
  }));
  return defineTool({
    name: "goal_resolution",
    label: "提交工作结论",
    description: "提交当前 Goal 的正常完成或失败结论。criterionResults 必须逐项对应当前 Goal 的 successCriteria；domainOutcome 按 Ticket 的领域输出契约填写。若需要纠正上游请调用 report_goal_correction，若计划本身不足请调用 request_goal_plan_change。Host 只校验契约并提交，不替你判断结论。",
    parameters: Type.Object({
      status: Type.Union([Type.Literal("completed"), Type.Literal("failed")]),
      summary: Type.Optional(Type.String()),
      evidence: Type.Optional(Type.Array(Type.Object({ evidenceId: Type.String() }))),
      criterionResults: genericCriterionResults,
      residualRisks: Type.Optional(Type.Array(Type.String())),
      ...(domainOutcomeSchema
        // Tool transport validates the Goal envelope only. The Mission manager
        // owns the authoritative domain contract and returns correctable errors
        // with the current Ticket/Plan context.
        ? { domainOutcome: goalResolutionTransportDomainOutcomeSchema() }
        : { domainOutcome: Type.Optional(Type.Unknown()) }),
    }),
    async execute(_callId, params) {
      if (!binding.goal || !binding.turnId || !binding.onProposal) {
        const details: ResolutionToolDetails = { ok: false, reason: "当前没有可结算的 Goal", proposal: null };
        binding.onInvalid?.(details.reason);
        return {
          content: [{ type: "text", text: details.reason }],
          details,
          terminate: true,
        };
      }
      const normalizedParams = withDefaultResidualRisks(params);
      const submitted = binding.mock
        ? {
            ...normalizedParams,
            criterionResults: binding.goal.spec.successCriteria.map((_criterion, criterionIndex) => ({
              criterionIndex,
              status: "satisfied" as const,
              evidence: [],
            })),
          }
        : normalizedParams;
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

export function goalResolutionDomainOutcomeSchema(
  outputContract?: AgentGoal["spec"]["outputContract"],
) {
  return outputContract?.completionOutcomeSchema
    ? Type.Unsafe(outputContract.completionOutcomeSchema)
    : Type.Unknown();
}

export function goalResolutionTransportDomainOutcomeSchema() {
  return Type.Unknown();
}

function correctionTool(
  binding: ResolutionBinding,
  now: () => Date,
  outputContract?: AgentGoal["spec"]["outputContract"],
): ToolDefinition {
  return defineTool({
    name: "report_goal_correction",
    label: "Report upstream correction",
    description: "Report that an existing upstream Ticket needs correction. This is a workflow proposal, not successful completion.",
    parameters: outputContract?.correctionOutcomeSchema
      ? Type.Unsafe(outputContract.correctionOutcomeSchema)
      : Type.Object({ reason: Type.String({ minLength: 1 }) }),
    async execute(_callId, params) {
      const value = isRecord(params) ? params : {};
      const reason = typeof value.reason === "string" ? value.reason.trim() : "";
      return submitWorkflowAction(
        binding,
        now,
        "report_goal_correction",
        reason,
        { disposition: "correction_required", ...value },
      );
    },
  });
}

function planChangeTool(
  binding: ResolutionBinding,
  now: () => Date,
  outputContract?: AgentGoal["spec"]["outputContract"],
): ToolDefinition {
  return defineTool({
    name: "request_goal_plan_change",
    label: "Request plan change",
    description: "Request planner action because the current Plan cannot satisfy this Goal as defined.",
    parameters: outputContract?.planChangeOutcomeSchema
      ? Type.Unsafe(outputContract.planChangeOutcomeSchema)
      : Type.Object({ reason: Type.String({ minLength: 1 }) }),
    async execute(_callId, params) {
      const value = isRecord(params) ? params : {};
      const reason = typeof value.reason === "string" ? value.reason.trim() : "";
      return submitWorkflowAction(
        binding,
        now,
        "request_goal_plan_change",
        reason,
        { disposition: "plan_change_required", ...value },
      );
    },
  });
}

function submitWorkflowAction(
  binding: ResolutionBinding,
  now: () => Date,
  toolName: string,
  reason: string,
  domainOutcome: Record<string, unknown>,
) {
  const criterionResults = binding.goal?.spec.successCriteria.map((_criterion, criterionIndex) => ({
    criterionIndex,
    status: "not_verified" as const,
    evidence: [],
    note: reason,
  })) ?? [];
  return submitResolution(binding, now, {
    status: "completed",
    summary: reason,
    criterionResults,
    residualRisks: [],
    domainOutcome,
  }, toolName);
}

function submitResolution(
  binding: ResolutionBinding,
  now: () => Date,
  params: unknown,
  toolName: string,
) {
  if (!binding.goal || !binding.turnId || !binding.onProposal) {
    const details: ResolutionToolDetails = { ok: false, reason: "No active Goal can accept this proposal", proposal: null };
    binding.onInvalid?.(details.reason);
    return {
      content: [{ type: "text" as const, text: details.reason }],
      details,
      terminate: true,
    };
  }
  const parsed = parseResolutionProposal(params, binding.goal, binding.turnId, now().toISOString());
  if (!parsed.ok) {
    if (process.env.AUTOAGENT_DEBUG_PI === "1") console.error(`Pi ${toolName} rejected`, parsed.reason, params);
    throw new Error(parsed.reason);
  }
  binding.onProposal(parsed.value);
  const details: ResolutionToolDetails = { ok: true, reason: "", proposal: parsed.value };
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ proposalSubmitted: true, proposalId: parsed.value.proposalId }) }],
    details,
    terminate: true,
  };
}

export function piSessionSkillsTraceId(
  threadId: string,
  goalId: string | undefined,
  turnId: string | undefined,
  skillNames: readonly string[],
): string {
  return stableId(
    "trace",
    threadId,
    goalId ?? "no-goal",
    turnId ?? "session-resources",
    "skills",
    skillNames.join(","),
  );
}

export function piWorkSessionKey(threadId: string, goalId?: string): string {
  return `${threadId}\u0000${goalId ?? "conversation"}`;
}

export const PI_WORK_SESSION_CONTEXT_VERSION = "goal-context-v4";

export function piWorkSessionDirectory(
  workspaceRoot: string,
  agentId: string,
  threadId: string,
  goalId?: string,
): string {
  return path.join(
    workspaceRoot,
    ".autoagent",
    "pi-sessions",
    PI_WORK_SESSION_CONTEXT_VERSION,
    safeKey(agentId),
    safeKey(threadId),
    safeKey(goalId ?? "conversation"),
  );
}

export function withDefaultResidualRisks<T extends object>(
  params: T & { residualRisks?: string[] },
): T & { residualRisks: string[] } {
  return {
    ...params,
    residualRisks: params.residualRisks ?? [],
  };
}

function humanInputTool(binding: ResolutionBinding, now: () => Date): ToolDefinition {
  return defineTool({
    name: "request_human_input",
    label: "请求 human 输入",
    description: "当前 Goal 只有在缺少不可替代的人工测试、授权、凭证、外部事实、不可逆操作确认或工具策略调整时调用。调用后当前 Goal 等待 human 回复。可逆实现选择、可自行完成的工作或普通失败不得使用此工具。",
    parameters: Type.Object({
      kind: Type.Union(AGENT_HUMAN_INPUT_KINDS.map((kind) => Type.Literal(kind))),
      description: Type.String(),
      details: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    }),
    async execute(_callId, params) {
      if (!binding.goal || !binding.turnId || !binding.onProposal) {
        const reason = "当前没有可请求 human 输入的 Goal";
        const details: ResolutionToolDetails = { ok: false, reason, proposal: null };
        binding.onInvalid?.(reason);
        return {
          content: [{ type: "text", text: reason }],
          details,
          terminate: true,
        };
      }
      const value = params as { kind?: unknown; description?: unknown; details?: unknown };
      const description = typeof value.description === "string" ? value.description.trim() : "";
      if (!AGENT_HUMAN_INPUT_KINDS.includes(value.kind as AgentHumanInputKind) || !description) {
        throw new Error("kind 或 description 无效");
      }
      if (value.details !== undefined && !isRecord(value.details)) {
        throw new Error("details 必须是对象");
      }
      const request: AgentHumanInputRequest = {
        kind: value.kind as AgentHumanInputKind,
        description,
        ...(value.details ? { details: structuredClone(value.details) } : {}),
      };
      const proposal = createHumanInputProposal(binding.goal, binding.turnId, request, now().toISOString());
      binding.onProposal(proposal);
      const details: ResolutionToolDetails = { ok: true, reason: "", proposal };
      return {
        content: [{ type: "text", text: JSON.stringify({ humanInputRequested: true, proposalId: proposal.proposalId }) }],
        details,
        terminate: true,
      };
    },
  });
}

function failureMessage(details: unknown): string {
  if (isRecord(details)) {
    if (details.failureKind === "infrastructure_transport") {
      const message = typeof details.error === "string" && details.error.trim()
        ? details.error
        : "平台工具连接暂时不可用";
      return `[AUTOAGENT_INFRASTRUCTURE_TRANSPORT] ${message}`;
    }
    if (typeof details.reason === "string" && details.reason.trim()) return details.reason;
    if (typeof details.error === "string" && details.error.trim()) return details.error;
    if (typeof details.message === "string" && details.message.trim()) return details.message;
  }
  return JSON.stringify(details);
}

export function isTransientInfrastructureToolFailure(result: unknown): boolean {
  const serialized = typeof result === "string" ? result : JSON.stringify(result);
  return serialized.includes("[AUTOAGENT_INFRASTRUCTURE_TRANSPORT]");
}

function toolParameters(name: WorkspaceToolName) {
  if (name === "writeFile") return Type.Object({ path: Type.String(), content: Type.String() });
  if (name === "editFile") {
    return Type.Object({
      path: Type.String(),
      oldText: Type.String({ minLength: 1 }),
      newText: Type.String(),
    });
  }
  if (name === "readFile") {
    return Type.Object({
      path: Type.String(),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 64_000 })),
    });
  }
  if (name === "readImage" || name === "listFiles") return Type.Object({ path: Type.Optional(Type.String()) });
  if (name === "startService") {
    return Type.Object({
      command: Type.String(),
      port: Type.Integer({ minimum: 1, maximum: 65_535 }),
    });
  }
  if (name === "pollProcess") return Type.Object({ serviceId: Type.String() });
  if (name === "browser") return Type.Object({ browserArgs: Type.Array(Type.String(), { minItems: 1 }) });
  return Type.Object({ command: Type.String() });
}

function compactToolResultDetails(result: WorkspaceAgentToolResult): Record<string, unknown> {
  return Object.fromEntries(Object.entries(result).filter(([key]) =>
    !["content", "data", "stdout", "stderr"].includes(key)));
}

export function compactPiToolEventDetails(result: unknown): Record<string, unknown> {
  if (!isRecord(result)) return {};
  const compact = Object.fromEntries(Object.entries(result).filter(([key]) =>
    !["content", "data", "stdout", "stderr", "details"].includes(key)));
  if (isRecord(result.details)) {
    compact.details = Object.fromEntries(Object.entries(result.details).filter(([key]) =>
      !["content", "data", "stdout", "stderr", "details"].includes(key)));
  }
  return compact;
}

async function configureModel(
  registry: ModelRegistry,
  auth: AuthStorage,
  providers: ProviderRegistry,
  provider: ProviderName,
  modelId: string,
  contextWindow: number,
  supportsReasoning: boolean,
  supportsImages: boolean,
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
    models: [{ id: modelId, name: modelId, api, baseUrl: config.baseUrl, reasoning: supportsReasoning, input: supportsImages ? ["text", "image"] : ["text"], cost: zeroCost(), contextWindow, maxTokens: Math.min(32_768, Math.max(4_096, Math.floor(contextWindow / 4))) }] as any,
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

async function restoreSessionHistory(
  sessionManager: SessionManager,
  history: AgentModelHistoryItem[],
  model: Model<any>,
  workspaceRoot: string,
): Promise<void> {
  const toolNames = new Map<string, string>();
  const startedAt = Date.now() - history.length;
  const attachments = new AttachmentStore(workspaceRoot);
  for (const [index, item] of history.entries()) {
    const timestamp = startedAt + index;
    if (item.type === "user_message") {
      const images = await Promise.all((item.attachments ?? []).map(async (attachment): Promise<ImageContent> => {
        const stored = await attachments.get(attachment.attachmentId);
        return { type: "image", data: stored.data.toString("base64"), mimeType: stored.metadata.mimeType };
      }));
      sessionManager.appendMessage({
        role: "user",
        content: images.length ? [{ type: "text", text: item.content || "请查看图片。" }, ...images] : item.content,
        timestamp,
      });
      continue;
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
      continue;
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
      continue;
    }
    sessionManager.appendMessage({
      role: "toolResult",
      toolCallId: item.callId,
      toolName: toolNames.get(item.callId) ?? "unknown_tool",
      content: [{ type: "text", text: item.content }],
      isError: item.isError,
      timestamp,
    });
  }
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

export function modelFacingToolResultText(result: unknown, isError: boolean): string {
  const text = toolResultText(result);
  if (!isError) return text;
  const receivedArguments = text.indexOf("\n\nReceived arguments:");
  if (text.startsWith("Validation failed for tool ") && receivedArguments >= 0) {
    return `${text.slice(0, receivedArguments).trim()}\n\n[Rejected arguments omitted from model context; full call remains in the audit trace.]`;
  }
  const maxErrorChars = 8_000;
  return text.length <= maxErrorChars
    ? text
    : `${text.slice(0, maxErrorChars)}\n...[tool error truncated before model context]`;
}

export function turnToolBudgetMessage(maxToolCalls: number): string {
  return [
    `当前 turn 已执行 ${maxToolCalls} 次工具调用，达到单轮执行预算。`,
    "Mission 和 Goal 均保持原状，但本轮会话已释放，避免单个 turn 长时间占用执行权并持续消耗。",
    "请检查当前证据和产物后再决定继续、调整计划或补充输入。",
  ].join("");
}

export function isUsefulToolProgress(
  name: string,
  args: unknown,
  result: unknown,
  isError: boolean,
  seen: Set<string>,
): boolean {
  if (isError) return false;
  if (isRecord(result) && result.ok === false) return false;
  if (isTerminalSubmissionTool(name)) return true;
  if (name === "writeFile" || name === "editFile") return true;
  if (name === "startService") return isRecord(result) ? result.running === true || result.ok === true : true;
  if (name === "browser" && isBrowserInteraction(args)) return false;
  if (name === "shell") {
    const command = isRecord(args) && typeof args.command === "string" ? args.command : "";
    if (isTrivialShellCommand(command)) return false;
  }
  const signature = createHash("sha256").update(JSON.stringify({
    name,
    args,
    result: progressResult(result),
  })).digest("hex");
  if (seen.has(signature)) return false;
  seen.add(signature);
  return true;
}

type AbortablePiSession = Pick<AgentSession, "abort" | "dispose">;

export async function abortPiSessionPromptly(
  session: AbortablePiSession,
  graceMs = DEFAULT_SESSION_ABORT_GRACE_MS,
): Promise<"idle" | "detached"> {
  const aborting = Promise.resolve()
    .then(() => session.abort())
    .then(() => "idle" as const);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"detached">((resolve) => {
    timer = setTimeout(() => resolve("detached"), graceMs);
  });
  const result = await Promise.race([aborting, timedOut]);
  if (timer) clearTimeout(timer);
  if (result === "idle") {
    session.dispose();
    return result;
  }
  void aborting
    .then(() => session.dispose())
    .catch(() => session.dispose());
  return result;
}

export async function waitForCleanupPromptly(
  cleanup: Promise<unknown>,
  graceMs = DEFAULT_SESSION_ABORT_GRACE_MS,
): Promise<"settled" | "detached"> {
  const guarded = cleanup.then(
    () => "settled" as const,
    () => "settled" as const,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"detached">((resolve) => {
    timer = setTimeout(() => resolve("detached"), graceMs);
  });
  const result = await Promise.race([guarded, timedOut]);
  if (timer) clearTimeout(timer);
  return result;
}

function isBrowserInteraction(args: unknown): boolean {
  if (!isRecord(args) || !Array.isArray(args.browserArgs)) return false;
  const command = args.browserArgs.find((item): item is string => (
    typeof item === "string" && !item.startsWith("-")
  ))?.toLowerCase();
  return command !== undefined && [
    "click",
    "dblclick",
    "drag",
    "fill",
    "hover",
    "move",
    "press",
    "scroll",
    "select",
    "type",
  ].includes(command);
}

function progressResult(result: unknown): unknown {
  if (Array.isArray(result)) return result.map((item) => progressResult(item));
  if (!isRecord(result)) return result;
  const stable: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(result)) {
    if ([
      "callId",
      "data",
      "durationMs",
      "evidenceId",
      "requestId",
      "timestamp",
      "traceId",
    ].includes(key)) continue;
    stable[key] = progressResult(value);
  }
  return stable;
}

export function isTerminalSubmissionTool(name: string): boolean {
  return [
    "goal_resolution",
    "report_goal_correction",
    "request_goal_plan_change",
    "request_human_input",
  ].includes(name);
}

export function toolFailureFingerprint(name: string, args: unknown, result: unknown): string {
  const terminal = isTerminalSubmissionTool(name);
  return createHash("sha256").update(JSON.stringify({
    name,
    ...(terminal ? {} : { args }),
    result: normalizedToolFailure(result),
  })).digest("hex");
}

function normalizedToolFailure(result: unknown): string {
  return modelFacingToolResultText(result, true)
    .replace(/\b(item|index|criterionIndex)\s+\d+\b/gi, "$1 #")
    .replace(/\/\d+(?=\/|$)/g, "/#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2_000);
}

function isTrivialShellCommand(command: string): boolean {
  const normalized = command.trim().toLowerCase().replace(/\s+/g, " ");
  if (!normalized) return true;
  if (/^(echo|printf)\b/.test(normalized)) return true;
  if (/^(pwd|cd|dir|ls)(\s|$)/.test(normalized)) return true;
  if (/^(true|false|exit\s+\d+)$/.test(normalized)) return true;
  return /^cmd \/c\s+(echo|cd|dir)\b/.test(normalized)
    || /^powershell(\.exe)?\s+(-command\s+)?["']?(echo|pwd|cd|dir)\b/.test(normalized);
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
  return { id: model.id, name: model.name, api: model.api, reasoning: model.reasoning, input: ["text"], cost: zeroCost(), contextWindow: model.contextWindow, maxTokens: model.maxTokens, baseUrl: model.baseUrl };
}

function zeroCost() { return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }; }

function envPositiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function stableSystemPrompt(input: AgentExecutionSliceInput): string {
  const skillInstructions = skillRuntimeAdapterInstructions(
    effectiveAgentSkills(input.profile, input.agent),
    input.policy.enabledTools ?? [],
  );
  return [
    input.profile.soul ? `## 个性\n${input.profile.soul}` : "",
    input.profile.identity ? `## 岗位\n${input.profile.identity}` : "",
    input.profile.agentMd ? `## 能力与工作方式\n${input.profile.agentMd}` : "",
    skillInstructions ? `## Skill 运行适配\n${skillInstructions}` : "",
    input.policy.canWriteWorkspace
      ? "## 新建交付物\n当 Goal 要求创建新的代码、文档、配置或其他交付物时，空工作区、尚无源码、尚无构建入口都不是缺少 human 输入，也不是 blocked 条件。你已经获得工作区写入授权，必须采用可逆的专业默认值，从零创建必要目录和文件，并使用可用工具持续实现与验证。不得仅因没有现成项目文件而要求 human 提供仓库、源码根目录或运行入口。"
      : "",
    "你是一个持续工作的通用 Agent。当前 Ticket 是你的 Goal。根据岗位、成功标准和输出契约完成工作；仅在工作本身需要时使用文件或命令工具，不要为了证明认知型交付物而寻找不存在的项目文件。正常完成或失败时调用 goal_resolution；发现上游交付需要纠正时调用 report_goal_correction；当前 Plan 无法支撑目标时调用 request_goal_plan_change；缺少不可替代的 human 输入时调用 request_human_input。evidenceId 只能引用本 Goal 工具调用真实返回的 ID，或 Host 在当前 Goal 中明确注入的继承证据 ID；没有证据时使用空数组。工具调用只是向 Host 提交提案，Ticket 和 Plan 状态仍由 Host 校验并提交。不要寻找或写入另一个提交文件、接口或平台内部状态，普通回复也不代表 Goal 完成。",
  ].filter(Boolean).join("\n\n");
}

function safeKey(value: string): string { return createHash("sha256").update(value).digest("base64url"); }
function stableId(prefix: string, ...parts: string[]): string { return `${prefix}_${createHash("sha256").update(JSON.stringify(parts)).digest("base64url")}`; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
