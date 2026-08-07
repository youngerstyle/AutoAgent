import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { ProviderRegistry } from "../../src/server/providers/provider-registry.js";

describe("real provider gateway recovery", () => {
  let server: Server | undefined;
  let homeDir: string | undefined;

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      if (!server) {
        resolve();
        return;
      }
      server.close((error) => (error ? reject(error) : resolve()));
    });
    server = undefined;
    if (homeDir) await rm(homeDir, { recursive: true, force: true });
    homeDir = undefined;
  });

  it("retries a 502 and a 530 from the OpenAI-compatible gateway, then returns the model result", async () => {
    const responses = [502, 530, 200];
    let requestCount = 0;
    server = createServer((request, response) => {
      requestCount += 1;
      expect(request.url).toBe("/v1/chat/completions");
      if (responses[requestCount - 1] !== 200) {
        response.writeHead(responses[requestCount - 1]);
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: "chatcmpl-gateway-recovery",
        object: "chat.completion",
        created: 0,
        model: "gateway-test-model",
        choices: [{ index: 0, message: { role: "assistant", content: "gateway recovered" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      }));
    });
    await new Promise<void>((resolve, reject) => {
      server?.listen(0, "127.0.0.1", () => resolve());
      server?.once("error", reject);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("gateway did not bind to a port");

    homeDir = await mkdtemp(join(tmpdir(), "autoagent-provider-gateway-"));
    const registry = new ProviderRegistry({ homeDir, retryCount: 2 });
    await registry.saveConfig("openai", {
      apiKey: "gateway-test-key",
      model: "gateway-test-model",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
    });

    const result = await registry.runModelTurnWithRetry({
      provider: "openai",
      model: "gateway-test-model",
      instructions: "Return a short acknowledgement.",
      history: [{ type: "user_message", content: "hello" }],
      tools: [],
    });

    expect(requestCount).toBe(3);
    expect(result.items).toEqual([{ type: "assistant_message", content: "gateway recovered" }]);
    expect(result.usage?.totalTokens).toBe(3);
  });
});
