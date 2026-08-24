import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  TicketAttemptChangeSet,
  TicketAttemptWorkspaceBaseline,
} from "../../shared/contracts/ticket-engine.js";
import { GitWorktreeAttemptStore } from "./git-worktree-attempt-store.js";

interface WorkspaceFileFact {
  path: string;
  size: number;
  modifiedAt: string;
  sha256: string;
}

interface WorkspaceManifest {
  schemaVersion: 1;
  workspaceRoot: string;
  capturedAt: string;
  artifactVersion: string;
  files: WorkspaceFileFact[];
}

const EXCLUDED_DIRECTORIES = new Set([".autoagent", ".git", "node_modules"]);

export interface TicketAttemptWorkspacePort {
  captureBaseline(attemptId: string, options?: { isolate?: boolean }): Promise<TicketAttemptWorkspaceBaseline>;
  captureChangeSet(attemptId: string, baseline: TicketAttemptWorkspaceBaseline, options?: { integrate?: boolean }): Promise<TicketAttemptChangeSet>;
  cleanupAttempt?(attemptId: string, baseline: TicketAttemptWorkspaceBaseline): Promise<void>;
  discardAttempt?(attemptId: string, baseline: TicketAttemptWorkspaceBaseline): Promise<void>;
  executionRoot?(attemptId: string): Promise<string | undefined>;
}

export class WorkspaceSnapshotStore implements TicketAttemptWorkspacePort {
  private readonly root: string;
  private readonly attemptDirectory: string;
  private readonly worktrees: GitWorktreeAttemptStore;

  constructor(workspaceRoot: string, private readonly now: () => Date = () => new Date()) {
    this.root = path.resolve(workspaceRoot);
    this.attemptDirectory = path.join(this.root, ".autoagent", "tickets", "attempts");
    this.worktrees = new GitWorktreeAttemptStore(this.root, now);
  }

  async captureBaseline(attemptId: string, options: { isolate?: boolean } = {}): Promise<TicketAttemptWorkspaceBaseline> {
    const baselineId = randomUUID();
    const isolation = options.isolate ? await this.worktrees.prepare(attemptId) : undefined;
    const manifest = await this.captureManifest(isolation?.rootPath ?? this.root);
    const manifestRef = path.posix.join(".autoagent", "tickets", "attempts", `${attemptId}.${baselineId}.baseline.json`);
    await this.writeManifest(manifestRef, manifest);
    return {
      baselineId,
      capturedAt: manifest.capturedAt,
      artifactVersion: manifest.artifactVersion,
      manifestRef,
      ...(isolation ? { isolation } : {}),
    };
  }

  async captureChangeSet(attemptId: string, baseline: TicketAttemptWorkspaceBaseline, options: { integrate?: boolean } = {}): Promise<TicketAttemptChangeSet> {
    const before = await this.readManifest(baseline.manifestRef);
    const executionRoot = baseline.isolation?.rootPath ?? this.root;
    const after = await this.captureManifest(executionRoot);
    const beforeByPath = new Map(before.files.map((item) => [item.path, item]));
    const afterByPath = new Map(after.files.map((item) => [item.path, item]));
    const added = after.files
      .filter((item) => !beforeByPath.has(item.path))
      .map((item) => ({ path: item.path, afterSha256: item.sha256 }));
    const modified = after.files
      .filter((item) => {
        const previous = beforeByPath.get(item.path);
        return previous && previous.sha256 !== item.sha256;
      })
      .map((item) => ({
        path: item.path,
        beforeSha256: beforeByPath.get(item.path)!.sha256,
        afterSha256: item.sha256,
      }));
    const deleted = before.files
      .filter((item) => !afterByPath.has(item.path))
      .map((item) => ({ path: item.path, beforeSha256: item.sha256 }));
    const manifestRef = path.posix.join(".autoagent", "tickets", "attempts", `${attemptId}.${baseline.baselineId}.result.json`);
    await this.writeManifest(manifestRef, after);
    const integration = options.integrate && baseline.isolation
      ? await this.worktrees.integrate(attemptId, baseline.isolation)
      : undefined;
    return {
      baselineId: baseline.baselineId,
      capturedAt: baseline.capturedAt,
      completedAt: after.capturedAt,
      artifactVersion: after.artifactVersion,
      manifestRef,
      added,
      modified,
      deleted,
      ...(integration ? { integration } : {}),
    };
  }

  async cleanupAttempt(attemptId: string, baseline: TicketAttemptWorkspaceBaseline): Promise<void> {
    if (baseline.isolation) await this.worktrees.cleanup(attemptId, baseline.isolation);
  }

  async discardAttempt(attemptId: string, baseline: TicketAttemptWorkspaceBaseline): Promise<void> {
    if (baseline.isolation) await this.worktrees.discard(attemptId, baseline.isolation);
  }

  executionRoot(attemptId: string): Promise<string | undefined> {
    return this.worktrees.executionRoot(attemptId);
  }

  private async captureManifest(workspaceRoot: string): Promise<WorkspaceManifest> {
    const files = await this.listFiles(workspaceRoot, workspaceRoot);
    files.sort((left, right) => left.path.localeCompare(right.path));
    const artifactVersion = createHash("sha256")
      .update(JSON.stringify(files.map(({ path: filePath, sha256 }) => [filePath, sha256])))
      .digest("hex");
    return {
      schemaVersion: 1,
      workspaceRoot,
      capturedAt: this.now().toISOString(),
      artifactVersion,
      files,
    };
  }

  private async listFiles(directory: string, workspaceRoot: string): Promise<WorkspaceFileFact[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    const facts: WorkspaceFileFact[] = [];
    for (const entry of entries) {
      if (EXCLUDED_DIRECTORIES.has(entry.name)) continue;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        facts.push(...await this.listFiles(absolutePath, workspaceRoot));
        continue;
      }
      if (!entry.isFile()) continue;
      const info = await stat(absolutePath);
      facts.push({
        path: path.relative(workspaceRoot, absolutePath).split(path.sep).join("/"),
        size: info.size,
        modifiedAt: info.mtime.toISOString(),
        sha256: await hashFile(absolutePath),
      });
    }
    return facts;
  }

  private async writeManifest(manifestRef: string, manifest: WorkspaceManifest): Promise<void> {
    const target = path.join(this.root, ...manifestRef.split("/"));
    await mkdir(this.attemptDirectory, { recursive: true });
    await writeFile(target, JSON.stringify(manifest), "utf8");
  }

  private async readManifest(manifestRef: string): Promise<WorkspaceManifest> {
    const target = path.join(this.root, ...manifestRef.split("/"));
    const { readFile } = await import("node:fs/promises");
    return JSON.parse(await readFile(target, "utf8")) as WorkspaceManifest;
  }
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}
