import { beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.hoisted(() => vi.fn());

vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create } };
  },
}));

import { OpenAIProvider } from "../../src/server/providers/openai-provider.js";

describe("OpenAIProvider native tools", () => {
  beforeEach(() => create.mockReset());

  it("sends native tools and preserves tool call ids without parsing assistant text", async () => {
    create.mockResolvedValue({
      choices: [{
        message: {
          content: "普通回复",
          tool_calls: [{
            id: "call-1",
            type: "function",
            function: { name: "readFile", arguments: "{\"path\":\"src/a.ts\"}" },
          }],
        },
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });

    const result = await new OpenAIProvider("key").runModelTurn({
      provider: "openai",
      model: "model",
      instructions: "system",
      history: [
        { type: "user_message", content: "读文件" },
        { type: "assistant_message", content: "先读取" },
        { type: "tool_call", callId: "old-call", name: "readFile", arguments: { path: "old.ts" } },
        { type: "tool_result", callId: "old-call", content: "old content", isError: false },
      ],
      tools: [{ name: "readFile", description: "read", inputSchema: { type: "object" } }],
    });

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      tools: [expect.objectContaining({ type: "function", function: expect.objectContaining({ name: "readFile" }) })],
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "读文件" },
        expect.objectContaining({ role: "assistant", content: "先读取", tool_calls: [expect.objectContaining({ id: "old-call" })] }),
        { role: "tool", tool_call_id: "old-call", content: "old content" },
      ],
    }));
    expect(result.items).toEqual([
      { type: "assistant_message", content: "普通回复" },
      { type: "tool_call", callId: "call-1", name: "readFile", arguments: { path: "src/a.ts" } },
    ]);
  });

  it("keeps malformed native arguments attached to the tool call for engine validation", async () => {
    create.mockResolvedValue({
      choices: [{ message: { content: null, tool_calls: [{ id: "bad", type: "function", function: { name: "readFile", arguments: "{" } }] } }],
    });

    const result = await new OpenAIProvider("key").runModelTurn({
      provider: "openai",
      model: "model",
      instructions: "system",
      history: [],
      tools: [{ name: "readFile", description: "read", inputSchema: { type: "object" } }],
    });

    expect(result.items).toEqual([{ type: "tool_call", callId: "bad", name: "readFile", arguments: "{" }]);
  });
});
