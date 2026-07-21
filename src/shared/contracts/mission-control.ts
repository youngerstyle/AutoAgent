import type {
  BlockedOwnershipReceipt,
  ClaimReceipt,
  ClaimRequest,
  ReleaseClaimRequest,
  RenewClaimRequest,
  TicketCommandEnvelope,
  TicketCommandPayload,
  TicketCommandResult,
  TicketEvent,
  TicketEventPage,
  TicketEventQuery,
  TicketExecutionAuthority,
  TicketId,
  TicketSnapshot,
  TicketWorkItem,
  TransferBlockedOwnershipRequest,
  PlanCommandEnvelope,
  PlanCommandResult,
  PlanDefinition,
  PlanId,
  PlanSnapshot,
} from "./ticket-engine.js";

export type { AgentPort, GoalResolutionPort } from "./agent-engine.js";

export interface TeamBindingMember {
  agentId: string;
  principalId: string;
  capabilities: string[];
}

export interface TeamBinding {
  teamBindingId: string;
  version: number;
  contentHash: string;
  members: TeamBindingMember[];
  deliveryPolicy?: {
    requiredTerminalCapabilities: string[];
  };
}

export interface ResolvedMissionStartBundle {
  planDefinition: PlanDefinition;
  teamBindingId: string;
}

export interface MissionStartRequest {
  missionId: string;
  objective: string;
  resolvedStart: ResolvedMissionStartBundle;
  requestedByPrincipalId: string;
  ownerPrincipalId: string;
  teamBinding: TeamBinding;
}

export interface PlanDefinitionRegistryPort {
  resolve(input: {
    templateId: string;
    templateVersion?: number;
    teamBindingId: string;
    objective: string;
  }): Promise<ResolvedMissionStartBundle>;
}

interface MissionRecordBase {
  missionId: string;
  objective: string;
  planId: PlanId;
  planCreateCommandId: string;
  ownerPrincipalId: string;
  teamBinding: TeamBinding;
  baseline?: MissionBaseline;
}

export interface MissionBaselineCriterion {
  criterionId: string;
  text: string;
}

export interface MissionBaseline {
  baselineId: string;
  version: number;
  objective: string;
  criteria: MissionBaselineCriterion[];
  constraints: string[];
  assumptions: string[];
  exclusions: string[];
  establishedByTicketId: TicketId;
  establishedAt: string;
}

export interface MissionSettlement {
  baselineVersion: number;
  acceptedByTicketId: TicketId;
  acceptedByPrincipalId: string;
  summary: string;
  criterionResults: Array<{
    criterionId: string;
    status: "satisfied";
    evidence: Array<{ kind: string; ref: string; note?: string }>;
  }>;
  residualRisks: string[];
  settledAt: string;
}

export type MissionRecord =
  | (MissionRecordBase & { status: "starting" })
  | (MissionRecordBase & { status: "linked"; linkedAt: string })
  | (MissionRecordBase & { status: "completed"; linkedAt: string; baseline: MissionBaseline; settlement: MissionSettlement })
  | (MissionRecordBase & { status: "start_failed"; failure: string });

interface MissionLinkBase {
  dispatchId: string;
  missionId: string;
  planId: PlanId;
  ticketId: TicketId;
  ticketVersion: number;
  agentId: string;
  agentPrincipalId: string;
  claimRequestId: string;
  goalStartKey: string;
  updatedAt: string;
  claimLeaseUntil?: string;
  lastProposalId?: string;
  lastCommandId?: string;
  lastDecisionId?: string;
}

export type DispatchingMissionLink = MissionLinkBase & {
  status: "dispatching";
  claimLeaseUntil?: never;
  authority?: never;
  agentThreadId?: never;
  agentGoalId?: never;
};

interface StartingMissionLinkBase extends MissionLinkBase {
  status: "starting";
  authority: TicketExecutionAuthority;
}

export type StartingMissionLink =
  | (StartingMissionLinkBase & {
      agentThreadId?: never;
      agentGoalId?: never;
    })
  | (StartingMissionLinkBase & {
      agentThreadId: string;
      agentGoalId?: never;
    })
  | (StartingMissionLinkBase & {
      agentThreadId: string;
      agentGoalId: string;
    });

export type ActiveMissionLink = MissionLinkBase & {
  status: "running" | "blocked" | "resolving" | "paused" | "recovering";
  authority: TicketExecutionAuthority;
  agentThreadId: string;
  agentGoalId: string;
};

export type SettledMissionLink = MissionLinkBase & {
  status: "settled";
  authority: TicketExecutionAuthority;
  agentThreadId: string;
  agentGoalId: string;
  finalTicketVersion: number;
  finalGoalVersion: number;
};

export type CancelledMissionLink = MissionLinkBase & {
  status: "cancelled";
  authority?: TicketExecutionAuthority;
  agentThreadId?: string;
  agentGoalId?: string;
  finalTicketVersion: number;
  finalGoalVersion?: number;
};

export type MissionLink =
  | DispatchingMissionLink
  | StartingMissionLink
  | ActiveMissionLink
  | SettledMissionLink
  | CancelledMissionLink;

export interface MissionProjection {
  missionId: string;
  lifecycle: "starting" | "start_failed" | "linked" | "completed";
  activity: "idle" | "running" | "waiting_for_human";
  planVersion?: number;
}

export interface LegacyPhaseRuntimeRecordEnvelope {
  engine: "legacy_phase";
  schemaVersion: 1;
  record: unknown;
}

export interface TicketAgentRuntimeRecordEnvelope {
  engine: "ticket_agent";
  schemaVersion: 4;
  record: MissionRecord;
}

export type RuntimeRecordEnvelope =
  | LegacyPhaseRuntimeRecordEnvelope
  | TicketAgentRuntimeRecordEnvelope;

export type RuntimeRecordClassification =
  | { kind: "ticket_agent"; schedulable: true }
  | {
      kind: "ticket_agent";
      schedulable: false;
      reason: "start_failed" | "invalid_record";
    }
  | { kind: "legacy_readonly"; schedulable: false };

export type RuntimeRecordVersion =
  | "legacy_phase@1"
  | "ticket_agent@2"
  | "ticket_agent@3"
  | "ticket_agent@4"
  | "undiscriminated_legacy"
  | "unsupported";

function hasString(value: object, key: string): boolean {
  return key in value && typeof (value as Record<string, unknown>)[key] === "string";
}

export function isTicketAgentRuntimeEnvelope(
  input: unknown,
): input is TicketAgentRuntimeRecordEnvelope {
  if (
    typeof input !== "object" ||
    input === null ||
    !("engine" in input) ||
    !("schemaVersion" in input) ||
    input.engine !== "ticket_agent" ||
    input.schemaVersion !== 4 ||
    !("record" in input) ||
    typeof input.record !== "object" ||
    input.record === null
  ) {
    return false;
  }

  const record = input.record;
  if (
    !hasString(record, "missionId") ||
    !hasString(record, "objective") ||
    !hasString(record, "planId") ||
    !hasString(record, "planCreateCommandId") ||
    !hasString(record, "ownerPrincipalId") ||
    !("teamBinding" in record) ||
    !("status" in record)
  ) {
    return false;
  }

  if (record.status === "starting") return true;
  if (record.status === "linked") return hasString(record, "linkedAt");
  if (record.status === "completed") return hasString(record, "linkedAt") && "baseline" in record && "settlement" in record;
  if (record.status === "start_failed") return hasString(record, "failure");
  return false;
}

export function classifyRuntimeRecordVersion(input: unknown): RuntimeRecordVersion {
  if (typeof input !== "object" || input === null || !("engine" in input)) {
    return "undiscriminated_legacy";
  }
  if (!("schemaVersion" in input)) return "unsupported";
  if (input.engine === "legacy_phase" && input.schemaVersion === 1) {
    return "legacy_phase@1";
  }
  if (input.engine === "ticket_agent" && input.schemaVersion === 2) {
    return "ticket_agent@2";
  }
  if (input.engine === "ticket_agent" && input.schemaVersion === 3) {
    return "ticket_agent@3";
  }
  if (input.engine === "ticket_agent" && input.schemaVersion === 4) {
    return "ticket_agent@4";
  }
  return "unsupported";
}

export function classifyRuntimeRecord(input: unknown): RuntimeRecordClassification {
  if (classifyRuntimeRecordVersion(input) !== "ticket_agent@4") {
    return { kind: "legacy_readonly", schedulable: false };
  }

  if (!isTicketAgentRuntimeEnvelope(input)) {
    return { kind: "ticket_agent", schedulable: false, reason: "invalid_record" };
  }
  if (input.record.status === "start_failed") {
    return { kind: "ticket_agent", schedulable: false, reason: "start_failed" };
  }
  return { kind: "ticket_agent", schedulable: true };
}

export interface TicketPort {
  createPlan(command: PlanCommandEnvelope): Promise<PlanCommandResult>;
  applyPlan(command: PlanCommandEnvelope): Promise<PlanCommandResult>;
  getPlan(planId: PlanId): Promise<PlanSnapshot>;
  getTicket(ticketId: TicketId): Promise<TicketSnapshot | undefined>;
  getWorkItem(ticketId: TicketId): Promise<TicketWorkItem | undefined>;
  getClaim(claimId: string): Promise<ClaimReceipt | undefined>;
  getClaimByRequestId(requestId: string): Promise<ClaimReceipt | undefined>;
  getPlanCommandResult(planId: PlanId, commandId: string): Promise<PlanCommandResult | undefined>;
  getTicketCommandResult(planId: PlanId, commandId: string): Promise<TicketCommandResult | undefined>;
  claimReady(input: ClaimRequest): Promise<ClaimReceipt | undefined>;
  renewClaim(input: RenewClaimRequest): Promise<ClaimReceipt>;
  releaseClaim(input: ReleaseClaimRequest): Promise<TicketSnapshot>;
  transferBlockedOwnership(
    input: TransferBlockedOwnershipRequest,
  ): Promise<BlockedOwnershipReceipt>;
  applyTicket(
    command: TicketCommandEnvelope<TicketCommandPayload>,
  ): Promise<TicketCommandResult>;
  readEvents<TPlanId extends PlanId>(
    input: TicketEventQuery<TPlanId>,
  ): Promise<TicketEventPage<TPlanId, TicketEvent<"ticket" | "plan", TPlanId>>>;
}
