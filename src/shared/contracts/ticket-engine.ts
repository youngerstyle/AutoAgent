declare const ticketIdBrand: unique symbol;
declare const planIdBrand: unique symbol;

export type TicketId<TValue extends string = string> = TValue & {
  readonly [ticketIdBrand]: "TicketId";
};

export type PlanId<TValue extends string = string> = TValue & {
  readonly [planIdBrand]: "PlanId";
};

export type PlanTicketRef = { ticketId: TicketId } | { clientRef: string };

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

export interface TicketDefinition {
  parentTicketId?: TicketId;
  title: string;
  objective: string;
  successCriteria: string[];
  assignment: PlannedTicketAssignment;
  outputContract: TicketOutputContract;
  missionContribution?: {
    missionCriterionIds: string[];
  };
  assurance?: {
    missionCriterionIds: string[];
  };
  contextPolicy?: {
    includeOriginalRequest?: boolean;
    establishesMissionBaseline?: boolean;
  };
  permissions?: {
    amendPlan?: boolean;
    settleMission?: boolean;
  };
}

export interface PlannedTicketNode extends Omit<TicketDefinition, "parentTicketId"> {
  clientRef: string;
  parentTicketId?: TicketId;
}

export interface PlanChangeSet {
  additions: PlannedTicketNode[];
  dependencyAdditions: Array<{
    from: PlanTicketRef;
    to: PlanTicketRef;
  }>;
  cancelTicketIds: TicketId[];
  requiredTerminalRefs: PlanTicketRef[];
}

export interface PlannedTicketGraph {
  schemaVersion: 3;
  nodes: PlannedTicketNode[];
  dependencyEdges: PlanChangeSet["dependencyAdditions"];
}

export interface PlannedPlanCompletionPolicy {
  requiredTerminalRefs: PlanTicketRef[];
  failurePolicy: "fail_fast" | "require_resolution";
  blockedPolicy: "wait";
}

export interface PlanGraphSnapshot {
  schemaVersion: 3;
  ticketIds: TicketId[];
  dependencyEdges: Array<{
    fromTicketId: TicketId;
    toTicketId: TicketId;
  }>;
}

export interface PlanCompletionPolicy {
  requiredTerminalTicketIds: TicketId[];
  failurePolicy: "fail_fast" | "require_resolution";
  blockedPolicy: "wait";
}

export interface PlanPolicyRef {
  policyId: string;
  policyVersion: number;
  contentHash: string;
}

export interface PlanAuthorizationGrant {
  principalId?: string;
  teamBindingId?: string;
  capabilities: string[];
}

export interface PlanAuthorizationPolicy {
  ref: PlanPolicyRef;
  grants: PlanAuthorizationGrant[];
}

export interface PlanPolicyPort {
  getPolicy(ref: PlanPolicyRef): Promise<PlanAuthorizationPolicy | undefined>;
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

export const PLAN_STATUSES = [
  "active",
  "paused",
  "blocked",
  "completed",
  "failed",
  "cancelled",
] as const;

export type PlanStatus = (typeof PLAN_STATUSES)[number];

export interface ClaimReceipt {
  requestId: string;
  claimId: string;
  planId: PlanId;
  ticketId: TicketId;
  ticketVersion: number;
  attemptId: string;
  principalId: string;
  fencingToken: number;
  leaseUntil: string;
}

export interface BlockedOwnershipReceipt {
  ownershipId: string;
  planId: PlanId;
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
  planId: PlanId;
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
  handoff: TicketHandoff;
}

export interface TicketHandoff {
  schemaVersion: 1;
  summary: string;
  output: unknown;
  evidence: TicketEvidenceRef[];
  criterionResults: Array<{
    criterionIndex: number;
    status: "satisfied" | "not_satisfied" | "not_verified";
    evidence: TicketEvidenceRef[];
    note?: string;
  }>;
  residualRisks: string[];
}

export type TicketAttemptStatus =
  | "running"
  | "blocked"
  | "completed"
  | "returned"
  | "failed"
  | "released"
  | "cancelled";

export interface TicketAttempt {
  attemptId: string;
  attemptNumber: number;
  status: TicketAttemptStatus;
  principalId: string;
  executionRef?: string;
  startedAt: string;
  endedAt?: string;
  handoff?: TicketHandoff;
  reason?: string;
  requiredInput?: TicketRequiredInput;
  evidence?: TicketEvidenceRef[];
}

export type TicketRequiredInputKind =
  | "manual_test"
  | "authorization"
  | "credential"
  | "external_fact"
  | "irreversible_confirmation"
  | "tool_policy";

export interface TicketRequiredInput {
  kind: TicketRequiredInputKind;
  description: string;
  details?: Record<string, unknown>;
}

export interface BlockTicketCommand {
  type: "block";
  reason: string;
  requiredInput: TicketRequiredInput;
}

export interface RequestCorrectionCommand {
  type: "request_correction";
  targetTicketId: TicketId;
  reason: string;
  evidence: TicketEvidenceRef[];
}

export interface RequestPlanChangeCommand {
  type: "request_plan_change";
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
  | BlockTicketCommand
  | RequestCorrectionCommand
  | RequestPlanChangeCommand
  | FailTicketCommand;

export interface TicketCommandEnvelope<TPayload extends TicketCommandPayload = TicketCommandPayload> {
  commandId: string;
  proposalId: string;
  planId: PlanId;
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
      ticketStatus: "pending" | "blocked" | "completed" | "failed";
      ticketVersion: number;
      planStatus: PlanStatus;
      planVersion: number;
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
        | "plan_terminal"
        | "idempotency_conflict";
      reason: string;
      currentTicketVersion?: number;
      currentPlanVersion?: number;
    };

export interface PlanDefinition {
  definitionId: string;
  definitionVersion: number;
  initialChange: PlanChangeSet;
  policyRef: PlanPolicyRef;
  plannerAssignment: PlannedTicketAssignment;
  amendmentTemplate: {
    title: string;
    successCriteria: string[];
    outputContract: TicketOutputContract;
  };
}

export type PlanCommand =
  | { type: "create_plan"; missionId: string; definition: PlanDefinition }
  | { type: "pause"; expectedPlanVersion: number }
  | { type: "resume"; expectedPlanVersion: number }
  | { type: "cancel"; expectedPlanVersion: number; reason: string }
  | {
      type: "apply_change";
      expectedPlanVersion: number;
      sourceTicketId: TicketId;
      sourceAuthority: TicketExecutionAuthority;
      change: PlanChangeSet;
    };

export interface PlanCommandEnvelope<TCommand extends PlanCommand = PlanCommand> {
  commandId: string;
  planId: PlanId;
  actorPrincipalId: string;
  issuedAt: string;
  payload: TCommand;
}

export type PlanCommandResult =
  | {
      accepted: true;
      commandId: string;
      planStatus: PlanStatus;
      planVersion: number;
    }
  | {
      accepted: false;
      commandId: string;
      code:
        | "invalid_command"
        | "invalid_definition"
        | "policy_violation"
        | "version_conflict"
        | "plan_terminal"
        | "idempotency_conflict";
      reason: string;
      currentPlanVersion?: number;
    };

export interface ClaimCommandEnvelope {
  commandId: string;
  planId: PlanId;
  actorPrincipalId: string;
  issuedAt: string;
  payload: { type: "claim" } & Omit<ClaimRequest, "planId" | "principalId">;
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
        | "plan_paused"
        | "plan_terminal"
        | "idempotency_conflict";
      reason: string;
      currentTicketVersion?: number;
    };

export interface TicketSnapshot {
  ticketId: TicketId;
  planId: PlanId;
  version: number;
  status: TicketStatus;
  parentTicketId?: TicketId;
  attempts: TicketAttempt[];
  activeAttemptId?: string;
  activeAuthority?: TicketExecutionAuthority;
  completion?: {
    handoff: TicketHandoff;
    completedAt: string;
    actorPrincipalId: string;
    executionRef: string;
  };
}

export interface TicketWorkItem {
  ticket: TicketSnapshot;
  definition: TicketDefinition;
}

export interface PlanSnapshot {
  planId: PlanId;
  missionId: string;
  version: number;
  status: PlanStatus;
  deferredOutcome?: "active" | "blocked" | "completed" | "failed";
  graph: PlanGraphSnapshot;
  completionPolicy: PlanCompletionPolicy;
  policyRef: PlanPolicyRef;
  plannerAssignment: PlannedTicketAssignment;
  amendmentTemplate: PlanDefinition["amendmentTemplate"];
}

export type TicketAggregateEventPayload =
  | { type: "TicketReady"; ticketVersion: number }
  | { type: "TicketClaimed"; claimId: string; attemptId: string; attemptNumber: number }
  | { type: "ClaimExpired"; claimId: string }
  | { type: "TicketBlocked"; requiredInput: TicketRequiredInput }
  | { type: "TicketRetryQueued"; prerequisiteTicketId: TicketId }
  | { type: "TicketReopened"; returnedByTicketId: TicketId; attemptNumber: number }
  | {
      type: "TicketTerminal";
      status: "completed" | "returned" | "failed" | "cancelled";
    }
  | { type: "AuthorityRevoked"; fencingToken: number };

export type PlanAggregateEventPayload = {
  type: "PlanStatusChanged";
  status: PlanStatus;
} | {
  type: "PlanChanged";
  addedTicketIds: TicketId[];
} | {
  type: "PlanAmendmentRequested";
  sourceTicketId: TicketId;
  reason: string;
  amendmentTicketId: TicketId;
} | {
  type: "TicketCorrectionRequested";
  sourceTicketId: TicketId;
  targetTicketId: TicketId;
  reason: string;
};

export interface TicketEventPayloadByAggregate {
  ticket: TicketAggregateEventPayload;
  plan: PlanAggregateEventPayload;
}

export type TicketAggregateType = keyof TicketEventPayloadByAggregate;

type TicketAggregateIdByType = {
  ticket: TicketId;
  plan: PlanId;
};

export type TicketEventEnvelope<
  TAggregate extends TicketAggregateType = TicketAggregateType,
  TPlanId extends PlanId = PlanId,
> = {
  [TCurrentAggregate in TAggregate]: {
    eventId: string;
    planId: TPlanId;
    aggregateType: TCurrentAggregate;
    aggregateId: TicketAggregateIdByType[TCurrentAggregate];
    aggregateVersion: number;
    occurredAt: string;
    payload: TicketEventPayloadByAggregate[TCurrentAggregate];
  };
}[TAggregate];

export type TicketEvent<
  TAggregate extends TicketAggregateType = TicketAggregateType,
  TPlanId extends PlanId = PlanId,
> = TicketEventEnvelope<TAggregate, TPlanId>;

export interface TicketEventCursor<TPlanId extends PlanId = PlanId> {
  source: "ticket";
  partitionId: TPlanId;
  position: string;
}

export interface TicketEventQuery<TPlanId extends PlanId = PlanId> {
  planId: TPlanId;
  after?: TicketEventCursor<NoInfer<TPlanId>>;
  limit: number;
}

export interface TicketEventPage<
  TPlanId extends PlanId = PlanId,
  TEvent extends TicketEvent<TicketAggregateType, TPlanId> = TicketEvent<
    TicketAggregateType,
    TPlanId
  >,
> {
  events: TEvent[];
  nextCursor: TicketEventCursor<TPlanId>;
}
