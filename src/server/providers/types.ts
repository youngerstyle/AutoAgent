import type { ProviderName } from "../../shared/types.js";

export interface ProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface AgentToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type AgentModelHistoryItem =
  | { type: "user_message"; content: string }
  | { type: "assistant_message"; content: string }
  | { type: "tool_call"; callId: string; name: string; arguments: unknown }
  | { type: "tool_result"; callId: string; content: string; isError: boolean };

export type AgentModelOutputItem =
  | { type: "assistant_message"; content: string }
  | { type: "tool_call"; callId: string; name: string; arguments: unknown };

export interface AgentModelTurnResult {
  items: AgentModelOutputItem[];
  usage?: ProviderUsage;
}

export interface AgentModelTurnInput {
  instructions: string;
  history: AgentModelHistoryItem[];
  tools: AgentToolDefinition[];
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
  runModelTurn(input: AgentModelTurnInput): Promise<AgentModelTurnResult>;
}
