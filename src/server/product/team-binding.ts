import { createHash } from "node:crypto";
import type { AgentProfile, WorkspaceAgent } from "../../shared/types.js";
import type { TeamBinding } from "../../shared/contracts/mission-control.js";

export function createTeamBinding(agents: WorkspaceAgent[], profiles: AgentProfile[], teamBindingId: string): TeamBinding {
  const members = agents.map((agent) => ({
    agentId: agent.id,
    principalId: `principal:${agent.id}`,
    capabilities: [...new Set(profiles.find((profile) => profile.id === agent.profileId)?.capabilities ?? [])].sort(),
  }));
  const deliveryPolicy = { requiredTerminalCapabilities: ["delivery:accept"] };
  return {
    teamBindingId,
    version: 1,
    contentHash: createHash("sha256").update(JSON.stringify({ members, deliveryPolicy })).digest("base64url"),
    deliveryPolicy,
    members,
  };
}
