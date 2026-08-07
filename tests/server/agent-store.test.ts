import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentStore, AgentStoreConflictError } from "../../src/server/agent-engine/agent-store.js";
import {
  agentEngineExecutionLeaseFile,
  agentEngineRolloutIndexFile,
  agentEngineRolloutFile,
} from "../../src/server/storage/paths.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("AgentStore", () => {
  it("allows only one process-wide Agent execution lease across store instances", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-agent-store-"));
    roots.push(root);
    const first = new AgentStore(root, "agent-a");
    const second = new AgentStore(root, "agent-a");
    let releaseFirst!: () => void;
    let announceFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => { announceFirst = resolve; });
    const firstRun = first.withExecutionLease(async () => {
      announceFirst();
      await new Promise<void>((release) => { releaseFirst = release; });
    });
    await firstStarted;

    expect(await second.executionLeaseHeld()).toBe(true);
    await expect(second.withExecutionLease(async () => "should-not-run")).resolves.toEqual({
      acquired: false,
    });

    releaseFirst();
    await firstRun;
    expect(await second.executionLeaseHeld()).toBe(false);
    await expect(second.withExecutionLease(async () => "ran")).resolves.toEqual({
      acquired: true,
      value: "ran",
    });
  });

  it("immediately recovers a lease left by a dead process on the same host", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-agent-store-"));
    roots.push(root);
    const leaseFile = agentEngineExecutionLeaseFile(root, "agent-a");
    await mkdir(path.dirname(leaseFile), { recursive: true });
    await writeFile(leaseFile, `${JSON.stringify({
      token: "abandoned",
      pid: 2_147_483_647,
      hostname: os.hostname(),
      acquiredAt: new Date().toISOString(),
    })}\n`, "utf8");
    const store = new AgentStore(root, "agent-a", {
      executionLeaseStaleMs: 60_000,
    });

    await expect(store.withExecutionLease(async () => "recovered")).resolves.toEqual({
      acquired: true,
      value: "recovered",
    });
  });

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

  it("writes a disposable rollout index and resumes from it without changing the audit log", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-agent-store-"));
    roots.push(root);
    const store = new AgentStore(root, "agent-a", {
      rolloutSnapshotEveryCommits: 2,
      rolloutSnapshotBytes: Number.MAX_SAFE_INTEGER,
    });

    for (let index = 0; index < 2; index += 1) {
      await store.transact((current) => ({
        ...current,
        aggregateVersion: current.aggregateVersion + 1,
        payloads: [...current.payloads, { payloadRef: `indexed-${index}`, value: { index } }],
      }));
    }

    const rollout = agentEngineRolloutFile(root, "agent-a");
    const indexFile = agentEngineRolloutIndexFile(root, "agent-a");
    const rolloutBefore = await readFile(rollout, "utf8");
    const index = JSON.parse(await readFile(indexFile, "utf8")) as {
      type: string;
      aggregateVersion: number;
      rolloutOffset: number;
    };
    expect(index).toMatchObject({
      type: "agent_store_rollout_index",
      aggregateVersion: 2,
      rolloutOffset: (await stat(rollout)).size,
    });

    await store.transact((current) => ({
      ...current,
      aggregateVersion: current.aggregateVersion + 1,
      payloads: [...current.payloads, { payloadRef: "indexed-2", value: { index: 2 } }],
    }));

    const recovered = await new AgentStore(root, "agent-a", {
      rolloutSnapshotEveryCommits: 2,
      rolloutSnapshotBytes: Number.MAX_SAFE_INTEGER,
    }).read();
    expect(recovered.aggregateVersion).toBe(3);
    expect(recovered.payloads.map((payload) => payload.payloadRef)).toEqual([
      "indexed-0",
      "indexed-1",
      "indexed-2",
    ]);
    expect((await readFile(rollout, "utf8")).startsWith(rolloutBefore)).toBe(true);
  });

  it("rejects an older Goal projection before it can overwrite newer state", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-agent-store-"));
    roots.push(root);
    const store = new AgentStore(root, "agent-a");
    const goal = {
      spec: {
        id: "goal-a",
        threadId: "thread-a",
        objective: "deliver",
        successCriteria: ["done"],
        contextRefs: [],
        createdAt: "2026-07-30T00:00:00.000Z",
      },
      version: 1,
      status: "active" as const,
      updatedAt: "2026-07-30T00:00:00.000Z",
    };
    await store.transact((current) => ({
      ...current,
      aggregateVersion: current.aggregateVersion + 1,
      threads: [{
        threadId: "thread-a",
        agentId: "agent-a",
        scopeId: "scope-a",
        version: 1,
        items: [],
      }],
      goals: [goal],
    }));
    await store.transact((current) => ({
      ...current,
      aggregateVersion: current.aggregateVersion + 1,
      goals: [{ ...goal, version: 2, status: "paused", updatedAt: "2026-07-30T00:01:00.000Z" }],
    }));

    await expect(store.transact((current) => ({
      ...current,
      aggregateVersion: current.aggregateVersion + 1,
      goals: [{ ...goal, version: 1, status: "active" }],
    }))).rejects.toBeInstanceOf(AgentStoreConflictError);
    await expect(new AgentStore(root, "agent-a").read()).resolves.toMatchObject({
      goals: [{ version: 2, status: "paused" }],
    });
  });

  it("reports a persisted Goal version regression with its Agent and Goal identity", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-agent-store-"));
    roots.push(root);
    const store = new AgentStore(root, "agent-a");
    const goal = {
      spec: {
        id: "goal-a",
        threadId: "thread-a",
        objective: "deliver",
        successCriteria: ["done"],
        contextRefs: [],
        createdAt: "2026-07-30T00:00:00.000Z",
      },
      version: 1,
      status: "active" as const,
      updatedAt: "2026-07-30T00:00:00.000Z",
    };
    await store.transact((current) => ({
      ...current,
      aggregateVersion: current.aggregateVersion + 1,
      threads: [{ threadId: "thread-a", agentId: "agent-a", scopeId: "scope-a", version: 1, items: [] }],
      goals: [goal],
    }));
    const file = agentEngineRolloutFile(root, "agent-a");
    const content = await readFile(file, "utf8");
    const invalidCommit = {
      schemaVersion: 1,
      type: "agent_store_commit",
      agentId: "agent-a",
      aggregateVersion: 2,
      occurredAt: "2026-07-30T00:02:00.000Z",
      threads: [],
      threadKeys: [],
      messageIds: [],
      payloads: [],
      goals: [goal],
      goalStartKeys: [],
      proposals: [],
      decisions: [],
      controls: [],
      outbox: [],
    };
    await writeFile(file, `${content.trim()}\n${JSON.stringify(invalidCommit)}\n`, "utf8");

    await expect(new AgentStore(root, "agent-a").read())
      .rejects.toThrow("Goal goal-a for Agent agent-a has version 1; expected 2");
  });
});
