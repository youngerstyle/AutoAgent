import { mkdtemp, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentTraceStore } from "../../src/server/agent-engine/trace-store.js";
import { agentEngineDir, agentEngineTraceRolloutFile } from "../../src/server/storage/paths.js";

describe("AgentTraceStore", () => {
  it("keeps raw prompts in an immutable audit store ordered by time", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-trace-v2-"));
    const store = new AgentTraceStore(root, "dev");
    const later = record("trace-2", "provider_response", "2026-07-10T00:02:00.000Z", { text: "完成" });
    const earlier = record("trace-1", "context", "2026-07-10T00:01:00.000Z", { prompt: "FULL PROMPT" });
    await store.append(later);
    await store.append(earlier);
    await store.append(earlier);

    expect((await new AgentTraceStore(root, "dev").list("thread-a")).map((item) => item.traceId))
      .toEqual(["trace-1", "trace-2"]);
    expect((await readFile(agentEngineTraceRolloutFile(root, "dev"), "utf8")).trim().split("\n")).toHaveLength(2);
    expect(await readdir(agentEngineDir(root, "dev"))).not.toContain("traces");
    await expect(store.append({ ...earlier, data: { prompt: "changed" } }))
      .rejects.toThrow("Trace idempotency conflict");
  });
});

function record(traceId: string, kind: "context" | "provider_response", createdAt: string, data: unknown) {
  return { traceId, agentId: "dev", threadId: "thread-a", turnId: "turn-a", kind, createdAt, data } as const;
}
