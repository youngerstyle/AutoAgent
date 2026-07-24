import path from "node:path";
import os from "node:os";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { WorkspaceSnapshotStore } from "../../src/server/tickets/workspace-snapshot-store.js";

describe("WorkspaceSnapshotStore", () => {
  it("records only changes made after the Ticket Attempt baseline", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-attempt-"));
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "existing.ts"), "before", "utf8");
    await writeFile(path.join(root, "old.txt"), "delete me", "utf8");
    const store = new WorkspaceSnapshotStore(root, monotonicClock());

    const baseline = await store.captureBaseline("attempt-1");
    await writeFile(path.join(root, "src", "existing.ts"), "after", "utf8");
    await writeFile(path.join(root, "src", "new.ts"), "new", "utf8");
    await rm(path.join(root, "old.txt"));
    const changeSet = await store.captureChangeSet("attempt-1", baseline);

    expect(changeSet.baselineId).toBe(baseline.baselineId);
    expect(changeSet.artifactVersion).not.toBe(baseline.artifactVersion);
    expect(changeSet.added.map((item) => item.path)).toEqual(["src/new.ts"]);
    expect(changeSet.modified.map((item) => item.path)).toEqual(["src/existing.ts"]);
    expect(changeSet.deleted.map((item) => item.path)).toEqual(["old.txt"]);
  });

  it("does not treat AutoAgent runtime files as delivery changes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-attempt-"));
    await writeFile(path.join(root, "index.html"), "delivery", "utf8");
    const store = new WorkspaceSnapshotStore(root);
    const baseline = await store.captureBaseline("attempt-2");

    await mkdir(path.join(root, ".autoagent", "sessions"), { recursive: true });
    await writeFile(path.join(root, ".autoagent", "sessions", "runtime.jsonl"), "runtime", "utf8");
    const changeSet = await store.captureChangeSet("attempt-2", baseline);

    expect(changeSet.added).toEqual([]);
    expect(changeSet.modified).toEqual([]);
    expect(changeSet.deleted).toEqual([]);
    expect(changeSet.artifactVersion).toBe(baseline.artifactVersion);
  });
});

function monotonicClock(): () => Date {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 6, 24, 0, 0, tick++));
}
