import { copyFile, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { agentEngineRolloutFile } from "../storage/paths.js";

export type AgentRolloutMigrationCandidate = {
  workspaceRoot: string;
  rolloutFile: string;
  agentId: string;
  sourceHash: string;
  staleGoalUpdates: Array<{
    line: number;
    goalId: string;
    persistedVersion: number;
    currentVersion: number;
  }>;
  canMigrate: boolean;
  reason?: string;
};

export type AgentRolloutMigrationResult = AgentRolloutMigrationCandidate & {
  applied: boolean;
  backupFile?: string;
};

type ScanResult = {
  candidate: AgentRolloutMigrationCandidate;
  repairedContent: string;
};

/**
 * Find only storage-level stale Goal writes. Business routing never belongs in
 * this migration: a stale turn is removed from the Goal projection while its
 * ordered thread, payload, and event records remain intact.
 */
export async function inspectAgentRolloutMigrations(
  workspaceRoot: string,
): Promise<AgentRolloutMigrationCandidate[]> {
  const root = path.join(workspaceRoot, ".autoagent", "agent-engine");
  let entries: Dirent<string>[];
  try {
    entries = await readdir(root, { withFileTypes: true, encoding: "utf8" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const candidates: AgentRolloutMigrationCandidate[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const rolloutFile = path.join(root, entry.name, "rollout.jsonl");
    try {
      await readFile(rolloutFile, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const { candidate } = await scanRollout(workspaceRoot, rolloutFile);
    if (candidate.staleGoalUpdates.length || !candidate.canMigrate) candidates.push(candidate);
  }
  return candidates;
}

export async function migrateAgentRollout(
  candidate: AgentRolloutMigrationCandidate,
  options: { apply: boolean; backupRoot?: string },
): Promise<AgentRolloutMigrationResult> {
  const current = await scanRollout(candidate.workspaceRoot, candidate.rolloutFile);
  const result: AgentRolloutMigrationResult = { ...current.candidate, applied: false };

  if (!current.candidate.canMigrate) return result;
  if (!current.candidate.staleGoalUpdates.length) {
    return { ...result, applied: true, reason: "already_migrated" };
  }
  if (current.candidate.sourceHash !== candidate.sourceHash) {
    return { ...result, canMigrate: false, reason: "source_rollout_changed_since_inspection" };
  }
  if (!options.apply) return result;

  const backupRoot = options.backupRoot
    ?? path.join(candidate.workspaceRoot, ".autoagent", "migrations", "agent-store");
  await mkdir(backupRoot, { recursive: true });
  const backupFile = path.join(
    backupRoot,
    `${safeFilePart(candidate.agentId)}.${randomUUID()}.jsonl`,
  );
  await copyFile(candidate.rolloutFile, backupFile);

  const tempFile = `${candidate.rolloutFile}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempFile, current.repairedContent, "utf8");
  await rename(tempFile, candidate.rolloutFile);
  return { ...result, applied: true, backupFile };
}

async function scanRollout(workspaceRoot: string, rolloutFile: string): Promise<ScanResult> {
  const content = await readFile(rolloutFile, "utf8");
  const sourceHash = sha256(content);
  const lines = content.split(/\r?\n/);
  const repairedLines: string[] = [];
  const goalVersions = new Map<string, number>();
  const staleGoalUpdates: AgentRolloutMigrationCandidate["staleGoalUpdates"] = [];
  let agentId: string | undefined;
  let aggregateVersion = 0;
  let canMigrate = true;
  let reason: string | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]!;
    if (!raw.trim()) {
      repairedLines.push(raw);
      continue;
    }

    let value: Record<string, unknown>;
    try {
      value = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return invalidScan(workspaceRoot, rolloutFile, sourceHash, agentId, staleGoalUpdates, index + 1, "invalid_jsonl");
    }
    if (typeof value.agentId === "string") agentId ??= value.agentId;

    if (value.type === "agent_store_snapshot") {
      const snapshotVersion = value.aggregateVersion;
      const aggregate = value.aggregate;
      if (!Number.isSafeInteger(snapshotVersion) || !aggregate || typeof aggregate !== "object") {
        return invalidScan(workspaceRoot, rolloutFile, sourceHash, agentId, staleGoalUpdates, index + 1, "invalid_snapshot");
      }
      const goals = (aggregate as { goals?: unknown }).goals;
      if (!Array.isArray(goals)) {
        return invalidScan(workspaceRoot, rolloutFile, sourceHash, agentId, staleGoalUpdates, index + 1, "invalid_snapshot_goals");
      }
      goalVersions.clear();
      for (const goal of goals) {
        const identity = goalIdentity(goal);
        const version = goalVersion(goal);
        if (!identity || version === undefined) {
          return invalidScan(workspaceRoot, rolloutFile, sourceHash, agentId, staleGoalUpdates, index + 1, "invalid_snapshot_goal");
        }
        goalVersions.set(identity, version);
      }
      aggregateVersion = Number(snapshotVersion);
      repairedLines.push(raw);
      continue;
    }

    if (value.type !== "agent_store_commit" || value.schemaVersion !== 1 || !Number.isSafeInteger(value.aggregateVersion)) {
      return invalidScan(workspaceRoot, rolloutFile, sourceHash, agentId, staleGoalUpdates, index + 1, "unsupported_commit");
    }
    if (value.aggregateVersion !== aggregateVersion + 1) {
      return invalidScan(workspaceRoot, rolloutFile, sourceHash, agentId, staleGoalUpdates, index + 1, "aggregate_version_gap");
    }

    const goals = Array.isArray(value.goals) ? value.goals : [];
    const keptGoals: unknown[] = [];
    for (const goal of goals) {
      const identity = goalIdentity(goal);
      const version = goalVersion(goal);
      if (!identity || version === undefined) {
        return invalidScan(workspaceRoot, rolloutFile, sourceHash, agentId, staleGoalUpdates, index + 1, "invalid_goal_update");
      }
      const currentVersion = goalVersions.get(identity);
      if (currentVersion === undefined) {
        if (version !== 1) {
          return invalidScan(workspaceRoot, rolloutFile, sourceHash, agentId, staleGoalUpdates, index + 1, "goal_start_version_gap");
        }
        goalVersions.set(identity, version);
        keptGoals.push(goal);
      } else if (version === currentVersion + 1) {
        goalVersions.set(identity, version);
        keptGoals.push(goal);
      } else if (version <= currentVersion) {
        staleGoalUpdates.push({
          line: index + 1,
          goalId: identity,
          persistedVersion: version,
          currentVersion,
        });
      } else {
        return invalidScan(workspaceRoot, rolloutFile, sourceHash, agentId, staleGoalUpdates, index + 1, "goal_version_gap");
      }
    }

    if (keptGoals.length === goals.length) {
      repairedLines.push(raw);
    } else {
      repairedLines.push(JSON.stringify({ ...value, goals: keptGoals }));
    }
    aggregateVersion = value.aggregateVersion;
  }

  if (!agentId) {
    return invalidScan(workspaceRoot, rolloutFile, sourceHash, agentId, staleGoalUpdates, 0, "missing_agent_id");
  }
  return {
    candidate: {
      workspaceRoot,
      rolloutFile,
      agentId,
      sourceHash,
      staleGoalUpdates,
      canMigrate,
      reason,
    },
    repairedContent: repairedLines.join("\n"),
  };
}

function invalidScan(
  workspaceRoot: string,
  rolloutFile: string,
  sourceHash: string,
  agentId: string | undefined,
  staleGoalUpdates: AgentRolloutMigrationCandidate["staleGoalUpdates"],
  line: number,
  reason: string,
): ScanResult {
  return {
    candidate: {
      workspaceRoot,
      rolloutFile,
      agentId: agentId ?? "unknown",
      sourceHash,
      staleGoalUpdates,
      canMigrate: false,
      reason: line > 0 ? `${reason}:line_${line}` : reason,
    },
    repairedContent: "",
  };
}

function goalIdentity(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const id = (value as { spec?: { id?: unknown } }).spec?.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function goalVersion(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const version = (value as { version?: unknown }).version;
  return Number.isSafeInteger(version) && Number(version) > 0 ? Number(version) : undefined;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeFilePart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

export function agentRolloutFileForTest(workspaceRoot: string, agentId: string): string {
  return agentEngineRolloutFile(workspaceRoot, agentId);
}
