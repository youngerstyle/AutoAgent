import type { AgentProfile, AgentRole, WorkspaceAgent } from "../../shared/types.js";
import type { TeamBinding } from "../../shared/contracts/mission-control.js";

const PRODUCT_CAPABILITIES: Record<AgentRole, string[]> = {
  boss: ["mission:intake", "delivery:accept"],
  pm: ["workflow:plan"],
  architect: ["architecture:design"],
  dev: ["delivery:implement"],
  qa: ["delivery:verify"],
  specialist: ["specialist:execute"],
};

export function createTeamBinding(agents: WorkspaceAgent[], profiles: AgentProfile[], contentHash: string): TeamBinding {
  return {
    teamBindingId: "minimal-team",
    version: 1,
    contentHash,
    members: agents.map((agent) => ({
      agentId: agent.id,
      principalId: `principal:${agent.id}`,
      capabilities: [...new Set([
        ...(profiles.find((profile) => profile.id === agent.profileId)?.capabilities ?? []),
        ...PRODUCT_CAPABILITIES[agent.roleInWorkspace],
      ])],
    })),
  };
}
