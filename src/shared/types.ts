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
export type WorkspaceToolName = "listFiles" | "readFile" | "writeFile" | "shell" | "startService" | "pollProcess";

export interface Workspace {
  id: string;
  name: string;
  rootPath: string;
  policyProfile: PolicyProfile;
  createdAt: string;
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
  | "external_dependency";

export interface TicketBlocker {
  type: TicketBlockerType;
  reason: string;
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
}

export type MissionPhase =
  | "idle"
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
  recentEvents: AutoAgentEvent[];
  phase: MissionPhase;
  status: EntityStatus;
  currentStep?: string;
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

export interface ModelConfig extends ProviderConfig {
  id: string;
  name: string;
  provider: Exclude<ProviderName, "mock">;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}
