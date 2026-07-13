import type { ProviderName } from "../../shared/types.js";
import type {
  AgentModelHistoryItem,
  AgentModelTurnResult,
  AgentToolDefinition,
} from "../providers/types.js";
import type { ProviderRegistry } from "../providers/provider-registry.js";

export interface AgentProviderRequest {
  provider: ProviderName;
  model: string;
  instructions: string;
  history: AgentModelHistoryItem[];
  tools: AgentToolDefinition[];
}

export interface AgentProviderAdapter {
  run(input: AgentProviderRequest): Promise<AgentModelTurnResult>;
}

export class RegistryAgentProviderAdapter implements AgentProviderAdapter {
  constructor(private readonly registry: ProviderRegistry) {}

  run(input: AgentProviderRequest): Promise<AgentModelTurnResult> {
    return this.registry.runModelTurnWithRetry(input);
  }
}
