import { Router } from "express";
import { loadConfig } from "../config.js";
import { asyncHandler } from "../errors.js";
import { ProviderRegistry } from "../providers/provider-registry.js";

export function createProviderRouter(registry?: ProviderRegistry) {
  const router = Router();
  const config = loadConfig();
  const providerRegistry = registry ?? new ProviderRegistry({
    homeDir: config.autoAgentHome,
    retryCount: config.providerRetryCount,
    env: process.env
  });

  router.get("/status", asyncHandler(async (_req, res) => {
    res.json({ providers: await providerRegistry.status() });
  }));

  router.get("/config", asyncHandler(async (_req, res) => {
    res.json({ providers: await providerRegistry.configs() });
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
