import { describe, expect, it } from "vitest";
import { managedProcessDetached } from "../../src/server/agent-engine/managed-process-tree.js";

describe("managed process tree policy", () => {
  it("creates a signalable process group on POSIX and uses taskkill trees on Windows", () => {
    expect(managedProcessDetached("linux")).toBe(true);
    expect(managedProcessDetached("darwin")).toBe(true);
    expect(managedProcessDetached("win32")).toBe(false);
  });
});
