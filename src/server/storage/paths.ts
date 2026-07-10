import { createHash } from "node:crypto";
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

export function globalAgentProfilesFile(home: string): string {
  return path.join(home, "agent-profiles.json");
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

export function agentEngineFile(workspaceRoot: string, agentId: string): string {
  const root = path.resolve(workspaceAutoAgentDir(workspaceRoot), "agent-engine");
  const key = createHash("sha256").update(agentId).digest("base64url");
  const file = path.resolve(root, `${key}.json`);
  if (!file.startsWith(`${root}${path.sep}`)) throw new Error("Agent Engine path escaped its storage root");
  return file;
}

export function agentEngineLockFile(workspaceRoot: string, agentId: string): string {
  return `${agentEngineFile(workspaceRoot, agentId)}.lock`;
}

export function agentEngineTraceDir(workspaceRoot: string, agentId: string): string {
  const aggregate = agentEngineFile(workspaceRoot, agentId);
  return path.join(path.dirname(aggregate), "traces", path.basename(aggregate, ".json"));
}

export function agentEngineTraceFile(workspaceRoot: string, agentId: string, traceId: string): string {
  return path.join(
    agentEngineTraceDir(workspaceRoot, agentId),
    `${createHash("sha256").update(traceId).digest("base64url")}.json`,
  );
}

export function missionProcessFile(workspaceRoot: string, missionId: string): string {
  const root = path.resolve(workspaceAutoAgentDir(workspaceRoot), "mission-process");
  return path.join(root, `${createHash("sha256").update(missionId).digest("base64url")}.json`);
}

export function runtimeHostFile(workspaceRoot: string): string {
  return path.join(workspaceAutoAgentDir(workspaceRoot), "runtime-host.json");
}

export function workspaceAgentThreadsDir(workspaceRoot: string, workspaceAgentId: string): string {
  return path.join(workspaceAgentDir(workspaceRoot, workspaceAgentId), "threads");
}

export function workspaceAgentThreadFile(workspaceRoot: string, workspaceAgentId: string, taskRunId: string): string {
  return path.join(workspaceAgentThreadsDir(workspaceRoot, workspaceAgentId), `${taskRunId}.jsonl`);
}

export function workspaceAgentContextDir(workspaceRoot: string, workspaceAgentId: string): string {
  return path.join(workspaceAgentDir(workspaceRoot, workspaceAgentId), "context");
}

export function workspaceAgentContextFile(workspaceRoot: string, workspaceAgentId: string, taskRunId: string): string {
  return path.join(workspaceAgentContextDir(workspaceRoot, workspaceAgentId), `${taskRunId}.json`);
}

export function workspaceAgentMemoryFile(workspaceRoot: string, workspaceAgentId: string): string {
  return path.join(workspaceAgentDir(workspaceRoot, workspaceAgentId), "memory.json");
}

export function taskRunDir(workspaceRoot: string, taskId: string, taskRunId: string): string {
  return path.join(workspaceAutoAgentDir(workspaceRoot), "tasks", taskId, "runs", taskRunId);
}

export function eventsFile(workspaceRoot: string, taskId: string, taskRunId: string): string {
  return path.join(taskRunDir(workspaceRoot, taskId, taskRunId), "events.jsonl");
}

export function loopTraceFile(workspaceRoot: string, taskId: string, taskRunId: string): string {
  return path.join(taskRunDir(workspaceRoot, taskId, taskRunId), "loop-trace.jsonl");
}

export function stateFile(workspaceRoot: string, taskId: string, taskRunId: string): string {
  return path.join(taskRunDir(workspaceRoot, taskId, taskRunId), "state.json");
}

export function ticketEngineFile(
  workspaceRoot: string,
  taskId: string,
  taskRunId: string,
  workflowId: string,
): string {
  const engineRoot = path.resolve(workspaceAutoAgentDir(workspaceRoot), "ticket-engine");
  const file = path.join(
    engineRoot,
    "tasks",
    ticketEngineStorageKey(taskId),
    "runs",
    ticketEngineStorageKey(taskRunId),
    "workflows",
    `${ticketEngineStorageKey(workflowId)}.json`,
  );
  const resolved = path.resolve(file);
  if (!resolved.startsWith(`${engineRoot}${path.sep}`)) {
    throw new Error("Ticket Engine path escaped its storage root");
  }
  return resolved;
}

export function ticketEngineLockFile(
  workspaceRoot: string,
  taskId: string,
  taskRunId: string,
  workflowId: string,
): string {
  return `${ticketEngineFile(workspaceRoot, taskId, taskRunId, workflowId)}.lock`;
}

function ticketEngineStorageKey(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

export function artifactsDir(workspaceRoot: string, taskId: string, taskRunId: string): string {
  return path.join(taskRunDir(workspaceRoot, taskId, taskRunId), "artifacts");
}
