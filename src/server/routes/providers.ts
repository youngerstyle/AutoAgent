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

  return router;
}
