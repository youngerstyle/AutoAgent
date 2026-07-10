import OpenAI from "openai";
import type { AgentModelProvider, AgentModelTurnInput, AgentTurnResult } from "./types.js";
import { ProviderError } from "./types.js";

export class OpenAIProvider implements AgentModelProvider {
  name = "openai" as const;

  constructor(private readonly apiKey?: string, private readonly baseURL?: string) {}

  async runModelTurn(input: AgentModelTurnInput): Promise<AgentTurnResult> {
    if (!this.apiKey) throw new ProviderError("OpenAI API key is not configured", false, "MISSING_OPENAI_API_KEY");
    try {
      const client = new OpenAI({ apiKey: this.apiKey, baseURL: this.baseURL });
      const response = await client.chat.completions.create({
        model: input.model,
        messages: [
          { role: "system", content: input.systemPrompt },
          { role: "user", content: input.prompt }
        ]
      });
      const text = response.choices[0]?.message.content ?? "";
      const usage = response.usage
        ? {
            inputTokens: response.usage.prompt_tokens,
            outputTokens: response.usage.completion_tokens,
            totalTokens: response.usage.total_tokens
          }
        : undefined;
      return { text, usage, structured: parseJsonObject(text), events: [{ type: "text", text }, { type: "usage", usage }] };
    } catch (error) {
      throw normalizeProviderError(error, "OPENAI_ERROR");
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

export function normalizeProviderError(error: unknown, code: string): ProviderError {
  const status = typeof error === "object" && error && "status" in error ? Number((error as { status?: number }).status) : undefined;
  const message = error instanceof Error ? error.message : "模型服务请求失败";
  const retryable = status === 429 || (status !== undefined && status >= 500);
  return new ProviderError(message, retryable, code);
}
