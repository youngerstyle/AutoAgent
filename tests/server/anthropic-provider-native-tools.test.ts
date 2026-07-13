import { beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.hoisted(() => vi.fn());

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create };
  },
}));

import { AnthropicProvider } from "../../src/server/providers/anthropic-provider.js";

describe("AnthropicProvider native tools", () => {
  beforeEach(() => create.mockReset());

  it("maps tool_use and tool_result blocks without a text JSON protocol", async () => {
    create.mockResolvedValue({
      content: [
        { type: "text", text: "继续处理" },
        { type: "tool_use", id: "toolu-1", name: "readFile", input: { path: "src/a.ts" } },
      ],
      usage: { input_tokens: 9, output_tokens: 4 },
    });

    const result = await new AnthropicProvider("key").runModelTurn({
      provider: "anthropic",
      model: "model",
      instructions: "system",
      history: [
        { type: "assistant_message", content: "读取" },
        { type: "tool_call", callId: "old", name: "readFile", arguments: { path: "old.ts" } },
        { type: "tool_result", callId: "old", content: "old content", isError: false },
      ],
      tools: [{ name: "readFile", description: "read", inputSchema: { type: "object" } }],
    });

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      system: "system",
      tools: [expect.objectContaining({ name: "readFile", input_schema: { type: "object" } })],
      messages: [
        { role: "assistant", content: [
          { type: "text", text: "读取" },
          { type: "tool_use", id: "old", name: "readFile", input: { path: "old.ts" } },
        ] },
        { role: "user", content: [{
          type: "tool_result",
          tool_use_id: "old",
          content: "old content",
          is_error: false,
        }] },
      ],
    }));
    expect(result.items).toEqual([
      { type: "assistant_message", content: "继续处理" },
      { type: "tool_call", callId: "toolu-1", name: "readFile", arguments: { path: "src/a.ts" } },
    ]);
  });
});
