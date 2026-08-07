import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentProfileStore } from "../../src/server/agents/profile-store.js";
import { inspectWorkspaceTeamBindingMigrations, migrateWorkspaceTeamBinding } from "../../src/server/mission-process/team-binding-migration.js";
import { MissionStore, type MissionAggregate } from "../../src/server/mission-process/mission-store.js";
import { missionProcessFile, workspaceAgentFile } from "../../src/server/storage/paths.js";
import type { MissionRecord, TeamBinding } from "../../src/shared/contracts/mission-control.js";
import type { PlanId } from "../../src/shared/contracts/ticket-engine.js";
import type { Workspace, WorkspaceAgent, WorkspaceToolName } from "../../src/shared/types.js";

describe("explicit TeamBinding migration", () => {
  it("only fills the missing tool snapshot and preserves the historical roster", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-team-binding-migration-"));
    const home = await mkdtemp(path.join(os.tmpdir(), "autoagent-team-binding-profiles-"));
    const workspace = makeWorkspace(root);
    await writeAgent(workspace, makeAgent("agent-dev", "prof_dev", "dev", ["readFile", "writeFile"]));
    await writeAgent(workspace, makeAgent("agent-added-later", "prof_qa", "qa", ["readFile", "browser"]));

    const missionId = "mission-migration-a";
    const store = new MissionStore(root, missionId);
    await store.create(makeCompletedRecord(missionId));
    const file = missionProcessFile(root, missionId);
    const raw = JSON.parse(await readFile(file, "utf8")) as MissionAggregate;
    delete (raw.record.teamBinding.members[0] as unknown as { enabledTools?: unknown }).enabledTools;
    await writeFile(file, JSON.stringify(raw), "utf8");

    const candidates = await inspectWorkspaceTeamBindingMigrations(workspace);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.missingAgentIds).toEqual(["agent-dev"]);

    const dryRun = await migrateWorkspaceTeamBinding(workspace, new AgentProfileStore(home), candidates[0]!, { apply: false });
    expect(dryRun.applied).toBe(false);
    expect((JSON.parse(await readFile(file, "utf8")) as MissionAggregate).version).toBe(1);

    const backupRoot = path.join(root, ".autoagent", "test-migration-backups");
    const applied = await migrateWorkspaceTeamBinding(workspace, new AgentProfileStore(home), candidates[0]!, {
      apply: true,
      backupRoot,
      now: () => new Date("2026-08-04T00:00:00.000Z"),
    });
    expect(applied.applied).toBe(true);
    expect(applied.backupFile).toBeDefined();

    const migrated = await store.read();
    expect(migrated?.version).toBe(2);
    expect(migrated?.record.teamBinding.teamBindingId).toBe("historical-team");
    expect(migrated?.record.teamBinding.members).toHaveLength(1);
    expect(migrated?.record.teamBinding.members[0]).toMatchObject({
      agentId: "agent-dev",
      principalId: "principal:agent-dev",
      capabilities: ["delivery:implement"],
    });
    expect(migrated?.record.teamBinding.members[0]?.enabledTools).toEqual(expect.arrayContaining(["readFile", "writeFile", "browser"]));
    expect(migrated?.record.teamBindingMigration).toMatchObject({
      kind: "reconstruct_enabled_tools",
      source: "workspace_agent_policy",
      fromContentHash: "historical-hash",
    });
    expect(await readFile(applied.backupFile!, "utf8")).toContain("historical-hash");
    expect(await inspectWorkspaceTeamBindingMigrations(workspace)).toEqual([]);

    const repeated = await migrateWorkspaceTeamBinding(workspace, new AgentProfileStore(home), candidates[0]!, {
      apply: true,
      backupRoot,
      now: () => new Date("2026-08-04T00:00:01.000Z"),
    });
    expect(repeated).toMatchObject({ applied: true, reason: "already_migrated" });
    expect(await store.read()).toMatchObject({ version: 2 });
  });

  it("does not mutate an active Mission unless the operator opts in", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-team-binding-migration-active-"));
    const home = await mkdtemp(path.join(os.tmpdir(), "autoagent-team-binding-profiles-active-"));
    const workspace = makeWorkspace(root);
    await writeAgent(workspace, makeAgent("agent-dev", "prof_dev", "dev", ["readFile", "writeFile"]));

    const missionId = "mission-migration-active";
    const store = new MissionStore(root, missionId);
    await store.create({ ...makeCompletedRecord(missionId), status: "starting" } as MissionRecord);
    const file = missionProcessFile(root, missionId);
    const raw = JSON.parse(await readFile(file, "utf8")) as MissionAggregate;
    delete (raw.record.teamBinding.members[0] as unknown as { enabledTools?: unknown }).enabledTools;
    await writeFile(file, JSON.stringify(raw), "utf8");
    const [candidate] = await inspectWorkspaceTeamBindingMigrations(workspace);

    const dryRun = await migrateWorkspaceTeamBinding(workspace, new AgentProfileStore(home), candidate!, { apply: false });
    expect(dryRun.applied).toBe(false);
    expect(dryRun.canMigrate).toBe(false);
    expect(dryRun.reason).toBe("active_or_unsettled_mission_requires_--include-active");

    const result = await migrateWorkspaceTeamBinding(workspace, new AgentProfileStore(home), candidate!, { apply: true });
    expect(result.applied).toBe(false);
    expect(result.canMigrate).toBe(false);
    expect(result.reason).toBe("active_or_unsettled_mission_requires_--include-active");
    expect((JSON.parse(await readFile(file, "utf8")) as MissionAggregate).version).toBe(1);
  });

  it("refuses an operator migration when the historical capability snapshot is invalid", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-team-binding-migration-capabilities-"));
    const home = await mkdtemp(path.join(os.tmpdir(), "autoagent-team-binding-profiles-capabilities-"));
    const workspace = makeWorkspace(root);
    await writeAgent(workspace, makeAgent("agent-dev", "prof_dev", "dev", ["readFile", "writeFile"]));

    const missionId = "mission-migration-capabilities";
    const store = new MissionStore(root, missionId);
    const record = makeCompletedRecord(missionId);
    await store.create(record);
    const file = missionProcessFile(root, missionId);
    const raw = JSON.parse(await readFile(file, "utf8")) as MissionAggregate;
    (raw.record.teamBinding.members[0]!.capabilities as unknown as unknown[]) = ["delivery:implement", 42];
    delete (raw.record.teamBinding.members[0] as unknown as { enabledTools?: unknown }).enabledTools;
    await writeFile(file, JSON.stringify(raw), "utf8");

    const [candidate] = await inspectWorkspaceTeamBindingMigrations(workspace);
    expect(candidate).toMatchObject({
      missingAgentIds: ["agent-dev"],
      unsupportedAgentIds: ["agent-dev"],
      canMigrate: false,
      reason: "unsupported_capability_snapshot",
    });

    const result = await migrateWorkspaceTeamBinding(workspace, new AgentProfileStore(home), candidate!, { apply: true });
    expect(result).toMatchObject({ applied: false, canMigrate: false, reason: "unsupported_capability_snapshot" });
    expect((JSON.parse(await readFile(file, "utf8")) as MissionAggregate).version).toBe(1);
  });

  it("refuses to overwrite a binding that changed after inspection", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-team-binding-migration-stale-"));
    const home = await mkdtemp(path.join(os.tmpdir(), "autoagent-team-binding-profiles-stale-"));
    const workspace = makeWorkspace(root);
    await writeAgent(workspace, makeAgent("agent-dev", "prof_dev", "dev", ["readFile", "writeFile"]));

    const missionId = "mission-migration-stale";
    const store = new MissionStore(root, missionId);
    await store.create(makeCompletedRecord(missionId));
    const file = missionProcessFile(root, missionId);
    const raw = JSON.parse(await readFile(file, "utf8")) as MissionAggregate;
    delete (raw.record.teamBinding.members[0] as unknown as { enabledTools?: unknown }).enabledTools;
    await writeFile(file, JSON.stringify(raw), "utf8");

    const [candidate] = await inspectWorkspaceTeamBindingMigrations(workspace);
    const changed = JSON.parse(await readFile(file, "utf8")) as MissionAggregate;
    changed.record.teamBinding.contentHash = "changed-by-another-operator";
    await writeFile(file, JSON.stringify(changed), "utf8");

    const result = await migrateWorkspaceTeamBinding(workspace, new AgentProfileStore(home), candidate!, { apply: true });
    expect(result).toMatchObject({ applied: false, canMigrate: false, reason: "source_binding_changed_since_inspection" });
    const unchanged = JSON.parse(await readFile(file, "utf8")) as MissionAggregate;
    expect(unchanged.version).toBe(1);
    expect(unchanged.record.teamBinding.contentHash).toBe("changed-by-another-operator");
  });

  it("detects an unknown historical tool and repairs it from the current policy", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-team-binding-migration-tool-"));
    const home = await mkdtemp(path.join(os.tmpdir(), "autoagent-team-binding-profiles-tool-"));
    const workspace = makeWorkspace(root);
    await writeAgent(workspace, makeAgent("agent-dev", "prof_dev", "dev", ["readFile", "writeFile"]));

    const missionId = "mission-migration-tool";
    const store = new MissionStore(root, missionId);
    await store.create(makeCompletedRecord(missionId));
    const file = missionProcessFile(root, missionId);
    const raw = JSON.parse(await readFile(file, "utf8")) as MissionAggregate;
    raw.record.teamBinding.members[0]!.enabledTools = ["readFile", "historical-unknown-tool"] as never;
    await writeFile(file, JSON.stringify(raw), "utf8");

    const [candidate] = await inspectWorkspaceTeamBindingMigrations(workspace);
    expect(candidate).toMatchObject({ missingAgentIds: ["agent-dev"], unsupportedAgentIds: [], canMigrate: true });
    const result = await migrateWorkspaceTeamBinding(workspace, new AgentProfileStore(home), candidate!, { apply: true });
    expect(result.applied).toBe(true);
    expect((await store.read())?.record.teamBinding.members[0]?.enabledTools).toEqual(["browser", "editFile", "readFile", "writeFile"]);
  });
});

function makeWorkspace(rootPath: string): Workspace {
  return {
    id: "workspace-migration",
    name: "Migration workspace",
    rootPath,
    policyProfile: "development",
    createdAt: "2026-08-04T00:00:00.000Z",
  };
}

function makeAgent(id: string, profileId: string, roleInWorkspace: WorkspaceAgent["roleInWorkspace"], enabledTools: string[]): WorkspaceAgent {
  return {
    id,
    workspaceId: "workspace-migration",
    profileId,
    roleInWorkspace,
    agentDir: `.autoagent/agents/${id}`,
    status: "idle",
    policyOverride: {
      canReadWorkspace: true,
      canWriteWorkspace: roleInWorkspace === "dev",
      canExecuteCommands: roleInWorkspace === "dev",
      enabledTools: enabledTools as WorkspaceToolName[],
    },
  };
}

async function writeAgent(workspace: Workspace, agent: WorkspaceAgent): Promise<void> {
  const file = workspaceAgentFile(workspace.rootPath, agent.id);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(agent), "utf8");
}

function makeCompletedRecord(missionId: string): MissionRecord {
  const teamBinding: TeamBinding = {
    teamBindingId: "historical-team",
    version: 1,
    contentHash: "historical-hash",
    deliveryPolicy: { requiredTerminalCapabilities: ["delivery:accept"] },
    members: [{
      agentId: "agent-dev",
      principalId: "principal:agent-dev",
      capabilities: ["delivery:implement"],
      enabledTools: ["readFile", "writeFile"],
    }],
  };
  return {
    missionId,
    objective: "migration test",
    planId: "178f1785-71a8-4a87-b799-8184b86eb227" as PlanId,
    planCreateCommandId: "create-migration",
    ownerPrincipalId: "principal:agent-dev",
    teamBinding,
    status: "completed",
    linkedAt: "2026-08-04T00:00:00.000Z",
    baseline: {
      baselineId: "baseline-migration",
      version: 1,
      objective: "migration test",
      criteria: [],
      constraints: [],
      assumptions: [],
      exclusions: [],
      establishedByTicketId: "ticket-migration" as never,
      establishedAt: "2026-08-04T00:00:00.000Z",
    },
    settlement: {
      baselineVersion: 1,
      acceptedByTicketId: "ticket-migration" as never,
      acceptedByPrincipalId: "principal:agent-dev",
      summary: "migration test",
      criterionResults: [],
      residualRisks: [],
      settledAt: "2026-08-04T00:00:00.000Z",
    },
  };
}
