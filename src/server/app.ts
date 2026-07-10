import express from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { errorMiddleware } from "./errors.js";
import { loadConfig, type AppConfig } from "./config.js";
import { AgentProfileStore } from "./agents/profile-store.js";
import { ProviderRegistry } from "./providers/provider-registry.js";
import { createAgentProfileRouter } from "./routes/agent-profiles.js";
import { createAgentRouter } from "./routes/agents.js";
import { createEventRouter } from "./routes/events.js";
import { createProviderRouter } from "./routes/providers.js";
import { createTaskRouter } from "./routes/tasks.js";
import { createWorkspaceRouter } from "./routes/workspaces.js";
import { EventLedger } from "./storage/event-ledger.js";
import { WorkspaceStore } from "./storage/workspace-store.js";
import { RuntimeHostRegistry } from "./runtime/runtime-host-registry.js";
import { WorkflowPolicyStore } from "./tickets/workflow-policy-store.js";
import { createMinimalTeamWorkflowPolicy, DEFAULT_MINIMAL_TEAM_POLICY_CONFIG } from "./tickets/workflow-policy-config.js";

function hasClientEntry(dir: string) {
  return existsSync(path.join(dir, "index.html"));
}

export function resolveClientDir(serverDir = path.dirname(fileURLToPath(import.meta.url))) {
  const candidates = [
    path.resolve(serverDir, "../../dist/client"),
    path.resolve(serverDir, "../../client"),
    path.resolve(serverDir, "../client"),
    path.resolve(process.cwd(), "dist/client")
  ];
  const clientDir = candidates.find(hasClientEntry);
  return clientDir ?? candidates[0];
}

export function createApp(config: AppConfig = loadConfig()) {
  const app = express();
  const workspaceStore = new WorkspaceStore(config.autoAgentHome);
  const profileStore = new AgentProfileStore(config.autoAgentHome);
  const ledger = new EventLedger();
  const providerRegistry = new ProviderRegistry({
    homeDir: config.autoAgentHome,
    retryCount: config.providerRetryCount,
    env: process.env
  });
  const policyStore = new WorkflowPolicyStore(config.autoAgentHome);
  const policyRef = createMinimalTeamWorkflowPolicy(DEFAULT_MINIMAL_TEAM_POLICY_CONFIG).ref;
  const mission = new RuntimeHostRegistry(workspaceStore, profileStore, providerRegistry, policyStore, policyRef);
  app.locals.runtimeHostRegistry = mission;
  app.use(express.json({ limit: "2mb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, name: "AutoAgent" });
  });
  app.use("/api/agent-profiles", createAgentProfileRouter(profileStore));
  app.use("/api/providers", createProviderRouter(providerRegistry));
  app.use("/api/workspaces", createWorkspaceRouter(workspaceStore));
  app.use("/api/workspaces/:workspaceId/agents", createAgentRouter(workspaceStore, profileStore));
  app.use("/api/workspaces/:workspaceId/events", createEventRouter(ledger));
  app.use("/api/workspaces/:workspaceId", createTaskRouter(mission));

  const clientDir = resolveClientDir();
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
