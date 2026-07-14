import type { Server } from "node:http";
import type { Express } from "express";
import { createApp } from "./app.js";
import { loadConfig, type AppConfig } from "./config.js";
import {
  DEFAULT_MINIMAL_TEAM_POLICY_CONFIG,
  seedMinimalTeamPlanPolicy,
} from "./tickets/plan-policy-config.js";
import { PlanPolicyStore } from "./tickets/plan-policy-store.js";
import type { RuntimeHostRegistry } from "./runtime/runtime-host-registry.js";

export type AutoAgentServer = Server & { stopRuntimeHosts(): void };

export async function bootstrapServer(config: AppConfig = loadConfig()): Promise<Express> {
  const policyStore = new PlanPolicyStore(config.autoAgentHome);
  await seedMinimalTeamPlanPolicy(policyStore, DEFAULT_MINIMAL_TEAM_POLICY_CONFIG);
  return createApp(config);
}

export async function startServer(config: AppConfig = loadConfig()): Promise<AutoAgentServer> {
  const app = await bootstrapServer(config);
  return new Promise<AutoAgentServer>((resolve, reject) => {
    const server = app.listen(config.port, () => {
      server.off("error", reject);
      resolve(Object.assign(server, {
        stopRuntimeHosts: () => (app.locals.runtimeHostRegistry as RuntimeHostRegistry | undefined)?.stopAll(),
      }));
    });
    server.once("error", reject);
  });
}
