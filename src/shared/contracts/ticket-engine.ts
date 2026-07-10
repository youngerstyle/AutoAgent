declare const ticketNodeKeyBrand: unique symbol;
declare const ticketIdBrand: unique symbol;
declare const workflowIdBrand: unique symbol;

export type TicketNodeKey<TValue extends string = string> = TValue & {
  readonly [ticketNodeKeyBrand]: "TicketNodeKey";
};

export type TicketId<TValue extends string = string> = TValue & {
  readonly [ticketIdBrand]: "TicketId";
};

export type WorkflowId<TValue extends string = string> = TValue & {
  readonly [workflowIdBrand]: "WorkflowId";
};

export interface TicketOutputContract {
  schemaRef: string;
}

export interface TicketEvidenceRef {
  kind: string;
  ref: string;
}

export interface PlannedTicketAssignment {
  principalId?: string;
  requiredCapabilities?: string[];
}

export interface PlannedTicketNode {
  key: TicketNodeKey;
  parentKey?: TicketNodeKey;
  revisionOfKey?: TicketNodeKey;
  title: string;
  objective: string;
  successCriteria: string[];
  assignment: PlannedTicketAssignment;
  outputContract: TicketOutputContract;
}

export interface PlannedTicketGraph {
  schemaVersion: 2;
  nodes: PlannedTicketNode[];
  dependencyEdges: Array<{
    fromKey: TicketNodeKey;
    toKey: TicketNodeKey;
  }>;
}

export interface PlannedWorkflowCompletionPolicy {
  requiredTerminalKeys: TicketNodeKey[];
  failurePolicy: "fail_fast" | "require_resolution";
  blockedPolicy: "wait";
}

export interface TicketGraphNodeSnapshot {
  nodeKey: TicketNodeKey;
  ticketId: TicketId;
  active: boolean;
  revisionOfTicketId?: TicketId;
  supersededByTicketId?: TicketId;
}

export interface TicketGraphSnapshot {
  schemaVersion: 2;
  nodes: TicketGraphNodeSnapshot[];
  dependencyEdges: Array<{
    fromTicketId: TicketId;
    toTicketId: TicketId;
  }>;
}

export interface WorkflowCompletionPolicy {
  requiredTerminalTicketIds: TicketId[];
  failurePolicy: "fail_fast" | "require_resolution";
  blockedPolicy: "wait";
}

export interface WorkflowPolicyRef {
  policyId: string;
  policyVersion: number;
  contentHash: string;
}

export interface WorkflowAuthorizationGrant {
  principalId?: string;
  teamBindingId?: string;
  capabilities: string[];
}

export interface WorkflowAuthorizationPolicy {
  ref: WorkflowPolicyRef;
  grants: WorkflowAuthorizationGrant[];
}

export interface WorkflowPolicyPort {
  getPolicy(ref: WorkflowPolicyRef): Promise<WorkflowAuthorizationPolicy | undefined>;
}

export const TICKET_STATUSES = [
  "pending",
  "ready",
  "running",
  "blocked",
  "completed",
  "returned",
  "failed",
  "cancelled",
] as const;

export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const WORKFLOW_STATUSES = [
  "active",
  "paused",
  "blocked",
  "completed",
  "failed",
  "cancelled",
] as const;

export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

export interface ClaimReceipt {
  requestId: string;
  claimId: string;
  workflowId: WorkflowId;
  ticketId: TicketId;
  ticketVersion: number;
  principalId: string;
  fencingToken: number;
  leaseUntil: string;
}

export interface BlockedOwnershipReceipt {
  ownershipId: string;
  workflowId: WorkflowId;
  ticketId: TicketId;
  ticketVersion: number;
  principalId: string;
  fencingToken: number;
}

export type TicketExecutionAuthority =
  | { kind: "claim"; claimId: string; fencingToken: number }
  | { kind: "blocked_owner"; ownershipId: string; fencingToken: number };

export interface ClaimRequest {
  requestId: string;
  workflowId: WorkflowId;
  ticketId: TicketId;
  expectedTicketVersion: number;
  principalId: string;
  leaseDurationMs: number;
}

export interface RenewClaimRequest {
  requestId: string;
  claimId: string;
  fencingToken: number;
  extendByMs: number;
}

export interface ReleaseClaimRequest {
  requestId: string;
  claimId: string;
  fencingToken: number;
  reason: "goal_cancelled" | "agent_unavailable" | "operator_release";
}

export interface TransferBlockedOwnershipRequest {
  requestId: string;
  ownershipId: string;
  fencingToken: number;
  toPrincipalId: string;
}

export interface CompleteTicketCommand {
  type: "complete";
  result: unknown;
  evidence: TicketEvidenceRef[];
}

export interface CompleteWithGraphTicketCommand {
  type: "complete_with_graph";
  result: unknown;
  evidence: TicketEvidenceRef[];
  expectedWorkflowVersion: number;
  graph: PlannedTicketGraph;
  completionPolicy: PlannedWorkflowCompletionPolicy;
  cancelTicketIds: TicketId[];
}

export interface BlockTicketCommand {
  type: "block";
  reason: string;
  requiredInput?: string;
}

export interface ReturnToParentTicketCommand {
  type: "return_to_parent";
  parentTicketId: TicketId;
  expectedWorkflowVersion: number;
  reason: string;
  evidence: TicketEvidenceRef[];
}

export interface FailTicketCommand {
  type: "fail";
  reason: string;
  evidence: TicketEvidenceRef[];
}

export type TicketCommandPayload =
  | CompleteTicketCommand
  | CompleteWithGraphTicketCommand
  | BlockTicketCommand
  | ReturnToParentTicketCommand
  | FailTicketCommand;

export interface TicketCommandEnvelope<TPayload extends TicketCommandPayload = TicketCommandPayload> {
  commandId: string;
  proposalId: string;
  workflowId: WorkflowId;
  ticketId: TicketId;
  expectedTicketVersion: number;
  actorPrincipalId: string;
  executionRef: string;
  authority: TicketExecutionAuthority;
  issuedAt: string;
  payload: TPayload;
}

export type TicketCommandResult =
  | {
      accepted: true;
      commandId: string;
      proposalId: string;
      ticketStatus: "blocked" | "completed" | "returned" | "failed";
      ticketVersion: number;
      workflowStatus: WorkflowStatus;
      workflowVersion: number;
      nextAuthority?: TicketExecutionAuthority;
    }
  | {
      accepted: false;
      commandId: string;
      proposalId: string;
      code:
        | "invalid_command"
        | "policy_violation"
        | "version_conflict"
        | "stale_authority"
        | "workflow_terminal"
        | "idempotency_conflict";
      reason: string;
      currentTicketVersion?: number;
      currentWorkflowVersion?: number;
    };

export interface WorkflowDefinition {
  definitionId: string;
  definitionVersion: number;
  initialGraph: PlannedTicketGraph;
  completionPolicy: PlannedWorkflowCompletionPolicy;
  policyRef: WorkflowPolicyRef;
}

export type WorkflowCommand =
  | { type: "create_graph"; definition: WorkflowDefinition }
  | { type: "pause"; expectedWorkflowVersion: number }
  | { type: "resume"; expectedWorkflowVersion: number }
  | { type: "cancel"; expectedWorkflowVersion: number; reason: string }
  | {
      type: "amend";
      expectedWorkflowVersion: number;
      graph: PlannedTicketGraph;
      completionPolicy: PlannedWorkflowCompletionPolicy;
      cancelTicketIds: TicketId[];
    };

export interface WorkflowCommandEnvelope<TCommand extends WorkflowCommand = WorkflowCommand> {
  commandId: string;
  workflowId: WorkflowId;
  actorPrincipalId: string;
  issuedAt: string;
  payload: TCommand;
}

export type WorkflowCommandResult =
  | {
      accepted: true;
      commandId: string;
      workflowStatus: WorkflowStatus;
      workflowVersion: number;
    }
  | {
      accepted: false;
      commandId: string;
      code:
        | "invalid_command"
        | "invalid_definition"
        | "policy_violation"
        | "version_conflict"
        | "workflow_terminal"
        | "idempotency_conflict";
      reason: string;
      currentWorkflowVersion?: number;
    };

export interface ClaimCommandEnvelope {
  commandId: string;
  workflowId: WorkflowId;
  actorPrincipalId: string;
  issuedAt: string;
  payload: { type: "claim" } & Omit<ClaimRequest, "workflowId" | "principalId">;
}

export type ClaimCommandResult =
  | { accepted: true; commandId: string; receipt: ClaimReceipt }
  | {
      accepted: false;
      commandId: string;
      code:
        | "not_ready"
        | "policy_violation"
        | "version_conflict"
        | "workflow_paused"
        | "workflow_terminal"
        | "idempotency_conflict";
      reason: string;
      currentTicketVersion?: number;
    };

export interface TicketSnapshot {
  ticketId: TicketId;
  workflowId: WorkflowId;
  version: number;
  status: TicketStatus;
  parentTicketId?: TicketId;
  activeAuthority?: TicketExecutionAuthority;
}

export interface TicketWorkItem {
  ticket: TicketSnapshot;
  definition: PlannedTicketNode;
}

export interface WorkflowSnapshot {
  workflowId: WorkflowId;
  version: number;
  status: WorkflowStatus;
  deferredOutcome?: "active" | "blocked" | "completed" | "failed";
  graph: TicketGraphSnapshot;
  completionPolicy: WorkflowCompletionPolicy;
  policyRef: WorkflowPolicyRef;
}

export type TicketAggregateEventPayload =
  | { type: "TicketReady"; ticketVersion: number }
  | { type: "TicketClaimed"; claimId: string }
  | { type: "ClaimExpired"; claimId: string }
  | { type: "TicketBlocked"; requiredInput?: string }
  | {
      type: "TicketTerminal";
      status: "completed" | "returned" | "failed" | "cancelled";
    }
  | { type: "AuthorityRevoked"; fencingToken: number };

export type WorkflowAggregateEventPayload = {
  type: "WorkflowStatusChanged";
  status: WorkflowStatus;
};

export interface TicketEventPayloadByAggregate {
  ticket: TicketAggregateEventPayload;
  workflow: WorkflowAggregateEventPayload;
}

export type TicketAggregateType = keyof TicketEventPayloadByAggregate;

type TicketAggregateIdByType = {
  ticket: TicketId;
  workflow: WorkflowId;
};

export type TicketEventEnvelope<
  TAggregate extends TicketAggregateType = TicketAggregateType,
  TWorkflowId extends WorkflowId = WorkflowId,
> = {
  [TCurrentAggregate in TAggregate]: {
    eventId: string;
    workflowId: TWorkflowId;
    aggregateType: TCurrentAggregate;
    aggregateId: TicketAggregateIdByType[TCurrentAggregate];
    aggregateVersion: number;
    occurredAt: string;
    payload: TicketEventPayloadByAggregate[TCurrentAggregate];
  };
}[TAggregate];

export type TicketEvent<
  TAggregate extends TicketAggregateType = TicketAggregateType,
  TWorkflowId extends WorkflowId = WorkflowId,
> = TicketEventEnvelope<TAggregate, TWorkflowId>;

export interface TicketEventCursor<TWorkflowId extends WorkflowId = WorkflowId> {
  source: "ticket";
  partitionId: TWorkflowId;
  position: string;
}

export interface TicketEventQuery<TWorkflowId extends WorkflowId = WorkflowId> {
  workflowId: TWorkflowId;
  after?: TicketEventCursor<NoInfer<TWorkflowId>>;
  limit: number;
}

export interface TicketEventPage<
  TWorkflowId extends WorkflowId = WorkflowId,
  TEvent extends TicketEvent<TicketAggregateType, TWorkflowId> = TicketEvent<
    TicketAggregateType,
    TWorkflowId
  >,
> {
  events: TEvent[];
  nextCursor: TicketEventCursor<TWorkflowId>;
}
