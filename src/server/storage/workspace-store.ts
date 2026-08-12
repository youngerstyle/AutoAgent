import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createId } from "../../shared/ids.js";
import type { PolicyProfile, Workspace } from "../../shared/types.js";
import { HttpError } from "../errors.js";
import { globalWorkspacesFile, workspaceAutoAgentDir, workspaceFile } from "./paths.js";
import { readJson, writeJson } from "./json.js";

const registryMutationQueues = new Map<string, Promise<void>>();

export class WorkspaceStore {
  constructor(private readonly homeDir: string) {}

  async list(): Promise<Workspace[]> {
    return readJson<Workspace[]>(globalWorkspacesFile(this.homeDir), []);
  }

  async get(workspaceId: string): Promise<Workspace> {
    const workspace = (await this.list()).find((item) => item.id === workspaceId);
    if (!workspace) throw new HttpError(404, `Workspace not found: ${workspaceId}`, "WORKSPACE_NOT_FOUND");
    return workspace;
  }

  async create(input: { name: string; rootPath: string; policyProfile?: PolicyProfile }): Promise<Workspace> {
    const rootPath = path.resolve(input.rootPath);
    await mkdir(rootPath, { recursive: true });
    return withRegistryMutation(globalWorkspacesFile(this.homeDir), async () => {
      const all = await this.list();
      const registered = all.find((item) => normalizePath(item.rootPath) === normalizePath(rootPath));
      if (registered) {
        await this.ensureWorkspaceFiles(registered);
        return registered;
      }

      const manifest = await readJson<Workspace | undefined>(workspaceFile(rootPath), undefined);
      const workspace: Workspace = isWorkspaceManifest(manifest)
        ? { ...manifest, rootPath }
        : {
            id: createId("ws"),
            name: input.name.trim() || path.basename(rootPath),
            rootPath,
            policyProfile: input.policyProfile ?? "production",
            createdAt: new Date().toISOString()
          };
      await this.ensureWorkspaceFiles(workspace);
      await writeJson(globalWorkspacesFile(this.homeDir), [
        ...all.filter((item) => item.id !== workspace.id),
        workspace,
      ]);
      return workspace;
    });
  }

  async remove(workspaceId: string, options: { deleteLocalFolder?: boolean } = {}): Promise<Workspace> {
    return withRegistryMutation(globalWorkspacesFile(this.homeDir), async () => {
      const workspace = await this.get(workspaceId);
      if (options.deleteLocalFolder) {
        assertSafeWorkspaceRemovalPath(workspace.rootPath);
        await rm(workspace.rootPath, { recursive: true, force: true });
      }
      const remaining = (await this.list()).filter((item) => item.id !== workspaceId);
      await writeJson(globalWorkspacesFile(this.homeDir), remaining);
      return workspace;
    });
  }

  async ensureWorkspaceFiles(workspace: Workspace): Promise<void> {
    await mkdir(workspaceAutoAgentDir(workspace.rootPath), { recursive: true });
    await writeJson(workspaceFile(workspace.rootPath), workspace);
    await ensureGitignore(workspace.rootPath);
  }
}

async function withRegistryMutation<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const key = path.resolve(filePath).toLowerCase();
  const previous = registryMutationQueues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  const settled = next.then(() => undefined, () => undefined);
  registryMutationQueues.set(key, settled);
  try {
    return await next;
  } finally {
    if (registryMutationQueues.get(key) === settled) registryMutationQueues.delete(key);
  }
}

function assertSafeWorkspaceRemovalPath(rootPath: string): void {
  const resolved = path.resolve(rootPath);
  const parsed = path.parse(resolved);
  const normalized = normalizePath(resolved);
  if (normalized === normalizePath(parsed.root)) {
    throw new HttpError(400, "Cannot delete a filesystem root as a workspace", "UNSAFE_WORKSPACE_DELETE");
  }
  if (normalized === normalizePath(os.homedir())) {
    throw new HttpError(400, "Cannot delete the user home directory as a workspace", "UNSAFE_WORKSPACE_DELETE");
  }
}

function normalizePath(value: string): string {
  return path.resolve(value).toLowerCase();
}

function isWorkspaceManifest(value: Workspace | undefined): value is Workspace {
  return Boolean(value
    && typeof value.id === "string"
    && value.id.length > 0
    && typeof value.name === "string"
    && typeof value.rootPath === "string"
    && (value.policyProfile === "development" || value.policyProfile === "production")
    && typeof value.createdAt === "string");
}

async function ensureGitignore(rootPath: string): Promise<void> {
  const gitignorePath = path.join(rootPath, ".gitignore");
  let content = "";
  try {
    content = await readFile(gitignorePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  if (!content.split(/\r?\n/).some((line) => line.trim() === ".autoagent/")) {
    const prefix = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
    await writeFile(gitignorePath, `${content}${prefix}.autoagent/\n`, "utf8");
  }
}
