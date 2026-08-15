import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DISABLED_AGENT_EVOLUTION_RUNTIME } from "../../src/server/agent-engine/evolution-runtime-port.js";

describe("Evol framework boundaries", () => {
  it("keeps Agent Loop and Mission Runtime dependent on consumer-owned ports, not Evol implementations", async () => {
    for (const relative of [
      "src/server/agent-engine/pi-runtime.ts",
      "src/server/runtime/runtime-host.ts",
      "src/server/staffing/staffing-coordinator.ts",
    ]) {
      const source = await readFile(path.resolve(relative), "utf8");
      expect(source).not.toMatch(/from ["'][^"']*\/evolution\//);
      expect(source).not.toMatch(/from ["'][^"']*\/evolution-adapters\//);
    }
  });

  it("keeps core experience and Memory reconciliation independent of operational framework stores", async () => {
    for (const relative of [
      "src/server/evolution/experience-reconciler.ts",
      "src/server/evolution/memory-usage-reconciler.ts",
      "src/server/evolution/evolution-store.ts",
    ]) {
      const source = await readFile(path.resolve(relative), "utf8");
      expect(source).not.toMatch(/agent-engine|mission-process|tickets\/|runtime-host-store|agents\/roster/);
    }
  });

  it("allows Agent Loop capabilities to run with Evol disabled", async () => {
    const projection = await DISABLED_AGENT_EVOLUTION_RUNTIME.project({
      workspaceId: "workspace-a",
      profile: { id: "profile-a", name: "Agent", role: "dev", capabilities: [], defaultProvider: "mock", defaultModel: "mock", defaultPolicy: {} },
      agent: { id: "agent-a", workspaceId: "workspace-a", profileId: "profile-a", roleInWorkspace: "dev", agentDir: "agents/a", status: "idle" },
      assignmentKey: "turn-a", tools: [],
    });
    expect(projection).toMatchObject({ skills: [], memories: [], plugins: [], prompts: [], snapshotHash: "disabled" });
    expect(await DISABLED_AGENT_EVOLUTION_RUNTIME.fingerprint("profile-a")).toBe("evolution-disabled");
  });
});
