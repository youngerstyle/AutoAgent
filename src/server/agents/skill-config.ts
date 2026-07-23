import type { AgentProfile, WorkspaceAgent } from "../../shared/types.js";

export function effectiveAgentSkills(profile: AgentProfile, agent: WorkspaceAgent): string[] {
  return [...new Set(agent.skillOverrides ?? profile.defaultSkills ?? [])];
}
