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
import {
  WORKFLOW_STATUSES,
  type BlockedOwnershipReceipt,
  type ClaimCommandEnvelope,
  type ClaimCommandResult,
  type ClaimReceipt,
  type PlannedTicketGraph,
  type PlannedWorkflowCompletionPolicy,
  type ReturnToParentTicketCommand,
  type CompleteWithGraphTicketCommand,
  type TicketCommandEnvelope,
  type TicketCommandPayload,
  type TicketCommandResult,
  type TicketEvent,
  type TicketEventCursor,
  type TicketEventEnvelope,
  type TicketEventPage,
  type TicketEventQuery,
  type TicketGraphSnapshot,
  type TicketId,
  type TicketNodeKey,
  type TransferBlockedOwnershipRequest,
  type WorkflowCommandEnvelope,
  type WorkflowCommandResult,
  type WorkflowCompletionPolicy,
  type WorkflowId,
  type WorkflowPolicyPort,
  type WorkflowStatus,
} from "../../src/shared/contracts/ticket-engine.js";

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

describe("Ticket Engine runtime contracts", () => {
  it("separates planned node keys from runtime Ticket IDs", () => {
    const rootKey = "plan" as TicketNodeKey;
    const implementationKey = "implementation" as TicketNodeKey;
    const implementationTicketId = "ticket-implementation" as TicketId;

    const graph = {
      schemaVersion: 2,
      nodes: [
        {
          key: rootKey,
          title: "Plan",
          objective: "Create an executable plan",
          successCriteria: ["The graph is complete"],
          assignment: { requiredCapabilities: ["planning"] },
          outputContract: { schemaRef: "schema:plan" },
        },
        {
          key: implementationKey,
          parentKey: rootKey,
          title: "Implement",
          objective: "Build the planned change",
          successCriteria: ["Tests pass"],
          assignment: { principalId: "principal-dev" },
          outputContract: { schemaRef: "schema:implementation" },
        },
      ],
      dependencyEdges: [{ fromKey: rootKey, toKey: implementationKey }],
    } satisfies PlannedTicketGraph;

    const snapshot = {
      schemaVersion: 2,
      nodes: [
        { nodeKey: rootKey, ticketId: "ticket-plan" as TicketId, active: true },
        { nodeKey: implementationKey, ticketId: implementationTicketId, active: true },
      ],
      dependencyEdges: [
        { fromTicketId: "ticket-plan" as TicketId, toTicketId: implementationTicketId },
      ],
    } satisfies TicketGraphSnapshot;

    expect(graph.dependencyEdges[0]).toEqual({ fromKey: rootKey, toKey: implementationKey });
    expect(snapshot.nodes[1]).toMatchObject({ nodeKey: implementationKey, ticketId: implementationTicketId });

    const acceptTicketId = (_ticketId: TicketId) => undefined;
    if (false) {
      // @ts-expect-error Planned keys are not runtime Ticket IDs.
      acceptTicketId(implementationKey);
    }
  });

  it("separates planned completion keys from runtime terminal Ticket IDs", () => {
    const planned = {
      requiredTerminalKeys: ["acceptance" as TicketNodeKey],
      failurePolicy: "require_resolution",
      blockedPolicy: "wait",
    } satisfies PlannedWorkflowCompletionPolicy;
    const runtime = {
      requiredTerminalTicketIds: ["ticket-acceptance" as TicketId],
      failurePolicy: "require_resolution",
      blockedPolicy: "wait",
    } satisfies WorkflowCompletionPolicy;

    expect(planned.requiredTerminalKeys).toHaveLength(1);
    expect(runtime.requiredTerminalTicketIds).toHaveLength(1);

    if (false) {
      const plannedKey = planned.requiredTerminalKeys[0];
      // @ts-expect-error Runtime completion policy accepts Ticket IDs, not planned keys.
      const invalidRuntimePolicy: WorkflowCompletionPolicy = { ...runtime, requiredTerminalTicketIds: [plannedKey] };
      void invalidRuntimePolicy;
    }
  });

  it("publishes Workflow status and immutable policy lookup contracts", () => {
    expect(WORKFLOW_STATUSES).toEqual([
      "active",
      "paused",
      "blocked",
      "completed",
      "failed",
      "cancelled",
    ]);
    expectTypeOf<(typeof WORKFLOW_STATUSES)[number]>().toEqualTypeOf<WorkflowStatus>();
    expectTypeOf<WorkflowPolicyPort["getPolicy"]>().returns.toEqualTypeOf<
      Promise<Awaited<ReturnType<WorkflowPolicyPort["getPolicy"]>>>
    >();
  });

  it("uses fenced claim and blocked-owner receipts as execution authority", () => {
    const workflowId = "workflow-1" as WorkflowId;
    const ticketId = "ticket-1" as TicketId;
    const claim = {
      requestId: "claim-request-1",
      claimId: "claim-1",
      workflowId,
      ticketId,
      ticketVersion: 3,
      principalId: "principal-1",
      fencingToken: 8,
      leaseUntil: "2026-07-10T02:00:00.000Z",
    } satisfies ClaimReceipt;
    const blockedOwner = {
      ownershipId: "ownership-1",
      workflowId,
      ticketId,
      ticketVersion: 4,
      principalId: "principal-1",
      fencingToken: 9,
    } satisfies BlockedOwnershipReceipt;
    const transfer = {
      requestId: "ownership-transfer-1",
      ownershipId: blockedOwner.ownershipId,
      fencingToken: blockedOwner.fencingToken,
      toPrincipalId: "principal-2",
    } satisfies TransferBlockedOwnershipRequest;

    expect(claim.fencingToken).toBe(8);
    expect(transfer.fencingToken).toBe(9);
  });

  it("defines create_graph, claim, and Ticket transition command envelopes", () => {
    const workflowId = "workflow-1" as WorkflowId;
    const ticketId = "ticket-1" as TicketId;
    const graph = {
      schemaVersion: 2,
      nodes: [],
      dependencyEdges: [],
    } satisfies PlannedTicketGraph;
    const completionPolicy = {
      requiredTerminalKeys: [],
      failurePolicy: "fail_fast",
      blockedPolicy: "wait",
    } satisfies PlannedWorkflowCompletionPolicy;
    const createGraph = {
      commandId: "workflow-command-1",
      workflowId,
      actorPrincipalId: "principal-planner",
      issuedAt: "2026-07-10T01:00:00.000Z",
      payload: {
        type: "create_graph",
        definition: {
          definitionId: "definition-1",
          definitionVersion: 1,
          initialGraph: graph,
          completionPolicy,
          policyRef: { policyId: "policy-1", policyVersion: 1, contentHash: "sha256:abc" },
        },
      },
    } satisfies WorkflowCommandEnvelope;
    const claim = {
      commandId: "claim-command-1",
      workflowId,
      actorPrincipalId: "principal-dev",
      issuedAt: "2026-07-10T01:01:00.000Z",
      payload: {
        type: "claim",
        requestId: "claim-request-1",
        ticketId,
        expectedTicketVersion: 1,
        leaseDurationMs: 30_000,
      },
    } satisfies ClaimCommandEnvelope;

    const acceptTicketCommand = (_command: TicketCommandEnvelope) => undefined;
    const base = {
      commandId: "ticket-command-1",
      proposalId: "proposal-1",
      workflowId,
      ticketId,
      expectedTicketVersion: 2,
      actorPrincipalId: "principal-dev",
      executionRef: "goal-1",
      authority: { kind: "claim", claimId: "claim-1", fencingToken: 2 } as const,
      issuedAt: "2026-07-10T01:02:00.000Z",
    };
    acceptTicketCommand({ ...base, payload: { type: "complete", result: {}, evidence: [] } });
    acceptTicketCommand({ ...base, payload: { type: "block", reason: "Need input" } });
    expect(createGraph.payload.type).toBe("create_graph");
    expect(claim.payload.type).toBe("claim");
    expectTypeOf<TicketCommandResult>().toMatchTypeOf<
      | { accepted: true; commandId: string; proposalId: string }
      | { accepted: false; commandId: string; proposalId: string; reason: string }
    >();
    expectTypeOf<WorkflowCommandResult>().toMatchTypeOf<
      | { accepted: true; commandId: string; workflowVersion: number }
      | { accepted: false; commandId: string; reason: string }
    >();
    expectTypeOf<ClaimCommandResult>().toMatchTypeOf<
      | { accepted: true; commandId: string; receipt: ClaimReceipt }
      | { accepted: false; commandId: string; reason: string }
    >();
  });

  it("requires workflow CAS for graph-changing Ticket commands", () => {
    const acceptReturn = (_command: ReturnToParentTicketCommand) => undefined;
    const acceptCompleteWithGraph = (_command: CompleteWithGraphTicketCommand) => undefined;

    if (false) {
      // @ts-expect-error Returning to a parent changes the graph and requires workflow CAS.
      acceptReturn({ type: "return_to_parent", parentTicketId: "parent" as TicketId, reason: "Defect", evidence: [] });
      // @ts-expect-error Completing with a graph changes the graph and requires workflow CAS.
      acceptCompleteWithGraph({ type: "complete_with_graph", result: {}, evidence: [], graph: { schemaVersion: 2, nodes: [], dependencyEdges: [] }, completionPolicy: { requiredTerminalKeys: [], failurePolicy: "fail_fast", blockedPolicy: "wait" }, cancelTicketIds: [] });
    }
  });

  it("binds Ticket event payloads and cursors to the workflow partition", () => {
    const workflowId = "workflow-1" as WorkflowId<"workflow-1">;
    const otherWorkflowId = "workflow-2" as WorkflowId<"workflow-2">;
    const cursor = {
      source: "ticket",
      partitionId: workflowId,
      position: "21",
    } satisfies TicketEventCursor<typeof workflowId>;
    const query = { workflowId, after: cursor, limit: 100 } satisfies TicketEventQuery<typeof workflowId>;
    const page = { events: [], nextCursor: cursor } satisfies TicketEventPage<TicketEvent, typeof workflowId>;

    expect(query.workflowId).toBe(cursor.partitionId);
    expect(page.nextCursor.position).toBe("21");

    const acceptEvent = (_event: TicketEvent) => undefined;
    const acceptEnvelope = (_event: TicketEventEnvelope) => undefined;
    if (false) {
      // @ts-expect-error Workflow events must use workflow payloads.
      acceptEvent({ eventId: "event-1", workflowId, aggregateType: "workflow", aggregateId: workflowId, aggregateVersion: 1, occurredAt: "2026-07-10T01:03:00.000Z", payload: { type: "TicketReady", ticketId: "ticket-1" as TicketId, ticketVersion: 1 } });
      // @ts-expect-error Ticket events must use Ticket payloads.
      acceptEnvelope({ eventId: "event-2", workflowId, aggregateType: "ticket", aggregateId: "ticket-1" as TicketId, aggregateVersion: 2, occurredAt: "2026-07-10T01:04:00.000Z", payload: { type: "WorkflowStatusChanged", workflowId, status: "active" } });
      // @ts-expect-error Cursor partition must match the queried workflowId.
      const crossWorkflowQuery: TicketEventQuery<typeof workflowId> = { workflowId, after: { source: "ticket", partitionId: otherWorkflowId, position: "22" }, limit: 100 };
      void crossWorkflowQuery;
    }
  });

  it("keeps Ticket command payloads as a closed discriminated union", () => {
    const acceptPayload = (_payload: TicketCommandPayload) => undefined;
    if (false) {
      // @ts-expect-error Ticket Engine does not accept role-directed phase routing commands.
      acceptPayload({ type: "advance_to_role", role: "qa" });
    }
  });
});
