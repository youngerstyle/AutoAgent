import Anthropic from "@anthropic-ai/sdk";
import type { AgentModelProvider, AgentTurnInput, AgentTurnResult } from "./types.js";
import { ProviderError } from "./types.js";
import { normalizeProviderError } from "./openai-provider.js";

export class AnthropicProvider implements AgentModelProvider {
  name = "anthropic" as const;

  constructor(private readonly apiKey?: string, private readonly baseURL?: string) {}

  async runAgentTurn(input: AgentTurnInput): Promise<AgentTurnResult> {
    if (!this.apiKey) throw new ProviderError("Anthropic API key is not configured", false, "MISSING_ANTHROPIC_API_KEY");
    try {
      const client = new Anthropic({ apiKey: this.apiKey, baseURL: this.baseURL });
      const response = await client.messages.create({
        model: input.model,
        max_tokens: 1200,
        system: `You are the ${input.role} agent. Return concise JSON when possible.`,
        messages: [{ role: "user", content: input.prompt }]
      });
      const text = response.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      const usage = response.usage
        ? {
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
            totalTokens: response.usage.input_tokens + response.usage.output_tokens
          }
        : undefined;
      return { text, usage, structured: parseJsonObject(text), events: [{ type: "text", text }, { type: "usage", usage }] };
    } catch (error) {
      throw normalizeProviderError(error, "ANTHROPIC_ERROR");
    }
  }
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
