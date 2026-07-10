import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RegistryAgentProviderAdapter } from "../../src/server/agent-engine/provider-adapter.js";
import { ProviderRegistry } from "../../src/server/providers/provider-registry.js";

describe("RegistryAgentProviderAdapter", () => {
  it("runs a ticket-neutral model turn", async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "autoagent-provider-v2-"));
    const adapter = new RegistryAgentProviderAdapter(new ProviderRegistry({ homeDir }));
    const result = await adapter.run({
      provider: "mock",
      model: "mock",
      systemPrompt: "通用 Agent",
      prompt: "继续处理当前目标",
    });

    expect(result.structured).toMatchObject({ goalResolution: { status: "completed" } });
    expect(result.structured).not.toHaveProperty("ticketGraph");
    expect(result.structured).not.toHaveProperty("next");
  });
});
