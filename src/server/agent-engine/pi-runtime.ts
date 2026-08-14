import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  defineTool,
  type AgentSession,
  type Skill,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, InMemoryCredentialStore, type AssistantMessage, type Context, type ImageContent, type Model } from "@earendil-works/pi-ai";
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
import { ProviderError, type AgentModelHistoryItem, type AgentModelTurnResult } from "../providers/types.js";
import { AgentEngineConflictError, type AgentEngine } from "./agent-engine.js";
import type { AgentContextAssembler } from "./context-assembler.js";
import type { AgentStore } from "./agent-store.js";
import { AgentGoalTransitionError } from "./goal-state.js";
import type { AgentExecutionRuntime, AgentExecutionSliceInput, AgentExecutionSliceResult } from "./runtime.js";
import { createHumanInputProposal, parseResolutionProposal } from "./resolution-proposal.js";
import { EvidenceLedger } from "./evidence-ledger.js";
import { isAgentInboxMessageConsumed, nextAgentInboxInput, projectAgentInbox } from "./agent-inbox.js";
import type { AgentTraceStore } from "./trace-store.js";
import {
  AgentToolRuntime,
  type AgentToolExecutionContext,
  type AgentToolIntent,
  type AgentToolResult as WorkspaceAgentToolResult,
} from "./tool-runtime.js";
import { AttachmentStore } from "../storage/attachment-store.js";
import { schemaValidationRecoveryHint } from "./tool-validation-feedback.js";
import { EvolutionStore } from "../evolution/evolution-store.js";
import { EvolutionEvaluationStore } from "../evolution/evaluation-store.js";
import { runtimeEvolutionProjection, runtimeEvolutionStateFingerprint, type OrganizationMemorySource, type RuntimeEvolutionExtension, type RuntimeEvolutionMemory, type RuntimeEvolutionPrompt } from "../evolution/runtime-projection.js";
import { IsolatedPluginHost, pluginToolName } from "../evolution/plugin-host.js";
import { EvolutionActivationStore } from "../evolution/activation-store.js";
import {
  TEAM_STAFFING_SCHEMA_REF,
  parseTeamStaffingOutcome,
} from "../../shared/contracts/staffing.js";

interface SessionState {
  session: AgentSession;
  goalVersions: Map<string, number>;
  resolution: ResolutionBinding;
  toolExecution: ToolExecutionBinding;
  safety: RunSafetyBinding;
  runtimeEvolutionFingerprint: string;
  evolutionToolNames: string[];
}

type AgentPrompt = string | { text: string; images: ImageContent[] };

interface ResolutionBinding {
  goal?: AgentGoal;
  turnId?: string;
  agentId?: string;
  workspaceRoot: string;
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
  failedToolSignatures: Set<string>;
  seenUsefulToolSignatures: Set<string>;
  lastToolObservationFingerprint?: string;
  lastIdleResponseFingerprint?: string;
  blockReasonKind?: "usage_limit" | "no_progress";
  blockedReason?: string;
}

const MAX_TOOL_CALLS_PER_TURN = envOptionalPositiveInteger("AUTOAGENT_MAX_TOOL_CALLS_PER_TURN");
const DEFAULT_TURN_TIMEOUT_MS = envPositiveInteger(
  "AUTOAGENT_TURN_TIMEOUT_MS",
  5 * 60_000,
);
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
  private readonly turnTimeoutMs: number;
  private readonly turnInactivityTimeoutMs: number;

  constructor(
    private readonly workspaceRoot: string,
    private readonly engine: AgentEngine<any>,
    private readonly store: AgentStore,
    private readonly contextAssembler: AgentContextAssembler,
    private readonly providers: ProviderRegistry,
    private readonly tools: AgentToolRuntime,
    private readonly traces: AgentTraceStore,
    private readonly options: {
      now?: () => Date;
      turnTimeoutMs?: number;
      turnInactivityTimeoutMs?: number;
      organizationMemorySources?: () => Promise<OrganizationMemorySource[]>;
    } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
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
    if (input.triggerMessageId && await isConsumedThreadMessage(thread, this.store, input.triggerMessageId)) {
      return {
        turnId: input.turnId ?? stableId("turn", input.threadId, input.triggerMessageId),
        status: "waiting",
        toolCalls: 0,
        goal: persistedGoal,
      };
    }
    const pending = await pendingThreadInput(thread, this.store, false, false, input.goalId);
    const turnId = input.turnId ?? (pending?.kind === "message" ? pending.turnId : undefined)
      ?? stableId("turn", input.threadId, String(thread.version + 1), this.now().toISOString());
    const triggerMessageId = input.triggerMessageId ?? (pending?.kind === "message" ? pending.itemId : undefined);
    let state: SessionState;
    try {
      state = await this.requireSession({ ...input, triggerMessageId });
    } catch (error) {
      // Provider configuration is part of the Agent Engine boundary. A
      // missing credential must become a typed execution result so Mission
      // Control can durably block the current Ticket instead of leaving its
      // claim running after an exception.
      this.sessions.delete(piWorkSessionKey(input.threadId, input.goalId));
      if (error instanceof ProviderError) {
        return this.providerFailure(turnId, input, 0, goal, error.message);
      }
      throw error;
    }
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
    let promptWatchdog: PiPromptWatchdog | undefined;
    let rebuildModelContext = false;
    let latestSchemaCorrection: string | undefined;
    let lastAssistantResponseFingerprint: string | undefined;
    let lastDurableProgressAt: string | undefined;
    const turnObservationFingerprints: string[] = [];
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
        if (MAX_TOOL_CALLS_PER_TURN !== undefined && toolCalls >= MAX_TOOL_CALLS_PER_TURN && !state.safety.blockedReason) {
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
        const observationFingerprint = toolObservationFingerprint(
          toolName,
          toolInput?.args,
          event.result,
          event.isError,
        );
        turnObservationFingerprints.push(observationFingerprint);
        if (state.safety.lastToolObservationFingerprint === observationFingerprint && !state.safety.blockedReason) {
          state.safety.blockReasonKind = "no_progress";
          state.safety.blockedReason = "模型连续重复相同的工具调用并得到相同结果，当前 turn 已暂停以避免无进展空转。";
          void state.session.abort();
        }
        state.safety.lastToolObservationFingerprint = observationFingerprint;
        if (event.isError) {
          if (isSchemaValidationToolFailure(event.result)) {
            // The audit thread keeps the exact rejected call. The live Pi
            // transcript is rebuilt before the next prompt so the model does
            // not see its own invalid arguments as a template to repeat.
            rebuildModelContext = true;
            latestSchemaCorrection = modelFacingToolResultText(event.result, true);
          }
          if (isTransientInfrastructureToolFailure(event.result) && !state.safety.blockedReason) {
            state.safety.blockReasonKind = "no_progress";
            state.safety.blockedReason = "平台工具连接暂时不可用，当前 Agent Goal 将保持不变并在基础设施恢复后继续。";
            void state.session.abort();
          }
          const fingerprint = toolFailureFingerprint(toolName, toolInput?.args, event.result);
          if (state.safety.failedToolSignatures.has(fingerprint) && !state.safety.blockedReason) {
            state.safety.blockReasonKind = "no_progress";
            state.safety.blockedReason = "模型收到工具纠错结果后再次提交了语义相同的失败调用，当前 turn 已暂停以避免空转。";
            void state.session.abort();
          } else {
            state.safety.failedToolSignatures.add(fingerprint);
          }
        }
        if (isUsefulToolProgress(toolName, toolInput?.args, event.result, event.isError, state.safety.seenUsefulToolSignatures)) {
          lastDurableProgressAt = this.now().toISOString();
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
        const assistantMessage = event.message as AssistantMessage;
        const usage = assistantMessage.usage;
        const providerTraceData = {
          provider: input.provider,
          model: input.model,
          inputTokens: finiteNonNegative(usage?.input),
          outputTokens: finiteNonNegative(usage?.output),
          totalTokens: finiteNonNegative(usage?.totalTokens),
          costUsd: 0,
          costMeasured: false,
          stopReason: assistantMessage.stopReason,
          ...(assistantMessage.errorMessage ? { errorMessage: assistantMessage.errorMessage } : {}),
        };
        persistEvent(() => this.traces.append({
          traceId: stableId("provider-response", turnId, String(sequence), JSON.stringify(providerTraceData)),
          agentId: input.agent.id,
          threadId: input.threadId,
          goalId: input.goalId,
          turnId,
          kind: "provider_response",
          createdAt: this.now().toISOString(),
          data: providerTraceData,
        }));
        const toolBatch = event.message.content.flatMap((item) => item.type === "toolCall"
          ? [{ name: item.name, arguments: item.arguments }]
          : []);
        if (toolBatch.length > 0) {
          state.safety.lastIdleResponseFingerprint = undefined;
        }
        const content = event.message.content.flatMap((item) => item.type === "text" ? [item.text] : []).join("\n").trim();
        if (content) {
          const fingerprint = createHash("sha256")
            .update(content.replace(/\s+/g, " ").trim())
            .digest("hex");
          if (toolBatch.length === 0) {
            if (state.safety.lastIdleResponseFingerprint === fingerprint && !state.safety.blockedReason) {
              state.safety.blockReasonKind = "no_progress";
              state.safety.blockedReason = "模型连续重复相同的无工具回复且没有提交 Goal 结论，当前 turn 已暂停以避免无进展空转。";
              void state.session.abort();
            }
            state.safety.lastIdleResponseFingerprint = fingerprint;
          }
          lastAssistantResponseFingerprint = fingerprint;
          persistEvent(() => this.engine.appendModelItem({
            itemId: `${turnId}:pi:${sequence}:assistant`, turnId, threadId: input.threadId, goalId: input.goalId,
            content, createdAt: this.now().toISOString(),
          }));
        }
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
    state.resolution.agentId = input.agent.id;
    state.resolution.onProposal = (value) => { proposal = value; };
    state.resolution.mock = input.provider === "mock";
    state.safety.failedToolSignatures.clear();
    state.safety.seenUsefulToolSignatures.clear();
    state.safety.lastToolObservationFingerprint = undefined;
    state.safety.lastIdleResponseFingerprint = undefined;
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
      { hostCorrection: pending?.kind === "correction", evolution: input.profile.capabilities.includes("company:evolve"), extensionTools: state.evolutionToolNames },
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
      // One Agent turn is one Pi prompt plus the tool calls Pi drains for that
      // prompt.  A further model decision is a new scheduled turn on the same
      // Thread/Session/Goal.  Keeping this boundary here prevents a productive
      // but inconclusive tool sequence from becoming an unbounded inner loop.
      for (let promptAttempt = 0; promptAttempt < 2; promptAttempt += 1) {
        await this.trace(turnId, input, "context", {
          sessionId: state.session.sessionId,
          promptChars: prompt.text.length,
          imageCount: prompt.images.length,
          persistent: Boolean(state.session.sessionFile),
          continuation: promptAttempt,
        });
        promptWatchdog = createPiPromptWatchdog(
          this.turnTimeoutMs,
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
          state.session.agent.abort();
          this.sessions.delete(piWorkSessionKey(input.threadId, input.goalId));
          void promptRun.finally(() => state.session.dispose()).catch(() => undefined);
          return this.providerFailure(turnId, input, toolCalls, goal, promptOutcome.message);
        }
        await eventWrites;
        if (rebuildModelContext && !state.safety.blockedReason) {
          await this.rebuildLiveModelContext(input, state);
          rebuildModelContext = false;
        }
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

        const schemaCorrection = latestSchemaCorrection;
        latestSchemaCorrection = undefined;
        if (schemaCorrection && promptAttempt === 0) {
          // A rejected tool call gets one immediate correction prompt.  If the
          // correction is rejected again, the scheduler starts a fresh turn so
          // the normal Agent Engine recovery and human-input rules apply.
          prompt = { text: structuredCorrectionContinuationPrompt(schemaCorrection), images: [] };
          continue;
        }

        await this.engine.appendToolItem({
          itemId: `${turnId}:yielded`,
          turnId,
          threadId: input.threadId,
          goalId: input.goalId,
          kind: "control",
          value: {
            turnId,
            status: "turn_yielded",
            reason: "turn_boundary",
            toolCalls,
            durableProgress: state.safety.seenUsefulToolSignatures.size > 0,
            ...(turnObservationFingerprints.length > 0
              ? { observationFingerprints: [...turnObservationFingerprints] }
              : {}),
            ...(lastDurableProgressAt ? { lastDurableProgressAt } : {}),
            ...(lastAssistantResponseFingerprint ? { idleResponseFingerprint: lastAssistantResponseFingerprint } : {}),
          },
          createdAt: this.now().toISOString(),
        });
        return { turnId, status: "yielded", toolCalls, goal };
      }
      throw new Error("Agent turn boundary did not yield a result");
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
      state.resolution.agentId = undefined;
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
      ...pendingSessions.map((pending) => disposePendingPiSessionPromptly(pending, DEFAULT_SESSION_ABORT_GRACE_MS)),
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

  private async requireSession(input: AgentExecutionSliceInput): Promise<SessionState> {
    const key = piWorkSessionKey(input.threadId, input.goalId);
    const organizationMemorySources = await this.options.organizationMemorySources?.() ?? [];
    const runtimeEvolutionFingerprint = await runtimeEvolutionStateFingerprint(this.workspaceRoot, organizationMemorySources);
    const existing = this.sessions.get(key);
    if (existing) {
      const state = await existing;
      if (state.runtimeEvolutionFingerprint === runtimeEvolutionFingerprint) return state;
      this.sessions.delete(key);
      await abortPiSessionPromptly(state.session, DEFAULT_SESSION_ABORT_GRACE_MS);
    }
    const pending = this.createSession(input, organizationMemorySources, runtimeEvolutionFingerprint);
    this.sessions.set(key, pending);
    return pending;
  }

  private async createSession(
    input: AgentExecutionSliceInput,
    organizationMemorySources: OrganizationMemorySource[],
    runtimeEvolutionFingerprint: string,
  ): Promise<SessionState> {
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
    const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
    const registry = new ModelRegistry(modelRuntime);
    const model = await configureModel(
      registry,
      modelRuntime,
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
    const evolutionProjection = await runtimeEvolutionProjection(
      this.workspaceRoot, input.agent.workspaceId, input.profile, input.agent,
      {
        assignmentKey: `${input.threadId}:${input.goalId ?? "idle"}`,
        taskType: input.taskType,
        tools: input.policy.enabledTools ?? [],
        organizationMemorySources,
      },
    );
    const evolvedSkills = evolutionProjection.skills;
    const evolvedMemories = evolutionProjection.memories;
    const evolvedProfile = evolutionProjection.agentProfiles.find((item) => item.target === input.profile.id)?.profile ?? input.profile;
    const evolvedInput = evolvedProfile === input.profile ? input : { ...input, profile: evolvedProfile };
    const evolvedNames = new Set(evolvedSkills.map((skill) => skill.name));
    const configuredNames = effectiveAgentSkills(evolvedProfile, input.agent).filter((name) => !evolvedNames.has(name));
    const enabledSkillNames = [...new Set([...configuredNames, ...evolvedSkills.map((skill) => skill.name)])];
    const loader = new DefaultResourceLoader({
      cwd: this.workspaceRoot,
      agentDir: input.agent.agentDir,
      settingsManager: settings,
      additionalSkillPaths: [...configuredSkillPaths(this.workspaceRoot, configuredNames), ...evolvedSkills.map((skill) => skill.directory)],
      noExtensions: true,
      noSkills: false,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: stableSystemPrompt(evolvedInput, evolvedMemories, evolutionProjection.prompts),
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
      profile: evolvedProfile,
      agent: input.agent,
      policy: input.policy,
      thread: historyThread,
      goal: sessionGoal,
    });
    await restoreSessionHistory(sessionManager, assembled.history, model, this.workspaceRoot);
    const resolution: ResolutionBinding = { workspaceRoot: this.workspaceRoot };
    const toolExecution: ToolExecutionBinding = {
      agentId: input.agent.id,
      threadId: input.threadId,
    };
    const safety: RunSafetyBinding = {
      failedToolSignatures: new Set(),
      seenUsefulToolSignatures: new Set(),
    };
    const baseTools = [
      ...workspaceTools(this.tools, toolExecution),
      piReadTool(this.tools, skills, toolExecution),
      ...(evolvedProfile.capabilities.includes("company:evolve")
        ? [
            proposeEvolutionCandidateTool(this.workspaceRoot, input.agent.workspaceId, input.agent.id),
            queryEvolutionStatusTool(this.workspaceRoot, input.agent.workspaceId),
          ]
        : []),
      goalTool(
        resolution,
        this.now,
        sessionGoal?.spec.outputContract,
        sessionGoal?.spec.successCriteria.length,
      ),
      staffingTool(resolution, this.now, sessionGoal?.spec.outputContract),
      correctionTool(resolution, this.now, sessionGoal?.spec.outputContract),
      planChangeTool(resolution, this.now, sessionGoal?.spec.outputContract),
      humanInputTool(resolution, this.now),
    ];
    const pluginTools = evolutionPluginTools(evolutionProjection.plugins, this.tools, toolExecution);
    const customTools = withEvolutionHarnesses([...baseTools, ...pluginTools], evolutionProjection.harnesses, this.tools, toolExecution);
    const { session } = await createAgentSession({
      cwd: this.workspaceRoot,
      agentDir: input.agent.agentDir,
      modelRuntime,
      model,
      resourceLoader: loader,
      settingsManager: settings,
      sessionManager,
      noTools: "builtin",
      customTools,
      tools: customTools.map((tool) => tool.name),
      thinkingLevel: input.supportsReasoning ? (input.thinkingLevel ?? "medium") : "off",
    });
    installPiTurnBoundary(session.agent);
    session.setAutoCompactionEnabled(true);
    const goalVersions = promptedGoalVersions(sessionManager.getEntries());
    const inheritanceTraceId = piSessionSkillsTraceId(
        input.threadId,
        input.goalId,
        input.turnId,
        skillNames,
      );
    const inheritanceTurnId = input.turnId ?? stableId("turn", input.threadId, "session-resources");
    await this.traces.append({
      traceId: inheritanceTraceId,
      agentId: input.agent.id,
      threadId: input.threadId,
      goalId: input.goalId,
      turnId: inheritanceTurnId,
      kind: "context",
      createdAt: this.now().toISOString(),
      data: {
        enabledSkills: skillNames, diagnostics: loader.getSkills().diagnostics,
        evolutionReleases: evolvedSkills.map((skill) => ({ name: skill.name, releaseId: skill.releaseId, releaseVersion: skill.releaseVersion, contentHash: skill.contentHash, generation: skill.generation, stage: skill.stage })),
        evolutionMemories: evolvedMemories.map((memory) => ({ target: memory.target, releaseId: memory.releaseId, releaseVersion: memory.releaseVersion, contentHash: memory.contentHash, generation: memory.generation, stage: memory.stage })),
        evolutionPlugins: evolutionProjection.plugins.map((plugin) => ({ name: plugin.name, releaseId: plugin.releaseId, releaseVersion: plugin.releaseVersion, contentHash: plugin.contentHash, generation: plugin.generation, stage: plugin.stage, tools: plugin.manifest.contributions.tools.map((tool) => pluginToolName(plugin.name, tool.name)) })),
        evolutionHarnesses: evolutionProjection.harnesses.map((harness) => ({ name: harness.name, releaseId: harness.releaseId, releaseVersion: harness.releaseVersion, contentHash: harness.contentHash, generation: harness.generation, stage: harness.stage, guardrails: harness.manifest.contributions.guardrails.map((guard) => guard.name) })),
        evolutionPrompts: evolutionProjection.prompts.map((prompt) => ({ target: prompt.target, releaseId: prompt.releaseId, releaseVersion: prompt.releaseVersion, contentHash: prompt.contentHash, generation: prompt.generation, stage: prompt.stage })),
        evolutionAgentProfiles: evolutionProjection.agentProfiles.map((item) => ({ target: item.target, releaseId: item.releaseId, releaseVersion: item.releaseVersion, contentHash: item.contentHash, generation: item.generation, stage: item.stage })),
        evolutionCanaries: evolutionProjection.canaryReleases,
        evolutionCanaryAssignments: evolutionProjection.canaryAssignments,
        evolutionOrganizationConflicts: evolutionProjection.organizationConflicts,
      },
    });
    const activationStore = new EvolutionActivationStore(this.workspaceRoot, this.now);
    const traceRef = { kind: "trace" as const, ref: inheritanceTraceId, workspaceId: input.agent.workspaceId, agentId: input.agent.id };
    await Promise.all([
      ...evolvedSkills.map((skill) => activationStore.observe({
        assetKind: "skill", target: skill.name,
        releaseRef: { id: skill.releaseId, version: skill.releaseVersion, contentHash: skill.contentHash },
        desiredGeneration: skill.generation, actualGeneration: skill.generation,
        runtimeKind: "turn", runtimeRef: inheritanceTurnId, runtimeSnapshotHash: runtimeEvolutionFingerprint, traceRef,
      })),
      ...evolvedMemories.filter((memory) => !memory.sourceWorkspaceId).map((memory) => activationStore.observe({
        assetKind: "memory", target: memory.target,
        releaseRef: { id: memory.releaseId, version: memory.releaseVersion, contentHash: memory.contentHash },
        desiredGeneration: memory.generation, actualGeneration: memory.generation,
        runtimeKind: "turn", runtimeRef: inheritanceTurnId, runtimeSnapshotHash: runtimeEvolutionFingerprint, traceRef,
      })),
      ...evolutionProjection.plugins.map((plugin) => activationStore.observe({
        assetKind: "plugin", target: plugin.name,
        releaseRef: { id: plugin.releaseId, version: plugin.releaseVersion, contentHash: plugin.contentHash },
        desiredGeneration: plugin.generation, actualGeneration: plugin.generation,
        runtimeKind: "session", runtimeRef: session.sessionId, runtimeSnapshotHash: runtimeEvolutionFingerprint, traceRef,
      })),
      ...evolutionProjection.harnesses.map((harness) => activationStore.observe({
        assetKind: "harness", target: harness.name,
        releaseRef: { id: harness.releaseId, version: harness.releaseVersion, contentHash: harness.contentHash },
        desiredGeneration: harness.generation, actualGeneration: harness.generation,
        runtimeKind: "session", runtimeRef: session.sessionId, runtimeSnapshotHash: runtimeEvolutionFingerprint, traceRef,
      })),
      ...evolutionProjection.prompts.map((prompt) => activationStore.observe({
        assetKind: "prompt", target: prompt.target,
        releaseRef: { id: prompt.releaseId, version: prompt.releaseVersion, contentHash: prompt.contentHash },
        desiredGeneration: prompt.generation, actualGeneration: prompt.generation,
        runtimeKind: "turn", runtimeRef: inheritanceTurnId, runtimeSnapshotHash: runtimeEvolutionFingerprint, traceRef,
      })),
      ...evolutionProjection.agentProfiles.map((item) => activationStore.observe({
        assetKind: "agent_profile", target: item.target,
        releaseRef: { id: item.releaseId, version: item.releaseVersion, contentHash: item.contentHash },
        desiredGeneration: item.generation, actualGeneration: item.generation,
        runtimeKind: "session", runtimeRef: session.sessionId, runtimeSnapshotHash: runtimeEvolutionFingerprint, traceRef,
      })),
    ]);
    return { session, goalVersions, resolution, toolExecution, safety, runtimeEvolutionFingerprint, evolutionToolNames: pluginTools.map((tool) => tool.name) };
  }

  private async rebuildLiveModelContext(
    input: AgentExecutionSliceInput,
    state: SessionState,
  ): Promise<void> {
    const thread = await this.engine.getThread(input.threadId);
    const goal = input.goalId ? await this.engine.getGoal(input.goalId) : undefined;
    const assembled = await this.contextAssembler.assemble({
      profile: input.profile,
      agent: input.agent,
      policy: input.policy,
      thread,
      goal,
    });
    const modelContext = SessionManager.inMemory(this.workspaceRoot);
    await restoreSessionHistory(
      modelContext,
      assembled.history,
      state.session.agent.state.model,
      this.workspaceRoot,
    );
    replaceLivePiModelContext(state.session.agent, modelContext);
    await this.trace(input.turnId ?? stableId("context-rebuild", input.threadId), input, "context", {
      sessionId: state.session.sessionId,
      reason: "schema_validation_recovery",
      modelHistoryRebuilt: true,
      threadItems: thread.items.length,
      projectedItems: assembled.history.length,
      rejectedArgumentsReplayed: false,
    });
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
    if (pending?.kind === "correction") {
      return [
        "## Host contract correction",
        pending.content,
        "This is an internal contract correction in the current Goal, not missing external input.",
        "Do not repeat the previous tool call verbatim. Rebuild the complete proposal from the current Goal and facts, change the reported structural violation, and resubmit it.",
        "Human-input tools are not available in this turn.",
      ].join("\n");
    }
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

function proposeEvolutionCandidateTool(workspaceRoot: string, workspaceId: string, agentId: string): ToolDefinition {
  return defineTool({
    name: "propose_evolution_candidate",
    label: "提出公司进化候选",
    description: "基于当前 Goal 中可引用的真实 Trace、Evidence、Ticket 或人工反馈，提出一个待独立评测的 Skill、Prompt、Agent Profile 或可选扩展候选。此工具只保存版本化变更，不代表验证、批准或后续 Runtime 已继承。",
    parameters: Type.Object({
      kind: Type.Optional(Type.Union([Type.Literal("skill"), Type.Literal("prompt"), Type.Literal("agent_profile"), Type.Literal("workflow"), Type.Literal("source_patch"), Type.Literal("plugin"), Type.Literal("harness")])),
      target: Type.String({ description: "候选名称，例如 incident-retrospective" }),
      title: Type.String(),
      rationale: Type.String({ description: "从引用事实中观察到的重复失败、低效或能力缺口" }),
      hypothesis: Type.String({ description: "候选将如何改善可观察指标，必须可被评测否证" }),
      artifactContent: Type.String({ description: "Skill 使用完整 SKILL.md；Prompt 使用完整片段；Agent Profile/Workflow 使用受限 schemaVersion 1 JSON；Plugin/Harness 使用 autoagent.plugin/v1 JSON Bundle" }),
      sourceRefs: Type.Array(Type.Object({
        kind: Type.Union([Type.Literal("trace"), Type.Literal("evidence"), Type.Literal("goal_proposal"), Type.Literal("goal_decision"), Type.Literal("ticket"), Type.Literal("mission"), Type.Literal("human_feedback")]),
        ref: Type.String(),
      }), { minItems: 1, maxItems: 32 }),
      expectedMetrics: Type.Array(Type.Object({
        metric: Type.String(),
        direction: Type.Union([Type.Literal("increase"), Type.Literal("decrease"), Type.Literal("maintain")]),
        minimumDelta: Type.Optional(Type.Number()),
        maximumRegression: Type.Optional(Type.Number()),
      }), { minItems: 1, maxItems: 16 }),
      riskLevel: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("critical")]),
      roles: Type.Optional(Type.Array(Type.String(), { maxItems: 16 })),
      taskTypes: Type.Optional(Type.Array(Type.String(), { maxItems: 16 })),
      tools: Type.Optional(Type.Array(Type.String(), { maxItems: 16 })),
    }),
    async execute(_callId, params) {
      const store = new EvolutionStore(workspaceId, workspaceRoot);
      const candidate = await store.create({
        commandId: createHash("sha256").update(JSON.stringify({ agentId, ...params })).digest("hex"),
        kind: params.kind ?? "skill",
        target: params.target,
        title: params.title,
        rationale: params.rationale,
        hypothesis: params.hypothesis,
        artifactContent: params.artifactContent,
        sourceRefs: params.sourceRefs.map((ref) => ({ ...ref, workspaceId, agentId })),
        scope: { workspaceId, ...(params.roles ? { roles: params.roles } : {}), ...(params.taskTypes ? { taskTypes: params.taskTypes } : {}), ...(params.tools ? { tools: params.tools } : {}) },
        expectedMetrics: params.expectedMetrics,
        riskLevel: params.riskLevel,
        proposedBy: { type: "agent", id: agentId },
      });
      return {
        content: [{ type: "text", text: JSON.stringify({ proposed: true, candidateId: candidate.candidateId, revision: candidate.revision, status: candidate.status, productionChanged: false }) }],
        details: { candidate },
      };
    },
  });
}

function queryEvolutionStatusTool(workspaceRoot: string, workspaceId: string): ToolDefinition {
  return defineTool({
    name: "query_evolution_status",
    label: "查询公司进化状态",
    description: "只读查询候选、独立评测和分级发布状态。该工具不能验证、评分、晋升或回滚任何候选。",
    parameters: Type.Object({ candidateId: Type.Optional(Type.String()) }),
    async execute(_callId, params) {
      const candidates = new EvolutionStore(workspaceId, workspaceRoot);
      const evaluations = new EvolutionEvaluationStore(workspaceId, workspaceRoot, candidates);
      const selected = params.candidateId ? [await candidates.get(params.candidateId)] : (await candidates.list()).slice(-20);
      const promotionRecords = await evaluations.listPromotions();
      const result = await Promise.all(selected.map(async (candidate) => ({
        candidateId: candidate.candidateId, revision: candidate.revision, kind: candidate.kind, target: candidate.target,
        contentHash: candidate.contentHash, status: candidate.status,
        evaluations: (await evaluations.listEvaluations(candidate.candidateId)).map((run) => ({ evaluationId: run.evaluationId, decision: run.decision, createdAt: run.createdAt })),
        promotions: promotionRecords.filter((record) => record.candidateId === candidate.candidateId).map((record) => ({
          promotionId: record.promotionId, stage: record.stage, status: record.status, release: record.toRelease,
        })),
      })));
      return { content: [{ type: "text", text: JSON.stringify({ candidates: result }) }], details: { candidates: result } };
    },
  });
}

function evolutionPluginTools(
  plugins: RuntimeEvolutionExtension[],
  tools: AgentToolRuntime,
  binding: ToolExecutionBinding,
): ToolDefinition[] {
  const names = new Set<string>();
  const definitions: ToolDefinition[] = [];
  for (const plugin of plugins) {
    for (const contribution of plugin.manifest.contributions.tools) {
      const name = pluginToolName(plugin.name, contribution.name);
      if (names.has(name)) throw new Error(`Evolution plugin tool collision: ${name}`);
      names.add(name);
      definitions.push(defineTool({
        name,
        label: `${plugin.name}: ${contribution.name}`,
        description: contribution.description,
        parameters: Type.Unsafe<Record<string, unknown>>(contribution.inputSchema),
        executionMode: "sequential",
        async execute(callId, params) {
          const host = new IsolatedPluginHost(plugin, tools, binding);
          const result = await host.invokeTool(contribution.name, params, callId);
          return {
            content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }],
            details: { plugin: plugin.name, releaseId: plugin.releaseId, result },
          };
        },
      }));
    }
  }
  return definitions;
}

export function withEvolutionHarnesses(
  definitions: ToolDefinition[],
  harnesses: RuntimeEvolutionExtension[],
  tools: AgentToolRuntime,
  binding: ToolExecutionBinding,
): ToolDefinition[] {
  const names = new Set<string>();
  for (const definition of definitions) {
    if (names.has(definition.name)) throw new Error(`Runtime tool collision while mounting evolution extensions: ${definition.name}`);
    names.add(definition.name);
  }
  if (!harnesses.length) return definitions;
  return definitions.map((definition) => {
    const guards = harnesses.flatMap((harness) => harness.manifest.contributions.guardrails
      .filter((guard) => guard.tools.includes("*") || guard.tools.includes(definition.name))
      .map((guard) => ({ harness, guard })));
    if (!guards.length) return definition;
    return {
      ...definition,
      async execute(callId, params, signal, onUpdate, context) {
        for (const { harness, guard } of guards.filter((item) => item.guard.phase === "pre_tool")) {
          const decision = await new IsolatedPluginHost(harness, tools, binding).guard(guard, definition.name, params, undefined, `${callId}:pre:${guard.name}`);
          if (decision.behavior === "reject") return harnessRejection(harness, guard.name, definition.name, decision.message);
        }
        const output = await definition.execute(callId, params, signal, onUpdate, context);
        for (const { harness, guard } of guards.filter((item) => item.guard.phase === "post_tool")) {
          const decision = await new IsolatedPluginHost(harness, tools, binding).guard(guard, definition.name, params, output, `${callId}:post:${guard.name}`);
          if (decision.behavior === "reject") return harnessRejection(harness, guard.name, definition.name, decision.message);
        }
        return output;
      },
    };
  });
}

function harnessRejection(harness: RuntimeEvolutionExtension, guardrail: string, tool: string, message?: string) {
  const reason = message ?? `Evolution harness ${harness.name} rejected ${tool}`;
  return {
    content: [{ type: "text" as const, text: reason }],
    details: { ok: false, rejected: true, harness: harness.name, releaseId: harness.releaseId, guardrail, tool, reason },
  };
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

interface PiPromptWatchdog {
  timeout: Promise<string>;
  touch(): void;
  dispose(): void;
}

export function createPiPromptWatchdog(
  turnTimeoutMs: number,
  inactivityMs: number,
  abort: () => void | Promise<void>,
): PiPromptWatchdog {
  let inactivityTimer: NodeJS.Timeout | undefined;
  let turnTimer: NodeJS.Timeout | undefined;
  let settled = false;
  let resolveTimeout!: (message: string) => void;
  const timeout = new Promise<string>((resolve) => {
    resolveTimeout = resolve;
  });
  const arm = () => {
    if (settled) return;
    if (inactivityTimer) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolveTimeout(`Provider turn produced no events for ${inactivityMs}ms (inactivity timeout)`);
      void Promise.resolve(abort()).catch(() => undefined);
    }, inactivityMs);
    inactivityTimer.unref?.();
  };
  turnTimer = setTimeout(() => {
    if (settled) return;
    settled = true;
    resolveTimeout(`Provider turn exceeded ${turnTimeoutMs}ms (turn timeout)`);
    void Promise.resolve(abort()).catch(() => undefined);
  }, turnTimeoutMs);
  turnTimer.unref?.();
  arm();
  return {
    timeout,
    touch: arm,
    dispose() {
      settled = true;
      if (inactivityTimer) clearTimeout(inactivityTimer);
      if (turnTimer) clearTimeout(turnTimer);
      inactivityTimer = undefined;
      turnTimer = undefined;
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
    "普通文本回复、思考内容或一次 turn 结束都不代表 Goal 已完成。完成或失败必须调用 goal_resolution；不要把 JSON 结论写成普通文本来代替终结工具调用。",
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
    "普通文本回复、思考内容或一次 turn 结束都不代表 Goal 已完成。完成或失败必须调用 goal_resolution；不要把 JSON 结论写成普通文本来代替终结工具调用。",
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
  const pending = nextAgentInboxInput(projectAgentInbox(thread, payloads), { humanOnly, earliest, goalId });
  return pending?.kind === "message"
    ? { kind: "message", itemId: pending.itemId, turnId: pending.turnId, content: pending.content }
    : pending?.kind === "correction"
      ? { kind: "correction", itemId: pending.itemId, content: pending.content }
      : undefined;
}

async function isConsumedThreadMessage(
  thread: Awaited<ReturnType<AgentEngine<any>["getThread"]>>,
  store: AgentStore,
  messageId: string,
): Promise<boolean> {
  const index = thread.items.findIndex((item) => item.itemId === messageId);
  if (index < 0) return false;
  const payloads = await store.payloads(thread.items.map((candidate) => candidate.payloadRef));
  return isAgentInboxMessageConsumed(projectAgentInbox(thread, payloads), messageId);
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

function workspaceTools(runtime: AgentToolRuntime, binding: ToolExecutionBinding): ToolDefinition[] {
  return runtime.definitions().map((definition) => defineTool({
    name: definition.name,
    label: definition.name,
    description: definition.description,
    executionMode: workspaceToolExecutionMode(definition.name as WorkspaceToolName),
    parameters: Type.Unsafe(definition.inputSchema),
    async execute(callId, params) {
      const result = await runtime.execute(
        { tool: definition.name as WorkspaceToolName, ...(params as Omit<AgentToolIntent, "tool">) },
        toolExecutionContext(binding, callId),
      );
      if (!result.ok && typeof result.failureKind === "string") {
        throw new Error(failureMessage(result));
      }
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

const SEQUENTIAL_WORKSPACE_TOOLS = new Set<WorkspaceToolName>([
  "writeFile",
  "editFile",
  "shell",
  "startService",
  "pollProcess",
  "browser",
]);

export function workspaceToolExecutionMode(
  tool: WorkspaceToolName,
): "parallel" | "sequential" {
  return SEQUENTIAL_WORKSPACE_TOOLS.has(tool) ? "sequential" : "parallel";
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
  options: { hostCorrection?: boolean; evolution?: boolean; extensionTools?: string[] } = {},
): string[] {
  const hasGoal = Boolean(outputContractOrHasGoal);
  const outputContract = typeof outputContractOrHasGoal === "object"
    ? outputContractOrHasGoal
    : undefined;
  const staffing = outputContract?.schemaRef === TEAM_STAFFING_SCHEMA_REF;
  return [...new Set([
    "read",
    ...workspaceToolNames.filter((name) => name !== "readImage" || supportsImages),
    ...(options.extensionTools ?? []),
    ...(options.evolution ? ["propose_evolution_candidate", "query_evolution_status"] : []),
    ...(hasGoal ? [
      staffing ? "staff_project" : "goal_resolution",
      ...(outputContract?.correctionOutcomeSchema ? ["report_goal_correction"] : []),
      ...(outputContract?.planChangeOutcomeSchema ? ["request_goal_plan_change"] : []),
      ...(options.hostCorrection ? [] : ["request_human_input"]),
    ] : []),
  ])];
}

function staffingTool(
  binding: ResolutionBinding,
  now: () => Date,
  outputContract?: AgentGoal["spec"]["outputContract"],
): ToolDefinition {
  return defineTool({
    name: "staff_project",
    label: "组建项目团队",
    description: [
      "组织工具：按 profileId 将人才池成员实例化到当前项目，并以所选成员启动 Mission。",
      "status=staffed 只表示所选团队能够对当前 Mission 的完整交付负责，不只是完成接收或计划。",
      "每个成员必须提交 capabilityCoverage，说明其为当前 Mission 覆盖的档案能力；平台只校验这些能力确实属于该人才档案。",
      "现有人才不足时提交 recruitment_required 及缺少的能力；不要用只有管理能力的 staffed 提案代替完整团队。",
      "平台只执行和校验结构化事实，不替负责人判断目标需要哪些业务能力。",
    ].join(""),
    parameters: Type.Unsafe(outputContract?.completionOutcomeSchema ?? {
      type: "object",
      properties: {},
    }),
    async execute(_callId, params) {
      if (outputContract?.schemaRef !== TEAM_STAFFING_SCHEMA_REF) {
        throw new Error("当前 Goal 不是组队任务");
      }
      const outcome = parseTeamStaffingOutcome(params);
      return submitResolution(binding, now, {
        status: "completed",
        summary: outcome.status === "staffed"
          ? `已选择 ${outcome.members.length} 名项目成员`
          : `发现 ${outcome.recruitmentRequests.length} 个人才缺口`,
        criterionResults: binding.goal?.spec.successCriteria.map((_criterion, criterionIndex) => ({
          criterionIndex,
          status: "satisfied",
          evidence: [],
        })) ?? [],
        residualRisks: [],
        domainOutcome: outcome,
      }, "staff_project");
    },
  });
}

function goalTool(
  binding: ResolutionBinding,
  now: () => Date,
  outputContract?: AgentGoal["spec"]["outputContract"],
  goalCriterionCount?: number,
): ToolDefinition {
  const finalSettlement = outputContract?.evidenceMode === "none";
  const allowsFailure = outputContract?.allowFailedResolution !== false;
  return defineTool({
    name: "goal_resolution",
    label: "提交工作结论",
    description: allowsFailure
      ? `提交当前 Goal 的正常完成或失败结论。填写 status、summary、residualRisks、Ticket 的 domainOutcome，以及精炼的 evidenceIds（只选择直接支持最终结论的当前 Goal 工具证据，不要包含调试过程或临时产物）；平台会逐项生成当前 Ticket 的 criterionResults。不要手写 criterionIndex 或顶层 criterionResults。若需要纠正上游请调用 report_goal_correction，若计划本身不足请调用 request_goal_plan_change。`
      : "只提交当前验收 Goal 的正常完成结论。验收未通过不得使用普通 failed：上游缺陷调用 report_goal_correction，计划缺口调用 request_goal_plan_change，不可替代的外部输入调用 request_human_input。",
    parameters: Type.Object({
      status: allowsFailure
        ? Type.Union([Type.Literal("completed"), Type.Literal("failed")])
        : Type.Literal("completed"),
      summary: Type.Optional(Type.String()),
      residualRisks: Type.Optional(Type.Array(Type.String())),
      evidenceIds: finalSettlement
        ? Type.Optional(Type.Array(Type.String(), { maxItems: 0 }))
        : Type.Optional(Type.Array(Type.String(), { maxItems: 32 })),
      // Keep the domain result opaque at the provider boundary. The domain
      // adapter validates outputContract.schemaRef after this generic proposal
      // is persisted; a deep business schema here makes provider tool-call
      // boundaries compete with the domain contract and blocks correction.
      ...(outputContract
        ? { domainOutcome: goalResolutionTransportDomainOutcomeSchema(outputContract) }
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
      const availableEvidence = finalSettlement || !binding.agentId
        ? []
        : (await new EvidenceLedger(binding.workspaceRoot).listForGoal({
            agentId: binding.agentId,
            goalId: binding.goal.spec.id,
            attemptId: binding.goal.spec.attemptId,
          }))
            .filter((fact) => fact.capture.status === "recorded" && fact.observation.status === "observed")
            .map((fact) => ({ evidenceId: fact.evidenceId }));
      const requestedEvidenceIds = Array.isArray(normalizedParams.evidenceIds)
        ? normalizedParams.evidenceIds
        : undefined;
      const evidence = requestedEvidenceIds
        ? selectResolutionEvidence(availableEvidence, requestedEvidenceIds)
        : availableEvidence;
      const { evidenceIds: _evidenceIds, ...proposalParams } = normalizedParams;
      const submitted = binding.mock
        ? {
            ...proposalParams,
            evidence,
            criterionResults: binding.goal.spec.successCriteria.map((_criterion, criterionIndex) => ({
              criterionIndex,
              status: "satisfied" as const,
              evidence,
            })),
          }
        : { ...proposalParams, evidence };
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

export function selectResolutionEvidence(
  available: ReadonlyArray<{ evidenceId: string }>,
  requestedIds: ReadonlyArray<unknown>,
): Array<{ evidenceId: string }> {
  const availableIds = new Set(available.map((item) => item.evidenceId));
  return [...new Set(requestedIds)]
    .filter((evidenceId): evidenceId is string => typeof evidenceId === "string" && availableIds.has(evidenceId))
    .map((evidenceId) => ({ evidenceId }));
}

export function goalResolutionCriterionResultsSchema(
  finalSettlement: boolean,
  goalCriterionCount?: number,
) {
  const evidenceItems = Type.Array(Type.Object({ evidenceId: Type.String() }), finalSettlement ? { maxItems: 0 } : {});
  const criterionOptions = typeof goalCriterionCount === "number"
    ? { minItems: goalCriterionCount, maxItems: goalCriterionCount }
    : {};
  return Type.Array(Type.Object({
    criterionIndex: Type.Integer({
      minimum: 0,
      ...(typeof goalCriterionCount === "number" && goalCriterionCount > 0
        ? { maximum: goalCriterionCount - 1 }
        : {}),
    }),
    status: Type.Union([Type.Literal("satisfied"), Type.Literal("not_satisfied"), Type.Literal("not_verified")]),
    evidence: evidenceItems,
    note: Type.Optional(Type.String()),
  }), criterionOptions);
}

export function goalResolutionDomainOutcomeSchema(
  outputContract?: AgentGoal["spec"]["outputContract"],
) {
  return outputContract?.completionOutcomeSchema
    ? Type.Unsafe(outputContract.completionOutcomeSchema)
    : Type.Unknown();
}

export function goalResolutionTransportDomainOutcomeSchema(
  outputContract?: AgentGoal["spec"]["outputContract"],
) {
  // Keep the provider boundary structural, not domain-semantic. The domain
  // adapter remains the authority for field names and business meaning, while
  // the model still needs to know that a nested collection contains objects.
  // Without this shallow envelope, providers can serialize an object list as
  // strings and the same rejected proposal is often repeated verbatim.
  const schema = outputContract?.completionOutcomeSchema;
  return schema ? Type.Unsafe(shallowTransportSchema(schema)) : Type.Unknown();
}

function shallowTransportSchema(schema: Record<string, unknown>, objectDepth = 0): Record<string, unknown> {
  const type = typeof schema.type === "string" ? schema.type : undefined;
  if (type === "object" || schema.properties) {
    const properties = isRecord(schema.properties)
      ? Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => [
        key,
        isRecord(value) ? shallowTransportSchema(value, objectDepth + 1) : { type: ["string", "number", "boolean", "object", "array"] },
      ]))
      : undefined;
    // At the item level keep arbitrary fields. Required domain fields are
    // checked only after persistence by the domain adapter.
    if (objectDepth >= 2 || !properties) {
      return { type: "object", additionalProperties: true };
    }
    const required = Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === "string" && Object.prototype.hasOwnProperty.call(properties, item))
      : undefined;
    return {
      type: "object",
      properties,
      ...(required?.length ? { required } : {}),
      additionalProperties: true,
    };
  }
  if (type === "array") {
    const items = isRecord(schema.items) ? shallowTransportSchema(schema.items, objectDepth) : { type: ["string", "number", "boolean", "object", "array"] };
    return { type: "array", items };
  }
  if (type === "string" || type === "number" || type === "integer" || type === "boolean" || type === "null") {
    return { type };
  }
  const union = Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : undefined;
  if (union) {
    const variants = union
      .filter(isRecord)
      .map((item: Record<string, unknown>) => shallowTransportSchema(item, objectDepth));
    return variants.length ? { anyOf: variants } : { type: ["string", "number", "boolean", "object", "array", "null"] };
  }
  return { type: ["string", "number", "boolean", "object", "array", "null"] };
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

async function submitWorkflowAction(
  binding: ResolutionBinding,
  now: () => Date,
  toolName: string,
  reason: string,
  domainOutcome: Record<string, unknown>,
): Promise<ReturnType<typeof submitResolution>> {
  const criterionResults = binding.goal?.spec.successCriteria.map((_criterion, criterionIndex) => ({
    criterionIndex,
    status: "not_verified" as const,
    evidence: [],
    note: reason,
  })) ?? [];
  const evidence = !binding.goal || !binding.agentId
    ? []
    : (await new EvidenceLedger(binding.workspaceRoot).listForGoal({
        agentId: binding.agentId,
        goalId: binding.goal.spec.id,
        attemptId: binding.goal.spec.attemptId,
      }))
        .filter((fact) => fact.capture.status === "recorded" && fact.observation.status === "observed")
        .map((fact) => ({ evidenceId: fact.evidenceId }));
  return submitResolution(binding, now, {
    status: "completed",
    summary: reason,
    evidence,
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
  modelRuntime: ModelRuntime,
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
  if (!config.apiKey) throw new ProviderError(`${provider} 未配置 API Key`, false, `MISSING_${provider.toUpperCase()}_API_KEY`);
  await modelRuntime.setRuntimeApiKey(provider, config.apiKey);
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
        const instructions = context.systemPrompt ?? "";
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

export function replaceLivePiModelContext(
  agent: AgentSession["agent"],
  modelContext: Pick<SessionManager, "buildSessionContext">,
): void {
  agent.clearAllQueues();
  agent.state.messages = modelContext.buildSessionContext().messages;
}

/**
 * Keep Pi's internal loop at one tool batch per platform turn.
 *
 * Pi exposes this as a runtime termination hint: every finalized tool result
 * in the current batch must carry `terminate: true`, then the low-level loop
 * emits `agent_end` without starting another provider request. Mission
 * Control can schedule the next turn with the same Goal/Session after the
 * durable tool result has been recorded.
 */
export function installPiTurnBoundary(agent: AgentSession["agent"]): void {
  const previousAfterToolCall = agent.afterToolCall;
  agent.afterToolCall = async (context, signal) => {
    const previous = await previousAfterToolCall?.(context, signal);
    return { ...previous, terminate: true };
  };
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
    const validation = text.slice(0, receivedArguments).trim();
    return `${validation}\n\n${schemaValidationRecoveryHint(validation)}\n[Rejected arguments omitted from model context; full call remains in the audit trace.]`;
  }
  const maxErrorChars = 8_000;
  return text.length <= maxErrorChars
    ? text
    : `${text.slice(0, maxErrorChars)}\n...[tool error truncated before model context]`;
}

function isSchemaValidationToolFailure(result: unknown): boolean {
  return toolResultText(result).startsWith("Validation failed for tool ");
}

function structuredCorrectionContinuationPrompt(correction: string): string {
  return [
    "## Host contract correction",
    correction,
    "这是当前 Goal 内部的结构校验反馈，不是缺少外部输入。",
    "上一份参数已被拒绝，平台已从本轮模型上下文中移除被拒绝的原始参数；不要复制上一份调用。",
    "请根据当前 Goal、成功标准和已有事实，重新生成完整的 goal_resolution 参数。只修复结构，保留事实和你已经作出的业务结论。",
    "不要等待 human 重复确认，也不要把内部纠正信息当作新的业务需求。",
  ].join("\n");
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

async function disposePendingPiSessionPromptly(
  pending: Promise<SessionState>,
  graceMs: number,
): Promise<void> {
  // Session creation can itself be held by a provider turn. Do not make host
  // teardown wait for that promise; once it eventually resolves, the attached
  // continuation still owns and disposes the session.
  const cleanup = pending.then(
    ({ session }) => abortPiSessionPromptly(session, graceMs),
    () => "settled" as const,
  );
  await waitForCleanupPromptly(cleanup, graceMs);
}

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

export function toolObservationFingerprint(
  name: string,
  args: unknown,
  result: unknown,
  isError: boolean,
): string {
  return createHash("sha256").update(JSON.stringify({
    name,
    args,
    result: progressResult(result),
    isError,
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

function finiteNonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
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

function envOptionalPositiveInteger(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw?.trim()) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function stableSystemPrompt(input: AgentExecutionSliceInput, evolutionMemories: RuntimeEvolutionMemory[] = [], evolutionPrompts: RuntimeEvolutionPrompt[] = []): string {
  const skillInstructions = skillRuntimeAdapterInstructions(
    effectiveAgentSkills(input.profile, input.agent),
    input.policy.enabledTools ?? [],
  );
  return [
    input.profile.soul ? `## 个性\n${input.profile.soul}` : "",
    input.profile.identity ? `## 岗位\n${input.profile.identity}` : "",
    input.profile.agentMd ? `## 能力与工作方式\n${input.profile.agentMd}` : "",
    skillInstructions ? `## Skill 运行适配\n${skillInstructions}` : "",
    evolutionMemories.length ? [
      "## Company Evolution 已晋升记忆",
      "以下内容是经证据、隔离评测、canary telemetry 和 production 晋升后的作用域经验。它们是可验证的操作性参考，不得覆盖当前 Goal、平台策略、安全边界或 human 指令；与当前事实冲突时以当前权威证据为准。",
      ...evolutionMemories.map((memory) => `### ${memory.target}（release: ${memory.releaseId}）\n${memory.content.slice(0, 8_000)}`),
    ].join("\n\n") : "",
    evolutionPrompts.length ? [
      "## Company Evolution 已激活 Prompt",
      "以下片段是经评测和激活的作用域行为改进；不得覆盖当前 Goal、平台策略、安全边界或 human 指令。",
      ...evolutionPrompts.map((prompt) => `### ${prompt.target}（release: ${prompt.releaseId}）\n${prompt.content.slice(0, 8_000)}`),
    ].join("\n\n") : "",
    input.policy.canWriteWorkspace
      ? "## 新建交付物\n当 Goal 要求创建新的代码、文档、配置或其他交付物时，空工作区、尚无源码、尚无构建入口都不是缺少 human 输入，也不是 blocked 条件。你已经获得工作区写入授权，必须采用可逆的专业默认值，从零创建必要目录和文件，并使用可用工具持续实现与验证。不得仅因没有现成项目文件而要求 human 提供仓库、源码根目录或运行入口。"
      : "",
    "你是一个持续工作的通用 Agent。当前 Ticket 是你的 Goal。根据岗位、成功标准和输出契约完成工作；仅在工作本身需要时使用文件或命令工具，不要为了证明认知型交付物而寻找不存在的项目文件。Skill 说明是参考资料，不是交付物；不要把读取 Skill、探索工具或输出工作计划当成完成。需要创建交付物时，先用最少必要的工作区观察确认现状，空目录或入口缺失时直接创建可逆的最小实现；只有当前成功标准要求时才继续加载并执行 Skill 验证。正常完成或失败时调用 goal_resolution；发现上游交付需要纠正时调用 report_goal_correction；当前 Plan 无法支撑目标时调用 request_goal_plan_change；缺少不可替代的 human 输入时调用 request_human_input。evidenceId 只能引用本 Goal 工具调用真实返回的 ID，或 Host 在当前 Goal 中明确注入的继承证据 ID；没有证据时使用空数组。工具调用只是向 Host 提交提案，Ticket 和 Plan 状态仍由 Host 校验并提交。不要寻找或写入另一个提交文件、接口或平台内部状态，普通回复也不代表 Goal 完成。",
  ].filter(Boolean).join("\n\n");
}

function safeKey(value: string): string { return createHash("sha256").update(value).digest("base64url"); }
function stableId(prefix: string, ...parts: string[]): string { return `${prefix}_${createHash("sha256").update(JSON.stringify(parts)).digest("base64url")}`; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
