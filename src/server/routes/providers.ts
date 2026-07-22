import { Router } from "express";
import { loadConfig } from "../config.js";
import { asyncHandler, HttpError } from "../errors.js";
import { ProviderRegistry } from "../providers/provider-registry.js";

export function createProviderRouter(registry?: ProviderRegistry) {
  const router = Router();
  const providerRegistry = registry ?? defaultProviderRegistry();

  router.get("/status", asyncHandler(async (_req, res) => {
    res.json({ providers: await providerRegistry.status() });
  }));

  router.get("/config", asyncHandler(async (_req, res) => {
    res.json({ providers: await providerRegistry.configs() });
  }));

  router.get("/model-configs", asyncHandler(async (_req, res) => {
    res.json({ configs: await providerRegistry.modelConfigs() });
  }));

  router.post("/model-configs", asyncHandler(async (req, res) => {
    const provider = assertRealProvider(req.body.provider);
    const config = await providerRegistry.createModelConfig({
      name: req.body.name !== undefined ? String(req.body.name) : undefined,
      provider,
      model: req.body.model !== undefined ? String(req.body.model) : undefined,
      contextWindowTokens: req.body.contextWindowTokens !== undefined
        ? assertContextWindowTokens(req.body.contextWindowTokens)
        : undefined,
      supportsReasoning: req.body.supportsReasoning !== undefined ? Boolean(req.body.supportsReasoning) : undefined,
      thinkingLevel: req.body.thinkingLevel !== undefined ? assertThinkingLevel(req.body.thinkingLevel) : undefined,
      apiKey: req.body.apiKey !== undefined ? String(req.body.apiKey) : undefined,
      baseUrl: req.body.baseUrl !== undefined ? String(req.body.baseUrl) : undefined,
      isDefault: Boolean(req.body.isDefault)
    });
    res.status(201).json({ config });
  }));

  router.patch("/model-configs/:configId", asyncHandler(async (req, res) => {
    try {
      const config = await providerRegistry.updateModelConfig(String(req.params.configId), {
        name: req.body.name !== undefined ? String(req.body.name) : undefined,
        provider: req.body.provider !== undefined ? assertRealProvider(req.body.provider) : undefined,
        model: req.body.model !== undefined ? String(req.body.model) : undefined,
        contextWindowTokens: req.body.contextWindowTokens !== undefined
          ? assertContextWindowTokens(req.body.contextWindowTokens)
          : undefined,
        supportsReasoning: req.body.supportsReasoning !== undefined ? Boolean(req.body.supportsReasoning) : undefined,
        thinkingLevel: req.body.thinkingLevel !== undefined ? assertThinkingLevel(req.body.thinkingLevel) : undefined,
        apiKey: req.body.apiKey !== undefined ? String(req.body.apiKey) : undefined,
        baseUrl: req.body.baseUrl !== undefined ? String(req.body.baseUrl) : undefined,
        isDefault: req.body.isDefault !== undefined ? Boolean(req.body.isDefault) : undefined
      });
      res.json({ config });
    } catch (error) {
      if ((error as Error).message.includes("not found")) throw new HttpError(404, (error as Error).message, "MODEL_CONFIG_NOT_FOUND");
      throw error;
    }
  }));

  router.post("/model-configs/:configId/default", asyncHandler(async (req, res) => {
    try {
      const config = await providerRegistry.setDefaultModelConfig(String(req.params.configId));
      res.json({ config });
    } catch (error) {
      if ((error as Error).message.includes("not found")) throw new HttpError(404, (error as Error).message, "MODEL_CONFIG_NOT_FOUND");
      throw error;
    }
  }));

  router.patch("/:provider", asyncHandler(async (req, res) => {
    const provider = String(req.params.provider);
    if (provider !== "openai" && provider !== "anthropic") {
      res.status(400).json({ error: "Provider must be openai or anthropic", code: "INVALID_PROVIDER" });
      return;
    }
    const saved = await providerRegistry.saveConfig(provider, {
      provider,
      model: req.body.model ? String(req.body.model) : undefined,
      apiKey: req.body.apiKey !== undefined ? String(req.body.apiKey) : undefined,
      baseUrl: req.body.baseUrl !== undefined ? String(req.body.baseUrl) : undefined
    });
    res.json({ provider: saved });
  }));

  return router;
}

function defaultProviderRegistry(): ProviderRegistry {
  const config = loadConfig();
  return new ProviderRegistry({
    homeDir: config.autoAgentHome,
    retryCount: config.providerRetryCount,
    env: process.env,
  });
}

function assertRealProvider(provider: unknown) {
  if (provider === "openai" || provider === "anthropic") return provider;
  throw new HttpError(400, "模型配置只支持 OpenAI 或 Anthropic", "INVALID_PROVIDER");
}

function assertContextWindowTokens(value: unknown): number {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new HttpError(400, "上下文窗口必须是正整数", "INVALID_CONTEXT_WINDOW");
  }
  return normalized;
}

function assertThinkingLevel(value: unknown) {
  const normalized = String(value);
  const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
  const level = levels.find((candidate) => candidate === normalized);
  if (!level) throw new HttpError(400, "推理强度无效", "INVALID_THINKING_LEVEL");
  return level;
}
