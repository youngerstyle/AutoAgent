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

/** Evolution may narrow an effective policy, but can never grant beyond the pre-evolution Agent/Project boundary. */
export function intersectEffectivePolicies(base: EffectivePolicy, evolved: EffectivePolicy): EffectivePolicy {
  const baseCommands = base.commandAllowlist?.filter(Boolean) ?? [];
  const evolvedCommands = evolved.commandAllowlist?.filter(Boolean) ?? [];
  const commandAllowlist = baseCommands.length && evolvedCommands.length
    ? baseCommands.filter((item) => evolvedCommands.some((candidate) => candidate.toLowerCase() === item.toLowerCase()))
    : baseCommands.length ? baseCommands : evolvedCommands.length ? evolvedCommands : undefined;
  const commandIntersectionEmpty = Boolean(baseCommands.length && evolvedCommands.length && !commandAllowlist?.length);
  return {
    ...evolved,
    profile: base.profile,
    workspaceRoot: base.workspaceRoot,
    canReadWorkspace: base.canReadWorkspace && evolved.canReadWorkspace,
    canWriteWorkspace: base.canWriteWorkspace && evolved.canWriteWorkspace,
    canExecuteCommands: base.canExecuteCommands && evolved.canExecuteCommands && !commandIntersectionEmpty,
    allowHostAccess: Boolean(base.allowHostAccess && evolved.allowHostAccess),
    enabledTools: (base.enabledTools ?? []).filter((tool) => (evolved.enabledTools ?? []).includes(tool)),
    ...(commandAllowlist?.length ? { commandAllowlist } : { commandAllowlist: undefined }),
  };
}
