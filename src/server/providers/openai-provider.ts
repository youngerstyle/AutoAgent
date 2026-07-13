import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions/completions";
import type {
  AgentModelHistoryItem,
  AgentModelProvider,
  AgentModelTurnInput,
  AgentModelTurnResult,
} from "./types.js";
import { ProviderError } from "./types.js";

export class OpenAIProvider implements AgentModelProvider {
  name = "openai" as const;

  constructor(private readonly apiKey?: string, private readonly baseURL?: string) {}

  async runModelTurn(input: AgentModelTurnInput): Promise<AgentModelTurnResult> {
    if (!this.apiKey) throw new ProviderError("OpenAI API key is not configured", false, "MISSING_OPENAI_API_KEY");
    try {
      const client = new OpenAI({ apiKey: this.apiKey, baseURL: this.baseURL });
      const response = await client.chat.completions.create({
        model: input.model,
        messages: [
          { role: "system", content: input.instructions },
          ...openAIHistory(input.history),
        ],
        tools: input.tools.map<ChatCompletionTool>((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          },
        })),
        tool_choice: input.tools.length ? "auto" : "none",
      });
      const message = response.choices[0]?.message;
      const items: AgentModelTurnResult["items"] = [];
      if (message?.content?.trim()) items.push({ type: "assistant_message", content: message.content });
      for (const call of message?.tool_calls ?? []) {
        if (call.type !== "function") continue;
        items.push({
          type: "tool_call",
          callId: call.id,
          name: call.function.name,
          arguments: parseToolArguments(call.function.arguments),
        });
      }
      const usage = response.usage
        ? {
            inputTokens: response.usage.prompt_tokens,
            outputTokens: response.usage.completion_tokens,
            totalTokens: response.usage.total_tokens,
          }
        : undefined;
      return { items, usage };
    } catch (error) {
      throw normalizeProviderError(error, "OPENAI_ERROR");
    }
  }
}

function openAIHistory(history: AgentModelHistoryItem[]): ChatCompletionMessageParam[] {
  const messages: ChatCompletionMessageParam[] = [];
  for (let index = 0; index < history.length;) {
    const item = history[index];
    if (item.type === "user_message") {
      messages.push({ role: "user", content: item.content });
      index += 1;
      continue;
    }
    if (item.type === "tool_result") {
      messages.push({ role: "tool", tool_call_id: item.callId, content: item.content });
      index += 1;
      continue;
    }
    const content = item.type === "assistant_message" ? item.content : null;
    const calls = [];
    if (item.type === "assistant_message") index += 1;
    while (index < history.length && history[index].type === "tool_call") {
      const call = history[index] as Extract<AgentModelHistoryItem, { type: "tool_call" }>;
      calls.push({
        id: call.callId,
        type: "function" as const,
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      });
      index += 1;
    }
    if (item.type === "tool_call" && calls.length === 0) {
      calls.push({
        id: item.callId,
        type: "function" as const,
        function: { name: item.name, arguments: JSON.stringify(item.arguments) },
      });
      index += 1;
    }
    messages.push({ role: "assistant", content, ...(calls.length ? { tool_calls: calls } : {}) });
  }
  return messages;
}

function parseToolArguments(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function normalizeProviderError(error: unknown, code: string): ProviderError {
  const status = typeof error === "object" && error && "status" in error ? Number((error as { status?: number }).status) : undefined;
  const message = error instanceof Error ? error.message : "模型服务请求失败";
  const retryable = status === 429 || (status !== undefined && status >= 500);
  return new ProviderError(message, retryable, code);
}
