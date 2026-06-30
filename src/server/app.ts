import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { errorMiddleware } from "./errors.js";
import { loadConfig } from "./config.js";
import { MissionControl } from "./mission/mission-control.js";
import { ProviderRegistry } from "./providers/provider-registry.js";
import { createEventRouter } from "./routes/events.js";
import { createProviderRouter } from "./routes/providers.js";
import { createTaskRouter } from "./routes/tasks.js";
import { createWorkspaceRouter } from "./routes/workspaces.js";
import { EventLedger } from "./storage/event-ledger.js";
import { WorkspaceStore } from "./storage/workspace-store.js";

export function createApp() {
  const app = express();
  const config = loadConfig();
  const workspaceStore = new WorkspaceStore(config.autoAgentHome);
  const ledger = new EventLedger();
  const providerRegistry = new ProviderRegistry({
    homeDir: config.autoAgentHome,
    retryCount: config.providerRetryCount,
    env: process.env
  });
  const mission = new MissionControl(workspaceStore, ledger, providerRegistry);
  app.use(express.json({ limit: "2mb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, name: "AutoAgent" });
  });
  app.use("/api/providers", createProviderRouter(providerRegistry));
  app.use("/api/workspaces", createWorkspaceRouter(workspaceStore));
  app.use("/api/workspaces/:workspaceId/events", createEventRouter(ledger));
  app.use("/api/workspaces/:workspaceId", createTaskRouter(mission));

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const clientDir = path.resolve(__dirname, "../client");
  app.use(express.static(clientDir));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api")) {
      next();
      return;
    }
    res.sendFile(path.join(clientDir, "index.html"), (err) => {
      if (err) next();
    });
  });

  app.use(errorMiddleware);
  return app;
}
