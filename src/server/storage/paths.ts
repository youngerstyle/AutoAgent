import path from "node:path";

export interface StoragePaths {
  home: string;
}

export function globalProfilesDir(home: string): string {
  return path.join(home, "profiles");
}

export function globalProvidersFile(home: string): string {
  return path.join(home, "providers.json");
}

export function globalWorkspacesFile(home: string): string {
  return path.join(home, "workspaces.json");
}

export function workspaceAutoAgentDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".autoagent");
}

export function workspaceFile(workspaceRoot: string): string {
  return path.join(workspaceAutoAgentDir(workspaceRoot), "workspace.json");
}

export function workspaceAgentDir(workspaceRoot: string, workspaceAgentId: string): string {
  return path.join(workspaceAutoAgentDir(workspaceRoot), "agents", workspaceAgentId);
}

export function workspaceAgentFile(workspaceRoot: string, workspaceAgentId: string): string {
  return path.join(workspaceAgentDir(workspaceRoot, workspaceAgentId), "agent.json");
}

export function workspaceAgentSessionsDir(workspaceRoot: string, workspaceAgentId: string): string {
  return path.join(workspaceAgentDir(workspaceRoot, workspaceAgentId), "sessions");
}

export function taskRunDir(workspaceRoot: string, taskId: string, taskRunId: string): string {
  return path.join(workspaceAutoAgentDir(workspaceRoot), "tasks", taskId, "runs", taskRunId);
}

export function eventsFile(workspaceRoot: string, taskId: string, taskRunId: string): string {
  return path.join(taskRunDir(workspaceRoot, taskId, taskRunId), "events.jsonl");
}

export function stateFile(workspaceRoot: string, taskId: string, taskRunId: string): string {
  return path.join(taskRunDir(workspaceRoot, taskId, taskRunId), "state.json");
}

export function artifactsDir(workspaceRoot: string, taskId: string, taskRunId: string): string {
  return path.join(taskRunDir(workspaceRoot, taskId, taskRunId), "artifacts");
}
