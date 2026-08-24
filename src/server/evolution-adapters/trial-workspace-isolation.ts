import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export interface TrialExecutionWorkspace {
  isolationId: string;
  rootPath: string;
  snapshotHash: string;
  manifestPath: string;
}

interface SnapshotManifest {
  schemaVersion: 1;
  trialId: string;
  generation: number;
  caseId: string;
  variant: "baseline" | "candidate";
  sourceRoot: string;
  executionRoot: string;
  snapshotHash: string;
  excludedTopLevelPaths: string[];
  createdAt: string;
}

const EXCLUDED_TOP_LEVEL_PATHS = new Set([".autoagent", ".git", "node_modules", "dist"]);
const preparationQueues = new Map<string, Promise<void>>();

/**
 * Platform-owned physical isolation for paired trials. The logical workspace
 * identity remains unchanged; only files and RuntimeHost state move to the
 * immutable generation snapshot and its independent arm copies.
 */
export class TrialWorkspaceIsolationManager {
  private readonly now: () => Date;
  private readonly isolationBaseRoot: string;

  constructor(private readonly sourceRoot: string, options: { now?: () => Date; baseRoot?: string } = {}) {
    this.now = options.now ?? (() => new Date());
    this.isolationBaseRoot = path.resolve(options.baseRoot ?? path.join(sourceRoot, ".autoagent", "evolution", "trial-executions"));
  }

  async prepare(
    trialId: string,
    generation: number,
    cases: Array<{ caseId: string }>,
  ): Promise<Map<string, { baseline: TrialExecutionWorkspace; candidate: TrialExecutionWorkspace }>> {
    const generationRoot = this.generationRoot(trialId, generation);
    const key = path.resolve(generationRoot).toLowerCase();
    const previous = preparationQueues.get(key) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(() => this.prepareUnlocked(trialId, generation, cases));
    const queued = operation.then(() => undefined, () => undefined);
    preparationQueues.set(key, queued);
    try {
      return await operation;
    } finally {
      if (preparationQueues.get(key) === queued) preparationQueues.delete(key);
    }
  }

  private async prepareUnlocked(
    trialId: string,
    generation: number,
    cases: Array<{ caseId: string }>,
  ): Promise<Map<string, { baseline: TrialExecutionWorkspace; candidate: TrialExecutionWorkspace }>> {
    const existing = await this.loadPrepared(trialId, generation, cases);
    if (existing) return existing;
    const generationRoot = this.generationRoot(trialId, generation);
    const seedRoot = path.join(generationRoot, "seed");
    await rm(generationRoot, { recursive: true, force: true });
    await mkdir(seedRoot, { recursive: true });
    try {
      await validateSourceSymlinks(this.sourceRoot);
      for (const entry of await readdir(this.sourceRoot, { withFileTypes: true })) {
        if (EXCLUDED_TOP_LEVEL_PATHS.has(entry.name)) continue;
        await cp(path.join(this.sourceRoot, entry.name), path.join(seedRoot, entry.name), {
          recursive: true,
          force: false,
          errorOnExist: true,
          preserveTimestamps: true,
        });
      }
      const snapshotHash = await hashDirectory(seedRoot);
      const prepared = new Map<string, { baseline: TrialExecutionWorkspace; candidate: TrialExecutionWorkspace }>();
      for (const item of cases) {
        const pair = {
          baseline: await this.cloneArm(seedRoot, trialId, generation, item.caseId, "baseline", snapshotHash),
          candidate: await this.cloneArm(seedRoot, trialId, generation, item.caseId, "candidate", snapshotHash),
        };
        prepared.set(item.caseId, pair);
      }
      return prepared;
    } catch (error) {
      await rm(generationRoot, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    } finally {
      await rm(seedRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async loadPrepared(
    trialId: string,
    generation: number,
    cases: Array<{ caseId: string }>,
  ): Promise<Map<string, { baseline: TrialExecutionWorkspace; candidate: TrialExecutionWorkspace }> | undefined> {
    const prepared = new Map<string, { baseline: TrialExecutionWorkspace; candidate: TrialExecutionWorkspace }>();
    try {
      for (const item of cases) {
        const read = async (variant: "baseline" | "candidate"): Promise<TrialExecutionWorkspace> => {
          const armRoot = path.join(this.generationRoot(trialId, generation), hash(item.caseId).slice(0, 24), variant);
          const manifestPath = path.join(armRoot, "manifest.json");
          const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as SnapshotManifest;
          if (manifest.schemaVersion !== 1 || manifest.trialId !== trialId || manifest.generation !== generation
            || manifest.caseId !== item.caseId || manifest.variant !== variant
            || path.resolve(manifest.sourceRoot) !== path.resolve(this.sourceRoot)
            || path.resolve(manifest.executionRoot) !== path.resolve(path.join(armRoot, "workspace"))) throw new Error("invalid manifest");
          return {
            isolationId: hash(`${trialId}\0${generation}\0${item.caseId}\0${variant}`).slice(0, 32),
            rootPath: manifest.executionRoot,
            snapshotHash: manifest.snapshotHash,
            manifestPath,
          };
        };
        prepared.set(item.caseId, { baseline: await read("baseline"), candidate: await read("candidate") });
      }
      return prepared;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as Error).message === "invalid manifest") return undefined;
      throw error;
    }
  }

  async verify(execution: TrialExecutionWorkspace): Promise<void> {
    this.assertExecutionRoot(execution.rootPath);
    const expectedManifest = path.join(path.dirname(execution.rootPath), "manifest.json");
    if (path.resolve(execution.manifestPath) !== path.resolve(expectedManifest)) {
      throw new Error("Evolution trial execution manifest escaped its arm boundary");
    }
    const manifest = JSON.parse(await readFile(execution.manifestPath, "utf8")) as SnapshotManifest;
    if (manifest.schemaVersion !== 1
      || path.resolve(manifest.executionRoot) !== path.resolve(execution.rootPath)
      || path.resolve(manifest.sourceRoot) !== path.resolve(this.sourceRoot)
      || execution.isolationId !== hash(`${manifest.trialId}\0${manifest.generation}\0${manifest.caseId}\0${manifest.variant}`).slice(0, 32)
      || manifest.snapshotHash !== execution.snapshotHash
      || manifest.snapshotHash !== await hashDirectory(execution.rootPath)) {
      throw new Error("Evolution trial execution snapshot is invalid or has drifted before start");
    }
  }

  async cleanupGeneration(trialId: string, generation: number): Promise<void> {
    const root = this.generationRoot(trialId, generation);
    this.assertExecutionRoot(root);
    await rm(root, { recursive: true, force: true });
  }

  assertExecutionRoot(rootPath: string): void {
    const base = path.resolve(this.baseRoot());
    const resolved = path.resolve(rootPath);
    if (resolved === base || !resolved.startsWith(`${base}${path.sep}`)) {
      throw new Error("Evolution trial execution root escaped its workspace isolation boundary");
    }
  }

  private async cloneArm(
    seedRoot: string,
    trialId: string,
    generation: number,
    caseId: string,
    variant: "baseline" | "candidate",
    snapshotHash: string,
  ): Promise<TrialExecutionWorkspace> {
    const isolationId = hash(`${trialId}\0${generation}\0${caseId}\0${variant}`).slice(0, 32);
    const armRoot = path.join(this.generationRoot(trialId, generation), hash(caseId).slice(0, 24), variant);
    const rootPath = path.join(armRoot, "workspace");
    await mkdir(armRoot, { recursive: true });
    await cp(seedRoot, rootPath, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true });
    // Prevent Git from walking up into the user's real repository. Trial tasks
    // may inspect files, but cannot accidentally commit against the source tree.
    await mkdir(path.join(rootPath, ".git"), { recursive: true });
    const manifestPath = path.join(armRoot, "manifest.json");
    await writeFile(manifestPath, `${JSON.stringify({
      schemaVersion: 1,
      trialId,
      generation,
      caseId,
      variant,
      sourceRoot: path.resolve(this.sourceRoot),
      executionRoot: path.resolve(rootPath),
      snapshotHash,
      excludedTopLevelPaths: [...EXCLUDED_TOP_LEVEL_PATHS].sort(),
      createdAt: this.now().toISOString(),
    } satisfies SnapshotManifest, null, 2)}\n`, "utf8");
    return { isolationId, rootPath, snapshotHash, manifestPath };
  }

  private baseRoot(): string {
    return this.isolationBaseRoot;
  }

  private generationRoot(trialId: string, generation: number): string {
    if (!Number.isInteger(generation) || generation < 1) throw new Error("Evolution trial generation is invalid");
    return path.join(this.baseRoot(), hash(trialId).slice(0, 32), String(generation));
  }
}

export function trialIsolationBaseRoot(homeRoot: string, sourceRoot: string): string {
  return path.join(homeRoot, "trial-executions", hash(path.resolve(sourceRoot)).slice(0, 32));
}

async function validateSourceSymlinks(root: string, relative = ""): Promise<void> {
  const directory = path.join(root, relative);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!relative && EXCLUDED_TOP_LEVEL_PATHS.has(entry.name)) continue;
    const child = path.join(relative, entry.name);
    const file = path.join(root, child);
    const info = await lstat(file);
    if (info.isSymbolicLink()) {
      const target = await readlink(file);
      const resolved = path.resolve(path.dirname(file), target);
      const source = path.resolve(root);
      if (path.isAbsolute(target) || (resolved !== source && !resolved.startsWith(`${source}${path.sep}`))) {
        throw new Error(`Evolution trial snapshot rejects an absolute or external symlink: ${child}`);
      }
      continue;
    }
    if (info.isDirectory()) await validateSourceSymlinks(root, child);
  }
}

async function hashDirectory(root: string): Promise<string> {
  const digest = createHash("sha256");
  for (const relative of await listEntries(root)) {
    if (relative === ".git" || relative.startsWith(`.git${path.sep}`)) continue;
    const file = path.join(root, relative);
    const info = await lstat(file);
    digest.update(relative.split(path.sep).join("/"), "utf8");
    digest.update("\0", "utf8");
    if (info.isSymbolicLink()) digest.update(`link:${await readlink(file)}`, "utf8");
    else if (info.isFile()) digest.update(await readFile(file));
    else digest.update("directory", "utf8");
    digest.update("\0", "utf8");
  }
  return digest.digest("hex");
}

async function listEntries(root: string, relative = ""): Promise<string[]> {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = path.join(relative, entry.name);
    result.push(child);
    if (entry.isDirectory()) result.push(...await listEntries(root, child));
  }
  return result;
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
