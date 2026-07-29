import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentStore } from "../../src/server/agent-engine/agent-store.js";
import { agentEngineRolloutFile } from "../../src/server/storage/paths.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("AgentStore", () => {
  it("serves concurrent first reads without turning an empty projection into a write race", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-agent-store-"));
    roots.push(root);
    const stores = Array.from({ length: 20 }, () => new AgentStore(root, "agent-a", {
      lockWaitTimeoutMs: 5_000,
      lockRetryMs: 2,
    }));

    const aggregates = await Promise.all(stores.map((store) => store.read()));

    expect(aggregates).toHaveLength(20);
    expect(aggregates.every((aggregate) => aggregate.aggregateVersion === 0)).toBe(true);
    await expect(stat(agentEngineRolloutFile(root, "agent-a"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("invalidates a cached projection when another store instance appends a commit", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-agent-store-"));
    roots.push(root);
    const first = new AgentStore(root, "agent-a");
    const second = new AgentStore(root, "agent-a");

    expect((await first.read()).aggregateVersion).toBe(0);
    await second.transact((current) => ({
      ...current,
      aggregateVersion: current.aggregateVersion + 1,
    }));

    expect((await first.read()).aggregateVersion).toBe(1);
  });

  it("persists each update as a canonical delta and recovers the same aggregate", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-agent-store-"));
    roots.push(root);
    const store = new AgentStore(root, "agent-a");

    for (let index = 0; index < 8; index += 1) {
      await store.transact((current) => ({
        ...current,
        aggregateVersion: current.aggregateVersion + 1,
        payloads: [...current.payloads, {
          payloadRef: `payload-${index}`,
          value: { index, optional: undefined },
        }],
      }));
    }

    const hot = await store.read();
    const recovered = await new AgentStore(root, "agent-a").read();
    expect(recovered).toEqual(hot);
    expect(recovered.payloads).toHaveLength(8);
    expect(recovered.payloads[0]?.value).toEqual({ index: 0 });

    const commits = (await readFile(agentEngineRolloutFile(root, "agent-a"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { payloads: unknown[] });
    expect(commits).toHaveLength(8);
    expect(commits.every((commit) => commit.payloads.length === 1)).toBe(true);
  });
});
