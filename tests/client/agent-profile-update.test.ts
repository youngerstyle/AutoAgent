import { describe, expect, it } from "vitest";
import { agentProfileUpdateInput } from "../../src/client/api";
import type { AgentProfile } from "../../src/shared/types";

describe("agent profile update input", () => {
  it("includes enabled skills in the persisted profile patch", () => {
    const profile = {
      id: "prof_qa",
      name: "测试",
      role: "qa",
      identity: "质量负责人",
      soul: "重视可复现证据",
      agentMd: "# 能力",
      capabilities: ["delivery:verify"],
      defaultSkills: ["agent-browser"],
      defaultProvider: "openai",
      defaultModel: "test-model",
      defaultPolicy: {
        canReadWorkspace: true,
        canWriteWorkspace: false,
        canExecuteCommands: true,
      },
    } satisfies AgentProfile;

    expect(agentProfileUpdateInput(profile)).toMatchObject({
      defaultSkills: ["agent-browser"],
    });
  });
});
