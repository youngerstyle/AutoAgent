import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentRole } from "../../shared/types.js";
import { resolveToolPath } from "../policy/path-policy.js";
import { emitToolEvent, policyFor, type ToolContext } from "./tool-runtime.js";

export async function readWorkspaceFile(context: ToolContext, targetPath: string): Promise<string> {
  await emitToolEvent(context, "tool.started", `读取文件：${targetPath}`, { tool: "readFile", path: targetPath });
  try {
    const absolute = resolveToolPath(policyFor(context), targetPath, "read");
    const content = await readFile(absolute, "utf8");
    await emitToolEvent(context, "tool.completed", `文件读取完成：${targetPath}`, { tool: "readFile", path: targetPath });
    return content;
  } catch (error) {
    await emitToolEvent(context, "tool.denied", `文件读取被拒绝：${targetPath}`, { tool: "readFile", path: targetPath, error: (error as Error).message });
    throw error;
  }
}

export async function writeWorkspaceFile(context: ToolContext, targetPath: string, content: string): Promise<void> {
  await emitToolEvent(context, "tool.started", `写入文件：${targetPath}`, { tool: "writeFile", path: targetPath });
  try {
    const absolute = resolveToolPath(policyForWrite(context, targetPath), targetPath, "write");
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content, "utf8");
    await emitToolEvent(context, "tool.completed", `文件写入完成：${targetPath}`, { tool: "writeFile", path: targetPath });
  } catch (error) {
    await emitToolEvent(context, "tool.denied", `文件写入被拒绝：${targetPath}`, { tool: "writeFile", path: targetPath, error: (error as Error).message });
    throw error;
  }
}

export async function listWorkspaceFiles(context: ToolContext, targetPath = "."): Promise<string[]> {
  const absolute = resolveToolPath(policyFor(context), targetPath, "read");
  return readdir(absolute);
}

function policyForWrite(context: ToolContext, targetPath: string) {
  const policy = policyFor(context);
  if (policy.canWriteWorkspace) return policy;
  if (!canRoleWriteDocumentPath(context.agent.roleInWorkspace, context.workspace.rootPath, targetPath)) return policy;
  return { ...policy, canWriteWorkspace: true };
}

function canRoleWriteDocumentPath(role: AgentRole, workspaceRoot: string, targetPath: string): boolean {
  if (role === "dev" || role === "specialist") return true;
  const relative = relativeWorkspacePath(workspaceRoot, targetPath);
  if (!relative) return false;
  const normalized = relative.replaceAll("\\", "/").toLowerCase();
  const documentRoot = normalized.startsWith("docs/") || normalized.startsWith("reports/") || normalized.startsWith("plans/");
  const documentExtension = normalized.endsWith(".md") || normalized.endsWith(".txt");
  return documentRoot && documentExtension;
}

function relativeWorkspacePath(workspaceRoot: string, targetPath: string): string | undefined {
  const absolute = path.isAbsolute(targetPath) ? path.resolve(targetPath) : path.resolve(workspaceRoot, targetPath);
  const root = path.resolve(workspaceRoot);
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  return relative;
}
