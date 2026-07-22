import type { AgentPolicy, AgentProfile, LoopDebugLog, ModelConfig, ProviderConfig, ProviderName, Workspace, WorkspaceAgent, WorkspaceSnapshot } from "../shared/types";
import type { AgentMessageAttachment } from "../shared/contracts/agent-engine";

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

export function updateAgent(
  workspaceId: string,
  agentId: string,
  input: { provider: ProviderName; model: string; policyOverride: Partial<AgentPolicy> }
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

export function updateAgentProfile(profileId: string, input: Partial<Pick<AgentProfile, "name" | "identity" | "soul" | "agentMd" | "capabilities" | "defaultSkills" | "defaultProvider" | "defaultModel" | "defaultPolicy">>): Promise<{ profile: AgentProfile }> {
  return api(`/api/agent-profiles/${profileId}`, { method: "PATCH", body: JSON.stringify(input) });
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
