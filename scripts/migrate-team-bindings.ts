import { loadConfig } from "../src/server/config.js";
import { AgentProfileStore } from "../src/server/agents/profile-store.js";
import { inspectWorkspaceTeamBindingMigrations, migrateWorkspaceTeamBinding } from "../src/server/mission-process/team-binding-migration.js";
import { WorkspaceStore } from "../src/server/storage/workspace-store.js";

const apply = process.argv.includes("--apply");
const includeActive = process.argv.includes("--include-active");
const workspaceId = valueAfter("--workspace");
const config = loadConfig();
const workspaces = await new WorkspaceStore(config.autoAgentHome).list();
const profiles = new AgentProfileStore(config.autoAgentHome);
const selected = workspaceId ? workspaces.filter((workspace) => workspace.id === workspaceId) : workspaces;
const results = [];

for (const workspace of selected) {
  const candidates = await inspectWorkspaceTeamBindingMigrations(workspace);
  for (const candidate of candidates) {
    results.push(await migrateWorkspaceTeamBinding(workspace, profiles, candidate, {
      apply,
      includeActive,
    }));
  }
}

console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", includeActive, results }, null, 2));

function valueAfter(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
