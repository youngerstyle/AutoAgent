import type { ProviderName } from "../../shared/types.js";

export interface AgentProviderEvent {
  type: "text" | "tool_intent" | "usage" | "status";
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  usage?: ProviderUsage;
}

export interface ProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface AgentTurnResult {
  events: AgentProviderEvent[];
  text: string;
  structured?: Record<string, unknown>;
  usage?: ProviderUsage;
}

export interface AgentModelTurnInput {
  systemPrompt: string;
  prompt: string;
  model: string;
  provider: ProviderName;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public retryable: boolean,
    public code = "PROVIDER_ERROR"
  ) {
    super(message);
  }
}

export interface AgentModelProvider {
  name: ProviderName;
  runModelTurn(input: AgentModelTurnInput): Promise<AgentTurnResult>;
}
