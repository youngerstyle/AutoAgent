import os from "node:os";
import path from "node:path";

export interface AppConfig {
  port: number;
  autoAgentHome: string;
  useMockProvider: boolean;
  providerRetryCount: number;
  runtimeRestoreConcurrency?: number;
  runtimeExecutionConcurrency?: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = Number(env.PORT ?? "8787");
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`Invalid PORT: ${env.PORT}`);
  }

  const runtimeRestoreConcurrency = Number(env.AUTOAGENT_RUNTIME_RESTORE_CONCURRENCY ?? "2");
  if (!Number.isInteger(runtimeRestoreConcurrency) || runtimeRestoreConcurrency <= 0) {
    throw new Error(`Invalid AUTOAGENT_RUNTIME_RESTORE_CONCURRENCY: ${env.AUTOAGENT_RUNTIME_RESTORE_CONCURRENCY}`);
  }
  const runtimeExecutionConcurrency = Number(env.AUTOAGENT_RUNTIME_EXECUTION_CONCURRENCY ?? "2");
  if (!Number.isInteger(runtimeExecutionConcurrency) || runtimeExecutionConcurrency <= 0) {
    throw new Error(`Invalid AUTOAGENT_RUNTIME_EXECUTION_CONCURRENCY: ${env.AUTOAGENT_RUNTIME_EXECUTION_CONCURRENCY}`);
  }

  return {
    port,
    autoAgentHome: env.AUTOAGENT_HOME
      ? path.resolve(env.AUTOAGENT_HOME)
      : path.join(os.homedir(), ".autoagent"),
    useMockProvider: env.AUTOAGENT_PROVIDER === "mock" || env.NODE_ENV === "test",
    providerRetryCount: Number(env.AUTOAGENT_PROVIDER_RETRIES ?? "2"),
    runtimeRestoreConcurrency,
    runtimeExecutionConcurrency,
  };
}
