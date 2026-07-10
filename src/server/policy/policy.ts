import type { AgentPolicy, PolicyProfile, Workspace, WorkspaceAgent } from "../../shared/types.js";

export interface EffectivePolicy extends AgentPolicy {
  profile: PolicyProfile;
  workspaceRoot: string;
}

export function resolvePolicy(workspace: Workspace, agent: Pick<WorkspaceAgent, "policyOverride">): EffectivePolicy {
  return {
    canReadWorkspace: false,
    canWriteWorkspace: false,
    canExecuteCommands: false,
    enabledTools: [],
    ...agent.policyOverride,
    profile: workspace.policyProfile,
    workspaceRoot: workspace.rootPath,
    allowHostAccess: workspace.policyProfile === "development" || agent.policyOverride?.allowHostAccess === true
  };
}
