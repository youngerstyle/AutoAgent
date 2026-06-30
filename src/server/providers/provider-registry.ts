import { readJson, writeJson } from "../storage/json.js";
import { globalProvidersFile } from "../storage/paths.js";
import { AnthropicProvider } from "./anthropic-provider.js";
import { MockProvider } from "./mock-provider.js";
import { OpenAIProvider } from "./openai-provider.js";
import type { AgentModelProvider, AgentTurnInput, AgentTurnResult } from "./types.js";
import { ProviderError } from "./types.js";
import type { ProviderConfig, ProviderName } from "../../shared/types.js";

export interface ProviderRegistryOptions {
  homeDir: string;
  env?: NodeJS.ProcessEnv;
  retryCount?: number;
}

export class ProviderRegistry {
  constructor(private readonly options: ProviderRegistryOptions) {}

  async get(providerName: ProviderName): Promise<AgentModelProvider> {
    if (providerName === "mock") return new MockProvider();
    const config = await this.configFor(providerName);
    if (providerName === "openai") return new OpenAIProvider(config.apiKey, config.baseUrl);
    return new AnthropicProvider(config.apiKey, config.baseUrl);
  }

  async runWithRetry(input: AgentTurnInput): Promise<AgentTurnResult> {
    const provider = await this.get(input.provider);
    const retries = this.options.retryCount ?? 2;
    let attempt = 0;
    let lastError: unknown;
    while (attempt <= retries) {
      try {
        return await provider.runAgentTurn(input);
      } catch (error) {
        lastError = error;
        if (!(error instanceof ProviderError) || !error.retryable || attempt === retries) {
          throw error;
        }
        attempt += 1;
      }
    }
    throw lastError;
  }

  async status() {
    const configs = await this.readConfig();
    return {
      mock: { configured: true },
      openai: { configured: Boolean(this.options.env?.OPENAI_API_KEY || configs.openai?.apiKey) },
      anthropic: { configured: Boolean(this.options.env?.ANTHROPIC_API_KEY || configs.anthropic?.apiKey) }
    };
  }

  async configs(): Promise<Partial<Record<Exclude<ProviderName, "mock">, ProviderConfig>>> {
    return {
      openai: redactRequiredConfig(await this.configFor("openai")),
      anthropic: redactRequiredConfig(await this.configFor("anthropic"))
    };
  }

  async saveConfig(provider: Exclude<ProviderName, "mock">, config: Partial<ProviderConfig>): Promise<ProviderConfig> {
    const configs = await this.readConfig();
    const existing = configs[provider];
    const next: ProviderConfig = {
      provider,
      model: config.model?.trim() || existing?.model || (provider === "openai" ? "gpt-4.1-mini" : "claude-3-5-sonnet-latest"),
      apiKey: config.apiKey === undefined || config.apiKey === "" ? existing?.apiKey : config.apiKey,
      baseUrl: config.baseUrl === undefined ? existing?.baseUrl : config.baseUrl || undefined
    };
    configs[provider] = next;
    await writeJson(globalProvidersFile(this.options.homeDir), configs);
    return redactRequiredConfig(next);
  }

  private async configFor(provider: Exclude<ProviderName, "mock">): Promise<ProviderConfig> {
    const configs = await this.readConfig();
    const env = this.options.env ?? process.env;
    if (provider === "openai") {
      return {
        provider,
        model: configs.openai?.model ?? "gpt-4.1-mini",
        apiKey: env.OPENAI_API_KEY ?? configs.openai?.apiKey,
        baseUrl: env.OPENAI_BASE_URL ?? configs.openai?.baseUrl
      };
    }
    return {
      provider,
      model: configs.anthropic?.model ?? "claude-3-5-sonnet-latest",
      apiKey: env.ANTHROPIC_API_KEY ?? configs.anthropic?.apiKey,
      baseUrl: env.ANTHROPIC_BASE_URL ?? configs.anthropic?.baseUrl
    };
  }

  private async readConfig(): Promise<Partial<Record<Exclude<ProviderName, "mock">, ProviderConfig>>> {
    return readJson(globalProvidersFile(this.options.homeDir), {});
  }
}

function redactRequiredConfig(config: ProviderConfig): ProviderConfig {
  return {
    ...config,
    apiKey: config.apiKey ? "********" : undefined
  };
}
