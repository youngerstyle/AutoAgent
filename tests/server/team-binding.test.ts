import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createTeamBinding } from "../../src/server/product/team-binding.js";
import type { AgentProfile, Workspace, WorkspaceAgent } from "../../src/shared/types.js";

describe("TeamBinding product adapter", () => {
  it("uses configured profile capabilities without inferring authority from role names", () => {
    const profile = makeProfile([]);
    const team = createTeamBinding(makeWorkspace(), [makeAgent()], [profile], "team-a");
    expect(team.members[0]).toMatchObject({ agentId: "agent-a", profileId: "profile-a" });

    expect(team.members[0]?.capabilities).toEqual([]);
    expect(team.members[0]?.capabilities).not.toContain("delivery:implement");
  });

  it("changes the immutable content hash when configured capabilities change", () => {
    const first = createTeamBinding(makeWorkspace(), [makeAgent()], [makeProfile(["delivery:implement"])], "team-a");
    const second = createTeamBinding(makeWorkspace(), [makeAgent()], [makeProfile(["delivery:verify"])], "team-a");

    expect(first.contentHash).not.toBe(second.contentHash);
  });

  it("keeps the v1 authority hash compatible when adding the stable profile snapshot", () => {
    const team = createTeamBinding(makeWorkspace(), [makeAgent()], [makeProfile(["delivery:implement"])], "team-a");
    const legacyMembers = team.members.map(({ profileId: _profileId, ...member }) => member);
    const legacyHash = createHash("sha256").update(JSON.stringify({ members: legacyMembers, deliveryPolicy: team.deliveryPolicy })).digest("base64url");

    expect(team.contentHash).toBe(legacyHash);
    expect(team.members[0]?.profileId).toBe("profile-a");
  });

  it("binds the exact tools enabled for each workspace Agent", () => {
    const agent: WorkspaceAgent = {
      ...makeAgent(),
      policyOverride: {
        canReadWorkspace: true,
        canWriteWorkspace: false,
        canExecuteCommands: true,
        enabledTools: ["readFile", "browser"],
      },
    };
    const team = createTeamBinding(makeWorkspace(), [agent], [makeProfile(["research"])], "team-a");

    expect(team.members[0]?.enabledTools).toEqual(["browser", "readFile"]);
  });
});

function makeWorkspace(): Workspace {
  return {
    id: "workspace-a",
    name: "Workspace A",
    rootPath: "C:\\workspace-a",
    policyProfile: "development",
    createdAt: "2026-07-29T00:00:00.000Z",
  };
}

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
