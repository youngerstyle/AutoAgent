import { readFile, readdir } from "node:fs/promises";
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

  it("keeps the entire Evol framework independent of operational framework implementations", async () => {
    const directory = path.resolve("src/server/evolution");
    for (const file of (await readdir(directory)).filter((item) => item.endsWith(".ts"))) {
      const source = await readFile(path.join(directory, file), "utf8");
      expect(source, file).not.toMatch(/from ["'][^"']*\/(?:agent-engine|mission-process|tickets|agents\/roster|runtime\/runtime-host-store)(?:\/|\.|["'])/);
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
