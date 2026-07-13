import os from "node:os";
import path from "node:path";

export interface AppConfig {
  port: number;
  autoAgentHome: string;
  useMockProvider: boolean;
  providerRetryCount: number;
  maxTokensPerAgentGoalWindow: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = Number(env.PORT ?? "8787");
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`Invalid PORT: ${env.PORT}`);
  }

  const maxTokensPerAgentGoalWindow = Number(env.AUTOAGENT_MAX_TOKENS_PER_AGENT_GOAL_WINDOW ?? "250000");
  if (!Number.isFinite(maxTokensPerAgentGoalWindow) || maxTokensPerAgentGoalWindow <= 0) {
    throw new Error(`Invalid AUTOAGENT_MAX_TOKENS_PER_AGENT_GOAL_WINDOW: ${env.AUTOAGENT_MAX_TOKENS_PER_AGENT_GOAL_WINDOW}`);
  }

  return {
    port,
    autoAgentHome: env.AUTOAGENT_HOME
      ? path.resolve(env.AUTOAGENT_HOME)
      : path.join(os.homedir(), ".autoagent"),
    useMockProvider: env.AUTOAGENT_PROVIDER === "mock" || env.NODE_ENV === "test",
    providerRetryCount: Number(env.AUTOAGENT_PROVIDER_RETRIES ?? "2"),
    maxTokensPerAgentGoalWindow,
  };
}
