import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { EvolutionSourcePatchArtifact } from "../../src/shared/contracts/evolution.js";
import { LocalGitScmProvider } from "../../src/server/evolution/local-git-scm-provider.js";

const exec = promisify(execFile);

describe("cross-platform Local Git SCM evolution adapter", () => {
  it("applies a bounded patch in a disposable worktree and protects the target ref with checks and review", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-local-git-"));
    const seed = path.join(root, "seed");
    const bare = path.join(root, "remote.git");
    const attestations = path.join(root, "attestations");
    await mkdir(path.join(seed, "src"), { recursive: true });
    await git(root, "init", "-b", "main", seed);
    await writeFile(path.join(seed, "src", "value.txt"), "old\n", "utf8");
    await git(seed, "add", "--all");
    await git(seed, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial");
    const baseCommit = (await git(seed, "rev-parse", "HEAD")).trim();
    await git(root, "clone", "--bare", seed, bare);
    const artifact = sourcePatch(baseCommit);

    const failing = provider(bare, attestations, ["-e", "process.exit(7)"]);
    const rejected = await failing.prepareChange({ candidateId: "candidate-rejected", contentHash: "a".repeat(64), artifact });
    expect((await failing.requiredChecks(rejected, ["typecheck"]))[0]).toMatchObject({ subject: "typecheck", status: "failed", revision: rejected.candidateCommit });
    await failing.review(rejected);
    await expect(failing.merge(rejected)).rejects.toThrow("requires passing checks");
    expect(await failing.currentRevision("autoagent")).toBe(baseCommit);

    const passing = provider(bare, attestations, ["-e", "process.exit(0)"]);
    const accepted = await passing.prepareChange({ candidateId: "candidate-accepted", contentHash: "b".repeat(64), artifact });
    expect(accepted.baseCommit).toBe(baseCommit);
    expect(accepted.candidateCommit).not.toBe(baseCommit);
    expect((await passing.requiredChecks(accepted, ["typecheck"]))[0]).toMatchObject({ status: "passed" });
    expect(await passing.review(accepted)).toMatchObject({ status: "passed", subject: "review" });
    const merged = await passing.merge(accepted);
    expect(merged).toMatchObject({ mergeCommit: accepted.candidateCommit, attestation: { status: "passed", subject: "merge" } });
    expect(await passing.currentRevision("autoagent")).toBe(accepted.candidateCommit);
    expect((await git(bare, "show", "main:src/value.txt")).trim()).toBe("new");
    expect(await readFile(path.join(seed, "src", "value.txt"), "utf8")).toBe("old\n");
  });
});

function provider(repositoryRoot: string, attestationRoot: string, checkArgs: string[]) {
  return new LocalGitScmProvider({
    repositories: { autoagent: { root: repositoryRoot, targetBranch: "main", checks: { typecheck: { program: process.execPath, args: checkArgs } } } },
    attestationRoot,
    reviewer: async () => ({ reviewerId: "human-reviewer", approved: true, evidence: "Reviewed the exact candidate commit and bounded diff." }),
  });
}
function sourcePatch(baseCommit: string): EvolutionSourcePatchArtifact {
  return {
    schemaVersion: 1, repositoryId: "autoagent", baseCommit, targetBranch: "main", files: ["src/value.txt"], requiredChecks: ["typecheck"],
    patch: "diff --git a/src/value.txt b/src/value.txt\nindex 3367afd..3e75765 100644\n--- a/src/value.txt\n+++ b/src/value.txt\n@@ -1 +1 @@\n-old\n+new\n",
  };
}
async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await exec("git", args, { cwd, windowsHide: true });
  return String(result.stdout);
}
