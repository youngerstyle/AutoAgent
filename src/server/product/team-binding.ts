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
      profileId: agent.profileId,
      principalId: `principal:${agent.id}`,
      capabilities: [...new Set(profile?.capabilities ?? [])].sort(),
      enabledTools: toolsForPolicy(policy).map((tool) => tool.name).sort() as WorkspaceToolName[],
    };
  });
  const deliveryPolicy = { requiredTerminalCapabilities: ["delivery:accept"] };
  // profileId was added as an immutable provenance snapshot after TeamBinding v1
  // shipped. Keep the v1 authority hash stable so persisted Missions can resume;
  // the Mission ledger itself durably protects the additional snapshot field.
  const authorityMembers = members.map(({ profileId: _profileId, ...member }) => member);
  return {
    teamBindingId,
    version: 1,
    contentHash: createHash("sha256").update(JSON.stringify({ members: authorityMembers, deliveryPolicy })).digest("base64url"),
    deliveryPolicy,
    members,
  };
}
