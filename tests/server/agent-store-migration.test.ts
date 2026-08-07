import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  agentRolloutFileForTest,
  inspectAgentRolloutMigrations,
  migrateAgentRollout,
} from "../../src/server/agent-engine/agent-store-migration.js";

describe("explicit Agent Store migration", () => {
  it("removes a stale Goal projection while preserving the ordered commit", async () => {
    const root = await mkdtemp();
    const file = agentRolloutFileForTest(root, "agent-a");
    await mkdir(path.dirname(file), { recursive: true });
    const goal = (version: number, status: string) => ({
      spec: { id: "goal-a" },
      version,
      status,
    });
    await writeFile(file, [
      commit("agent-a", 1, [goal(1, "active")]),
      commit("agent-a", 2, [goal(2, "paused")]),
      commit("agent-a", 3, [goal(1, "paused")], [{ position: 2 }]),
    ].join("\n") + "\n", "utf8");

    const [candidate] = await inspectAgentRolloutMigrations(root);
    expect(candidate).toMatchObject({ agentId: "agent-a", canMigrate: true });
    expect(candidate?.staleGoalUpdates).toEqual([{
      line: 3,
      goalId: "goal-a",
      persistedVersion: 1,
      currentVersion: 2,
    }]);

    const dryRun = await migrateAgentRollout(candidate!, { apply: false });
    expect(dryRun.applied).toBe(false);
    expect((await readFile(file, "utf8")).match(/\n/g)?.length).toBe(3);

    const applied = await migrateAgentRollout(candidate!, { apply: true, backupRoot: path.join(root, "backups") });
    expect(applied.applied).toBe(true);
    expect(applied.backupFile).toBeDefined();
    const repaired = (await readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(repaired[2]).toMatchObject({ aggregateVersion: 3, goals: [], outbox: [{ position: 2 }] });
    expect(await inspectAgentRolloutMigrations(root)).toEqual([]);
  });

  it("does not migrate an unknown forward version gap", async () => {
    const root = await mkdtemp();
    const file = agentRolloutFileForTest(root, "agent-a");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, [
      commit("agent-a", 1, [{ spec: { id: "goal-a" }, version: 1, status: "active" }]),
      commit("agent-a", 2, [{ spec: { id: "goal-a" }, version: 4, status: "active" }]),
    ].join("\n") + "\n", "utf8");

    const [candidate] = await inspectAgentRolloutMigrations(root);
    expect(candidate?.canMigrate).toBe(false);
    expect(candidate?.reason).toContain("goal_version_gap");
  });
});

function mkdtemp() {
  return import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(path.join(os.tmpdir(), "autoagent-agent-store-migration-")));
}

function commit(agentId: string, aggregateVersion: number, goals: unknown[], extra: Record<string, unknown>[] = []) {
  return JSON.stringify({
    schemaVersion: 1,
    type: "agent_store_commit",
    agentId,
    aggregateVersion,
    occurredAt: new Date(0).toISOString(),
    threads: [],
    threadKeys: [],
    messageIds: [],
    payloads: [],
    goals,
    goalStartKeys: [],
    proposals: [],
    decisions: [],
    controls: [],
    outbox: extra,
  });
}
