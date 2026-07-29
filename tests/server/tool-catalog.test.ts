import { describe, expect, it } from "vitest";
import {
  configuredToolsInclude,
  permissionPatchForTool,
  toolProtocolFor,
  toolsForPolicy,
} from "../../src/server/tools/tool-catalog";
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
    expect(toolProtocolFor(pmPolicy)).toContain('request_human_input(kind="manual_test")');
    expect(toolProtocolFor(pmPolicy)).not.toContain("返回 manual_test_required");
  });

  it("does not infer tools when a policy has no explicit tool configuration", () => {
    expect(toolsForPolicy({ canReadWorkspace: true, canWriteWorkspace: true, canExecuteCommands: true })).toEqual([]);
  });

  it("treats exact editing as part of an explicitly configured write capability", () => {
    const policy: AgentPolicy = {
      canReadWorkspace: true,
      canWriteWorkspace: true,
      canExecuteCommands: false,
      enabledTools: ["readFile", "writeFile"],
    };

    expect(toolsForPolicy(policy).map((tool) => tool.name)).toEqual(["readFile", "writeFile", "editFile"]);
    expect(configuredToolsInclude(policy.enabledTools!, "editFile")).toBe(true);
    expect(configuredToolsInclude(["readFile"], "editFile")).toBe(false);
  });

  it("maps enabled tools back to the coarse permissions they require", () => {
    expect(permissionPatchForTool("readFile")).toEqual({ canReadWorkspace: true });
    expect(permissionPatchForTool("writeFile")).toEqual({ canWriteWorkspace: true });
    expect(permissionPatchForTool("editFile")).toEqual({ canWriteWorkspace: true });
    expect(permissionPatchForTool("startService")).toEqual({ canExecuteCommands: true });
  });
});
