import { describe, expect, it } from "vitest";
import { resolvePolicy } from "../../src/server/policy/policy.js";

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
});
