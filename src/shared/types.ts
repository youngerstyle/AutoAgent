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
  allowHostAccess?: boolean;
  commandAllowlist?: string[];
}

export interface AgentProfile {
  id: string;
  name: string;
  role: AgentRole;
  identity?: string;
  soul?: string;
  loopDefinition?: string[];
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
  recentEvents: AutoAgentEvent[];
  phase: MissionPhase;
  status: EntityStatus;
  currentStep?: string;
}

export interface ProviderConfig {
  provider: ProviderName;
  model: string;
  apiKey?: string;
  baseUrl?: string;
}
