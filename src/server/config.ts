import os from "node:os";
import path from "node:path";
import { existsSync, statSync } from "node:fs";

export interface AppConfig {
  port: number;
  autoAgentHome: string;
  useMockProvider: boolean;
  providerRetryCount: number;
  runtimeRestoreConcurrency?: number;
  runtimeExecutionConcurrency?: number;
  evolutionEvaluatorProgramPath?: string;
  evolutionPluginSandboxProgramPath?: string;
  evolutionWorkerIntervalMs?: number;
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
  const evolutionWorkerIntervalMs = Number(env.AUTOAGENT_EVOLUTION_WORKER_INTERVAL_MS ?? "30000");
  if (!Number.isSafeInteger(evolutionWorkerIntervalMs) || evolutionWorkerIntervalMs < 1_000) {
    throw new Error(`Invalid AUTOAGENT_EVOLUTION_WORKER_INTERVAL_MS: ${env.AUTOAGENT_EVOLUTION_WORKER_INTERVAL_MS}`);
  }

  const evolutionEvaluatorProgramPath = env.AUTOAGENT_EVOLUTION_EVALUATOR_PROGRAM
    ? path.resolve(env.AUTOAGENT_EVOLUTION_EVALUATOR_PROGRAM)
    : undefined;
  if (evolutionEvaluatorProgramPath
    && (!existsSync(evolutionEvaluatorProgramPath)
      || !statSync(evolutionEvaluatorProgramPath).isFile()
      || !new Set([".js", ".mjs", ".cjs"]).has(path.extname(evolutionEvaluatorProgramPath).toLowerCase()))) {
    throw new Error(`Invalid AUTOAGENT_EVOLUTION_EVALUATOR_PROGRAM: ${env.AUTOAGENT_EVOLUTION_EVALUATOR_PROGRAM}`);
  }
  const evolutionPluginSandboxProgramPath = env.AUTOAGENT_EVOLUTION_PLUGIN_SANDBOX_PROGRAM;
  if (evolutionPluginSandboxProgramPath
    && (!path.isAbsolute(evolutionPluginSandboxProgramPath)
      || !existsSync(evolutionPluginSandboxProgramPath)
      || !statSync(evolutionPluginSandboxProgramPath).isFile())) {
    throw new Error(`Invalid AUTOAGENT_EVOLUTION_PLUGIN_SANDBOX_PROGRAM: ${env.AUTOAGENT_EVOLUTION_PLUGIN_SANDBOX_PROGRAM}`);
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
    evolutionEvaluatorProgramPath,
    ...(evolutionPluginSandboxProgramPath ? { evolutionPluginSandboxProgramPath: path.resolve(evolutionPluginSandboxProgramPath) } : {}),
    evolutionWorkerIntervalMs,
  };
}
