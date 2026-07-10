import type { Server } from "node:http";
import type { Express } from "express";
import { createApp } from "./app.js";
import { loadConfig, type AppConfig } from "./config.js";
import {
  DEFAULT_MINIMAL_TEAM_POLICY_CONFIG,
  seedMinimalTeamWorkflowPolicy,
} from "./tickets/workflow-policy-config.js";
import { WorkflowPolicyStore } from "./tickets/workflow-policy-store.js";

export async function bootstrapServer(config: AppConfig = loadConfig()): Promise<Express> {
  const policyStore = new WorkflowPolicyStore(config.autoAgentHome);
  await seedMinimalTeamWorkflowPolicy(policyStore, DEFAULT_MINIMAL_TEAM_POLICY_CONFIG);
  return createApp();
}

export async function startServer(config: AppConfig = loadConfig()): Promise<Server> {
  const app = await bootstrapServer(config);
  return new Promise<Server>((resolve, reject) => {
    const server = app.listen(config.port, () => {
      server.off("error", reject);
      resolve(server);
    });
    server.once("error", reject);
  });
}
