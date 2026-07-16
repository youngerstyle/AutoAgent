import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { HttpError } from "../errors.js";
import type { EffectivePolicy } from "./policy.js";

export type PathOperation = "read" | "write";

export function resolveToolPath(policy: EffectivePolicy, targetPath: string, operation: PathOperation): string {
  if (operation === "read" && !policy.canReadWorkspace) {
    throw new HttpError(403, "Agent is not allowed to read workspace files", "TOOL_DENIED");
  }
  if (operation === "write" && !policy.canWriteWorkspace) {
    throw new HttpError(403, "Agent is not allowed to write workspace files", "TOOL_DENIED");
  }

  const explicitHostPath = path.isAbsolute(targetPath);
  const absolute = explicitHostPath
    ? path.resolve(targetPath)
    : path.resolve(policy.workspaceRoot, targetPath);

  // Relative workspace tools never change scope. Host access requires both an
  // explicit absolute path and an explicit policy grant.
  if (!isWorkspacePath(policy.workspaceRoot, absolute) && (!explicitHostPath || !policy.allowHostAccess)) {
    throw new HttpError(403, `Path escapes workspace: ${targetPath}`, "TOOL_DENIED");
  }
  return absolute;
}

export function isWorkspacePath(workspaceRoot: string, targetPath: string): boolean {
  return isInside(workspaceRoot, targetPath)
    && isInside(resolveThroughExistingPath(workspaceRoot), resolveThroughExistingPath(targetPath));
}

function resolveThroughExistingPath(targetPath: string): string {
  let existing = path.resolve(targetPath);
  const suffix: string[] = [];
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    suffix.unshift(path.basename(existing));
    existing = parent;
  }
  const canonical = existsSync(existing) ? realpathSync.native(existing) : existing;
  return path.resolve(canonical, ...suffix);
}

export function isInside(rootPath: string, targetPath: string): boolean {
  const root = path.resolve(rootPath).toLowerCase();
  const target = path.resolve(targetPath).toLowerCase();
  return target === root || target.startsWith(`${root}${path.sep}`);
}
