import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import type { TicketAttemptChangeSet, TicketAttemptWorkspaceBaseline } from "../../shared/contracts/ticket-engine.js";

const execFileAsync = promisify(execFile);

interface GitAttemptState {
  schemaVersion: 1;
  attemptId: string;
  canonicalRoot: string;
  rootPath: string;
  branch: string;
  baseCommit: string;
  stateRef: string;
  status: "prepared" | "checkpointed" | "conflict" | "integrated" | "cleaned";
  deliveryCommit?: string;
  integratedCommit?: string;
  conflictingPaths?: string[];
  reason?: string;
  updatedAt: string;
}

export type GitAttemptIsolation = NonNullable<TicketAttemptWorkspaceBaseline["isolation"]>;
export type GitAttemptIntegration = NonNullable<TicketAttemptChangeSet["integration"]>;
export type GitAttemptSalvage = NonNullable<TicketAttemptChangeSet["salvage"]>;

export class GitWorktreeAttemptStore {
  private operationTail: Promise<unknown> = Promise.resolve();
  private readonly canonicalRoot: string;
  private readonly stateDirectory: string;
  private readonly worktreeParent: string;

  constructor(workspaceRoot: string, private readonly now: () => Date = () => new Date()) {
    this.canonicalRoot = path.resolve(workspaceRoot);
    this.stateDirectory = path.join(this.canonicalRoot, ".autoagent", "tickets", "worktrees");
    const workspaceKey = createHash("sha256").update(this.canonicalRoot.toLowerCase()).digest("hex").slice(0, 16);
    // Trial arms and deeply nested user projects can already be close to the
    // Windows path limit. Keeping another worktree beside the canonical root
    // compounds that path and makes Git for Windows fail before checkout.
    this.worktreeParent = path.join(os.tmpdir(), "autoagent-worktrees", workspaceKey);
  }

  prepare(attemptId: string): Promise<GitAttemptIsolation | undefined> {
    return this.exclusive(() => this.prepareUnlocked(attemptId));
  }

  integrate(attemptId: string, isolation: GitAttemptIsolation): Promise<GitAttemptIntegration> {
    return this.exclusive(() => this.integrateUnlocked(attemptId, isolation));
  }

  checkpoint(attemptId: string, isolation: GitAttemptIsolation): Promise<GitAttemptSalvage> {
    return this.exclusive(() => this.checkpointUnlocked(attemptId, isolation));
  }

  cleanup(attemptId: string, isolation: GitAttemptIsolation): Promise<void> {
    return this.exclusive(() => this.cleanupUnlocked(attemptId, isolation));
  }

  discard(attemptId: string, isolation: GitAttemptIsolation): Promise<void> {
    return this.exclusive(() => this.discardUnlocked(attemptId, isolation));
  }

  async executionRoot(attemptId: string): Promise<string | undefined> {
    const state = await this.readState(attemptId);
    if (!state || state.status === "cleaned") return undefined;
    if (!existsSync(state.rootPath)) throw new Error(`Attempt worktree is missing: ${state.rootPath}`);
    return state.rootPath;
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operationTail.catch(() => undefined).then(operation);
    this.operationTail = next;
    return next;
  }

  private async prepareUnlocked(attemptId: string): Promise<GitAttemptIsolation | undefined> {
    const retained = await this.readState(attemptId);
    if (retained && retained.status !== "cleaned" && existsSync(retained.rootPath)) return isolationFrom(retained);
    if (!await this.isCanonicalGitRoot()) return undefined;
    if ((await this.git(this.canonicalRoot, ["status", "--porcelain", "--untracked-files=all"])).trim()) return undefined;

    const baseCommit = (await this.git(this.canonicalRoot, ["rev-parse", "HEAD"])).trim();
    const branch = `autoagent/attempt/${safeAttemptId(attemptId)}`;
    const rootPath = path.join(this.worktreeParent, safeAttemptId(attemptId));
    const stateRef = path.posix.join(".autoagent", "tickets", "worktrees", `${safeAttemptId(attemptId)}.json`);
    await mkdir(this.worktreeParent, { recursive: true });

    if (!existsSync(rootPath)) {
      const branchExists = await this.gitSucceeds(this.canonicalRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
      await this.git(this.canonicalRoot, branchExists
        ? ["worktree", "add", rootPath, branch]
        : ["worktree", "add", "-b", branch, rootPath, baseCommit]);
    }
    const state: GitAttemptState = {
      schemaVersion: 1,
      attemptId,
      canonicalRoot: this.canonicalRoot,
      rootPath,
      branch,
      baseCommit,
      stateRef,
      status: "prepared",
      updatedAt: this.now().toISOString(),
    };
    await this.writeState(state);
    return isolationFrom(state);
  }

  private async integrateUnlocked(attemptId: string, isolation: GitAttemptIsolation): Promise<GitAttemptIntegration> {
    const state = await this.requireMatchingState(attemptId, isolation);
    if (state.status === "integrated" || state.status === "cleaned") {
      return integrationFrom(state, state.deliveryCommit ? "integrated" : "no_changes");
    }
    if (!existsSync(state.rootPath)) throw new Error(`Attempt worktree is missing: ${state.rootPath}`);
    if ((await this.unmergedPaths(state.rootPath)).length > 0) {
      return this.persistConflict(state, "Attempt worktree still contains unresolved merge conflicts");
    }

    const dirty = (await this.git(state.rootPath, ["status", "--porcelain", "--untracked-files=all"])).trim();
    if (dirty) {
      await this.git(state.rootPath, ["add", "-A"]);
      await this.git(state.rootPath, [
        "-c", "user.name=AutoAgent",
        "-c", "user.email=autoagent@local.invalid",
        "commit", "-m", `AutoAgent delivery attempt ${attemptId}`,
      ]);
    }
    let deliveryCommit = (await this.git(state.rootPath, ["rev-parse", "HEAD"])).trim();
    if (deliveryCommit === state.baseCommit) {
      const integrated = { ...state, status: "integrated" as const, updatedAt: this.now().toISOString() };
      await this.writeState(integrated);
      return integrationFrom(integrated, "no_changes");
    }

    if ((await this.git(this.canonicalRoot, ["status", "--porcelain", "--untracked-files=all"])).trim()) {
      return this.persistConflict(state, "Canonical workspace contains uncommitted changes; integration was not attempted");
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const canonicalHead = (await this.git(this.canonicalRoot, ["rev-parse", "HEAD"])).trim();
      if (await this.isAncestor(deliveryCommit, canonicalHead)) {
        const integrated = {
          ...state,
          status: "integrated" as const,
          deliveryCommit,
          integratedCommit: canonicalHead,
          conflictingPaths: undefined,
          reason: undefined,
          updatedAt: this.now().toISOString(),
        };
        await this.writeState(integrated);
        return integrationFrom(integrated, "integrated");
      }
      if (!await this.isAncestor(canonicalHead, deliveryCommit)) {
        const merged = await this.gitResult(state.rootPath, [
          "-c", "user.name=AutoAgent",
          "-c", "user.email=autoagent@local.invalid",
          "merge", "--no-edit", canonicalHead,
        ]);
        if (merged.exitCode !== 0) {
          return this.persistConflict(state, "Latest canonical changes conflict with this Ticket delivery");
        }
        deliveryCommit = (await this.git(state.rootPath, ["rev-parse", "HEAD"])).trim();
      }
      const advanced = await this.gitResult(this.canonicalRoot, ["merge", "--ff-only", deliveryCommit]);
      if (advanced.exitCode === 0) {
        const integratedCommit = (await this.git(this.canonicalRoot, ["rev-parse", "HEAD"])).trim();
        const integrated = {
          ...state,
          status: "integrated" as const,
          deliveryCommit,
          integratedCommit,
          conflictingPaths: undefined,
          reason: undefined,
          updatedAt: this.now().toISOString(),
        };
        await this.writeState(integrated);
        return integrationFrom(integrated, "integrated");
      }
    }
    return this.persistConflict(state, "Canonical branch advanced repeatedly during integration; retry from the retained worktree");
  }

  private async checkpointUnlocked(attemptId: string, isolation: GitAttemptIsolation): Promise<GitAttemptSalvage> {
    const state = await this.requireMatchingState(attemptId, isolation);
    if (state.status === "checkpointed" || state.status === "integrated" || state.status === "cleaned") {
      return salvageFrom(state, state.deliveryCommit ? "checkpointed" : "no_changes");
    }
    if (!existsSync(state.rootPath)) throw new Error(`Attempt worktree is missing: ${state.rootPath}`);
    const conflictingPaths = await this.unmergedPaths(state.rootPath);
    if (conflictingPaths.length > 0) {
      const conflict = {
        ...state,
        status: "conflict" as const,
        conflictingPaths,
        reason: "Attempt worktree contains unresolved merge conflicts and cannot be checkpointed",
        updatedAt: this.now().toISOString(),
      };
      await this.writeState(conflict);
      return salvageFrom(conflict, "conflict");
    }
    const dirty = (await this.git(state.rootPath, ["status", "--porcelain", "--untracked-files=all"])).trim();
    if (dirty) {
      await this.git(state.rootPath, ["add", "-A"]);
      await this.git(state.rootPath, [
        "-c", "user.name=AutoAgent",
        "-c", "user.email=autoagent@local.invalid",
        "commit", "-m", `AutoAgent salvage checkpoint ${attemptId}`,
      ]);
    }
    const deliveryCommit = (await this.git(state.rootPath, ["rev-parse", "HEAD"])).trim();
    const checkpointed = {
      ...state,
      status: "checkpointed" as const,
      ...(deliveryCommit === state.baseCommit ? { deliveryCommit: undefined } : { deliveryCommit }),
      conflictingPaths: undefined,
      reason: undefined,
      updatedAt: this.now().toISOString(),
    };
    await this.writeState(checkpointed);
    return salvageFrom(checkpointed, checkpointed.deliveryCommit ? "checkpointed" : "no_changes");
  }

  private async cleanupUnlocked(attemptId: string, isolation: GitAttemptIsolation): Promise<void> {
    const state = await this.requireMatchingState(attemptId, isolation);
    if (state.status === "cleaned") return;
    if (state.status !== "integrated") return;
    assertManagedWorktreePath(this.worktreeParent, state.rootPath);
    if (existsSync(state.rootPath)) await this.git(this.canonicalRoot, ["worktree", "remove", "--force", state.rootPath]);
    await this.gitResult(this.canonicalRoot, ["branch", "-d", state.branch]);
    await this.writeState({ ...state, status: "cleaned", updatedAt: this.now().toISOString() });
  }

  private async discardUnlocked(attemptId: string, isolation: GitAttemptIsolation): Promise<void> {
    const state = await this.requireMatchingState(attemptId, isolation);
    if (state.status === "cleaned" || state.status === "integrated") return;
    assertManagedWorktreePath(this.worktreeParent, state.rootPath);
    if (existsSync(state.rootPath)) await this.git(this.canonicalRoot, ["worktree", "remove", "--force", state.rootPath]);
    await this.gitResult(this.canonicalRoot, ["branch", "-D", state.branch]);
    await this.writeState({ ...state, status: "cleaned", reason: "attempt discarded before claim publication", updatedAt: this.now().toISOString() });
  }

  private async persistConflict(state: GitAttemptState, reason: string): Promise<GitAttemptIntegration> {
    const conflictingPaths = existsSync(state.rootPath) ? await this.unmergedPaths(state.rootPath) : [];
    const next = {
      ...state,
      status: "conflict" as const,
      conflictingPaths,
      reason,
      updatedAt: this.now().toISOString(),
    };
    await this.writeState(next);
    return integrationFrom(next, "conflict");
  }

  private async isCanonicalGitRoot(): Promise<boolean> {
    const result = await this.gitResult(this.canonicalRoot, ["rev-parse", "--show-toplevel"]);
    return result.exitCode === 0 && path.resolve(result.stdout.trim()) === this.canonicalRoot;
  }

  private isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    return this.gitSucceeds(this.canonicalRoot, ["merge-base", "--is-ancestor", ancestor, descendant]);
  }

  private async unmergedPaths(root: string): Promise<string[]> {
    const result = await this.git(root, ["diff", "--name-only", "--diff-filter=U"]);
    return result.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  }

  private async requireMatchingState(attemptId: string, isolation: GitAttemptIsolation): Promise<GitAttemptState> {
    const state = await this.readState(attemptId);
    if (!state) throw new Error(`Attempt worktree state is missing: ${attemptId}`);
    if (path.resolve(state.rootPath) !== path.resolve(isolation.rootPath)
      || state.branch !== isolation.branch
      || state.baseCommit !== isolation.baseCommit) {
      throw new Error(`Attempt worktree state does not match the Ticket baseline: ${attemptId}`);
    }
    return state;
  }

  private stateFile(attemptId: string): string {
    return path.join(this.stateDirectory, `${safeAttemptId(attemptId)}.json`);
  }

  private async readState(attemptId: string): Promise<GitAttemptState | undefined> {
    try {
      const value: unknown = JSON.parse(await readFile(this.stateFile(attemptId), "utf8"));
      return validateState(value, attemptId, this.canonicalRoot, this.worktreeParent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async writeState(state: GitAttemptState): Promise<void> {
    await mkdir(this.stateDirectory, { recursive: true });
    const target = this.stateFile(state.attemptId);
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
    await rename(temporary, target);
  }

  private async git(cwd: string, args: string[]): Promise<string> {
    const result = await this.gitResult(cwd, args);
    if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim() || result.stdout.trim()}`);
    return result.stdout;
  }

  private async gitSucceeds(cwd: string, args: string[]): Promise<boolean> {
    return (await this.gitResult(cwd, args)).exitCode === 0;
  }

  private async gitResult(cwd: string, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    try {
      const result = await execFileAsync("git", args, { cwd, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
      return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & { code?: number; stdout?: string; stderr?: string };
      return {
        exitCode: typeof failure.code === "number" ? failure.code : 1,
        stdout: failure.stdout ?? "",
        stderr: failure.stderr ?? failure.message,
      };
    }
  }
}

function isolationFrom(state: GitAttemptState): GitAttemptIsolation {
  return {
    mode: "git_worktree",
    rootPath: state.rootPath,
    branch: state.branch,
    baseCommit: state.baseCommit,
    stateRef: state.stateRef,
  };
}

function integrationFrom(state: GitAttemptState, status: GitAttemptIntegration["status"]): GitAttemptIntegration {
  return {
    status,
    branch: state.branch,
    baseCommit: state.baseCommit,
    ...(state.deliveryCommit ? { deliveryCommit: state.deliveryCommit } : {}),
    ...(state.integratedCommit ? { integratedCommit: state.integratedCommit } : {}),
    ...(state.conflictingPaths?.length ? { conflictingPaths: state.conflictingPaths } : {}),
    ...(state.reason ? { reason: state.reason } : {}),
  };
}

function safeAttemptId(attemptId: string): string {
  const safe = attemptId.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96);
  if (!safe) throw new Error("Attempt ID cannot be represented as a Git worktree name");
  return safe;
}

function assertManagedWorktreePath(parent: string, candidate: string): void {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to manage a worktree outside the configured parent: ${candidate}`);
  }
}

function validateState(value: unknown, attemptId: string, canonicalRoot: string, worktreeParent: string): GitAttemptState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Attempt worktree state is invalid: ${attemptId}`);
  }
  const state = value as Record<string, unknown>;
  const safeId = safeAttemptId(attemptId);
  const expectedBranch = `autoagent/attempt/${safeId}`;
  const expectedStateRef = path.posix.join(".autoagent", "tickets", "worktrees", `${safeId}.json`);
  const expectedRootPath = path.join(worktreeParent, safeId);
  const statuses = new Set(["prepared", "checkpointed", "conflict", "integrated", "cleaned"]);
  if (state.schemaVersion !== 1
    || state.attemptId !== attemptId
    || typeof state.canonicalRoot !== "string"
    || path.resolve(state.canonicalRoot) !== canonicalRoot
    || typeof state.rootPath !== "string"
    || path.resolve(state.rootPath) !== path.resolve(expectedRootPath)
    || state.branch !== expectedBranch
    || typeof state.baseCommit !== "string"
    || !/^[0-9a-f]{40,64}$/i.test(state.baseCommit)
    || state.stateRef !== expectedStateRef
    || typeof state.status !== "string"
    || !statuses.has(state.status)
    || typeof state.updatedAt !== "string") {
    throw new Error(`Attempt worktree state is invalid: ${attemptId}`);
  }
  assertManagedWorktreePath(worktreeParent, state.rootPath);
  return value as GitAttemptState;
}

function salvageFrom(state: GitAttemptState, status: GitAttemptSalvage["status"]): GitAttemptSalvage {
  return {
    status,
    branch: state.branch,
    baseCommit: state.baseCommit,
    ...(state.deliveryCommit ? { deliveryCommit: state.deliveryCommit } : {}),
    ...(state.conflictingPaths?.length ? { conflictingPaths: state.conflictingPaths } : {}),
    ...(state.reason ? { reason: state.reason } : {}),
  };
}
