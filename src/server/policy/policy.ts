import type { AgentPolicy, AgentRole, PolicyProfile, Workspace, WorkspaceAgent } from "../../shared/types.js";

const ROLE_DEFAULTS: Record<AgentRole, AgentPolicy> = {
  boss: { canReadWorkspace: true, canWriteWorkspace: false, canExecuteCommands: false },
  pm: { canReadWorkspace: true, canWriteWorkspace: false, canExecuteCommands: false },
  architect: { canReadWorkspace: true, canWriteWorkspace: false, canExecuteCommands: false },
  dev: { canReadWorkspace: true, canWriteWorkspace: true, canExecuteCommands: true },
  qa: { canReadWorkspace: true, canWriteWorkspace: false, canExecuteCommands: true },
  specialist: { canReadWorkspace: true, canWriteWorkspace: true, canExecuteCommands: true }
};

export interface EffectivePolicy extends AgentPolicy {
  profile: PolicyProfile;
  workspaceRoot: string;
}

export function resolvePolicy(workspace: Workspace, agent: Pick<WorkspaceAgent, "roleInWorkspace" | "policyOverride">): EffectivePolicy {
  const base = ROLE_DEFAULTS[agent.roleInWorkspace];
  return {
    ...base,
    ...agent.policyOverride,
    profile: workspace.policyProfile,
    workspaceRoot: workspace.rootPath,
    allowHostAccess: workspace.policyProfile === "development" || agent.policyOverride?.allowHostAccess === true
  };
}
