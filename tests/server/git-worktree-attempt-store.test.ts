import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { GitWorktreeAttemptStore } from "../../src/server/tickets/git-worktree-attempt-store.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("GitWorktreeAttemptStore", () => {
  it("checkpoints a dirty attempt without advancing canonical and replays across restart", async () => {
    const root = await repository();
    const store = new GitWorktreeAttemptStore(root, () => new Date("2026-08-24T07:00:00.000Z"));
    const isolation = await store.prepare("attempt-salvage");
    await writeFile(path.join(isolation!.rootPath, "salvaged.txt"), "partial delivery\n", "utf8");

    const checkpoint = await store.checkpoint("attempt-salvage", isolation!);
    expect(checkpoint).toMatchObject({
      status: "checkpointed",
      branch: "autoagent/attempt/attempt-salvage",
      deliveryCommit: expect.any(String),
    });
    await expect(readFile(path.join(root, "salvaged.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(normalizeLines(await git(root, ["show", `${checkpoint.deliveryCommit}:salvaged.txt`]))).toBe("partial delivery\n");

    const restarted = new GitWorktreeAttemptStore(root, () => new Date("2026-08-24T07:01:00.000Z"));
    expect(await restarted.checkpoint("attempt-salvage", isolation!)).toEqual(checkpoint);
    expect(await restarted.executionRoot("attempt-salvage")).toBe(isolation!.rootPath);
  });

  it("prepares, integrates, replays, and cleans an isolated Ticket delivery", async () => {
    const root = await repository();
    const store = new GitWorktreeAttemptStore(root, () => new Date("2026-08-24T08:00:00.000Z"));
    const isolation = await store.prepare("attempt-a");

    expect(isolation).toMatchObject({ mode: "git_worktree", branch: "autoagent/attempt/attempt-a" });
    await writeFile(path.join(isolation!.rootPath, "delivery.txt"), "isolated delivery\n", "utf8");

    const integrated = await store.integrate("attempt-a", isolation!);
    expect(integrated).toMatchObject({
      status: "integrated",
      branch: "autoagent/attempt/attempt-a",
      deliveryCommit: expect.any(String),
      integratedCommit: expect.any(String),
    });
    expect(normalizeLines(await readFile(path.join(root, "delivery.txt"), "utf8"))).toBe("isolated delivery\n");
    expect(await store.integrate("attempt-a", isolation!)).toEqual(integrated);

    await store.cleanup("attempt-a", isolation!);
    expect(await store.executionRoot("attempt-a")).toBeUndefined();
  });

  it("retains a conflicting worktree so the Ticket owner can resolve it and retry", async () => {
    const root = await repository();
    const store = new GitWorktreeAttemptStore(root);
    const first = await store.prepare("attempt-first");
    const second = await store.prepare("attempt-second");
    await writeFile(path.join(first!.rootPath, "shared.txt"), "first delivery\n", "utf8");
    await writeFile(path.join(second!.rootPath, "shared.txt"), "second delivery\n", "utf8");

    expect(await store.integrate("attempt-first", first!)).toMatchObject({ status: "integrated" });
    const conflict = await store.integrate("attempt-second", second!);
    expect(conflict).toMatchObject({
      status: "conflict",
      conflictingPaths: ["shared.txt"],
    });
    expect(await store.executionRoot("attempt-second")).toBe(second!.rootPath);

    await writeFile(path.join(second!.rootPath, "shared.txt"), "resolved delivery\n", "utf8");
    await git(second!.rootPath, ["add", "shared.txt"]);
    const retried = await store.integrate("attempt-second", second!);
    expect(retried).toMatchObject({ status: "integrated" });
    expect(normalizeLines(await readFile(path.join(root, "shared.txt"), "utf8"))).toBe("resolved delivery\n");
  });

  it("recovers a dirty isolated delivery across store recreation and integrates it exactly once", async () => {
    const root = await repository();
    const firstProcess = new GitWorktreeAttemptStore(root, () => new Date("2026-08-24T08:00:00.000Z"));
    const isolation = await firstProcess.prepare("attempt-restart");
    await writeFile(path.join(isolation!.rootPath, "recovered.txt"), "survived restart\n", "utf8");

    const restartedProcess = new GitWorktreeAttemptStore(root, () => new Date("2026-08-24T08:01:00.000Z"));
    expect(await restartedProcess.executionRoot("attempt-restart")).toBe(isolation!.rootPath);
    expect(await restartedProcess.prepare("attempt-restart")).toEqual(isolation);
    const integrated = await restartedProcess.integrate("attempt-restart", isolation!);
    expect(integrated).toMatchObject({ status: "integrated", deliveryCommit: expect.any(String) });

    const replayProcess = new GitWorktreeAttemptStore(root, () => new Date("2026-08-24T08:02:00.000Z"));
    expect(await replayProcess.integrate("attempt-restart", isolation!)).toEqual(integrated);
    expect(normalizeLines(await readFile(path.join(root, "recovered.txt"), "utf8"))).toBe("survived restart\n");
    await replayProcess.cleanup("attempt-restart", isolation!);
  });

  it("rejects a persisted state that points outside the managed worktree parent", async () => {
    const root = await repository();
    const store = new GitWorktreeAttemptStore(root);
    const isolation = await store.prepare("attempt-tampered");
    const statePath = path.join(root, isolation!.stateRef);
    const state = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
    await writeFile(statePath, JSON.stringify({ ...state, rootPath: root }), "utf8");

    await expect(new GitWorktreeAttemptStore(root).executionRoot("attempt-tampered"))
      .rejects.toThrow("Attempt worktree state is invalid");
  });

  it("falls back without mutating a dirty or non-Git workspace", async () => {
    const root = await repository();
    await writeFile(path.join(root, "dirty.txt"), "not committed\n", "utf8");
    expect(await new GitWorktreeAttemptStore(root).prepare("attempt-dirty")).toBeUndefined();

    const plain = await mkdtemp(path.join(os.tmpdir(), "autoagent-plain-workspace-"));
    roots.push(plain);
    expect(await new GitWorktreeAttemptStore(plain).prepare("attempt-plain")).toBeUndefined();
  });
});

async function repository(): Promise<string> {
  const parent = await mkdtemp(path.join(os.tmpdir(), "autoagent-git-attempt-parent-"));
  roots.push(parent);
  const root = path.join(parent, "workspace");
  await git(parent, ["init", "workspace"]);
  await writeFile(path.join(root, ".gitignore"), ".autoagent/\n", "utf8");
  await writeFile(path.join(root, "shared.txt"), "baseline\n", "utf8");
  await git(root, ["add", ".gitignore", "shared.txt"]);
  await git(root, ["-c", "user.name=Test", "-c", "user.email=test@local.invalid", "commit", "-m", "baseline"]);
  return root;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  return result.stdout;
}

function normalizeLines(value: string): string {
  return value.replaceAll("\r\n", "\n");
}
