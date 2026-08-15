import type { AgentPolicy, AgentProfile, LoopDebugLog, ModelConfig, ProviderConfig, ProviderName, Workspace, WorkspaceAgent, WorkspaceSnapshot } from "../shared/types";
import type { AgentMessageAttachment } from "../shared/contracts/agent-engine";
import type { EvaluationJob, EvolutionActivationRecord, EvolutionCandidate, EvolutionInheritanceProof, EvolutionWorkerStatus, MemoryLifecycleState, PromotionRecord } from "../shared/contracts/evolution";

export type RuntimeHealth = {
  ok: boolean;
  ready: boolean;
  name: string;
  runtimeHosts: {
    status: "not_started" | "restoring" | "ready" | "degraded" | "failed";
    restoredWorkspaceCount?: number;
    failedWorkspaces?: Array<{
      workspaceId: string;
      workspaceName: string;
      rootPath: string;
      error: string;
    }>;
    error?: string;
  };
};

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers
    }
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(body.error ?? response.statusText);
  }
  return response.json() as Promise<T>;
}

export function listWorkspaces(): Promise<{ workspaces: Workspace[] }> {
  return api("/api/workspaces");
}

export function getHealth(): Promise<RuntimeHealth> {
  return api("/api/health");
}

export function reconcileHealth(): Promise<RuntimeHealth> {
  return api("/api/health/reconcile", { method: "POST" });
}

export function createWorkspace(input: { name: string; rootPath: string; policyProfile: Workspace["policyProfile"] }): Promise<{ workspace: Workspace }> {
  return api("/api/workspaces", { method: "POST", body: JSON.stringify(input) });
}

export function deleteWorkspace(workspaceId: string, input: { deleteLocalFolder: boolean }): Promise<{ workspace: Workspace }> {
  return api(`/api/workspaces/${workspaceId}`, { method: "DELETE", body: JSON.stringify(input) });
}

export function getSnapshot(workspaceId: string): Promise<{ snapshot: WorkspaceSnapshot }> {
  return api(`/api/workspaces/${workspaceId}/snapshot`);
}

export function getLoopDebugLog(workspaceId: string): Promise<{ log: LoopDebugLog }> {
  return api(`/api/workspaces/${workspaceId}/debug-log`);
}

export function startTask(workspaceId: string, goal: string): Promise<{ snapshot: WorkspaceSnapshot }> {
  return api(`/api/workspaces/${workspaceId}/tasks`, { method: "POST", body: JSON.stringify({ goal }) });
}

export function pauseTask(workspaceId: string, taskId: string): Promise<unknown> {
  return api(`/api/workspaces/${workspaceId}/tasks/${taskId}/pause`, { method: "POST" });
}

export function resumeTask(workspaceId: string, taskId: string): Promise<{ snapshot: WorkspaceSnapshot }> {
  return api(`/api/workspaces/${workspaceId}/tasks/${taskId}/resume`, { method: "POST" });
}

export function sendTaskFollowup(workspaceId: string, taskId: string, message: string): Promise<{ snapshot: WorkspaceSnapshot }> {
  return api(`/api/workspaces/${workspaceId}/tasks/${taskId}/followups`, { method: "POST", body: JSON.stringify({ message }) });
}

export async function uploadAttachment(workspaceId: string, file: File): Promise<{ attachment: AgentMessageAttachment }> {
  const response = await fetch(`/api/workspaces/${workspaceId}/attachments`, {
    method: "POST",
    headers: { "Content-Type": file.type, "X-File-Name": encodeURIComponent(file.name) },
    body: file,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(body.error ?? response.statusText);
  }
  return response.json();
}

export function sendAgentMessage(workspaceId: string, taskId: string, agentId: string, message: string, attachments: AgentMessageAttachment[] = []): Promise<{ snapshot: WorkspaceSnapshot }> {
  return api(`/api/workspaces/${workspaceId}/tasks/${taskId}/agents/${agentId}/messages`, {
    method: "POST",
    body: JSON.stringify({ message, attachments, messageId: crypto.randomUUID() }),
  });
}

export function stopTask(workspaceId: string, taskId: string): Promise<unknown> {
  return api(`/api/workspaces/${workspaceId}/tasks/${taskId}/stop`, { method: "POST" });
}

export type WorkspaceAgentConfig = WorkspaceAgent & {
  name?: string;
  capabilities?: string[];
};

export function listAgents(workspaceId: string): Promise<{ agents: WorkspaceAgentConfig[] }> {
  return api(`/api/workspaces/${workspaceId}/agents`);
}

export function addWorkspaceAgent(workspaceId: string, profileId: string): Promise<{ agent: WorkspaceAgentConfig }> {
  return api(`/api/workspaces/${workspaceId}/agents`, { method: "POST", body: JSON.stringify({ profileId }) });
}

export function removeWorkspaceAgent(workspaceId: string, agentId: string): Promise<{ agent: WorkspaceAgentConfig }> {
  return api(`/api/workspaces/${workspaceId}/agents/${agentId}`, { method: "DELETE" });
}

export function updateAgent(
  workspaceId: string,
  agentId: string,
  input: { provider: ProviderName; model: string; skillOverrides: string[] | null; policyOverride: Partial<AgentPolicy> }
): Promise<{ agent: WorkspaceAgentConfig }> {
  return api(`/api/workspaces/${workspaceId}/agents/${agentId}`, { method: "PATCH", body: JSON.stringify(input) });
}

export function listAgentProfiles(): Promise<{ profiles: AgentProfile[] }> {
  return api("/api/agent-profiles");
}

export interface AvailableSkill {
  name: string;
  description: string;
  filePath: string;
}

export function listAvailableSkills(): Promise<{ skills: AvailableSkill[]; diagnostics: unknown[] }> {
  return api("/api/agent-profiles/skills");
}

export type AgentProfileUpdateInput = Pick<AgentProfile, "name" | "identity" | "soul" | "agentMd" | "capabilities" | "defaultSkills" | "defaultProvider" | "defaultModel" | "defaultPolicy">;
export type AgentProfileCreateInput = Omit<AgentProfile, "id" | "contentVersion">;

export function agentProfileUpdateInput(profile: AgentProfile): AgentProfileUpdateInput {
  return {
    name: profile.name,
    identity: profile.identity,
    soul: profile.soul,
    agentMd: profile.agentMd,
    capabilities: profile.capabilities,
    defaultSkills: profile.defaultSkills,
    defaultProvider: profile.defaultProvider,
    defaultModel: profile.defaultModel,
    defaultPolicy: profile.defaultPolicy,
  };
}

export function updateAgentProfile(profileId: string, input: Partial<AgentProfileUpdateInput>): Promise<{ profile: AgentProfile }> {
  return api(`/api/agent-profiles/${profileId}`, { method: "PATCH", body: JSON.stringify(input) });
}

export function createAgentProfile(input: AgentProfileCreateInput): Promise<{ profile: AgentProfile }> {
  return api("/api/agent-profiles", { method: "POST", body: JSON.stringify(input) });
}

export function getProviderConfig(): Promise<{ providers: Partial<Record<Exclude<ProviderName, "mock">, ProviderConfig>> }> {
  return api("/api/providers/config");
}

export function saveProviderConfig(provider: Exclude<ProviderName, "mock">, input: Partial<ProviderConfig>): Promise<{ provider: ProviderConfig }> {
  return api(`/api/providers/${provider}`, { method: "PATCH", body: JSON.stringify(input) });
}

export function listModelConfigs(): Promise<{ configs: ModelConfig[] }> {
  return api("/api/providers/model-configs");
}

export function createModelConfig(input: Partial<ModelConfig> & Pick<ModelConfig, "provider">): Promise<{ config: ModelConfig }> {
  return api("/api/providers/model-configs", { method: "POST", body: JSON.stringify(input) });
}

export function updateModelConfig(configId: string, input: Partial<ModelConfig>): Promise<{ config: ModelConfig }> {
  return api(`/api/providers/model-configs/${configId}`, { method: "PATCH", body: JSON.stringify(input) });
}

export function setDefaultModelConfig(configId: string): Promise<{ config: ModelConfig }> {
  return api(`/api/providers/model-configs/${configId}/default`, { method: "POST" });
}

export interface EvolutionOverview {
  candidates: EvolutionCandidate[];
  releases: PromotionRecord[];
  evaluationJobs: EvaluationJob[];
  memories: MemoryLifecycleState[];
  activations: EvolutionActivationRecord[];
  inheritanceProofs: EvolutionInheritanceProof[];
  worker: EvolutionWorkerStatus;
}

export async function getEvolutionOverview(workspaceId: string): Promise<EvolutionOverview> {
  const root = `/api/workspaces/${workspaceId}/evolution`;
  const [candidates, releases, jobs, memories, activations, worker] = await Promise.all([
    api<{ candidates: EvolutionCandidate[] }>(`${root}/candidates`),
    api<{ releases: PromotionRecord[] }>(`${root}/releases`),
    api<{ jobs: EvaluationJob[] }>(`${root}/evaluation-jobs`),
    api<{ memories: MemoryLifecycleState[] }>(`${root}/memories`),
    api<{ activations: EvolutionActivationRecord[]; proofs: EvolutionInheritanceProof[] }>(`${root}/activations`),
    api<{ worker: EvolutionWorkerStatus }>(`${root}/worker`),
  ]);
  return { candidates: candidates.candidates, releases: releases.releases, evaluationJobs: jobs.jobs, memories: memories.memories, activations: activations.activations, inheritanceProofs: activations.proofs, worker: worker.worker };
}

export function pinEvolutionMemory(workspaceId: string, releaseId: string, pinned: boolean): Promise<{ memory: MemoryLifecycleState }> {
  return api(`/api/workspaces/${workspaceId}/evolution/memories/${releaseId}/pin`, {
    method: "POST", body: JSON.stringify({ commandId: crypto.randomUUID(), pinned }),
  });
}

export function restoreEvolutionMemory(workspaceId: string, releaseId: string): Promise<{ memory: MemoryLifecycleState }> {
  return api(`/api/workspaces/${workspaceId}/evolution/memories/${releaseId}/restore`, {
    method: "POST", body: JSON.stringify({ commandId: crypto.randomUUID(), reason: "Human restored from Evolution governance UI" }),
  });
}

export function maintainEvolutionMemories(workspaceId: string): Promise<{ memories: MemoryLifecycleState[] }> {
  return api(`/api/workspaces/${workspaceId}/evolution/memories/maintenance`, { method: "POST", body: "{}" });
}

export function reconcileEvolution(workspaceId: string): Promise<unknown> {
  return api(`/api/workspaces/${workspaceId}/evolution/episodes/reconcile`, {
    method: "POST", body: JSON.stringify({ commandId: crypto.randomUUID() }),
  });
}
