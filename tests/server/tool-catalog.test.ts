import { describe, expect, it } from "vitest";
import { permissionPatchForTool, toolProtocolFor, toolsForPolicy } from "../../src/server/tools/tool-catalog";
import type { AgentPolicy } from "../../src/shared/types";

describe("tool catalog", () => {
  it("derives visible tools from one catalog and the effective policy", () => {
    const pmPolicy: AgentPolicy = {
      canReadWorkspace: true,
      canWriteWorkspace: false,
      canExecuteCommands: false,
      enabledTools: ["listFiles", "readFile"]
    };
    const devPolicy: AgentPolicy = {
      canReadWorkspace: true,
      canWriteWorkspace: true,
      canExecuteCommands: true,
      enabledTools: ["readFile"]
    };

    expect(toolsForPolicy(pmPolicy).map((tool) => tool.name)).toEqual(["listFiles", "readFile"]);
    expect(toolsForPolicy(devPolicy).map((tool) => tool.name)).toEqual(["readFile"]);
    expect(toolProtocolFor(pmPolicy)).toContain("\"tool\":\"readFile\"");
    expect(toolProtocolFor(pmPolicy)).not.toContain("\"tool\":\"startService\"");
  });

  it("does not infer tools when a policy has no explicit tool configuration", () => {
    expect(toolsForPolicy({ canReadWorkspace: true, canWriteWorkspace: true, canExecuteCommands: true })).toEqual([]);
  });

  it("maps enabled tools back to the coarse permissions they require", () => {
    expect(permissionPatchForTool("readFile")).toEqual({ canReadWorkspace: true });
    expect(permissionPatchForTool("writeFile")).toEqual({ canWriteWorkspace: true });
    expect(permissionPatchForTool("startService")).toEqual({ canExecuteCommands: true });
  });
});
