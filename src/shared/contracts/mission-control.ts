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
  TransferBlockedOwnershipRequest,
  WorkflowCommandEnvelope,
  WorkflowCommandResult,
  WorkflowDefinition,
  WorkflowId,
  WorkflowSnapshot,
  WorkflowStatus,
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
}

export interface ResolvedMissionStartBundle {
  workflowDefinition: WorkflowDefinition;
  teamBindingId: string;
}

export interface MissionStartRequest {
  missionId: string;
  objective: string;
  resolvedStart: ResolvedMissionStartBundle;
  requestedByPrincipalId: string;
}

export interface WorkflowDefinitionRegistryPort {
  resolve(input: {
    templateId: string;
    templateVersion?: number;
    teamBindingId: string;
  }): Promise<ResolvedMissionStartBundle>;
}

interface MissionRecordBase {
  missionId: string;
  workflowId: WorkflowId;
  workflowCreateCommandId: string;
}

export type MissionRecord =
  | (MissionRecordBase & { status: "starting" })
  | (MissionRecordBase & { status: "linked"; linkedAt: string })
  | (MissionRecordBase & { status: "start_failed"; failure: string });

interface MissionLinkBase {
  dispatchId: string;
  missionId: string;
  workflowId: WorkflowId;
  ticketId: TicketId;
  ticketVersion: number;
  agentId: string;
  agentPrincipalId: string;
  claimRequestId: string;
  goalStartKey: string;
  updatedAt: string;
  lastProposalId?: string;
  lastCommandId?: string;
  lastDecisionId?: string;
}

export type DispatchingMissionLink = MissionLinkBase & {
  status: "dispatching";
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

export type TerminalMissionLink = MissionLinkBase & {
  status: "settled" | "cancelled";
  authority: TicketExecutionAuthority;
  agentThreadId: string;
  agentGoalId: string;
  finalTicketVersion: number;
  finalGoalVersion: number;
};

export type MissionLink =
  | DispatchingMissionLink
  | StartingMissionLink
  | ActiveMissionLink
  | TerminalMissionLink;

export interface MissionProjection {
  missionId: string;
  lifecycle: "starting" | "start_failed" | WorkflowStatus;
  activity: "idle" | "running" | "waiting_for_human";
  workflowVersion?: number;
}

export interface LegacyPhaseRuntimeRecordEnvelope {
  engine: "legacy_phase";
  schemaVersion: 1;
  record: unknown;
}

export interface TicketAgentRuntimeRecordEnvelope {
  engine: "ticket_agent";
  schemaVersion: 2;
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
    input.schemaVersion !== 2 ||
    !("record" in input) ||
    typeof input.record !== "object" ||
    input.record === null
  ) {
    return false;
  }

  const record = input.record;
  if (
    !hasString(record, "missionId") ||
    !hasString(record, "workflowId") ||
    !hasString(record, "workflowCreateCommandId") ||
    !("status" in record)
  ) {
    return false;
  }

  if (record.status === "starting") return true;
  if (record.status === "linked") return hasString(record, "linkedAt");
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
  return "unsupported";
}

export function classifyRuntimeRecord(input: unknown): RuntimeRecordClassification {
  if (classifyRuntimeRecordVersion(input) !== "ticket_agent@2") {
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
  createWorkflow(command: WorkflowCommandEnvelope): Promise<WorkflowCommandResult>;
  applyWorkflow(command: WorkflowCommandEnvelope): Promise<WorkflowCommandResult>;
  getWorkflow(workflowId: WorkflowId): Promise<WorkflowSnapshot>;
  getTicket(ticketId: TicketId): Promise<TicketSnapshot | undefined>;
  getClaim(claimId: string): Promise<ClaimReceipt | undefined>;
  getClaimByRequestId(requestId: string): Promise<ClaimReceipt | undefined>;
  getWorkflowCommandResult(commandId: string): Promise<WorkflowCommandResult | undefined>;
  getTicketCommandResult(commandId: string): Promise<TicketCommandResult | undefined>;
  claimReady(input: ClaimRequest): Promise<ClaimReceipt | undefined>;
  renewClaim(input: RenewClaimRequest): Promise<ClaimReceipt>;
  releaseClaim(input: ReleaseClaimRequest): Promise<TicketSnapshot>;
  transferBlockedOwnership(
    input: TransferBlockedOwnershipRequest,
  ): Promise<BlockedOwnershipReceipt>;
  applyTicket(
    command: TicketCommandEnvelope<TicketCommandPayload>,
  ): Promise<TicketCommandResult>;
  readEvents<TWorkflowId extends WorkflowId>(
    input: TicketEventQuery<TWorkflowId>,
  ): Promise<TicketEventPage<TWorkflowId, TicketEvent<"ticket" | "workflow", TWorkflowId>>>;
}
