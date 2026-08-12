import { readJson, updateJson } from "../storage/json.js";
import { globalProvidersFile } from "../storage/paths.js";
import { createId } from "../../shared/ids.js";
import { AnthropicProvider } from "./anthropic-provider.js";
import { MockProvider } from "./mock-provider.js";
import { OpenAIProvider } from "./openai-provider.js";
import type { AgentModelProvider, AgentModelTurnInput, AgentModelTurnResult } from "./types.js";
import { ProviderError } from "./types.js";
import type { ModelConfig, ModelThinkingLevel, ProviderConfig, ProviderName } from "../../shared/types.js";
import { DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS } from "../../shared/model-context.js";

export interface ProviderRegistryOptions {
  homeDir: string;
  env?: NodeJS.ProcessEnv;
  retryCount?: number;
}

type RealProviderName = Exclude<ProviderName, "mock">;

interface StoredProviderConfigFile extends Partial<Record<RealProviderName, ProviderConfig>> {
  modelConfigs?: ModelConfig[];
}

type ModelConfigPatch = Partial<Omit<ModelConfig, "id" | "createdAt" | "updatedAt">>;

const REAL_PROVIDERS: RealProviderName[] = ["openai", "anthropic"];

export class ProviderRegistry {
  constructor(private readonly options: ProviderRegistryOptions) {}

  async get(providerName: ProviderName): Promise<AgentModelProvider> {
    if (providerName === "mock") return new MockProvider();
    const config = await this.configFor(providerName);
    if (providerName === "openai") return new OpenAIProvider(config.apiKey, config.baseUrl);
    return new AnthropicProvider(config.apiKey, config.baseUrl);
  }

  async status() {
    const configs = await this.readConfigFile();
    const modelConfigs = await this.materializeModelConfigs(configs);
    return {
      mock: { configured: true },
      openai: { configured: Boolean(this.options.env?.OPENAI_API_KEY || configs.openai?.apiKey || modelConfigs.some((config) => config.provider === "openai" && config.apiKey)) },
      anthropic: { configured: Boolean(this.options.env?.ANTHROPIC_API_KEY || configs.anthropic?.apiKey || modelConfigs.some((config) => config.provider === "anthropic" && config.apiKey)) }
    };
  }

  async runModelTurnWithRetry(input: AgentModelTurnInput): Promise<AgentModelTurnResult> {
    const provider = await this.get(input.provider);
    return this.retry(() => provider.runModelTurn(input));
  }

  private async retry(operation: () => Promise<AgentModelTurnResult>): Promise<AgentModelTurnResult> {
    const retries = this.options.retryCount ?? 2;
    let attempt = 0;
    while (true) {
      try {
        return await operation();
      } catch (error) {
        if (!(error instanceof ProviderError) || !error.retryable || attempt >= retries) throw error;
        attempt += 1;
      }
    }
  }

  async configs(): Promise<Partial<Record<RealProviderName, ProviderConfig>>> {
    return {
      openai: redactRequiredConfig(await this.configFor("openai")),
      anthropic: redactRequiredConfig(await this.configFor("anthropic"))
    };
  }

  async saveConfig(provider: RealProviderName, config: Partial<ProviderConfig>): Promise<ProviderConfig> {
    const stored = await this.updateConfigFile(async (configs) => {
      const existing = configs[provider];
      const next: ProviderConfig = {
        provider,
        model: config.model?.trim() || existing?.model || defaultModel(provider),
        apiKey: config.apiKey === undefined || config.apiKey === "" ? existing?.apiKey : config.apiKey,
        baseUrl: config.baseUrl === undefined ? existing?.baseUrl : config.baseUrl || undefined
      };
      configs[provider] = next;
      configs.modelConfigs = await this.upsertLegacyModelConfig(configs, next);
      return configs;
    });
    return redactRequiredConfig(stored[provider]!);
  }

  async modelConfigs(): Promise<ModelConfig[]> {
    const stored = await this.readConfigFile();
    return (await this.materializeModelConfigs(stored)).map(redactModelConfig);
  }

  async contextWindowTokens(provider: ProviderName, model: string): Promise<number> {
    if (provider === "mock") return DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS;
    const configs = await this.materializeModelConfigs(await this.readConfigFile());
    const matches = configs.filter((config) => config.provider === provider && config.model === model);
    return (matches.find((config) => config.isDefault) ?? matches[0])?.contextWindowTokens
      ?? DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS;
  }

  async modelRuntimeConfig(provider: ProviderName, model: string): Promise<Pick<ModelConfig, "contextWindowTokens" | "supportsReasoning" | "supportsImages" | "thinkingLevel">> {
    if (provider === "mock") {
      return { contextWindowTokens: DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS, supportsReasoning: false, supportsImages: true, thinkingLevel: "off" };
    }
    const configs = await this.materializeModelConfigs(await this.readConfigFile());
    const matches = configs.filter((config) => config.provider === provider && config.model === model);
    const selected = matches.find((config) => config.isDefault) ?? matches[0];
    return selected
      ? pickModelRuntimeConfig(selected)
      : { contextWindowTokens: DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS, supportsReasoning: false, supportsImages: false, thinkingLevel: "off" };
  }

  /** Internal runtime credentials. Never return this value from an HTTP route. */
  async runtimeConfig(provider: ProviderName, model: string): Promise<ProviderConfig> {
    if (provider === "mock") return { provider, model };
    const config = await this.configFor(provider);
    return { ...config, model };
  }

  async createModelConfig(config: Partial<ModelConfig> & Pick<ModelConfig, "provider">): Promise<ModelConfig> {
    const now = new Date().toISOString();
    const next: ModelConfig = {
      id: createId("mc"),
      name: config.name?.trim() || `${providerLabel(config.provider)} 配置`,
      provider: config.provider,
      model: config.model?.trim() || defaultModel(config.provider),
      contextWindowTokens: normalizeContextWindowTokens(config.contextWindowTokens),
      supportsReasoning: Boolean(config.supportsReasoning),
      supportsImages: Boolean(config.supportsImages),
      thinkingLevel: normalizeThinkingLevel(config.thinkingLevel, Boolean(config.supportsReasoning)),
      apiKey: config.apiKey || undefined,
      baseUrl: config.baseUrl || undefined,
      isDefault: false,
      createdAt: now,
      updatedAt: now
    };
    const stored = await this.updateConfigFile(async (current) => {
      const configs = ensureSingleDefault(await this.materializeModelConfigs(current));
      const shouldBeDefault = Boolean(config.isDefault) || configs.length === 0;
      next.isDefault = shouldBeDefault;
      current.modelConfigs = shouldBeDefault
        ? [...configs.map((item) => ({ ...item, isDefault: false })), next]
        : [...configs, next];
      return current;
    });
    return redactModelConfig(stored.modelConfigs!.find((item) => item.id === next.id)!);
  }

  async updateModelConfig(configId: string, patch: ModelConfigPatch): Promise<ModelConfig> {
    const stored = await this.updateConfigFile(async (current) => {
      const configs = ensureSingleDefault(await this.materializeModelConfigs(current));
      const existing = configs.find((config) => config.id === configId);
      if (!existing) throw new Error(`Model config not found: ${configId}`);
      const updated: ModelConfig = {
        ...existing,
        name: patch.name !== undefined ? String(patch.name).trim() || existing.name : existing.name,
        provider: patch.provider ?? existing.provider,
        model: patch.model !== undefined ? String(patch.model).trim() || existing.model : existing.model,
        contextWindowTokens: patch.contextWindowTokens === undefined
          ? existing.contextWindowTokens
          : normalizeContextWindowTokens(patch.contextWindowTokens),
        supportsReasoning: patch.supportsReasoning ?? existing.supportsReasoning,
        supportsImages: patch.supportsImages ?? existing.supportsImages,
        thinkingLevel: normalizeThinkingLevel(
          patch.thinkingLevel ?? existing.thinkingLevel,
          patch.supportsReasoning ?? existing.supportsReasoning,
        ),
        apiKey: patch.apiKey === undefined || patch.apiKey === "" ? existing.apiKey : patch.apiKey,
        baseUrl: patch.baseUrl === undefined ? existing.baseUrl : patch.baseUrl || undefined,
        updatedAt: new Date().toISOString()
      };
      current.modelConfigs = configs.map((item) => item.id === configId ? updated : item);
      if (patch.isDefault) current.modelConfigs = setOnlyDefault(current.modelConfigs, configId);
      return current;
    });
    return redactModelConfig(stored.modelConfigs!.find((config) => config.id === configId)!);
  }

  async setDefaultModelConfig(configId: string): Promise<ModelConfig> {
    const stored = await this.updateConfigFile(async (current) => {
      const configs = ensureSingleDefault(await this.materializeModelConfigs(current));
      if (!configs.some((config) => config.id === configId)) throw new Error(`Model config not found: ${configId}`);
      current.modelConfigs = setOnlyDefault(configs, configId);
      return current;
    });
    return redactModelConfig(stored.modelConfigs!.find((config) => config.id === configId)!);
  }

  private async configFor(provider: RealProviderName): Promise<ProviderConfig> {
    const configs = await this.readConfigFile();
    const modelConfigs = await this.materializeModelConfigs(configs);
    const selected = modelConfigs.find((config) => config.provider === provider && config.isDefault)
      ?? modelConfigs.find((config) => config.provider === provider);
    const env = this.options.env ?? process.env;
    if (provider === "openai") {
      return {
        provider,
        model: selected?.model ?? configs.openai?.model ?? defaultModel(provider),
        apiKey: env.OPENAI_API_KEY ?? selected?.apiKey ?? configs.openai?.apiKey,
        baseUrl: env.OPENAI_BASE_URL ?? selected?.baseUrl ?? configs.openai?.baseUrl
      };
    }
    return {
      provider,
      model: selected?.model ?? configs.anthropic?.model ?? defaultModel(provider),
      apiKey: env.ANTHROPIC_API_KEY ?? selected?.apiKey ?? configs.anthropic?.apiKey,
      baseUrl: env.ANTHROPIC_BASE_URL ?? selected?.baseUrl ?? configs.anthropic?.baseUrl
    };
  }

  private async readConfigFile(): Promise<StoredProviderConfigFile> {
    return readJson(globalProvidersFile(this.options.homeDir), {});
  }

  private async updateConfigFile(update: (stored: StoredProviderConfigFile) => StoredProviderConfigFile | Promise<StoredProviderConfigFile>): Promise<StoredProviderConfigFile> {
    return updateJson(globalProvidersFile(this.options.homeDir), {}, update);
  }

  private async materializeModelConfigs(stored: StoredProviderConfigFile): Promise<ModelConfig[]> {
    if (stored.modelConfigs?.length) {
      return ensureSingleDefault(stored.modelConfigs.map((config) => ({
        ...config,
        contextWindowTokens: normalizeContextWindowTokens(config.contextWindowTokens, true),
        supportsReasoning: Boolean(config.supportsReasoning),
        supportsImages: Boolean(config.supportsImages),
        thinkingLevel: normalizeThinkingLevel(config.thinkingLevel, Boolean(config.supportsReasoning)),
      })));
    }
    const now = new Date().toISOString();
    const configs = REAL_PROVIDERS.map((provider) => {
      const legacy = stored[provider];
      return {
        id: `mc_${provider}`,
        name: `${providerLabel(provider)} 默认`,
        provider,
        model: legacy?.model ?? defaultModel(provider),
        contextWindowTokens: DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS,
        supportsReasoning: false,
        supportsImages: false,
        thinkingLevel: "off" as const,
        apiKey: legacy?.apiKey,
        baseUrl: legacy?.baseUrl,
        isDefault: false,
        createdAt: now,
        updatedAt: now
      };
    });
    const defaultId = configs.find((config) => Boolean(config.apiKey))?.id ?? configs[0]?.id;
    return configs.map((config) => ({ ...config, isDefault: config.id === defaultId }));
  }

  private async upsertLegacyModelConfig(stored: StoredProviderConfigFile, config: ProviderConfig): Promise<ModelConfig[]> {
    const configs = await this.materializeModelConfigs(stored);
    const existingId = `mc_${config.provider}`;
    return configs.map((item) => item.id === existingId ? {
      ...item,
      model: config.model,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      updatedAt: new Date().toISOString()
    } : item);
  }
}

function redactRequiredConfig(config: ProviderConfig): ProviderConfig {
  return {
    ...config,
    apiKey: config.apiKey ? "********" : undefined
  };
}

function redactModelConfig(config: ModelConfig): ModelConfig {
  return {
    ...config,
    apiKey: config.apiKey ? "********" : undefined
  };
}

function ensureSingleDefault(configs: ModelConfig[]): ModelConfig[] {
  if (!configs.length) return configs;
  const defaultId = configs.find((config) => config.isDefault)?.id ?? configs[0].id;
  return setOnlyDefault(configs, defaultId);
}

function setOnlyDefault(configs: ModelConfig[], configId: string): ModelConfig[] {
  return configs.map((config) => ({ ...config, isDefault: config.id === configId }));
}

function defaultModel(provider: RealProviderName): string {
  return provider === "openai" ? "gpt-4.1-mini" : "claude-3-5-sonnet-latest";
}

function providerLabel(provider: RealProviderName): string {
  return provider === "openai" ? "OpenAI" : "Anthropic";
}

function normalizeContextWindowTokens(value: unknown, allowMissing = false): number {
  if ((value === undefined || value === null) && allowMissing) return DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS;
  const normalized = value === undefined || value === null
    ? DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS
    : Number(value);
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error("contextWindowTokens must be a positive integer");
  }
  return normalized;
}

function normalizeThinkingLevel(value: unknown, supportsReasoning: boolean): ModelThinkingLevel {
  if (!supportsReasoning) return "off";
  const levels: ModelThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];
  return levels.includes(value as ModelThinkingLevel) ? value as ModelThinkingLevel : "medium";
}

function pickModelRuntimeConfig(config: ModelConfig) {
  return {
    contextWindowTokens: config.contextWindowTokens,
    supportsReasoning: config.supportsReasoning,
    supportsImages: config.supportsImages,
    thinkingLevel: config.thinkingLevel,
  };
}
