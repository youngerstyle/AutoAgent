export interface ContextRef {
  kind: string;
  ref: string;
}

export interface OutputContract {
  schemaRef: string;
}

export interface EvidenceRef {
  kind: string;
  ref: string;
}

export type AgentThreadItemKind =
  | "message"
  | "goal"
  | "model"
  | "tool"
  | "observation"
  | "control";

export interface AgentThreadItem {
  itemId: string;
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
  threadId: string;
  goalId?: string;
  senderPrincipalId: string;
  content: string;
  createdAt: string;
}

export interface AgentGoalControlRequest {
  requestId: string;
  goalId: string;
  expectedGoalVersion: number;
  action: "pause" | "resume" | "cancel";
  reason: string;
}

export interface GoalResolutionProposal<TDomainOutcome = unknown> {
  proposalId: string;
  goalId: string;
  expectedGoalVersion: number;
  resolvingGoalVersion: number;
  status: "completed" | "blocked" | "failed";
  summary: string;
  evidence: EvidenceRef[];
  domainOutcome?: TDomainOutcome;
  createdAt: string;
}

export type GoalResolutionDecision =
  | {
      accepted: true;
      committedState: "completed" | "blocked" | "failed";
      domainResult?: unknown;
    }
  | {
      accepted: false;
      disposition: "correctable";
      reason: string;
    }
  | {
      accepted: false;
      disposition: "stale_claim" | "workflow_terminal";
      reason: string;
    }
  | {
      accepted: false;
      disposition: "host_error";
      reason: string;
      incidentId: string;
    };

export type GoalResolutionAttemptResult =
  | { settle: true; decision: GoalResolutionDecision }
  | {
      settle: false;
      pending: "retry_later";
      reason: string;
      retryAfter: string;
    };

export interface GoalResolutionPort<TDomainOutcome = unknown> {
  resolve(
    goal: AgentGoal,
    proposal: GoalResolutionProposal<TDomainOutcome>,
  ): Promise<GoalResolutionAttemptResult>;
}

export interface SettleProposalRequest {
  decisionId: string;
  proposalId: string;
  expectedGoalVersion: number;
  decision: GoalResolutionDecision;
}

export type SettleProposalResult =
  | { applied: true; goal: AgentGoal }
  | {
      applied: false;
      code: "version_conflict" | "goal_terminal" | "idempotency_conflict";
      goal: AgentGoal;
    };

export type AgentEventPayload =
  | { type: "MessageAppended"; threadId: string; messageId: string; sequence: number }
  | { type: "TurnStatusChanged"; threadId: string; turnId: string; status: string }
  | { type: "GoalStatusChanged"; goalId: string; status: AgentGoalStatus }
  | { type: "GoalProposalCreated"; goalId: string; proposalId: string };

export interface AgentEventEnvelope<TPayload extends AgentEventPayload = AgentEventPayload> {
  eventId: string;
  aggregateType: "agent_thread" | "agent_goal";
  aggregateId: string;
  aggregateVersion: number;
  occurredAt: string;
  payload: TPayload;
}

export type AgentEvent = AgentEventEnvelope;

export interface AgentEventCursor {
  source: "agent";
  partitionId: string;
  position: string;
}

export interface AgentEventQuery {
  agentId: string;
  after?: AgentEventCursor;
  limit: number;
}

export interface AgentEventPage<TEvent extends AgentEvent = AgentEvent> {
  events: TEvent[];
  nextCursor: AgentEventCursor;
}

export interface AgentEnginePort<TDomainOutcome = unknown> {
  ensureThread(input: EnsureAgentThreadRequest): Promise<AgentThreadSnapshot>;
  getThreadForAgent(agentId: string, scopeId: string): Promise<AgentThreadSnapshot | undefined>;
  startGoal(input: StartAgentGoalRequest): Promise<AgentGoal>;
  getGoalByStartKey(idempotencyKey: string): Promise<AgentGoal | undefined>;
  getGoal(goalId: string): Promise<AgentGoal | undefined>;
  getProposal(proposalId: string): Promise<GoalResolutionProposal<TDomainOutcome> | undefined>;
  getThread(threadId: string): Promise<AgentThreadSnapshot>;
  sendMessage(input: SendAgentMessageRequest): Promise<void>;
  controlGoal(input: AgentGoalControlRequest): Promise<AgentGoal>;
  settleProposal(input: SettleProposalRequest): Promise<SettleProposalResult>;
  readEvents(input: AgentEventQuery): Promise<AgentEventPage>;
}
