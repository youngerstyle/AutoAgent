import type { ProviderName } from "../../shared/types.js";
import type { AgentTurnResult } from "../providers/types.js";
import type { ProviderRegistry } from "../providers/provider-registry.js";

export interface AgentProviderRequest {
  provider: ProviderName;
  model: string;
  systemPrompt: string;
  prompt: string;
}

export interface AgentProviderAdapter {
  run(input: AgentProviderRequest): Promise<AgentTurnResult>;
}

export class RegistryAgentProviderAdapter implements AgentProviderAdapter {
  constructor(private readonly registry: ProviderRegistry) {}

  run(input: AgentProviderRequest): Promise<AgentTurnResult> {
    return this.registry.runModelTurnWithRetry(input);
  }
}
