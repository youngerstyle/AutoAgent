import { mkdir, readdir } from "node:fs/promises";
import type { AgentProfile, AgentRole, Workspace, WorkspaceAgent } from "../../shared/types.js";
import { createId } from "../../shared/ids.js";
import { workspaceAgentDir, workspaceAgentFile, workspaceAgentSessionsDir } from "../storage/paths.js";
import { readJson, writeJson } from "../storage/json.js";

export const CORE_AGENT_PROFILES: AgentProfile[] = [
  {
    id: "prof_boss",
    name: "Boss",
    role: "boss",
    capabilities: ["goal intake", "approval", "staffing"],
    defaultProvider: "mock",
    defaultModel: "mock-boss",
    defaultPolicy: { canReadWorkspace: true, canWriteWorkspace: false, canExecuteCommands: false }
  },
  {
    id: "prof_pm",
    name: "PM",
    role: "pm",
    capabilities: ["planning", "scope control", "handoff"],
    defaultProvider: "mock",
    defaultModel: "mock-pm",
    defaultPolicy: { canReadWorkspace: true, canWriteWorkspace: false, canExecuteCommands: false }
  },
  {
    id: "prof_architect",
    name: "Architect",
    role: "architect",
    capabilities: ["technical design", "capability gap detection"],
    defaultProvider: "mock",
    defaultModel: "mock-architect",
    defaultPolicy: { canReadWorkspace: true, canWriteWorkspace: true, canExecuteCommands: false }
  },
  {
    id: "prof_dev",
    name: "Dev",
    role: "dev",
    capabilities: ["implementation", "tool use", "local verification"],
    defaultProvider: "mock",
    defaultModel: "mock-dev",
    defaultPolicy: { canReadWorkspace: true, canWriteWorkspace: true, canExecuteCommands: true }
  },
  {
    id: "prof_qa",
    name: "QA",
    role: "qa",
    capabilities: ["test planning", "quality review", "acceptance checks"],
    defaultProvider: "mock",
    defaultModel: "mock-qa",
    defaultPolicy: { canReadWorkspace: true, canWriteWorkspace: false, canExecuteCommands: true }
  }
];

export type CoreRole = Exclude<AgentRole, "specialist">;

export async function ensureCoreTeam(workspace: Workspace): Promise<WorkspaceAgent[]> {
  const agents: WorkspaceAgent[] = [];
  for (const profile of CORE_AGENT_PROFILES) {
    agents.push(await ensureWorkspaceAgent(workspace, profile, `wa_${profile.role}`));
  }
  return agents;
}

export async function listWorkspaceAgents(workspace: Workspace): Promise<WorkspaceAgent[]> {
  const agentsRoot = workspaceAgentDir(workspace.rootPath, "");
  try {
    const entries = await readdir(agentsRoot, { withFileTypes: true });
    const agents = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => readJson<WorkspaceAgent | undefined>(workspaceAgentFile(workspace.rootPath, entry.name), undefined))
    );
    return agents.filter((agent): agent is WorkspaceAgent => Boolean(agent));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export function profileForRole(role: AgentRole): AgentProfile {
  const profile = CORE_AGENT_PROFILES.find((item) => item.role === role);
  if (profile) return profile;
  return {
    id: "prof_specialist",
    name: "Specialist",
    role: "specialist",
    capabilities: ["specialized delivery"],
    defaultProvider: "mock",
    defaultModel: "mock-specialist",
    defaultPolicy: { canReadWorkspace: true, canWriteWorkspace: true, canExecuteCommands: true }
  };
}

export async function ensureWorkspaceAgent(workspace: Workspace, profile: AgentProfile, workspaceAgentId = createId("wa")): Promise<WorkspaceAgent> {
  const existing = await readJson<WorkspaceAgent | undefined>(workspaceAgentFile(workspace.rootPath, workspaceAgentId), undefined);
  if (existing) return existing;

  const agent: WorkspaceAgent = {
    id: workspaceAgentId,
    workspaceId: workspace.id,
    profileId: profile.id,
    roleInWorkspace: profile.role,
    agentDir: workspaceAgentDir(workspace.rootPath, workspaceAgentId),
    status: "idle",
    policyOverride: profile.defaultPolicy
  };
  await mkdir(workspaceAgentSessionsDir(workspace.rootPath, workspaceAgentId), { recursive: true });
  await writeJson(workspaceAgentFile(workspace.rootPath, workspaceAgentId), agent);
  return agent;
}

export function profileMetadata(agent: WorkspaceAgent): Pick<AgentProfile, "name" | "role" | "capabilities"> {
  const profile = profileForRole(agent.roleInWorkspace);
  return { name: profile.name, role: profile.role, capabilities: profile.capabilities };
}
