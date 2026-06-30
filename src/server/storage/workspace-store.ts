import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createId } from "../../shared/ids.js";
import type { PolicyProfile, Workspace } from "../../shared/types.js";
import { HttpError } from "../errors.js";
import { globalWorkspacesFile, workspaceAutoAgentDir, workspaceFile } from "./paths.js";
import { readJson, writeJson } from "./json.js";

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
    const workspace: Workspace = {
      id: createId("ws"),
      name: input.name.trim() || path.basename(rootPath),
      rootPath,
      policyProfile: input.policyProfile ?? "production",
      createdAt: new Date().toISOString()
    };
    await this.ensureWorkspaceFiles(workspace);
    const all = await this.list();
    const withoutDuplicate = all.filter((item) => path.resolve(item.rootPath).toLowerCase() !== rootPath.toLowerCase());
    withoutDuplicate.push(workspace);
    await writeJson(globalWorkspacesFile(this.homeDir), withoutDuplicate);
    return workspace;
  }

  async ensureWorkspaceFiles(workspace: Workspace): Promise<void> {
    await mkdir(workspaceAutoAgentDir(workspace.rootPath), { recursive: true });
    await writeJson(workspaceFile(workspace.rootPath), workspace);
    await ensureGitignore(workspace.rootPath);
  }
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
