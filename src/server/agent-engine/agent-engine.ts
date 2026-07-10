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
  type AgentStoreAggregate,
} from "./agent-store.js";
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
    goal: AgentGoal,
    proposal: GoalResolutionProposal<TStatus>,
  ): Promise<GoalResolutionAttemptResult<TStatus>> {
    const outputContract = goal.spec.outputContract;
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
      return existing;
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
    return updated.threads.find((item) => item.threadId === threadId)!;
  }

  async getThreadForAgent(agentId: string, scopeId: string): Promise<AgentThreadSnapshot | undefined> {
    this.requireAgent(agentId);
    return structuredClone((await this.store.read()).threads.find((item) => item.scopeId === scopeId));
  }

  async getThread(threadId: string): Promise<AgentThreadSnapshot> {
    const thread = (await this.store.read()).threads.find((item) => item.threadId === threadId);
    if (!thread) throw new Error(`Thread ${threadId} does not exist`);
    return thread;
  }

  async getPayload(payloadRef: string): Promise<unknown> {
    return this.store.payload(payloadRef);
  }

  async getPayloads(payloadRefs: readonly string[]): Promise<Map<string, unknown>> {
    return this.store.payloads(payloadRefs);
  }

  async sendMessage(input: SendAgentMessageRequest): Promise<void> {
    const fingerprint = hash(input);
    const current = await this.store.read();
    const duplicate = current.messageIds.find((item) => item.messageId === input.messageId);
    if (duplicate) {
      if (duplicate.fingerprint !== fingerprint || duplicate.threadId !== input.threadId) {
        throw new AgentEngineConflictError("Message idempotency conflict");
      }
      return;
    }
    await this.appendThreadItem(
      input.threadId,
      input.messageId,
      "message",
      `message:${input.messageId}`,
      input.createdAt,
      input,
      { messageId: input.messageId, fingerprint },
    );
  }

  async appendModelItem(input: {
    itemId: string;
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
      input,
    );
  }

  async appendToolItem(input: {
    itemId: string;
    threadId: string;
    goalId?: string;
    kind: "tool" | "observation" | "control";
    value: unknown;
    createdAt: string;
  }): Promise<void> {
    await this.appendThreadItem(
      input.threadId,
      input.itemId,
      input.kind,
      `${input.kind}:${input.itemId}`,
      input.createdAt,
      input.value,
    );
  }

  async startGoal(input: StartAgentGoalRequest): Promise<AgentGoal> {
    this.requireAgent(input.agentId);
    if (!input.spec.id.trim() || input.spec.threadId !== input.threadId) {
      throw new Error("Goal identity is invalid");
    }
    const fingerprint = hash(input);
    const current = await this.store.read();
    const key = current.goalStartKeys.find((item) => item.idempotencyKey === input.idempotencyKey);
    if (key) {
      if (key.fingerprint !== fingerprint) throw new AgentEngineConflictError("Goal start conflict");
      return current.goals.find((item) => item.spec.id === key.goalId)!;
    }
    const thread = current.threads.find((item) => item.threadId === input.threadId);
    if (!thread) throw new Error("Goal thread does not exist");
    if (thread.agentId !== input.agentId) throw new Error("Goal agent does not own the thread");
    if (current.goals.some((item) => item.spec.id === input.spec.id)) throw new AgentEngineConflictError("Goal ID exists");
    const goal: AgentGoal = {
      spec: structuredClone(input.spec),
      version: 1,
      status: "active",
      updatedAt: input.spec.createdAt,
    };
    const nextThread = appendItem(thread, {
      itemId: `goal:${input.spec.id}`,
      kind: "goal",
      createdAt: input.spec.createdAt,
      payloadRef: `goal:${input.spec.id}`,
    });
    const event = goalEvent(goal, "GoalStatusChanged", input.spec.createdAt);
    const updated = await this.store.transact((aggregate) => {
      const replay = aggregate.goalStartKeys.find((item) => item.idempotencyKey === input.idempotencyKey);
      if (replay) {
        if (replay.fingerprint !== fingerprint) throw new AgentEngineConflictError("Goal start conflict");
        return aggregate;
      }
      if (aggregate.goals.some((item) => item.spec.id === input.spec.id)) {
        throw new AgentEngineConflictError("Goal ID exists");
      }
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
        pendingEvents: [event],
      };
    });
    return updated.goals.find((item) => item.spec.id === input.spec.id)!;
  }

  async getGoalByStartKey(idempotencyKey: string): Promise<AgentGoal | undefined> {
    const aggregate = await this.store.read();
    const key = aggregate.goalStartKeys.find((item) => item.idempotencyKey === idempotencyKey);
    return structuredClone(aggregate.goals.find((item) => item.spec.id === key?.goalId));
  }

  async getGoal(goalId: string): Promise<AgentGoal | undefined> {
    return structuredClone((await this.store.read()).goals.find((item) => item.spec.id === goalId));
  }

  async getProposal(proposalId: string): Promise<GoalResolutionProposal<GoalResolutionStatus, TDomainOutcome> | undefined> {
    return structuredClone((await this.store.read()).proposals.find((item) => item.proposalId === proposalId)) as
      GoalResolutionProposal<GoalResolutionStatus, TDomainOutcome> | undefined;
  }

  async controlGoal(input: AgentGoalControlRequest): Promise<AgentGoal> {
    const fingerprint = hash(input);
    const current = await this.store.read();
    const replay = current.controls.find((item) => item.requestId === input.requestId);
    if (replay) {
      if (replay.fingerprint !== fingerprint) throw new AgentEngineConflictError("Goal control conflict");
      return replay.goal;
    }
    const goal = current.goals.find((item) => item.spec.id === input.goalId);
    if (!goal) throw new Error("Goal does not exist");
    const next = controlGoalState(goal, input, this.now().toISOString());
    const updated = await this.store.transact((aggregate) => {
      const duplicate = aggregate.controls.find((item) => item.requestId === input.requestId);
      if (duplicate) {
        if (duplicate.fingerprint !== fingerprint) throw new AgentEngineConflictError("Goal control conflict");
        return aggregate;
      }
      return {
        ...aggregate,
        aggregateVersion: aggregate.aggregateVersion + 1,
        goals: aggregate.goals.map((item) => item.spec.id === next.spec.id ? next : item),
        controls: [...aggregate.controls, { requestId: input.requestId, fingerprint, goal: next }],
        pendingEvents: [goalEvent(next, "GoalStatusChanged", next.updatedAt)],
      };
    });
    return updated.goals.find((item) => item.spec.id === input.goalId)!;
  }

  async proposeGoalResolution(
    proposal: GoalResolutionProposal<GoalResolutionStatus, TDomainOutcome>,
  ): Promise<{ goal: AgentGoal; attempt: GoalResolutionAttemptResult }> {
    const current = await this.store.read();
    const existing = current.proposals.find((item) => item.proposalId === proposal.proposalId);
    if (existing) {
      if (hash(existing) !== hash(proposal)) throw new AgentEngineConflictError("Proposal conflict");
      const goal = current.goals.find((item) => item.spec.id === proposal.goalId)!;
      const attempt = await this.resolutionPort.resolve(
        goal,
        existing as GoalResolutionProposal<GoalResolutionStatus, TDomainOutcome>,
      );
      return { goal, attempt };
    }
    const goal = current.goals.find((item) => item.spec.id === proposal.goalId);
    if (!goal) throw new Error("Goal does not exist");
    const resolving = beginGoalResolution(goal, proposal);
    const updated = await this.store.transact((aggregate) => ({
      ...aggregate,
      aggregateVersion: aggregate.aggregateVersion + 1,
      goals: aggregate.goals.map((item) => item.spec.id === resolving.spec.id ? resolving : item),
      proposals: [...aggregate.proposals, structuredClone(proposal)],
      pendingEvents: [goalEvent(resolving, "GoalProposalCreated", proposal.createdAt, proposal.proposalId)],
    }));
    const persistedGoal = updated.goals.find((item) => item.spec.id === proposal.goalId)!;
    const attempt = await this.resolutionPort.resolve(persistedGoal, proposal);
    if (!attempt.settle) return { goal: persistedGoal, attempt };
    const decisionId = stableId("decision", proposal.proposalId, hash(attempt.decision));
    const settled = await this.settleProposal({
      decisionId,
      proposalId: proposal.proposalId,
      expectedGoalVersion: persistedGoal.version,
      decision: attempt.decision,
    });
    return { goal: settled.goal, attempt };
  }

  async settleProposal<TStatus extends GoalResolutionStatus>(
    input: SettleProposalRequest<TStatus>,
  ): Promise<SettleProposalResult> {
    const fingerprint = hash(input);
    const current = await this.store.read();
    const existing = current.decisions.find((item) => item.decisionId === input.decisionId);
    const proposal = current.proposals.find((item) => item.proposalId === input.proposalId);
    if (!proposal) throw new Error("Proposal does not exist");
    const goal = current.goals.find((item) => item.spec.id === proposal.goalId)!;
    if (existing) {
      if (existing.fingerprint !== fingerprint) return { applied: false, code: "idempotency_conflict", goal };
      await this.recordResolutionDecision(goal, input);
      return existing.result;
    }
    let next: AgentGoal;
    try {
      next = settleGoalState(goal, proposal, input.decision, input.expectedGoalVersion, this.now().toISOString());
    } catch (error) {
      if (!(error instanceof AgentGoalTransitionError)) throw error;
      const code = error.code === "goal_terminal" ? "goal_terminal" : "version_conflict";
      return { applied: false, code, goal };
    }
    const result: SettleProposalResult = { applied: true, goal: next };
    await this.store.transact((aggregate) => ({
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
    }));
    await this.recordResolutionDecision(goal, input);
    return result;
  }

  private async recordResolutionDecision<TStatus extends GoalResolutionStatus>(
    goal: AgentGoal,
    input: SettleProposalRequest<TStatus>,
  ): Promise<void> {
    await this.appendToolItem({
      itemId: `decision:${input.decisionId}`,
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
  ): Promise<void> {
    const current = await this.store.read();
    const existingThread = current.threads.find((item) => item.threadId === threadId);
    if (!existingThread) throw new Error("Thread does not exist");
    const existingItem = existingThread.items.find((item) => item.itemId === itemId);
    if (existingItem) {
      if (existingItem.kind !== kind || existingItem.payloadRef !== payloadRef) {
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
      const next = appendItem(thread, { itemId, kind, payloadRef, createdAt });
      const event: AgentEvent = kind === "message"
        ? {
            eventId: eventId("message", itemId, next.version),
            aggregateType: "agent_thread",
            aggregateId: threadId,
            aggregateVersion: next.version,
            occurredAt: createdAt,
            payload: { type: "MessageAppended", threadId, messageId: itemId, sequence: next.items.length },
          }
        : {
            eventId: eventId(kind, itemId, next.version),
            aggregateType: "agent_thread",
            aggregateId: threadId,
            aggregateVersion: next.version,
            occurredAt: createdAt,
            payload: { type: "TurnStatusChanged", threadId, turnId: itemId, status: kind },
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

function goalEvent(
  goal: AgentGoal,
  type: "GoalStatusChanged" | "GoalProposalCreated",
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
