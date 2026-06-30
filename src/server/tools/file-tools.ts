import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveToolPath } from "../policy/path-policy.js";
import { emitToolEvent, policyFor, type ToolContext } from "./tool-runtime.js";

export async function readWorkspaceFile(context: ToolContext, targetPath: string): Promise<string> {
  await emitToolEvent(context, "tool.started", `Read ${targetPath}`, { tool: "readFile", path: targetPath });
  try {
    const absolute = resolveToolPath(policyFor(context), targetPath, "read");
    const content = await readFile(absolute, "utf8");
    await emitToolEvent(context, "tool.completed", `Read ${targetPath}`, { tool: "readFile", path: targetPath });
    return content;
  } catch (error) {
    await emitToolEvent(context, "tool.denied", `Read denied ${targetPath}`, { tool: "readFile", path: targetPath, error: (error as Error).message });
    throw error;
  }
}

export async function writeWorkspaceFile(context: ToolContext, targetPath: string, content: string): Promise<void> {
  await emitToolEvent(context, "tool.started", `Write ${targetPath}`, { tool: "writeFile", path: targetPath });
  try {
    const absolute = resolveToolPath(policyFor(context), targetPath, "write");
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content, "utf8");
    await emitToolEvent(context, "tool.completed", `Wrote ${targetPath}`, { tool: "writeFile", path: targetPath });
  } catch (error) {
    await emitToolEvent(context, "tool.denied", `Write denied ${targetPath}`, { tool: "writeFile", path: targetPath, error: (error as Error).message });
    throw error;
  }
}

export async function listWorkspaceFiles(context: ToolContext, targetPath = "."): Promise<string[]> {
  const absolute = resolveToolPath(policyFor(context), targetPath, "read");
  return readdir(absolute);
}
