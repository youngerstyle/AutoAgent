import { describe, expect, it } from "vitest";
import {
  effectiveAgentSkills,
  skillRuntimeAdapterInstructions,
  toolsRequiredBySkills,
} from "../../src/server/agents/skill-config";
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

describe("skill tool requirements", () => {
  it("adds the dedicated tool required by a skill without removing explicit tools", () => {
    expect(toolsRequiredBySkills(["agent-browser"], ["readFile", "shell"]))
      .toEqual(["readFile", "shell", "browser"]);
  });

  it("does not infer tools from roles or unrelated skills", () => {
    expect(toolsRequiredBySkills(["custom-skill"], ["readFile"]))
      .toEqual(["readFile"]);
  });

  it("adapts agent-browser CLI instructions to the dedicated browser tool", () => {
    const instructions = skillRuntimeAdapterInstructions(
      ["agent-browser"],
      ["readFile", "browser"],
    );

    expect(instructions).toContain("一级 `browser` 工具");
    expect(instructions).toContain("set viewport 1264 900");
    expect(instructions).toContain("逐项数组");
    expect(instructions).toContain("公网 HTTP/HTTPS 页面");
    expect(instructions).toContain("不得通过 shell");
  });

  it("does not advertise a runtime adapter when its required tool is unavailable", () => {
    expect(skillRuntimeAdapterInstructions(["agent-browser"], ["readFile"])).toBe("");
  });
});
