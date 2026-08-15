import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { productionEvolutionRuntimeConfig } from "../../src/server/evolution/runtime-config-projection.js";
import type { EvolutionScope } from "../../src/shared/contracts/evolution.js";

describe("layered Runtime Config evolution", () => {
  it("uses Company config for new projects and preserves the higher-priority Project override", async () => {
    const local = await mkdtemp(path.join(os.tmpdir(), "autoagent-config-local-"));
    const company = await mkdtemp(path.join(os.tmpdir(), "autoagent-config-company-"));
    await writeConfig(company, 1, { workspaceId: "shared:company:company-a", ownerLevel: "company" }, 900);
    expect(await productionEvolutionRuntimeConfig(local, "workspace-new", company)).toMatchObject({ ownerLevel: "company", settings: { intervalMs: 900 }, sourceRoot: company });
    await writeConfig(local, 2, { workspaceId: "workspace-new", ownerLevel: "project" }, 700);
    expect(await productionEvolutionRuntimeConfig(local, "workspace-new", company)).toMatchObject({ ownerLevel: "project", settings: { intervalMs: 700 }, sourceRoot: local });
  });
});

async function writeConfig(root: string, version: number, scope: EvolutionScope, intervalMs: number): Promise<void> {
  const artifact = JSON.stringify({ schemaVersion: 1, target: "runtime-host", settings: { intervalMs } }); const contentHash = hash(artifact);
  const release = { id: `config-release-${scope.ownerLevel}-${version}`, version: String(version), contentHash }; const promotionId = `config-promotion-${scope.ownerLevel}-${version}`; const artifactRef = `artifacts/${contentHash}/artifact.txt`;
  await write(path.join(root, ".autoagent", "evolution", artifactRef), artifact);
  await write(path.join(root, ".autoagent", "evolution", "releases", release.id, "manifest.json"), JSON.stringify({ schemaVersion: 1, release, stage: "production", candidateId: `candidate-${version}`, candidateHash: contentHash, candidateKind: "runtime_config", target: "runtime-host", artifactRef, scope, promotionId, runtimeActive: true, validationPassed: true, validationChecks: [{ name: "runtime_config_contract", passed: true, message: "valid" }] }));
  await write(path.join(root, ".autoagent", "evolution", "active", "production", `config-${version}.json`), JSON.stringify({ schemaVersion: 1, target: "runtime-host", stage: "production", scope, generation: version, release, promotionId, active: true, updatedAt: new Date().toISOString() }));
}
async function write(file: string, content: string): Promise<void> { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, content, "utf8"); }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
