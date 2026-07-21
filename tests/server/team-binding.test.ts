import { describe, expect, it } from "vitest";
import { createTeamBinding } from "../../src/server/product/team-binding.js";
import type { AgentProfile, WorkspaceAgent } from "../../src/shared/types.js";

describe("TeamBinding product adapter", () => {
  it("uses configured profile capabilities without inferring authority from role names", () => {
    const profile = makeProfile([]);
    const team = createTeamBinding([makeAgent()], [profile], "team-a");

    expect(team.members[0]?.capabilities).toEqual([]);
    expect(team.members[0]?.capabilities).not.toContain("delivery:implement");
  });

  it("changes the immutable content hash when configured capabilities change", () => {
    const first = createTeamBinding([makeAgent()], [makeProfile(["delivery:implement"])], "team-a");
    const second = createTeamBinding([makeAgent()], [makeProfile(["delivery:verify"])], "team-a");

    expect(first.contentHash).not.toBe(second.contentHash);
  });
});

function makeAgent(): WorkspaceAgent {
  return {
    id: "agent-a",
    workspaceId: "workspace-a",
    profileId: "profile-a",
    roleInWorkspace: "dev",
    agentDir: ".autoagent/agents/agent-a",
    status: "idle",
  };
}

function makeProfile(capabilities: string[]): AgentProfile {
  return {
    id: "profile-a",
    name: "Agent A",
    role: "dev",
    capabilities,
    defaultProvider: "mock",
    defaultModel: "mock",
    defaultPolicy: {},
  };
}
