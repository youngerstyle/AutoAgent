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

export type AutoAgentServer = Server & { stopRuntimeHosts(): Promise<void> };

type BootstrapOptions = {
  restoreRuntimeHosts?: boolean;
};

export async function bootstrapServer(
  config: AppConfig = loadConfig(),
  options: BootstrapOptions = {},
): Promise<Express> {
  const policyStore = new PlanPolicyStore(config.autoAgentHome);
  await seedMinimalTeamPlanPolicy(policyStore, DEFAULT_MINIMAL_TEAM_POLICY_CONFIG);
  const app = createApp(config);
  if (options.restoreRuntimeHosts !== false) {
    await restoreRuntimeHosts(app);
  }
  return app;
}

export async function startServer(config: AppConfig = loadConfig()): Promise<AutoAgentServer> {
  const app = await bootstrapServer(config, { restoreRuntimeHosts: false });
  return new Promise<AutoAgentServer>((resolve, reject) => {
    const server = app.listen(config.port, () => {
      server.off("error", reject);
      const managedServer = Object.assign(server, {
        stopRuntimeHosts: () => (app.locals.runtimeHostRegistry as RuntimeHostRegistry | undefined)?.stopAll() ?? Promise.resolve(),
      });
      resolve(managedServer);
      void restoreRuntimeHosts(app).catch((error) => {
        console.error("Runtime host restoration failed", error);
      });
    });
    server.once("error", reject);
  });
}

async function restoreRuntimeHosts(app: Express): Promise<void> {
  const state = app.locals.runtimeHostRestoration as { status: string; error?: string } | undefined;
  if (state?.status === "restoring" || state?.status === "ready") return;
  app.locals.runtimeHostRestoration = { status: "restoring" };
  try {
    await (app.locals.runtimeHostRegistry as RuntimeHostRegistry).startAll();
    app.locals.runtimeHostRestoration = { status: "ready" };
  } catch (error) {
    app.locals.runtimeHostRestoration = {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
    throw error;
  }
}
