import { describe, expect, it } from "vitest";
import { intersectEffectivePolicies, resolvePolicy } from "../../src/server/policy/policy.js";

describe("resolvePolicy", () => {
  const workspace = {
    id: "ws",
    name: "workspace",
    rootPath: "C:\\workspace",
    policyProfile: "development" as const,
    createdAt: "2026-07-16T00:00:00.000Z",
  };

  it("honors an explicit Agent host-access denial in a development workspace", () => {
    expect(resolvePolicy(workspace, { policyOverride: { allowHostAccess: false } }).allowHostAccess).toBe(false);
  });

  it("inherits the workspace default only when the Agent has no explicit setting", () => {
    expect(resolvePolicy(workspace, { policyOverride: {} }).allowHostAccess).toBe(true);
    expect(resolvePolicy({ ...workspace, policyProfile: "production" }, { policyOverride: {} }).allowHostAccess).toBe(false);
  });

  it("allows evolved Agent defaults to narrow but never widen the effective project policy", () => {
    const base = resolvePolicy(workspace, { policyOverride: { canReadWorkspace: true, canWriteWorkspace: false, canExecuteCommands: true, allowHostAccess: false, enabledTools: ["readFile", "shell"], commandAllowlist: ["git", "npm"] } });
    const evolved = resolvePolicy(workspace, { policyOverride: { canReadWorkspace: true, canWriteWorkspace: true, canExecuteCommands: true, allowHostAccess: true, enabledTools: ["readFile", "writeFile", "shell"], commandAllowlist: ["npm", "powershell"] } });
    expect(intersectEffectivePolicies(base, evolved)).toMatchObject({ canReadWorkspace: true, canWriteWorkspace: false, canExecuteCommands: true, allowHostAccess: false, enabledTools: ["readFile", "shell"], commandAllowlist: ["npm"] });
  });

  it("disables command execution when two explicit allowlists have no common executable", () => {
    const base = resolvePolicy(workspace, { policyOverride: { canExecuteCommands: true, enabledTools: ["shell"], commandAllowlist: ["git"] } });
    const evolved = resolvePolicy(workspace, { policyOverride: { canExecuteCommands: true, enabledTools: ["shell"], commandAllowlist: ["npm"] } });
    expect(intersectEffectivePolicies(base, evolved)).toMatchObject({ canExecuteCommands: false, enabledTools: ["shell"] });
  });
});
