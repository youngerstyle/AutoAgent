import { describe, expect, it } from "vitest";
import { createTeamBinding } from "../../src/server/product/team-binding.js";
import type { AgentProfile, Workspace, WorkspaceAgent } from "../../src/shared/types.js";

describe("TeamBinding product adapter", () => {
  it("uses configured profile capabilities without inferring authority from role names", () => {
    const profile = makeProfile([]);
    const team = createTeamBinding(makeWorkspace(), [makeAgent()], [profile], "team-a");

    expect(team.members[0]?.capabilities).toEqual([]);
    expect(team.members[0]?.capabilities).not.toContain("delivery:implement");
  });

  it("changes the immutable content hash when configured capabilities change", () => {
    const first = createTeamBinding(makeWorkspace(), [makeAgent()], [makeProfile(["delivery:implement"])], "team-a");
    const second = createTeamBinding(makeWorkspace(), [makeAgent()], [makeProfile(["delivery:verify"])], "team-a");

    expect(first.contentHash).not.toBe(second.contentHash);
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
