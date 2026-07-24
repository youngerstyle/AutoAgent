import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  TicketAttemptChangeSet,
  TicketAttemptWorkspaceBaseline,
} from "../../shared/contracts/ticket-engine.js";

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
  captureBaseline(attemptId: string): Promise<TicketAttemptWorkspaceBaseline>;
  captureChangeSet(attemptId: string, baseline: TicketAttemptWorkspaceBaseline): Promise<TicketAttemptChangeSet>;
}

export class WorkspaceSnapshotStore implements TicketAttemptWorkspacePort {
  private readonly root: string;
  private readonly attemptDirectory: string;

  constructor(workspaceRoot: string, private readonly now: () => Date = () => new Date()) {
    this.root = path.resolve(workspaceRoot);
    this.attemptDirectory = path.join(this.root, ".autoagent", "tickets", "attempts");
  }

  async captureBaseline(attemptId: string): Promise<TicketAttemptWorkspaceBaseline> {
    const baselineId = randomUUID();
    const manifest = await this.captureManifest();
    const manifestRef = path.posix.join(".autoagent", "tickets", "attempts", `${attemptId}.${baselineId}.baseline.json`);
    await this.writeManifest(manifestRef, manifest);
    return {
      baselineId,
      capturedAt: manifest.capturedAt,
      artifactVersion: manifest.artifactVersion,
      manifestRef,
    };
  }

  async captureChangeSet(attemptId: string, baseline: TicketAttemptWorkspaceBaseline): Promise<TicketAttemptChangeSet> {
    const before = await this.readManifest(baseline.manifestRef);
    const after = await this.captureManifest();
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
    return {
      baselineId: baseline.baselineId,
      capturedAt: baseline.capturedAt,
      completedAt: after.capturedAt,
      artifactVersion: after.artifactVersion,
      manifestRef,
      added,
      modified,
      deleted,
    };
  }

  private async captureManifest(): Promise<WorkspaceManifest> {
    const files = await this.listFiles(this.root);
    files.sort((left, right) => left.path.localeCompare(right.path));
    const artifactVersion = createHash("sha256")
      .update(JSON.stringify(files.map(({ path: filePath, sha256 }) => [filePath, sha256])))
      .digest("hex");
    return {
      schemaVersion: 1,
      workspaceRoot: this.root,
      capturedAt: this.now().toISOString(),
      artifactVersion,
      files,
    };
  }

  private async listFiles(directory: string): Promise<WorkspaceFileFact[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    const facts: WorkspaceFileFact[] = [];
    for (const entry of entries) {
      if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) continue;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        facts.push(...await this.listFiles(absolutePath));
        continue;
      }
      if (!entry.isFile()) continue;
      const info = await stat(absolutePath);
      facts.push({
        path: path.relative(this.root, absolutePath).split(path.sep).join("/"),
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
