import type { AgentPolicy, AgentProfile, PolicyProfile, Workspace, WorkspaceAgent } from "../../shared/types.js";
import { toolsRequiredBySkills } from "../agents/skill-config.js";

export interface EffectivePolicy extends AgentPolicy {
  profile: PolicyProfile;
  workspaceRoot: string;
}

export function resolvePolicy(
  workspace: Workspace,
  agent: Pick<WorkspaceAgent, "policyOverride" | "skillOverrides">,
  profile?: AgentProfile,
): EffectivePolicy {
  const enabledTools = profile
    ? toolsRequiredBySkills(agent.skillOverrides ?? profile.defaultSkills ?? [], agent.policyOverride?.enabledTools)
    : agent.policyOverride?.enabledTools;
  return {
    canReadWorkspace: false,
    canWriteWorkspace: false,
    canExecuteCommands: false,
    ...agent.policyOverride,
    enabledTools: enabledTools ?? [],
    profile: workspace.policyProfile,
    workspaceRoot: workspace.rootPath,
    allowHostAccess: agent.policyOverride?.allowHostAccess ?? workspace.policyProfile === "development"
  };
}
