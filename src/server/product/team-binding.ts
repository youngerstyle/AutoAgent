import { createHash } from "node:crypto";
import type { AgentProfile, Workspace, WorkspaceAgent, WorkspaceToolName } from "../../shared/types.js";
import type { TeamBinding } from "../../shared/contracts/mission-control.js";
import { toolsForPolicy } from "../../shared/tool-catalog.js";
import { resolvePolicy } from "../policy/policy.js";

export function createTeamBinding(
  workspace: Workspace,
  agents: WorkspaceAgent[],
  profiles: AgentProfile[],
  teamBindingId: string,
): TeamBinding {
  const members = agents.map((agent) => {
    const profile = profiles.find((item) => item.id === agent.profileId);
    const policy = resolvePolicy(workspace, agent, profile);
    return {
      agentId: agent.id,
      principalId: `principal:${agent.id}`,
      capabilities: [...new Set(profile?.capabilities ?? [])].sort(),
      enabledTools: toolsForPolicy(policy).map((tool) => tool.name).sort() as WorkspaceToolName[],
    };
  });
  const deliveryPolicy = { requiredTerminalCapabilities: ["delivery:accept"] };
  return {
    teamBindingId,
    version: 1,
    contentHash: createHash("sha256").update(JSON.stringify({ members, deliveryPolicy })).digest("base64url"),
    deliveryPolicy,
    members,
  };
}
