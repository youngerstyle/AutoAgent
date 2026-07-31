import { createHash } from "node:crypto";
import type {
  AgentEvent,
  AgentEventPage,
  AgentEventQuery,
  AgentGoal,
  AgentGoalControlRequest,
  AgentPort,
  AgentThreadItemKind,
  AgentThreadSnapshot,
  EnsureAgentThreadRequest,
  GoalResolutionAttemptResult,
  GoalResolutionDecision,
  GoalResolutionPort,
  GoalResolutionProposal,
  GoalResolutionStatus,
  SendAgentMessageRequest,
  SettleProposalRequest,
  SettleProposalResult,
  StartAgentGoalRequest,
} from "../../shared/contracts/agent-engine.js";
import {
  AgentStore,
} from "./agent-store.js";
import type { AgentStoreAggregate } from "./agent-store.js";
import type { AgentModelHistoryItem } from "../providers/types.js";
import {
  AgentGoalTransitionError,
  beginGoalResolution,
  controlGoalState,
  settleGoalState,
} from "./goal-state.js";

export class AgentEngineConflictError extends Error {}

export interface AgentOutputContractValidator {
  validate(schemaRef: string, value: unknown): { valid: true } | { valid: false; reason: string };
}

export class AcceptingGoalResolutionPort implements GoalResolutionPort {
  constructor(private readonly validator?: AgentOutputContractValidator) {}

  async resolve<TStatus extends GoalResolutionStatus>(
    _goal: AgentGoal,
    proposal: GoalResolutionProposal<TStatus>,
  ): Promise<GoalResolutionAttemptResult<TStatus>> {
    const outputContract = _goal.spec.outputContract;
    if (outputContract) {
      const validation = this.validator?.validate(outputContract.schemaRef, proposal.domainOutcome)
        ?? { valid: false as const, reason: `No validator registered for ${outputContract.schemaRef}` };
      if (!validation.valid) {
        return {
          settle: true,
          decision: { accepted: false, disposition: "correctable", reason: validation.reason },
        };
      }
    }
    return {
      settle: true,
      decision: { accepted: true, committedState: proposal.status },
    };
  }
}

export function validateGoalCriterionResults(goal: AgentGoal, proposal: GoalResolutionProposal): string | undefined {
  if (!Array.isArray(proposal.criterionResults)) return "criterionResults 必须是数组";
  if (!Array.isArray(proposal.residualRisks) || proposal.residualRisks.some((item) => typeof item !== "string")) {
    return "residualRisks 必须是字符串数组";
  }
  if (goal.spec.outputContract?.completionOutcomeSchema) return undefined;
  if (proposal.status !== "completed") return undefined;
  const expected = goal.spec.successCriteria.length;
  if (proposal.criterionResults.length !== expected) return `完成报告必须逐项回应全部 ${expected} 条成功标准`;
  const seen = new Set<number>();
  for (const result of proposal.criterionResults) {
    if (!Number.isInteger(result.criterionIndex) || result.criterionIndex < 0 || result.criterionIndex >= expected || seen.has(result.criterionIndex)) {
      return "criterionResults 的 criterionIndex 必须唯一覆盖当前 Goal 的成功标准";
    }
    seen.add(result.criterionIndex);
    if (!Array.isArray(result.evidence)) return `成功标准 ${result.criterionIndex + 1} 的 evidence 必须是数组`;
  }
  return undefined;
}

export class AgentEngine<TDomainOutcome = unknown> implements AgentPort<TDomainOutcome> {
  private readonly now: () => Date;

  constructor(
    private readonly store: AgentStore,
    private readonly resolutionPort: GoalResolutionPort<TDomainOutcome> = new AcceptingGoalResolutionPort(),
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async ensureThread(input: EnsureAgentThreadRequest): Promise<AgentThreadSnapshot> {
    this.requireAgent(input.agentId);
    const current = await this.store.read();
    const existingKey = current.threadKeys.find((item) => item.idempotencyKey === input.idempotencyKey);
    if (existingKey) {
      const existing = current.threads.find((item) => item.threadId === existingKey.threadId)!;
      if (existing.scopeId !== input.scopeId) throw new AgentEngineConflictError("Thread idempotency conflict");
      return structuredClone(existing);
    }
    const threadId = stableId("thread", input.agentId, input.scopeId, input.idempotencyKey);
    const thread: AgentThreadSnapshot = {
      threadId,
      agentId: input.agentId,
      scopeId: input.scopeId,
      version: 1,
      items: [],
    };
    const updated = await this.store.transact((aggregate) => {
      const replay = aggregate.threadKeys.find((item) => item.idempotencyKey === input.idempotencyKey);
      if (replay) {
        if (replay.scopeId !== input.scopeId) throw new AgentEngineConflictError("Thread idempotency conflict");
        return aggregate;
      }
      return {
        ...aggregate,
        aggregateVersion: aggregate.aggregateVersion + 1,
        threads: [...aggregate.threads, thread],
        threadKeys: [...aggregate.threadKeys, {
          idempotencyKey: input.idempotencyKey,
          scopeId: input.scopeId,
          threadId,
        }],
      };
    });
    return structuredClone(updated.threads.find((item) => item.threadId === threadId)!);
  }

  async getThreadForAgent(agentId: string, scopeId: string): Promise<AgentThreadSnapshot | undefined> {
    this.requireAgent(agentId);
    return structuredClone((await this.store.read()).threads.find((item) => item.scopeId === scopeId));
  }

  async getThread(threadId: string): Promise<AgentThreadSnapshot> {
    const thread = (await this.store.read()).threads.find((item) => item.threadId === threadId);
    if (!thread) throw new Error(`Thread ${threadId} does not exist`);
    return structuredClone(thread);
  }

  async getPayload(payloadRef: string): Promise<unknown> {
    return this.store.payload(payloadRef);
  }

  async getPayloads(payloadRefs: readonly string[]): Promise<Map<string, unknown>> {
    return this.store.payloads(payloadRefs);
  }

  async sendMessage(input: SendAgentMessageRequest): Promise<boolean> {
    const fingerprint = hash({
      messageId: input.messageId,
      turnId: input.turnId,
      threadId: input.threadId,
      goalId: input.goalId,
      senderPrincipalId: input.senderPrincipalId,
      deliveryKind: input.deliveryKind ?? "turn",
      content: input.content,
      attachments: input.attachments ?? [],
    });
    const current = await this.store.read();
    const duplicate = current.messageIds.find((item) => item.messageId === input.messageId);
    if (duplicate) {
      if (duplicate.fingerprint !== fingerprint || duplicate.threadId !== input.threadId) {
        throw new AgentEngineConflictError("Message idempotency conflict");
      }
      return false;
    }
    await this.appendThreadItem(
      input.threadId,
      input.messageId,
      "message",
      `message:${input.messageId}`,
      input.createdAt,
      input,
      { messageId: input.messageId, fingerprint },
      undefined,
      input.turnId,
    );
    return true;
  }

  async appendModelItem(input: {
    itemId: string;
    turnId?: string;
    threadId: string;
    goalId?: string;
    content: string;
    createdAt: string;
  }): Promise<void> {
    await this.appendThreadItem(
      input.threadId,
      input.itemId,
      "model",
      `model:${input.itemId}`,
      input.createdAt,
      {
        type: "assistant_message",
        ...(input.turnId ? { turnId: input.turnId } : {}),
        ...(input.goalId ? { goalId: input.goalId } : {}),
        content: input.content,
      },
      undefined,
      undefined,
      input.turnId,
    );
  }

  async appendToolItem(input: {
    itemId: string;
    turnId?: string;
    threadId: string;
    goalId?: string;
    kind: "tool" | "observation" | "control";
    value: unknown;
    createdAt: string;
  }): Promise<void> {
    const value = input.goalId && isRecord(input.value)
      ? { ...input.value, goalId: input.goalId }
      : input.value;
    await this.appendThreadItem(
      input.threadId,
      input.itemId,
      input.kind,
      `${input.kind}:${input.itemId}`,
      input.createdAt,
      value,
      undefined,
      undefined,
      input.turnId,
    );
  }

  async appendCompaction(input: {
    itemId: string;
    turnId?: string;
    threadId: string;
    replacedThroughSequence: number;
    replacementHistory: AgentModelHistoryItem[];
    originalItemCount: number;
    createdAt: string;
  }): Promise<void> {
    if (!Number.isInteger(input.replacedThroughSequence) || input.replacedThroughSequence < 1) {
      throw new Error("Compaction sequence boundary must be positive");
    }
    if (!input.replacementHistory.length) throw new Error("Compaction replacement history is required");
    await this.appendThreadItem(
      input.threadId,
      input.itemId,
      "compaction",
      `compaction:${input.itemId}`,
      input.createdAt,
      {
        type: "context_compaction",
        replacedThroughSequence: input.replacedThroughSequence,
        replacementHistory: structuredClone(input.replacementHistory),
        originalItemCount: input.originalItemCount,
      },
      undefined,
      (aggregate, thread) => {
        const factTail = latestFactSequence(thread);
        if (input.replacedThroughSequence > factTail) {
          throw new AgentEngineConflictError("Compaction boundary exceeds thread facts");
        }
        const latestBoundary = latestCompactionBoundary(aggregate, thread);
        if (latestBoundary !== undefined && input.replacedThroughSequence < latestBoundary) {
          throw new AgentEngineConflictError("Compaction boundary is stale");
        }
      },
      input.turnId,
    );
  }

  async startGoal(input: StartAgentGoalRequest): Promise<AgentGoal> {
    this.requireAgent(input.agentId);
    if (!input.spec.id.trim() || input.spec.threadId !== input.threadId) {
      throw new Error("Goal identity is invalid");
    }
    const fingerprint = hash(input);
    const goal: AgentGoal = {
      spec: structuredClone(input.spec),
      version: 1,
      status: "active",
      updatedAt: input.spec.createdAt,
    };
    const updated = await this.store.transact((aggregate) => {
      const replay = aggregate.goalStartKeys.find((item) => item.idempotencyKey === input.idempotencyKey);
      if (replay) {
        if (replay.fingerprint !== fingerprint) throw new AgentEngineConflictError("Goal start conflict");
        return aggregate;
      }
      const thread = aggregate.threads.find((item) => item.threadId === input.threadId);
      if (!thread) throw new Error("Goal thread does not exist");
      if (thread.agentId !== input.agentId) throw new Error("Goal agent does not own the thread");
      if (aggregate.goals.some((item) => item.spec.id === input.spec.id)) {
        throw new AgentEngineConflictError("Goal ID exists");
      }
      const nextThread = appendItem(thread, {
        itemId: `goal:${input.spec.id}`,
        kind: "goal",
        createdAt: input.spec.createdAt,
        payloadRef: `goal:${input.spec.id}`,
      });
      return {
        ...aggregate,
        aggregateVersion: aggregate.aggregateVersion + 1,
        threads: aggregate.threads.map((item) => item.threadId === nextThread.threadId ? nextThread : item),
        payloads: [...aggregate.payloads, { payloadRef: `goal:${input.spec.id}`, value: input.spec }],
        goals: [...aggregate.goals, goal],
        goalStartKeys: [...aggregate.goalStartKeys, {
          idempotencyKey: input.idempotencyKey,
          goalId: input.spec.id,
          fingerprint,
        }],
        pendingEvents: [goalEvent(goal, "GoalStatusChanged", input.spec.createdAt)],
      };
    });
    return structuredClone(updated.goals.find((item) => item.spec.id === input.spec.id)!);
  }

  async getGoalByStartKey(idempotencyKey: string): Promise<AgentGoal | undefined> {
    const aggregate = await this.store.read();
    const key = aggregate.goalStartKeys.find((item) => item.idempotencyKey === idempotencyKey);
    return structuredClone(aggregate.goals.find((item) => item.spec.id === key?.goalId));
  }

  async getGoal(goalId: string): Promise<AgentGoal | undefined> {
    return structuredClone((await this.store.read()).goals.find((item) => item.spec.id === goalId));
  }

  async executionReadiness(goalId: string): Promise<{ ready: boolean; reason: string }> {
    if (await this.store.executionLeaseHeld()) {
      return { ready: false, reason: "agent_busy" };
    }
    const aggregate = await this.store.read();
    const goal = aggregate.goals.find((item) => item.spec.id === goalId);
    if (!goal || goal.status !== "active") return { ready: false, reason: "goal_not_active" };
    const thread = aggregate.threads.find((item) => item.threadId === goal.spec.threadId);
    if (!thread) throw new Error("Goal thread does not exist");
    const payloads = new Map(aggregate.payloads.map((item) => [item.payloadRef, item.value]));
    const latestControlStatus = [...thread.items].reverse()
      .filter((item) => item.kind === "control")
      .map((item) => payloadControlStatus(payloads, item.payloadRef, goalId))
      .find((status): status is string => Boolean(status));
    if (latestControlStatus === "running"
      || latestControlStatus === "provider_retry_wait"
      || latestControlStatus === "external_service_waiting"
      || latestControlStatus === "execution_retry_wait"
      || latestControlStatus === "execution_blocked"
      || latestControlStatus === "stale_goal") {
      return {
        ready: true,
        reason: latestControlStatus === "running"
          || latestControlStatus === "execution_blocked"
          ? "interrupted_turn"
          : latestControlStatus === "stale_goal"
            ? "goal_version_updated"
            : latestControlStatus === "execution_retry_wait"
              ? "execution_retry_due"
              : "provider_retry_due",
      };
    }
    let lastAgentOutputIndex = -1;
    for (let index = thread.items.length - 1; index >= 0; index -= 1) {
      const item = thread.items[index]!;
      if ((item.kind === "model" || item.kind === "tool")
        && payloadGoalId(payloads, item.payloadRef) === goalId) {
        lastAgentOutputIndex = index;
        break;
      }
    }
    if (lastAgentOutputIndex < 0) return { ready: true, reason: "goal_not_started" };
    const afterOutput = thread.items.slice(lastAgentOutputIndex + 1);
    if (afterOutput.some((item) => item.kind === "message")) {
      return { ready: true, reason: "new_input" };
    }
    const latestCorrection = [...afterOutput].reverse()
      .map((item) => correctionReason(payloads, item.payloadRef))
      .find((reason): reason is string => Boolean(reason));
    if (latestCorrection) {
      const correctionReasons = thread.items
        .map((item) => correctionReason(payloads, item.payloadRef))
        .filter((reason): reason is string => Boolean(reason));
      if (correctionReasons.slice(0, -1).includes(latestCorrection)) {
        return { ready: false, reason: "repeated_host_correction_without_progress" };
      }
      return { ready: true, reason: "host_correction" };
    }
    return { ready: false, reason: "no_new_input_after_agent_output" };
  }

  async tokenUsageSinceLastHumanMessage(goalId: string): Promise<number> {
    const aggregate = await this.store.read();
    const goal = aggregate.goals.find((item) => item.spec.id === goalId);
    if (!goal) throw new Error("Goal does not exist");
    const thread = aggregate.threads.find((item) => item.threadId === goal.spec.threadId);
    if (!thread) throw new Error("Goal thread does not exist");
    const payloads = new Map(aggregate.payloads.map((item) => [item.payloadRef, item.value]));
    let windowStart = 0;
    for (let index = thread.items.length - 1; index >= 0; index -= 1) {
      const item = thread.items[index]!;
      if (item.kind !== "message") continue;
      const value = payloads.get(item.payloadRef);
      if (isRecord(value) && value.senderPrincipalId === "human") {
        windowStart = index + 1;
        break;
      }
    }
    return thread.items.slice(windowStart).reduce((total, item) => {
      const value = payloads.get(item.payloadRef);
      if (!isRecord(value) || value.type !== "provider_usage" || value.goalId !== goalId) return total;
      return total + (typeof value.totalTokens === "number" && Number.isFinite(value.totalTokens) ? value.totalTokens : 0);
    }, 0);
  }

  async getProjection(scopeId: string, goalId?: string, itemLimit?: number): Promise<{
    thread?: AgentThreadSnapshot;
    goal?: AgentGoal;
    payloads: Map<string, unknown>;
  }> {
    const aggregate = await this.store.read();
    const storedThread = aggregate.threads.find((item) => item.scopeId === scopeId);
    const thread = storedThread && itemLimit !== undefined
      ? { ...storedThread, items: storedThread.items.slice(-Math.max(0, itemLimit)) }
      : storedThread;
    const wanted = new Set(thread?.items.map((item) => item.payloadRef) ?? []);
    return {
      thread: thread ? structuredClone(thread) : undefined,
      goal: goalId ? structuredClone(aggregate.goals.find((item) => item.spec.id === goalId)) : undefined,
      payloads: new Map(aggregate.payloads
        .filter((item) => wanted.has(item.payloadRef))
        .map((item) => [item.payloadRef, structuredClone(item.value)])),
    };
  }

  async getProposal(proposalId: string): Promise<GoalResolutionProposal<GoalResolutionStatus, TDomainOutcome> | undefined> {
    return structuredClone((await this.store.read()).proposals.find((item) => item.proposalId === proposalId)) as
      GoalResolutionProposal<GoalResolutionStatus, TDomainOutcome> | undefined;
  }

  async hasPendingHumanTurn(goalId: string, excludingTurnId?: string): Promise<boolean> {
    const aggregate = await this.store.read();
    const goal = aggregate.goals.find((item) => item.spec.id === goalId);
    if (!goal) return false;
    return hasUnconsumedHumanTurn(aggregate, goal.spec.threadId, goalId, excludingTurnId);
  }

  async controlGoal(input: AgentGoalControlRequest): Promise<AgentGoal> {
    const fingerprint = hash(input);
    const updated = await this.store.transact((aggregate) => {
      const duplicate = aggregate.controls.find((item) => item.requestId === input.requestId);
      if (duplicate) {
        if (duplicate.fingerprint !== fingerprint) throw new AgentEngineConflictError("Goal control conflict");
        return aggregate;
      }
      const goal = aggregate.goals.find((item) => item.spec.id === input.goalId);
      if (!goal) throw new Error("Goal does not exist");
      const next = controlGoalState(goal, input, this.now().toISOString());
      const stateChanged = next.version !== goal.version;
      return {
        ...aggregate,
        aggregateVersion: aggregate.aggregateVersion + 1,
        goals: aggregate.goals.map((item) => item.spec.id === next.spec.id ? next : item),
        controls: [...aggregate.controls, { requestId: input.requestId, fingerprint, goal: next }],
        pendingEvents: stateChanged ? [goalEvent(next, "GoalStatusChanged", next.updatedAt)] : [],
      };
    });
    return structuredClone(updated.goals.find((item) => item.spec.id === input.goalId)!);
  }

  async proposeGoalResolution(
    proposal: GoalResolutionProposal<GoalResolutionStatus, TDomainOutcome>,
  ): Promise<{ goal: AgentGoal; attempt: GoalResolutionAttemptResult }> {
    const updated = await this.store.transact((aggregate) => {
      const existing = aggregate.proposals.find((item) => item.proposalId === proposal.proposalId);
      if (existing) {
        if (hash(existing) !== hash(proposal)) throw new AgentEngineConflictError("Proposal conflict");
        return aggregate;
      }
      const goal = aggregate.goals.find((item) => item.spec.id === proposal.goalId);
      if (!goal) throw new Error("Goal does not exist");
      const resolving = beginGoalResolution(goal, proposal);
      return {
        ...aggregate,
        aggregateVersion: aggregate.aggregateVersion + 1,
        goals: aggregate.goals.map((item) => item.spec.id === resolving.spec.id ? resolving : item),
        proposals: [...aggregate.proposals, structuredClone(proposal)],
        pendingEvents: [goalEvent(resolving, "GoalProposalCreated", proposal.createdAt, proposal.proposalId)],
      };
    });
    const persistedGoal = updated.goals.find((item) => item.spec.id === proposal.goalId)!;
    const persistedProposal = updated.proposals.find((item) => item.proposalId === proposal.proposalId)! as
      GoalResolutionProposal<GoalResolutionStatus, TDomainOutcome>;
    return this.finishProposalResolution(persistedGoal, persistedProposal);
  }

  async retryProposalResolution(
    proposalId: string,
  ): Promise<{ goal: AgentGoal; attempt: GoalResolutionAttemptResult }> {
    const current = await this.store.read();
    const proposal = current.proposals.find((item) => item.proposalId === proposalId) as
      | GoalResolutionProposal<GoalResolutionStatus, TDomainOutcome>
      | undefined;
    if (!proposal) throw new Error("Proposal does not exist");
    const goal = current.goals.find((item) => item.spec.id === proposal.goalId);
    if (!goal) throw new Error("Goal does not exist");
    if (goal.status !== "resolving" || goal.activeProposalId !== proposalId) {
      return {
        goal,
        attempt: {
          settle: false,
          pending: "retry_later",
          reason: "Proposal is no longer pending",
          retryAfter: this.now().toISOString(),
        },
      };
    }
    return this.finishProposalResolution(goal, proposal);
  }

  private async finishProposalResolution(
    goal: AgentGoal,
    proposal: GoalResolutionProposal<GoalResolutionStatus, TDomainOutcome>,
  ): Promise<{ goal: AgentGoal; attempt: GoalResolutionAttemptResult }> {
    const pendingHumanTurn = await this.hasPendingHumanTurn(goal.spec.id, proposal.turnId);
    const attempt: GoalResolutionAttemptResult = pendingHumanTurn
      ? {
          settle: true,
          decision: {
            accepted: false,
            disposition: "correctable",
            reason: "当前 Goal 还有一条按时间序排队、尚未处理的 human 消息；请先处理该消息，再重新提交结论。",
          },
        }
      : await this.resolveProposal(goal, proposal);
    if (!attempt.settle) {
      await this.publishSettlementRequest(goal, proposal.proposalId);
      return { goal: (await this.getGoal(goal.spec.id)) ?? goal, attempt };
    }
    const decisionId = stableId("decision", proposal.proposalId, hash(attempt.decision));
    const settled = await this.settleProposal({
      decisionId,
      proposalId: proposal.proposalId,
      expectedGoalVersion: goal.version,
      decision: attempt.decision,
    });
    return { goal: settled.goal, attempt };
  }

  private async publishSettlementRequest(goal: AgentGoal, proposalId: string): Promise<void> {
    await this.store.transact((aggregate) => {
      const currentGoal = aggregate.goals.find((item) => item.spec.id === goal.spec.id);
      const currentProposal = aggregate.proposals.find((item) => item.proposalId === proposalId);
      if (
        !currentGoal
        || !currentProposal
        || currentGoal.status !== "resolving"
        || currentGoal.activeProposalId !== proposalId
      ) return aggregate;
      const event = goalEvent(currentGoal, "GoalSettlementRequested", this.now().toISOString(), proposalId);
      if (aggregate.outbox.some((item) => item.event.eventId === event.eventId)) return aggregate;
      return {
        ...aggregate,
        aggregateVersion: aggregate.aggregateVersion + 1,
        pendingEvents: [event],
      };
    });
  }

  private async resolveProposal<TStatus extends GoalResolutionStatus>(
    goal: AgentGoal,
    proposal: GoalResolutionProposal<TStatus, TDomainOutcome>,
  ): Promise<GoalResolutionAttemptResult<TStatus>> {
    const completionError = validateGoalCriterionResults(goal, proposal);
    if (completionError) {
      return { settle: true, decision: { accepted: false, disposition: "correctable", reason: completionError } };
    }
    return this.resolutionPort.resolve(goal, proposal);
  }

  async settleProposal<TStatus extends GoalResolutionStatus>(
    input: SettleProposalRequest<TStatus>,
  ): Promise<SettleProposalResult> {
    const fingerprint = hash(input);
    let result: SettleProposalResult | undefined;
    let proposalTurnId: string | undefined;
    await this.store.transact((aggregate) => {
      const proposal = aggregate.proposals.find((item) => item.proposalId === input.proposalId);
      if (!proposal) throw new Error("Proposal does not exist");
      proposalTurnId = proposal.turnId;
      const goal = aggregate.goals.find((item) => item.spec.id === proposal.goalId)!;
      const existing = aggregate.decisions.find((item) => item.decisionId === input.decisionId);
      if (existing) {
        result = existing.fingerprint === fingerprint
          ? existing.result
          : { applied: false, code: "idempotency_conflict", goal };
        return aggregate;
      }
      let next: AgentGoal;
      try {
        next = settleGoalState(goal, proposal, input.decision, input.expectedGoalVersion, this.now().toISOString());
      } catch (error) {
        if (!(error instanceof AgentGoalTransitionError)) throw error;
        result = {
          applied: false,
          code: error.code === "goal_terminal" ? "goal_terminal" : "version_conflict",
          goal,
        };
        return aggregate;
      }
      result = { applied: true, goal: next };
      return {
        ...aggregate,
        aggregateVersion: aggregate.aggregateVersion + 1,
        goals: aggregate.goals.map((item) => item.spec.id === next.spec.id ? next : item),
        decisions: [...aggregate.decisions, {
          decisionId: input.decisionId,
          proposalId: input.proposalId,
          fingerprint,
          result,
        }],
        pendingEvents: [goalEvent(next, "GoalStatusChanged", next.updatedAt)],
      };
    });
    if (!result) throw new Error("Proposal settlement did not produce a result");
    if (result.applied || result.code !== "idempotency_conflict") {
      await this.recordResolutionDecision(result.goal, input, proposalTurnId);
    }
    return result;
  }

  private async recordResolutionDecision<TStatus extends GoalResolutionStatus>(
    goal: AgentGoal,
    input: SettleProposalRequest<TStatus>,
    turnId?: string,
  ): Promise<void> {
    await this.appendToolItem({
      itemId: `decision:${input.decisionId}`,
      turnId,
      threadId: goal.spec.threadId,
      goalId: goal.spec.id,
      kind: "control",
      value: {
        type: "goal_resolution_decision",
        status: input.decision.accepted ? "accepted" : input.decision.disposition,
        decision: input.decision,
      },
      createdAt: this.now().toISOString(),
    });
  }

  async readEvents<TAgentId extends string>(
    input: AgentEventQuery<TAgentId>,
  ): Promise<AgentEventPage<AgentEvent, TAgentId>> {
    return this.store.readEvents(input);
  }

  private async appendThreadItem(
    threadId: string,
    itemId: string,
    kind: AgentThreadItemKind,
    payloadRef: string,
    createdAt: string,
    value: unknown,
    message?: { messageId: string; fingerprint: string },
    validate?: (aggregate: AgentStoreAggregate, thread: AgentThreadSnapshot) => void,
    turnId?: string,
  ): Promise<void> {
    const current = await this.store.read();
    const existingThread = current.threads.find((item) => item.threadId === threadId);
    if (!existingThread) throw new Error("Thread does not exist");
    const existingItem = existingThread.items.find((item) => item.itemId === itemId);
    if (existingItem) {
      if (existingItem.kind !== kind || existingItem.payloadRef !== payloadRef || existingItem.turnId !== turnId) {
        throw new AgentEngineConflictError("Thread item idempotency conflict");
      }
      const existingPayload = current.payloads.find((item) => item.payloadRef === payloadRef);
      if (!existingPayload || hash(existingPayload.value) !== hash(value)) {
        throw new AgentEngineConflictError("Thread item payload conflict");
      }
      return;
    }
    await this.store.transact((aggregate) => {
      const thread = aggregate.threads.find((item) => item.threadId === threadId);
      if (!thread) throw new Error("Thread does not exist");
      if (thread.items.some((item) => item.itemId === itemId)) {
        const existingPayload = aggregate.payloads.find((item) => item.payloadRef === payloadRef);
        if (!existingPayload || hash(existingPayload.value) !== hash(value)) {
          throw new AgentEngineConflictError("Concurrent thread item conflict");
        }
        return aggregate;
      }
      validate?.(aggregate, thread);
      const next = appendItem(thread, { itemId, ...(turnId ? { turnId } : {}), kind, payloadRef, createdAt });
      const event: AgentEvent = kind === "message"
        ? {
            eventId: eventId("message", itemId, next.version),
            aggregateType: "agent_thread",
            aggregateId: threadId,
            aggregateVersion: next.version,
            occurredAt: createdAt,
            payload: { type: "MessageAppended", threadId, messageId: itemId, ...(turnId ? { turnId } : {}), sequence: next.items.length },
          }
        : {
            eventId: eventId(kind, itemId, next.version),
            aggregateType: "agent_thread",
            aggregateId: threadId,
            aggregateVersion: next.version,
            occurredAt: createdAt,
            payload: { type: "TurnStatusChanged", threadId, turnId: turnId ?? itemId, status: kind },
          };
      return {
        ...aggregate,
        aggregateVersion: aggregate.aggregateVersion + 1,
        threads: aggregate.threads.map((item) => item.threadId === threadId ? next : item),
        payloads: [...aggregate.payloads, { payloadRef, value }],
        messageIds: message ? [...aggregate.messageIds, { ...message, threadId }] : aggregate.messageIds,
        pendingEvents: [event],
      };
    });
  }

  private requireAgent(agentId: string): void {
    if (agentId !== this.store.agentId) throw new Error("Agent partition mismatch");
  }
}

function latestCompactionBoundary(
  aggregate: AgentStoreAggregate,
  thread: AgentThreadSnapshot,
): number | undefined {
  for (let index = thread.items.length - 1; index >= 0; index -= 1) {
    const item = thread.items[index];
    if (item.kind !== "compaction") continue;
    const payload = aggregate.payloads.find((candidate) => candidate.payloadRef === item.payloadRef)?.value;
    if (isRecord(payload) && Number.isInteger(payload.replacedThroughSequence)) {
      return Number(payload.replacedThroughSequence);
    }
  }
  return undefined;
}

function latestFactSequence(thread: AgentThreadSnapshot): number {
  for (let index = thread.items.length - 1; index >= 0; index -= 1) {
    if (thread.items[index].kind !== "compaction") return thread.items[index].sequence;
  }
  return 0;
}

function appendItem(
  thread: AgentThreadSnapshot,
  item: Omit<AgentThreadSnapshot["items"][number], "sequence">,
): AgentThreadSnapshot {
  return {
    ...thread,
    version: thread.version + 1,
    items: [...thread.items, { ...item, sequence: thread.items.length + 1 }],
  };
}

function payloadGoalId(payloads: ReadonlyMap<string, unknown>, payloadRef: string): string | undefined {
  const value = payloads.get(payloadRef);
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const goalId = (value as Record<string, unknown>).goalId;
  return typeof goalId === "string" ? goalId : undefined;
}

function correctionReason(payloads: ReadonlyMap<string, unknown>, payloadRef: string): string | undefined {
  const value = payloads.get(payloadRef);
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.type !== "goal_resolution_decision" || record.status !== "correctable") return undefined;
  const decision = record.decision;
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) return undefined;
  const reason = (decision as Record<string, unknown>).reason;
  return typeof reason === "string" ? reason : undefined;
}

function hasUnconsumedHumanTurn(
  aggregate: AgentStoreAggregate,
  threadId: string,
  goalId: string,
  excludingTurnId?: string,
): boolean {
  const thread = aggregate.threads.find((item) => item.threadId === threadId);
  if (!thread) return false;
  const payloads = new Map(aggregate.payloads.map((item) => [item.payloadRef, item.value]));
  return thread.items.some((item, index) => {
    if (item.kind !== "message" || item.turnId === excludingTurnId) return false;
    const payload = payloads.get(item.payloadRef);
    if (!isRecord(payload)
      || payload.goalId !== goalId
      || payload.senderPrincipalId !== "human"
      || payload.deliveryKind === "context") return false;
    return !thread.items.slice(index + 1).some((candidate) => {
      if (candidate.turnId === item.turnId && candidate.kind !== "message") return true;
      const candidatePayload = payloads.get(candidate.payloadRef);
      return isRecord(candidatePayload) && candidatePayload.triggerMessageId === item.itemId;
    });
  });
}


function payloadControlStatus(
  payloads: ReadonlyMap<string, unknown>,
  payloadRef: string,
  goalId: string,
): string | undefined {
  const value = payloads.get(payloadRef);
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.goalId !== goalId || typeof record.status !== "string") return undefined;
  return record.status;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function goalEvent(
  goal: AgentGoal,
  type: "GoalStatusChanged" | "GoalProposalCreated" | "GoalSettlementRequested",
  occurredAt: string,
  proposalId?: string,
): AgentEvent {
  return {
    eventId: eventId(type, proposalId ?? goal.spec.id, goal.version),
    aggregateType: "agent_goal",
    aggregateId: goal.spec.id,
    aggregateVersion: goal.version,
    occurredAt,
    payload: type === "GoalStatusChanged"
      ? { type, goalId: goal.spec.id, status: goal.status }
      : { type, goalId: goal.spec.id, proposalId: proposalId! },
  };
}

function eventId(kind: string, id: string, version: number): string {
  return stableId("event", kind, id, String(version));
}

function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash("sha256").update(JSON.stringify(parts)).digest("base64url")}`;
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}
