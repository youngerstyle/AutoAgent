import Anthropic from "@anthropic-ai/sdk";
import type {
  ContentBlockParam,
  MessageParam,
  Tool,
} from "@anthropic-ai/sdk/resources/messages/messages";
import type {
  AgentModelHistoryItem,
  AgentModelProvider,
  AgentModelTurnInput,
  AgentModelTurnResult,
} from "./types.js";
import { ProviderError } from "./types.js";
import { normalizeProviderError } from "./openai-provider.js";

export class AnthropicProvider implements AgentModelProvider {
  name = "anthropic" as const;

  constructor(private readonly apiKey?: string, private readonly baseURL?: string) {}

  async runModelTurn(input: AgentModelTurnInput): Promise<AgentModelTurnResult> {
    if (!this.apiKey) throw new ProviderError("Anthropic API key is not configured", false, "MISSING_ANTHROPIC_API_KEY");
    try {
      const client = new Anthropic({ apiKey: this.apiKey, baseURL: this.baseURL });
      const response = await client.messages.create({
        model: input.model,
        max_tokens: 4096,
        system: input.instructions,
        messages: anthropicHistory(input.history),
        tools: input.tools.map<Tool>((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.inputSchema as Tool.InputSchema,
        })),
      });
      const items: AgentModelTurnResult["items"] = [];
      for (const block of response.content) {
        if (block.type === "text" && block.text.trim()) {
          items.push({ type: "assistant_message", content: block.text });
        } else if (block.type === "tool_use") {
          items.push({ type: "tool_call", callId: block.id, name: block.name, arguments: block.input });
        }
      }
      const usage = response.usage
        ? {
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
            totalTokens: response.usage.input_tokens + response.usage.output_tokens,
          }
        : undefined;
      return { items, usage };
    } catch (error) {
      throw normalizeProviderError(error, "ANTHROPIC_ERROR");
    }
  }
}

function anthropicHistory(history: AgentModelHistoryItem[]): MessageParam[] {
  const messages: MessageParam[] = [];
  for (let index = 0; index < history.length;) {
    const item = history[index];
    if (item.type === "user_message") {
      messages.push({ role: "user", content: item.content });
      index += 1;
      continue;
    }
    if (item.type === "tool_result") {
      const content: ContentBlockParam[] = [];
      while (index < history.length && history[index].type === "tool_result") {
        const result = history[index] as Extract<AgentModelHistoryItem, { type: "tool_result" }>;
        content.push({
          type: "tool_result",
          tool_use_id: result.callId,
          content: result.content,
          is_error: result.isError,
        });
        index += 1;
      }
      messages.push({ role: "user", content });
      continue;
    }
    const content: ContentBlockParam[] = [];
    if (item.type === "assistant_message") {
      content.push({ type: "text", text: item.content });
      index += 1;
    }
    while (index < history.length && history[index].type === "tool_call") {
      const call = history[index] as Extract<AgentModelHistoryItem, { type: "tool_call" }>;
      content.push({ type: "tool_use", id: call.callId, name: call.name, input: call.arguments });
      index += 1;
    }
    if (item.type === "tool_call" && content.length === 0) {
      content.push({ type: "tool_use", id: item.callId, name: item.name, input: item.arguments });
      index += 1;
    }
    messages.push({ role: "assistant", content });
  }
  return messages;
}
