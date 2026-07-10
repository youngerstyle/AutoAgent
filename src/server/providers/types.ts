import type { AgentRole, ProviderName } from "../../shared/types.js";

export interface AgentTurnInput {
  role: AgentRole;
  assignmentType: string;
  prompt: string;
  model: string;
  provider: ProviderName;
  context?: Record<string, unknown>;
}

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
  runAgentTurn(input: AgentTurnInput): Promise<AgentTurnResult>;
  runModelTurn?(input: AgentModelTurnInput): Promise<AgentTurnResult>;
}
