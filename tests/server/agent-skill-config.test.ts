import { describe, expect, it } from "vitest";
import { effectiveAgentSkills } from "../../src/server/agents/skill-config";
import type { AgentProfile, WorkspaceAgent } from "../../src/shared/types";

const profile = {
  id: "prof_dev",
  name: "开发",
  role: "dev",
  capabilities: [],
  defaultSkills: ["agent-browser"],
  defaultProvider: "openai",
  defaultModel: "model",
  defaultPolicy: {},
} satisfies AgentProfile;

const agent = {
  id: "wa_dev",
  workspaceId: "ws_1",
  profileId: profile.id,
  roleInWorkspace: "dev",
  agentDir: "C:/workspace/.autoagent/agents/wa_dev",
  status: "idle",
} satisfies WorkspaceAgent;

describe("effective agent skills", () => {
  it("inherits profile defaults when the workspace has no override", () => {
    expect(effectiveAgentSkills(profile, agent)).toEqual(["agent-browser"]);
  });

  it("uses the workspace override including an explicitly empty set", () => {
    expect(effectiveAgentSkills(profile, { ...agent, skillOverrides: ["chrome-devtools"] }))
      .toEqual(["chrome-devtools"]);
    expect(effectiveAgentSkills(profile, { ...agent, skillOverrides: [] })).toEqual([]);
  });
});
