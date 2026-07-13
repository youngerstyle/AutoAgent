import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ProviderRegistry } from "../../src/server/providers/provider-registry";
import type { AgentModelProvider, AgentModelTurnInput, AgentModelTurnResult } from "../../src/server/providers/types";
import { ProviderError } from "../../src/server/providers/types";

describe("ProviderRegistry", () => {
  it("runs the mock Agent Engine provider with usage metadata", async () => {
    const registry = new ProviderRegistry({ homeDir: await tempHome(), env: {}, retryCount: 0 });

    const result = await registry.runModelTurnWithRetry(input());

    expect(result.items).toContainEqual(expect.objectContaining({ type: "tool_call", name: "goal_resolution" }));
    expect(result.usage?.totalTokens).toBe(35);
  });

  it("reports missing real provider credentials without leaking secrets", async () => {
    const registry = new ProviderRegistry({ homeDir: await tempHome(), env: {}, retryCount: 0 });

    await expect(registry.runModelTurnWithRetry(input("openai"))).rejects.toMatchObject({
      retryable: false,
      code: "MISSING_OPENAI_API_KEY"
    });
    await expect(registry.status()).resolves.toMatchObject({ openai: { configured: false }, anthropic: { configured: false } });
  });

  it("retries transient provider failures", async () => {
    const flaky = new FlakyProvider();
    const registry = new ProviderRegistry({ homeDir: await tempHome(), env: {}, retryCount: 1 });
    registry.get = async () => {
      return flaky;
    };

    const result = await registry.runModelTurnWithRetry(input());

    expect(result.items).toEqual([{ type: "assistant_message", content: "ok" }]);
    expect(flaky.calls).toBe(2);
  });

  it("does not retry terminal provider failures", async () => {
    const registry = new ProviderRegistry({ homeDir: await tempHome(), env: {}, retryCount: 2 });
    registry.get = async () => new TerminalProvider();

    await expect(registry.runModelTurnWithRetry(input())).rejects.toMatchObject({ retryable: false });
  });

  it("saves provider config and redacts stored secrets in API responses", async () => {
    const home = await tempHome();
    const registry = new ProviderRegistry({ homeDir: home, env: {}, retryCount: 0 });

    const saved = await registry.saveConfig("openai", { provider: "openai", model: "gpt-test", apiKey: "secret", baseUrl: "https://example.test" });

    expect(saved).toMatchObject({ provider: "openai", model: "gpt-test", apiKey: "********" });
    await expect(registry.configs()).resolves.toMatchObject({ openai: { apiKey: "********" } });
    const raw = JSON.parse(await readFile(path.join(home, "providers.json"), "utf8"));
    expect(raw.openai.apiKey).toBe("secret");
  });

  it("projects environment provider config without leaking secrets", async () => {
    const registry = new ProviderRegistry({
      homeDir: await tempHome(),
      env: { OPENAI_API_KEY: "env-secret", OPENAI_BASE_URL: "https://gateway.test" },
      retryCount: 0
    });

    await expect(registry.configs()).resolves.toMatchObject({
      openai: { provider: "openai", model: "gpt-4.1-mini", apiKey: "********", baseUrl: "https://gateway.test" },
      anthropic: { provider: "anthropic", model: "claude-3-5-sonnet-latest", apiKey: undefined }
    });
  });

  it("adds, renames, and sets a single default model config while preserving legacy config", async () => {
    const home = await tempHome();
    const registry = new ProviderRegistry({ homeDir: home, env: {}, retryCount: 0 });
    await registry.saveConfig("openai", { provider: "openai", model: "gpt-legacy", apiKey: "legacy-secret" });

    const created = await registry.createModelConfig({
      name: "OpenAI 备用网关",
      provider: "openai",
      model: "gpt-4.1",
      apiKey: "new-secret",
      baseUrl: "https://gateway.test"
    });
    expect(created).toMatchObject({
      name: "OpenAI 备用网关",
      provider: "openai",
      model: "gpt-4.1",
      apiKey: "********",
      isDefault: false
    });

    const renamed = await registry.updateModelConfig(created.id, { name: "OpenAI 主力网关" });
    expect(renamed.name).toBe("OpenAI 主力网关");

    await registry.setDefaultModelConfig(created.id);
    const configs = await registry.modelConfigs();

    expect(configs.find((config) => config.model === "gpt-legacy")).toMatchObject({ name: "OpenAI 默认", apiKey: "********" });
    expect(configs.filter((config) => config.isDefault)).toHaveLength(1);
    expect(configs.find((config) => config.id === created.id)).toMatchObject({ name: "OpenAI 主力网关", isDefault: true });
    await expect(registry.status()).resolves.toMatchObject({ openai: { configured: true } });
  });
});

function input(provider: AgentModelTurnInput["provider"] = "mock"): AgentModelTurnInput {
  return {
    provider,
    model: "mock-model",
    instructions: "You are an Agent",
    history: [{ type: "user_message", content: "Do work" }],
    tools: [{ name: "goal_resolution", description: "resolve", inputSchema: { type: "object" } }],
  };
}

async function tempHome(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "autoagent-provider-"));
}

class FlakyProvider implements AgentModelProvider {
  name = "mock" as const;
  calls = 0;

  async runModelTurn() {
    this.calls += 1;
    if (this.calls === 1) throw new ProviderError("rate limited", true, "RATE_LIMIT");
    return { items: [{ type: "assistant_message" as const, content: "ok" }] };
  }
}

class TerminalProvider implements AgentModelProvider {
  name = "mock" as const;
  async runModelTurn(): Promise<AgentModelTurnResult> {
    throw new ProviderError("bad key", false, "BAD_KEY");
  }
}
