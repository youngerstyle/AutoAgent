export interface ContextRef {
  kind: string;
  ref: string;
}

export interface OutputContract {
  schemaRef: string;
  /**
   * Controls the generic evidence envelope at the Agent Engine boundary.
   * Domain adapters still own the meaning of the domain result.
   */
  evidenceMode?: "required" | "optional" | "none";
  /**
   * False when an unsuccessful outcome must use a typed workflow action
   * (correction, plan change, or human input) instead of a generic failure.
   */
  allowFailedResolution?: boolean;
  completionOutcomeSchema?: Record<string, unknown>;
  correctionOutcomeSchema?: Record<string, unknown>;
  planChangeOutcomeSchema?: Record<string, unknown>;
}

export interface EvidenceRef {
  evidenceId: string;
}

export type EvidenceKind =
  | "file_read"
  | "file_write"
  | "command"
  | "service"
  | "image"
  | "browser"
  | "tool";

export interface EvidenceArtifactFact {
  path: string;
  size: number;
  modifiedAt: string;
  sha256: string;
}

export interface EvidenceFact {
  evidenceId: string;
  agentId: string;
  threadId: string;
  goalId?: string;
  attemptId?: string;
  turnId: string;
  toolCallId: string;
  toolName: string;
  kind: EvidenceKind;
  capture: {
    status: "recorded" | "unavailable";
    error?: {
      category: "tool" | "policy" | "transport" | "timeout";
      message: string;
    };
  };
  observation: {
    status: "observed" | "not_observed";
    result: unknown;
  };
  workspaceRoot: string;
  createdAt: string;
  input: unknown;
  artifact?: EvidenceArtifactFact;
}

export type AgentThreadItemKind =
  | "message"
  | "goal"
  | "model"
  | "tool"
  | "observation"
  | "compaction"
  | "control";

export interface AgentThreadItem {
  itemId: string;
  turnId?: string;
  sequence: number;
  kind: AgentThreadItemKind;
  createdAt: string;
  payloadRef: string;
}

export interface AgentThreadSnapshot {
  threadId: string;
  agentId: string;
  scopeId: string;
  version: number;
  items: AgentThreadItem[];
}

export interface EnsureAgentThreadRequest {
  agentId: string;
  scopeId: string;
  idempotencyKey: string;
}

export interface AgentGoalSpec {
  id: string;
  threadId: string;
  objective: string;
  successCriteria: string[];
  contextRefs: ContextRef[];
  outputContract?: OutputContract;
  externalRef?: string;
  attemptId?: string;
  evidencePolicy?: {
    inheritedEvidenceIds: string[];
  };
  createdAt: string;
}

export const AGENT_GOAL_STATUSES = [
  "active",
  "paused",
  "blocked",
  "resolving",
  "completed",
  "failed",
  "cancelled",
  "budget_limited",
  "usage_limited",
] as const;

export type AgentGoalStatus = (typeof AGENT_GOAL_STATUSES)[number];

export interface AgentGoal {
  spec: AgentGoalSpec;
  version: number;
  status: AgentGoalStatus;
  activeProposalId?: string;
  updatedAt: string;
}

export interface StartAgentGoalRequest {
  agentId: string;
  threadId: string;
  spec: AgentGoalSpec;
  idempotencyKey: string;
}

export interface SendAgentMessageRequest {
  messageId: string;
  turnId?: string;
  threadId: string;
  goalId?: string;
  senderPrincipalId: string;
  deliveryKind?: "turn" | "context";
  content: string;
  attachments?: AgentMessageAttachment[];
  createdAt: string;
}

export interface AgentMessageAttachment {
  attachmentId: string;
  type: "image";
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  fileName: string;
  size: number;
}

export interface AgentGoalControlRequest {
  requestId: string;
  goalId: string;
  expectedGoalVersion: number;
  action: "pause" | "limit_usage" | "resume" | "cancel";
  reason: string;
}

export type GoalResolutionStatus = "completed" | "blocked" | "failed";

export const AGENT_HUMAN_INPUT_KINDS = [
  "manual_test",
  "authorization",
  "credential",
  "external_fact",
  "irreversible_confirmation",
  "tool_policy",
] as const;

export type AgentHumanInputKind = (typeof AGENT_HUMAN_INPUT_KINDS)[number];

export interface AgentHumanInputRequest {
  kind: AgentHumanInputKind;
  description: string;
  details?: Record<string, unknown>;
}

export interface GoalCriterionResult {
  criterionIndex: number;
  status: "satisfied" | "not_satisfied" | "not_verified";
  evidence: EvidenceRef[];
  note?: string;
}

export interface GoalResolutionProposal<
  TStatus extends GoalResolutionStatus = GoalResolutionStatus,
  TDomainOutcome = unknown,
> {
  proposalId: string;
  turnId?: string;
  goalId: string;
  expectedGoalVersion: number;
  resolvingGoalVersion: number;
  status: TStatus;
  summary: string;
  evidence: EvidenceRef[];
  criterionResults: GoalCriterionResult[];
  residualRisks: string[];
  domainOutcome?: TDomainOutcome;
  humanInputRequest?: AgentHumanInputRequest;
  createdAt: string;
}

export type GoalResolutionDecision<TStatus extends GoalResolutionStatus = GoalResolutionStatus> =
  | {
      accepted: true;
      committedState: TStatus;
      domainResult?: unknown;
    }
  | {
      accepted: false;
      disposition: "correctable";
      reason: string;
    }
  | {
      accepted: false;
      disposition: "stale_claim" | "plan_terminal";
      reason: string;
    }
  | {
      accepted: false;
      disposition: "host_error";
      reason: string;
      incidentId: string;
    };

export type GoalResolutionAttemptResult<TStatus extends GoalResolutionStatus = GoalResolutionStatus> =
  | { settle: true; decision: GoalResolutionDecision<TStatus> }
  | {
      settle: false;
      pending: "retry_later";
      reason: string;
      retryAfter: string;
    };

export interface GoalResolutionPort<TDomainOutcome = unknown> {
  resolve<TStatus extends GoalResolutionStatus>(
    goal: AgentGoal,
    proposal: GoalResolutionProposal<TStatus, TDomainOutcome>,
  ): Promise<GoalResolutionAttemptResult<TStatus>>;
}

export interface SettleProposalRequest<TStatus extends GoalResolutionStatus = GoalResolutionStatus> {
  decisionId: string;
  proposalId: string;
  expectedGoalVersion: number;
  decision: GoalResolutionDecision<TStatus>;
}

export type SettleProposalResult =
  | { applied: true; goal: AgentGoal }
  | {
      applied: false;
      code: "version_conflict" | "goal_terminal" | "idempotency_conflict";
      goal: AgentGoal;
    };

export type AgentThreadEventPayload =
  | { type: "MessageAppended"; threadId: string; messageId: string; turnId?: string; sequence: number }
  | { type: "TurnStatusChanged"; threadId: string; turnId: string; status: string };

export type AgentGoalEventPayload =
  | { type: "GoalStatusChanged"; goalId: string; status: AgentGoalStatus }
  | { type: "GoalProposalCreated"; goalId: string; proposalId: string }
  | { type: "GoalSettlementRequested"; goalId: string; proposalId: string };

export interface AgentEventPayloadByAggregate {
  agent_thread: AgentThreadEventPayload;
  agent_goal: AgentGoalEventPayload;
}

export type AgentAggregateType = keyof AgentEventPayloadByAggregate;
export type AgentEventPayload = AgentEventPayloadByAggregate[AgentAggregateType];

export type AgentEventEnvelope<TAggregateType extends AgentAggregateType = AgentAggregateType> = {
  [TCurrentAggregate in TAggregateType]: {
    eventId: string;
    aggregateType: TCurrentAggregate;
    aggregateId: string;
    aggregateVersion: number;
    occurredAt: string;
    payload: AgentEventPayloadByAggregate[TCurrentAggregate];
  };
}[TAggregateType];

export type AgentEvent<TAggregateType extends AgentAggregateType = AgentAggregateType> =
  AgentEventEnvelope<TAggregateType>;

export interface AgentEventCursor<TAgentId extends string = string> {
  source: "agent";
  partitionId: TAgentId;
  position: string;
}

export interface AgentEventQuery<TAgentId extends string = string> {
  agentId: TAgentId;
  after?: AgentEventCursor<NoInfer<TAgentId>>;
  limit: number;
}

export interface AgentEventPage<
  TEvent extends AgentEvent = AgentEvent,
  TAgentId extends string = string,
> {
  events: TEvent[];
  nextCursor: AgentEventCursor<TAgentId>;
}

export interface AgentPort<TDomainOutcome = unknown> {
  ensureThread(input: EnsureAgentThreadRequest): Promise<AgentThreadSnapshot>;
  getThreadForAgent(agentId: string, scopeId: string): Promise<AgentThreadSnapshot | undefined>;
  startGoal(input: StartAgentGoalRequest): Promise<AgentGoal>;
  getGoalByStartKey(idempotencyKey: string): Promise<AgentGoal | undefined>;
  getGoal(goalId: string): Promise<AgentGoal | undefined>;
  getProposal(
    proposalId: string,
  ): Promise<GoalResolutionProposal<GoalResolutionStatus, TDomainOutcome> | undefined>;
  hasPendingHumanTurn?(goalId: string, excludingTurnId?: string): Promise<boolean>;
  retryProposalResolution(
    proposalId: string,
  ): Promise<{ goal: AgentGoal; attempt: GoalResolutionAttemptResult }>;
  getThread(threadId: string): Promise<AgentThreadSnapshot>;
  sendMessage(input: SendAgentMessageRequest): Promise<boolean>;
  controlGoal(input: AgentGoalControlRequest): Promise<AgentGoal>;
  settleProposal<TStatus extends GoalResolutionStatus>(
    input: SettleProposalRequest<TStatus>,
  ): Promise<SettleProposalResult>;
  readEvents<TAgentId extends string>(
    input: AgentEventQuery<TAgentId>,
  ): Promise<AgentEventPage<AgentEvent, TAgentId>>;
}
