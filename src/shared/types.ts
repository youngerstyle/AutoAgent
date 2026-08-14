import type { AutoAgentEventType } from "./events.js";

export type PolicyProfile = "development" | "production";
export type EntityStatus =
  | "idle"
  | "running"
  | "waiting"
  | "paused"
  | "completed"
  | "failed"
  | "blocked"
  | "interrupted";

export type AgentRole = "boss" | "pm" | "architect" | "dev" | "qa" | "specialist";
export type ProviderName = "mock" | "openai" | "anthropic";
export type WorkspaceToolName = "listFiles" | "readFile" | "readImage" | "writeFile" | "editFile" | "shell" | "startService" | "pollProcess" | "browser";

export interface Workspace {
  id: string;
  name: string;
  rootPath: string;
  policyProfile: PolicyProfile;
  createdAt: string;
  organization?: {
    id: string;
    /** Source workspaces this workspace explicitly allows to inject organization Memory. */
    trustedMemoryWorkspaceIds: string[];
  };
}

export interface AgentPolicy {
  canReadWorkspace: boolean;
  canWriteWorkspace: boolean;
  canExecuteCommands: boolean;
  enabledTools?: WorkspaceToolName[];
  allowHostAccess?: boolean;
  commandAllowlist?: string[];
}

export interface AgentProfile {
  id: string;
  name: string;
  role: AgentRole;
  contentVersion?: number;
  identity?: string;
  soul?: string;
  agentMd?: string;
  capabilities: string[];
  defaultSkills?: string[];
  defaultProvider: ProviderName;
  defaultModel: string;
  defaultPolicy: Partial<AgentPolicy>;
}

export interface WorkspaceAgent {
  id: string;
  workspaceId: string;
  profileId: string;
  roleInWorkspace: AgentRole;
  agentDir: string;
  status: EntityStatus;
  provider?: ProviderName;
  model?: string;
  skillOverrides?: string[];
  policyOverride?: Partial<AgentPolicy>;
}

export interface Task {
  id: string;
  workspaceId: string;
  title: string;
  goal: string;
  status: EntityStatus;
  createdBy: "user" | "agent";
  activeTaskRunId?: string;
}

export interface TaskRun {
  id: string;
  taskId: string;
  workspaceId: string;
  status: EntityStatus;
  phase: MissionPhase;
  startedAt: string;
  endedAt?: string;
}

export type AssignmentType =
  | "work"
  | "boss_intake"
  | "pm_plan"
  | "architect_plan"
  | "implementation"
  | "qa"
  | "boss_acceptance"
  | "specialist";

export interface Assignment {
  id: string;
  taskId: string;
  taskRunId: string;
  ownerWorkspaceAgentId: string;
  type: AssignmentType;
  brief: string;
  expectedArtifact: string;
  status: EntityStatus;
}

export type TicketStatus =
  | "pending"
  | "running"
  | "blocked"
  | "completed"
  | "returned"
  | "failed"
  | "dead_letter"
  | "cancelled";

export type TicketType = AssignmentType | "rework" | "human_action";

export type TicketMessageStatus = "pending" | "claimed" | "acked" | "expired" | "dead_letter" | "cancelled";

export type TicketBlockerType =
  | "manual_test_required"
  | "human_authorization_required"
  | "waiting_for_agent_capacity"
  | "tool_policy_blocked"
  | "agent_stalled"
  | "external_dependency";

export interface TicketBlocker {
  type: TicketBlockerType;
  reason: string;
  details?: Record<string, unknown>;
}

export interface Ticket {
  id: string;
  workspaceId: string;
  taskId: string;
  taskRunId: string;
  type: TicketType;
  status: TicketStatus;
  brief: string;
  expectedArtifact: string;
  targetAgentId?: string;
  targetRole?: AgentRole;
  capabilityTags?: string[];
  priority: number;
  attempt: number;
  leaseUntil?: string;
  parentTicketId?: string;
  createdByTicketId?: string;
  plannedByTicketId?: string;
  dependsOnTicketIds?: string[];
  artifactRefs?: string[];
  blocker?: TicketBlocker;
  returnReason?: string;
  result?: unknown;
  execution?: TicketExecutionState;
  createdAt: string;
  updatedAt: string;
}

export interface TicketExecutionState {
  sliceStatus?: "idle" | "running" | "yielded";
  yieldedAt?: string;
  yieldReason?: string;
  continuationCount?: number;
  lastAssignmentRunId?: string;
  nextRunAfter?: string;
}

export interface AgentInboxMessage {
  id: string;
  workspaceId: string;
  ticketId: string;
  toAgentId?: string;
  toRole?: AgentRole;
  status: TicketMessageStatus;
  dedupeKey: string;
  correlationId: string;
  priority: number;
  claimedByAgentId?: string;
  leaseUntil?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentDirectMessage {
  id: string;
  agentId: string;
  taskId: string;
  taskRunId: string;
  message: string;
  createdBy: "human";
  createdAt: string;
  handledAt?: string;
  failedAt?: string;
  response?: string;
  error?: string;
}

export type AgentThreadEventSource = "human" | "agent" | "platform" | "tool" | "system";

export type AgentThreadEventKind =
  | "human_message"
  | "agent_message"
  | "turn_failed"
  | "ticket_received"
  | "ticket_claimed"
  | "ticket_outcome"
  | "tool_observation"
  | "system_note";

export type AgentThreadVisibility = "chat" | "timeline" | "debug";

export interface AgentThreadEvent<TPayload = Record<string, unknown>> {
  id: string;
  turnId?: string;
  taskId: string;
  taskRunId: string;
  workspaceAgentId: string;
  sequence: number;
  timestamp: string;
  source: AgentThreadEventSource;
  kind: AgentThreadEventKind;
  visibility: AgentThreadVisibility;
  ticketId?: string;
  assignmentRunId?: string;
  humanMessageId?: string;
  traceId?: string;
  payload: TPayload;
}

export interface AssignmentRun {
  id: string;
  taskId: string;
  taskRunId: string;
  assignmentId: string;
  workspaceAgentId: string;
  status: EntityStatus;
  startedAt: string;
  endedAt?: string;
}

export interface AutoAgentEvent<TPayload = Record<string, unknown>> {
  id: string;
  workspaceId: string;
  taskId?: string;
  taskRunId?: string;
  assignmentRunId?: string;
  actorId?: string;
  type: AutoAgentEventType;
  summary: string;
  payload: TPayload;
  timestamp: string;
  sequence?: number;
  workspaceSequence?: number;
}

export type MissionPhase =
  | "idle"
  | "running"
  | "blocked"
  | "boss_intake"
  | "pm_plan"
  | "architect_plan"
  | "implementation"
  | "qa"
  | "boss_acceptance"
  | "paused"
  | "completed"
  | "failed"
  | "interrupted";

export interface WorkspaceSnapshot {
  workspace: Workspace;
  mission?: {
    missionId: string;
    planId: string;
    planStatus: "active" | "paused" | "blocked" | "completed" | "failed" | "cancelled";
    planVersion: number;
  };
  consistency?: {
    state: "consistent" | "reconciling";
    asOf: {
      planVersion: number;
      missionVersion: number;
      ticketVersions: Record<string, number>;
      goalVersions: Record<string, number>;
    };
    issues: Array<{
      code: string;
      message: string;
      ticketId?: string;
      agentId?: string;
    }>;
  };
  activeTask?: Task;
  activeTaskRun?: TaskRun;
  agents: Array<WorkspaceAgent & {
    name?: string;
    role?: AgentRole;
    capabilities?: string[];
    currentStep?: string;
  }>;
  assignments: Assignment[];
  tickets?: Ticket[];
  inboxMessages?: AgentInboxMessage[];
  agentMessages?: Record<string, AgentDirectMessage[]>;
  agentThreads?: Record<string, AgentThreadEvent[]>;
  recentEvents: AutoAgentEvent[];
  phase: MissionPhase;
  status: EntityStatus;
  currentStep?: string;
  readOnlyReason?: string;
  runtimeError?: {
    source: "scheduler" | "staffing" | "agent_turn";
    message: string;
    at: string;
    agentId?: string;
    turnId?: string;
  };
  humanLoop?: {
    latestReply?: {
      agentId?: string;
      phase?: MissionPhase;
      action?: string;
      reason?: string;
      text: string;
    };
  };
}

export type LoopDebugEntryKind = "flow" | "prompt" | "llm" | "tool";

export interface LoopDebugEntry {
  id: string;
  kind: LoopDebugEntryKind;
  timestamp: string;
  actor: string;
  title: string;
  content: string;
  detail?: string;
  sequence?: number;
  metadata?: Record<string, unknown>;
}

export interface LoopDebugLog {
  task?: Task;
  taskRun?: TaskRun;
  entries: LoopDebugEntry[];
}

export interface ProviderConfig {
  provider: ProviderName;
  model: string;
  apiKey?: string;
  baseUrl?: string;
}

export type ModelThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelConfig extends ProviderConfig {
  id: string;
  name: string;
  provider: Exclude<ProviderName, "mock">;
  contextWindowTokens: number;
  supportsReasoning: boolean;
  supportsImages?: boolean;
  thinkingLevel: ModelThinkingLevel;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}
