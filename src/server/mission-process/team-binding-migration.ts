import { copyFile, mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { AgentProfileStore } from "../agents/profile-store.js";
import { listWorkspaceAgents } from "../agents/roster.js";
import { createTeamBinding } from "../product/team-binding.js";
import type { Workspace } from "../../shared/types.js";
import { missionProcessFile } from "../storage/paths.js";
import { MissionStore, type MissionAggregate } from "./mission-store.js";
import type { TeamBinding, TeamBindingMigration } from "../../shared/contracts/mission-control.js";
import { isKnownToolName } from "../../shared/tool-catalog.js";

export type TeamBindingMigrationCandidate = {
  workspaceId: string;
  workspaceName: string;
  workspaceRoot: string;
  missionId: string;
  missionFile: string;
  missionStatus: string;
  sourceContentHash: string;
  missingAgentIds: string[];
  unsupportedAgentIds: string[];
  canMigrate: boolean;
  reason?: string;
};

export type TeamBindingMigrationResult = TeamBindingMigrationCandidate & {
  applied: boolean;
  backupFile?: string;
};

export async function inspectWorkspaceTeamBindingMigrations(
  workspace: Workspace,
): Promise<TeamBindingMigrationCandidate[]> {
  const directory = path.join(workspace.rootPath, ".autoagent", "mission-process");
  let files: string[];
  try {
    files = (await readdir(directory)).filter((name) => name.endsWith(".json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const candidates: TeamBindingMigrationCandidate[] = [];
  for (const name of files) {
    const missionFile = path.join(directory, name);
    const raw = JSON.parse(await readFile(missionFile, "utf8")) as Partial<MissionAggregate>;
    const record = raw.record;
    const teamBinding = record?.teamBinding;
    const members = teamBinding?.members;
    if (!raw.missionId || !record || !Array.isArray(members)) continue;
    const missingAgentIds = members
      .filter((member) => !Array.isArray(member.enabledTools) || member.enabledTools.some((tool) => typeof tool !== "string" || !isKnownToolName(tool)))
      .map((member) => member.agentId)
      .filter((agentId): agentId is string => typeof agentId === "string");
    const unsupportedAgentIds = members
      .filter((member) => !Array.isArray(member.capabilities) || member.capabilities.some((capability) => typeof capability !== "string"))
      .map((member) => member.agentId)
      .filter((agentId): agentId is string => typeof agentId === "string");
    if (!missingAgentIds.length && !unsupportedAgentIds.length) continue;
    candidates.push({
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      workspaceRoot: workspace.rootPath,
      missionId: raw.missionId,
      missionFile,
      missionStatus: String(record.status ?? "unknown"),
      sourceContentHash: typeof teamBinding?.contentHash === "string" ? teamBinding.contentHash : "",
      missingAgentIds,
      unsupportedAgentIds,
      canMigrate: unsupportedAgentIds.length === 0,
      reason: unsupportedAgentIds.length ? "unsupported_capability_snapshot" : undefined,
    });
  }
  return candidates;
}

export async function migrateWorkspaceTeamBinding(
  workspace: Workspace,
  profiles: AgentProfileStore,
  candidate: TeamBindingMigrationCandidate,
  options: { apply: boolean; includeActive?: boolean; backupRoot?: string; now?: () => Date },
): Promise<TeamBindingMigrationResult> {
  const result: TeamBindingMigrationResult = { ...candidate, applied: false };

  // Re-read before applying. A CLI candidate can be stale because another
  // operator or a previous invocation may have already repaired the Mission.
  const raw = JSON.parse(await readFile(candidate.missionFile, "utf8")) as MissionAggregate;
  const currentBinding = raw.record.teamBinding;
  const currentNeedsRepair = currentBinding.members.some((member) => (
    !Array.isArray(member.enabledTools)
    || member.enabledTools.some((tool) => typeof tool !== "string" || !isKnownToolName(tool))
    || !Array.isArray(member.capabilities)
    || member.capabilities.some((capability) => typeof capability !== "string")
  ));
  if (!currentNeedsRepair) {
    return { ...result, applied: true, reason: "already_migrated" };
  }
  if (currentBinding.contentHash !== candidate.sourceContentHash) {
    return { ...result, canMigrate: false, reason: "source_binding_changed_since_inspection" };
  }
  if (candidate.unsupportedAgentIds.length) {
    return { ...result, canMigrate: false, reason: "unsupported_capability_snapshot" };
  }
  if (!options.includeActive && candidate.missionStatus !== "completed") {
    return { ...result, canMigrate: false, reason: "active_or_unsettled_mission_requires_--include-active" };
  }
  if (!options.apply) return result;

  const agents = await listWorkspaceAgents(workspace);
  const binding = createTeamBinding(workspace, agents, await profiles.list(), "minimal-team");
  const expected = new Set(candidate.missingAgentIds);
  const available = new Set(binding.members.map((member) => member.agentId));
  const missing = [...expected].filter((agentId) => !available.has(agentId));
  if (missing.length) {
    return { ...result, canMigrate: false, reason: `workspace agents are missing: ${missing.join(", ")}` };
  }

  const derivedByAgentId = new Map(binding.members.map((member) => [member.agentId, member]));
  const migratedMembers = currentBinding.members.map((member) => {
    const existingTools = (member as unknown as { enabledTools?: unknown }).enabledTools;
    if (Array.isArray(existingTools) && existingTools.every((tool) => typeof tool === "string" && isKnownToolName(tool))) {
      return structuredClone(member);
    }
    const derived = derivedByAgentId.get(member.agentId);
    if (!derived) {
      throw new Error(`workspace agents are missing: ${member.agentId}`);
    }
    return {
      ...structuredClone(member),
      enabledTools: [...derived.enabledTools],
    };
  });
  const migratedBinding: TeamBinding = {
    ...structuredClone(currentBinding),
    teamBindingId: currentBinding.teamBindingId,
    version: currentBinding.version + 1,
    members: migratedMembers,
    contentHash: createHash("sha256").update(JSON.stringify({
      members: migratedMembers,
      deliveryPolicy: currentBinding.deliveryPolicy,
    })).digest("base64url"),
  };
  const migration: TeamBindingMigration = {
    kind: "reconstruct_enabled_tools",
    source: "workspace_agent_policy",
    fromContentHash: currentBinding.contentHash,
    migratedAt: (options.now ?? (() => new Date()))().toISOString(),
  };

  const backupRoot = options.backupRoot
    ?? path.join(workspace.rootPath, ".autoagent", "migrations", "team-binding");
  await mkdir(backupRoot, { recursive: true });
  const backupFile = path.join(backupRoot, `${candidate.missionId}.${randomUUID()}.json`);
  await copyFile(candidate.missionFile, backupFile);
  await new MissionStore(workspace.rootPath, candidate.missionId).migrateTeamBinding({
    teamBinding: migratedBinding,
    migration,
  });
  return { ...result, applied: true, backupFile };
}
