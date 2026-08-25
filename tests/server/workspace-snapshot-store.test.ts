import { execFile } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { WorkspaceSnapshotStore } from "../../src/server/tickets/workspace-snapshot-store.js";

describe("WorkspaceSnapshotStore", () => {
  it("captures a salvage checkpoint without integrating partial work", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "autoagent-attempt-salvage-parent-"));
    const root = path.join(parent, "workspace");
    try {
      await git(parent, ["init", "workspace"]);
      await writeFile(path.join(root, ".gitignore"), ".autoagent/\n", "utf8");
      await git(root, ["add", ".gitignore"]);
      await git(root, ["-c", "user.name=Test", "-c", "user.email=test@local.invalid", "commit", "-m", "baseline"]);
      const store = new WorkspaceSnapshotStore(root, monotonicClock());
      const baseline = await store.captureBaseline("attempt-salvage", { isolate: true });
      await writeFile(path.join(baseline.isolation!.rootPath, "partial.txt"), "partial\n", "utf8");

      const changeSet = await store.captureChangeSet("attempt-salvage", baseline, { checkpoint: true });
      expect(changeSet.added.map((item) => item.path)).toEqual(["partial.txt"]);
      expect(changeSet.salvage).toMatchObject({ status: "checkpointed", deliveryCommit: expect.any(String) });
      await expect(readFile(path.join(root, "partial.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      expect(await store.executionRoot("attempt-salvage")).toBe(baseline.isolation!.rootPath);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("captures an isolated Git worktree and integrates its delivery before cleanup", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "autoagent-attempt-git-parent-"));
    const root = path.join(parent, "workspace");
    try {
      await git(parent, ["init", "workspace"]);
      await writeFile(path.join(root, ".gitignore"), ".autoagent/\n", "utf8");
      await writeFile(path.join(root, "baseline.txt"), "baseline\n", "utf8");
      await git(root, ["add", ".gitignore", "baseline.txt"]);
      await git(root, ["-c", "user.name=Test", "-c", "user.email=test@local.invalid", "commit", "-m", "baseline"]);
      const store = new WorkspaceSnapshotStore(root, monotonicClock());

      const baseline = await store.captureBaseline("attempt-isolated", { isolate: true });
      expect(baseline.isolation).toMatchObject({ mode: "git_worktree" });
      await writeFile(path.join(baseline.isolation!.rootPath, "delivery.txt"), "delivery\n", "utf8");
      const changeSet = await store.captureChangeSet("attempt-isolated", baseline, { integrate: true });

      expect(changeSet.added.map((item) => item.path)).toEqual(["delivery.txt"]);
      expect(changeSet.integration).toMatchObject({ status: "integrated" });
      expect((await readFile(path.join(root, "delivery.txt"), "utf8")).replaceAll("\r\n", "\n")).toBe("delivery\n");
      await store.cleanupAttempt("attempt-isolated", baseline);
      expect(await store.executionRoot("attempt-isolated")).toBeUndefined();
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("keeps Attempt worktrees on a short external path for deeply nested trial workspaces", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "autoagent-deep-attempt-"));
    const root = path.join(parent, "trial-executions", "a".repeat(32), "b".repeat(32), "1", "c".repeat(24), "candidate", "workspace");
    try {
      await mkdir(root, { recursive: true });
      await git(root, ["init"]);
      await writeFile(path.join(root, ".gitignore"), ".autoagent/\n", "utf8");
      await writeFile(path.join(root, "baseline.txt"), "baseline\n", "utf8");
      await git(root, ["add", ".gitignore", "baseline.txt"]);
      await git(root, ["-c", "user.name=Test", "-c", "user.email=test@local.invalid", "commit", "-m", "baseline"]);
      const store = new WorkspaceSnapshotStore(root, monotonicClock());

      const baseline = await store.captureBaseline("deep-trial-attempt", { isolate: true });
      expect(baseline.isolation?.rootPath).toContain(path.join(os.tmpdir(), "autoagent-worktrees"));
      expect(baseline.isolation?.rootPath).not.toContain("trial-executions");
      await store.captureChangeSet("deep-trial-attempt", baseline, { integrate: true });
      await store.cleanupAttempt("deep-trial-attempt", baseline);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

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

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, encoding: "utf8", windowsHide: true });
}
