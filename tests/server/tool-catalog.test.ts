import { describe, expect, it } from "vitest";
import { roleToolDefaults, toolProtocolFor, toolsForPolicy } from "../../src/server/tools/tool-catalog";
import type { AgentPolicy } from "../../src/shared/types";

describe("tool catalog", () => {
  it("derives visible tools from one catalog and the effective policy", () => {
    const pmPolicy: AgentPolicy = {
      canReadWorkspace: true,
      canWriteWorkspace: false,
      canExecuteCommands: false
    };
    const devPolicy: AgentPolicy = {
      canReadWorkspace: true,
      canWriteWorkspace: true,
      canExecuteCommands: true,
      enabledTools: ["readFile"]
    };

    expect(toolsForPolicy(pmPolicy, "pm").map((tool) => tool.name)).toEqual(["listFiles", "readFile", "writeFile"]);
    expect(toolsForPolicy(devPolicy, "dev").map((tool) => tool.name)).toEqual(["readFile"]);
    expect(toolProtocolFor(pmPolicy, "pm")).toContain("docs/notes.md");
    expect(toolProtocolFor(pmPolicy, "pm")).not.toContain("\"tool\":\"startService\"");
  });

  it("keeps role defaults explicit so new agents start with real tool choices", () => {
    expect(roleToolDefaults("pm")).toEqual(["listFiles", "readFile", "writeFile"]);
    expect(roleToolDefaults("dev")).toEqual(["listFiles", "readFile", "writeFile", "shell", "startService", "pollProcess"]);
    expect(roleToolDefaults("qa")).toEqual(["listFiles", "readFile", "writeFile", "shell", "startService", "pollProcess"]);
  });
});
