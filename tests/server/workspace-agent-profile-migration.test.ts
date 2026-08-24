import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { migrateAndValidateWorkspaceAgentProfiles } from "../../src/server/agents/roster.js";
import { readJson } from "../../src/server/storage/json.js";
import { workspaceAgentFile } from "../../src/server/storage/paths.js";
import type { AgentProfile, Workspace, WorkspaceAgent } from "../../src/shared/types.js";

describe("WorkspaceAgent profile identity migration", () => {
  const profiles = [profile("profile-dev", "dev"), profile("profile-qa", "qa")];

  it("adds the only unambiguous stable profileId to a legacy project instance", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-agent-profile-migration-")); const workspace = fixtureWorkspace(root);
    const file = workspaceAgentFile(root, "legacy-dev"); await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ id: "legacy-dev", workspaceId: workspace.id, roleInWorkspace: "dev", agentDir: "agents/legacy-dev", status: "idle" }), "utf8");
    expect(await migrateAndValidateWorkspaceAgentProfiles(workspace, profiles)).toEqual([expect.objectContaining({ id: "legacy-dev", profileId: "profile-dev" })]);
    expect(await readJson<WorkspaceAgent | undefined>(file, undefined)).toMatchObject({ profileId: "profile-dev" });
  });

  it("maps a legacy developer to the canonical profile when parallel developer profiles exist", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-agent-profile-canonical-")); const workspace = fixtureWorkspace(root);
    const file = workspaceAgentFile(root, "legacy-dev"); await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ id: "legacy-dev", workspaceId: workspace.id, roleInWorkspace: "dev", agentDir: "agents/legacy-dev", status: "idle" }), "utf8");
    const parallelProfiles = [profile("prof_dev", "dev"), profile("prof_dev_integration", "dev")];
    expect(await migrateAndValidateWorkspaceAgentProfiles(workspace, parallelProfiles))
      .toEqual([expect.objectContaining({ id: "legacy-dev", profileId: "prof_dev" })]);
  });

  it("rejects unknown and duplicate personal identities instead of silently splitting or merging growth", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-agent-profile-invalid-")); const workspace = fixtureWorkspace(root);
    await writeAgent(root, workspace.id, "one", "profile-dev"); await writeAgent(root, workspace.id, "two", "profile-dev");
    await expect(migrateAndValidateWorkspaceAgentProfiles(workspace, profiles)).rejects.toThrow("duplicate instances");
  });
});

async function writeAgent(root: string, workspaceId: string, id: string, profileId: string): Promise<void> {
  const file = workspaceAgentFile(root, id); await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ id, workspaceId, profileId, roleInWorkspace: "dev", agentDir: `agents/${id}`, status: "idle" }), "utf8");
}
function fixtureWorkspace(rootPath: string): Workspace { return { id: "workspace-a", name: "Workspace", rootPath, createdAt: "2026-08-15T00:00:00.000Z", policyProfile: "development" }; }
function profile(id: string, role: AgentProfile["role"]): AgentProfile { return { id, name: id, role, capabilities: [], defaultProvider: "mock", defaultModel: "mock", defaultPolicy: {} }; }
