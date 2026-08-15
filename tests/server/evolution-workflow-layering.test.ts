import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { productionEvolutionWorkflow } from "../../src/server/evolution/workflow-projection.js";
import type { EvolutionScope } from "../../src/shared/contracts/evolution.js";

describe("layered Workflow evolution", () => {
  it("inherits Company Workflow in a new project and lets Agent and Project layers override it deterministically", async () => {
    const local = await mkdtemp(path.join(os.tmpdir(), "autoagent-workflow-local-"));
    const company = await mkdtemp(path.join(os.tmpdir(), "autoagent-workflow-company-"));
    const agent = await mkdtemp(path.join(os.tmpdir(), "autoagent-workflow-agent-"));
    await writeWorkflow(company, 1, { workspaceId: "shared:company:company-a", ownerLevel: "company" });
    await writeWorkflow(agent, 2, { workspaceId: "shared:agent:profile-a", ownerLevel: "agent", profileId: "profile-a" });
    const sources = [{ layerRoot: company, ownerLevel: "company" as const, ownerId: "company-a", companyId: "company-a" }, { layerRoot: agent, ownerLevel: "agent" as const, ownerId: "profile-a", companyId: "company-a" }];
    const inherited = await productionEvolutionWorkflow(local, "workspace-new", "minimal-team", policy(), { profileId: "profile-a", sharedReleaseSources: sources });
    expect(inherited).toMatchObject({ ownerLevel: "agent", releaseVersion: "2", definition: { definitionVersion: 2 }, sourceRoot: agent });
    const peer = await productionEvolutionWorkflow(local, "workspace-new", "minimal-team", policy(), { profileId: "profile-b", sharedReleaseSources: sources });
    expect(peer).toMatchObject({ ownerLevel: "company", releaseVersion: "1", sourceRoot: company });
    await writeWorkflow(local, 3, { workspaceId: "workspace-new", ownerLevel: "project" });
    const overridden = await productionEvolutionWorkflow(local, "workspace-new", "minimal-team", policy(), { profileId: "profile-a", sharedReleaseSources: sources });
    expect(overridden).toMatchObject({ ownerLevel: "project", releaseVersion: "3", sourceRoot: local });
  });
});

async function writeWorkflow(root: string, version: number, scope: EvolutionScope): Promise<void> {
  const artifact = JSON.stringify({ schemaVersion: 1, templateId: "minimal-team", definitionVersion: version, plannerAssignment: {}, amendmentTemplate: {}, initialChange: {} });
  const contentHash = hash(artifact); const release = { id: `workflow-release-${scope.ownerLevel}-${version}`, version: String(version), contentHash }; const promotionId = `workflow-promotion-${scope.ownerLevel}-${version}`;
  const artifactRef = `artifacts/${contentHash}/artifact.txt`; await write(path.join(root, ".autoagent", "evolution", artifactRef), artifact);
  await write(path.join(root, ".autoagent", "evolution", "releases", release.id, "manifest.json"), JSON.stringify({ schemaVersion: 1, release, stage: "production", candidateId: `candidate-${version}`, candidateHash: contentHash, candidateKind: "workflow", target: "minimal-team", promotionId, artifactRef, scope, runtimeActive: true, validationPassed: true, validationChecks: [{ name: "workflow_contract", passed: true }] }));
  await write(path.join(root, ".autoagent", "evolution", "active", "production", `workflow-${version}.json`), JSON.stringify({ schemaVersion: 1, target: "minimal-team", stage: "production", scope, generation: version, release, promotionId, active: true, updatedAt: new Date().toISOString() }));
}
function policy() { return { policyId: "policy", policyVersion: 1, contentHash: "policy-hash" }; }
async function write(file: string, content: string): Promise<void> { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, content, "utf8"); }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
