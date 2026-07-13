import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RegistryAgentProviderAdapter } from "../../src/server/agent-engine/provider-adapter.js";
import { ProviderRegistry } from "../../src/server/providers/provider-registry.js";

describe("RegistryAgentProviderAdapter", () => {
  it("passes a ticket-neutral structured history and native tools to the provider", async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "autoagent-provider-native-"));
    const registry = new ProviderRegistry({ homeDir });
    const adapter = new RegistryAgentProviderAdapter(registry);

    const result = await adapter.run({
      provider: "mock",
      model: "mock",
      instructions: "通用 Agent",
      history: [{ type: "user_message", content: "继续处理当前目标" }],
      tools: [{ name: "goal_resolution", description: "提交目标结论", inputSchema: { type: "object" } }],
    });

    expect(result.items).toEqual([
      expect.objectContaining({ type: "tool_call", name: "goal_resolution" }),
    ]);
    expect(JSON.stringify(result)).not.toContain("ticketGraph");
  });
});
