import { describe, expect, expectTypeOf, it } from "vitest";

import {
  AGENT_GOAL_STATUSES,
  type AgentAggregateType,
  type AgentEvent,
  type AgentEventCursor,
  type AgentEventEnvelope,
  type AgentEventPage,
  type AgentEventQuery,
  type AgentGoalControlRequest,
  type AgentGoalStatus,
  type AgentPort,
  type AgentThreadItem,
  type AgentThreadSnapshot,
  type EnsureAgentThreadRequest,
  type GoalResolutionAttemptResult,
  type GoalResolutionDecision,
  type GoalResolutionProposal,
  type SendAgentMessageRequest,
  type SettleProposalRequest,
  type StartAgentGoalRequest,
} from "../../src/shared/contracts/agent-engine.js";

describe("Agent Engine runtime contracts", () => {
  it("publishes the complete Agent Goal status set", () => {
    expect(AGENT_GOAL_STATUSES).toEqual([
      "active",
      "paused",
      "blocked",
      "resolving",
      "completed",
      "failed",
      "cancelled",
      "budget_limited",
      "usage_limited",
    ]);
    expectTypeOf<(typeof AGENT_GOAL_STATUSES)[number]>().toEqualTypeOf<AgentGoalStatus>();
  });

  it("allows an ordinary Thread to be ensured without a Goal", () => {
    const request = {
      agentId: "agent-1",
      scopeId: "workspace-1",
      idempotencyKey: "thread:agent-1:workspace-1",
    } satisfies EnsureAgentThreadRequest;

    expect(request).not.toHaveProperty("goalId");
    expectTypeOf<AgentPort["ensureThread"]>().parameter(0).toEqualTypeOf<EnsureAgentThreadRequest>();
    expectTypeOf<AgentPort["getThreadForAgent"]>().toEqualTypeOf<
      (agentId: string, scopeId: string) => Promise<AgentThreadSnapshot | undefined>
    >();
  });

  it("uses one chronological sequence for every Thread item kind", () => {
    const thread = {
      threadId: "thread-1",
      agentId: "agent-1",
      scopeId: "workspace-1",
      version: 2,
      items: [
        {
          itemId: "item-1",
          sequence: 1,
          kind: "message",
          createdAt: "2026-07-10T01:00:00.000Z",
          payloadRef: "payload:message-1",
        },
        {
          itemId: "item-2",
          sequence: 2,
          kind: "control",
          createdAt: "2026-07-10T01:01:00.000Z",
          payloadRef: "payload:control-1",
        },
      ],
    } satisfies AgentThreadSnapshot;

    expect(thread.items.map(({ sequence, createdAt }) => ({ sequence, createdAt }))).toEqual([
      { sequence: 1, createdAt: "2026-07-10T01:00:00.000Z" },
      { sequence: 2, createdAt: "2026-07-10T01:01:00.000Z" },
    ]);

    const acceptThreadItem = (_item: AgentThreadItem) => undefined;
    if (false) {
      // @ts-expect-error All Thread items participate in the shared sequence.
      acceptThreadItem({ itemId: "item-3", kind: "model", createdAt: "2026-07-10T01:02:00.000Z", payloadRef: "payload:model-1" });
    }
  });

  it("requires proposal and settlement CAS versions", () => {
    expectTypeOf<GoalResolutionProposal>().toHaveProperty("expectedGoalVersion").toEqualTypeOf<number>();
    expectTypeOf<GoalResolutionProposal>().toHaveProperty("resolvingGoalVersion").toEqualTypeOf<number>();
    expectTypeOf<SettleProposalRequest>().toHaveProperty("decisionId").toEqualTypeOf<string>();
    expectTypeOf<SettleProposalRequest>().toHaveProperty("expectedGoalVersion").toEqualTypeOf<number>();
  });

  it("keeps retry_later pending and outside final settlement decisions", () => {
    type RetryDecision = Extract<GoalResolutionDecision, { pending: "retry_later" }>;
    type PendingAttempt = Extract<GoalResolutionAttemptResult, { settle: false }>;

    expectTypeOf<RetryDecision>().toEqualTypeOf<never>();
    expectTypeOf<PendingAttempt>().toEqualTypeOf<{
      settle: false;
      pending: "retry_later";
      reason: string;
      retryAfter: string;
    }>();

    const pendingAttempt: GoalResolutionAttemptResult = {
      settle: false,
      pending: "retry_later",
      reason: "host unavailable",
      retryAfter: "2026-07-10T01:05:00.000Z",
    };
    expect(pendingAttempt.settle).toBe(false);

    const invalidSettlement = {
      decisionId: "decision-1",
      proposalId: "proposal-1",
      expectedGoalVersion: 3,
      // @ts-expect-error retry_later is an attempt result, never a final decision.
      decision: pendingAttempt,
    } satisfies SettleProposalRequest;
    expect(invalidSettlement.decision.settle).toBe(false);
  });

  it("binds accepted resolution state to the proposal status", () => {
    const blockedProposal = {
      proposalId: "proposal-blocked",
      goalId: "goal-1",
      expectedGoalVersion: 2,
      resolvingGoalVersion: 3,
      status: "blocked",
      summary: "Waiting for user input",
      evidence: [],
      createdAt: "2026-07-10T01:03:00.000Z",
    } satisfies GoalResolutionProposal<"blocked">;
    const settleBlocked = (_request: SettleProposalRequest<typeof blockedProposal.status>) => undefined;

    if (false) {
      // @ts-expect-error A blocked proposal cannot be accepted as completed.
      settleBlocked({ decisionId: "decision-2", proposalId: blockedProposal.proposalId, expectedGoalVersion: 3, decision: { accepted: true, committedState: "completed" } });
    }
  });

  it("requires idempotency fields for start, message, and Goal control operations", () => {
    expectTypeOf<StartAgentGoalRequest>().toHaveProperty("idempotencyKey").toEqualTypeOf<string>();
    expectTypeOf<SendAgentMessageRequest>().toHaveProperty("messageId").toEqualTypeOf<string>();
    expectTypeOf<AgentGoalControlRequest>().toHaveProperty("requestId").toEqualTypeOf<string>();
  });

  it("partitions Agent event reads by agentId with a namespaced cursor", () => {
    const cursor = {
      source: "agent",
      partitionId: "agent-1",
      position: "42",
    } satisfies AgentEventCursor<"agent-1">;
    const query = { agentId: "agent-1", after: cursor, limit: 100 } satisfies AgentEventQuery<"agent-1">;
    const page = { events: [], nextCursor: cursor } satisfies AgentEventPage<AgentEvent, "agent-1">;

    expect(query.agentId).toBe(cursor.partitionId);
    expect(page.nextCursor).toEqual({ source: "agent", partitionId: "agent-1", position: "42" });

    // @ts-expect-error Agent event queries cannot omit their aggregate partition.
    const invalidQuery: AgentEventQuery = { limit: 100 };
    expect(invalidQuery).not.toHaveProperty("agentId");

    const agentPort = null as unknown as AgentPort;
    if (false) {
      // @ts-expect-error Cursor partition must match the queried agentId.
      void agentPort.readEvents({ agentId: "agent-1", after: { source: "agent", partitionId: "agent-2", position: "43" }, limit: 100 });
    }
  });

  it("binds Agent event payloads to their aggregate type", () => {
    const acceptEvent = (_event: AgentEvent) => undefined;
    const acceptEnvelope = (_event: AgentEventEnvelope<AgentAggregateType>) => undefined;

    if (false) {
      // @ts-expect-error Goal events belong to the agent_goal aggregate.
      acceptEvent({ eventId: "event-1", aggregateType: "agent_thread", aggregateId: "thread-1", aggregateVersion: 1, occurredAt: "2026-07-10T01:04:00.000Z", payload: { type: "GoalStatusChanged", goalId: "goal-1", status: "blocked" } });
      // @ts-expect-error Message events belong to the agent_thread aggregate.
      acceptEvent({ eventId: "event-2", aggregateType: "agent_goal", aggregateId: "goal-1", aggregateVersion: 2, occurredAt: "2026-07-10T01:05:00.000Z", payload: { type: "MessageAppended", threadId: "thread-1", messageId: "message-1", sequence: 3 } });
      // @ts-expect-error The exported envelope must preserve aggregate and payload correlation.
      acceptEnvelope({ eventId: "event-3", aggregateType: "agent_thread", aggregateId: "thread-1", aggregateVersion: 3, occurredAt: "2026-07-10T01:06:00.000Z", payload: { type: "GoalStatusChanged", goalId: "goal-1", status: "blocked" } });
    }
  });
});
