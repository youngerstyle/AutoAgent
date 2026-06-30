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

  const absolute = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(policy.workspaceRoot, targetPath);

  if (!policy.allowHostAccess && !isInside(policy.workspaceRoot, absolute)) {
    throw new HttpError(403, `Path escapes workspace: ${targetPath}`, "TOOL_DENIED");
  }
  return absolute;
}

export function isInside(rootPath: string, targetPath: string): boolean {
  const root = path.resolve(rootPath).toLowerCase();
  const target = path.resolve(targetPath).toLowerCase();
  return target === root || target.startsWith(`${root}${path.sep}`);
}
