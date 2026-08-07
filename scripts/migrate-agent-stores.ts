import { loadConfig } from "../src/server/config.js";
import { inspectAgentRolloutMigrations, migrateAgentRollout } from "../src/server/agent-engine/agent-store-migration.js";
import { WorkspaceStore } from "../src/server/storage/workspace-store.js";

const apply = process.argv.includes("--apply");
const workspaceId = valueAfter("--workspace");
const config = loadConfig();
const workspaces = await new WorkspaceStore(config.autoAgentHome).list();
const selected = workspaceId ? workspaces.filter((workspace) => workspace.id === workspaceId) : workspaces;
const results = [];

for (const workspace of selected) {
  const candidates = await inspectAgentRolloutMigrations(workspace.rootPath);
  for (const candidate of candidates) {
    results.push(await migrateAgentRollout(candidate, { apply }));
  }
}

console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", results }, null, 2));

function valueAfter(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
