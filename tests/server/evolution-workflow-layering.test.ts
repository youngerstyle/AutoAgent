import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { evolutionWorkflowForTask, productionEvolutionWorkflow, trialEvolutionWorkflow } from "../../src/server/evolution/workflow-projection.js";
import type { EvolutionScope } from "../../src/shared/contracts/evolution.js";
import { EvolutionStore } from "../../src/server/evolution/evolution-store.js";
import { createMinimalTeamPlanDefinition } from "../../src/server/product/plan-template.js";

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

  it("loads an immutable Workflow Candidate only for a candidate trial without changing the production pointer", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-workflow-trial-"));
    const definition = createMinimalTeamPlanDefinition(policy(), "Run a frozen workflow trial");
    const artifact = JSON.stringify({ schemaVersion: 1, templateId: "minimal-team", definitionVersion: 101, plannerAssignment: definition.plannerAssignment, amendmentTemplate: definition.amendmentTemplate, initialChange: definition.initialChange });
    const candidates = new EvolutionStore("workspace-a", root, undefined, {}, { async verify() { return true; } });
    const proposed = await candidates.create({
      commandId: "workflow-trial-candidate", kind: "workflow", target: "minimal-team", title: "Trial workflow",
      rationale: "Repeated project evidence supports a workflow trial.", hypothesis: "The candidate improves the frozen task.", artifactContent: artifact,
      sourceRefs: [{ kind: "evidence", ref: "source-a", workspaceId: "workspace-a" }], scope: { workspaceId: "workspace-a", ownerLevel: "project" },
      expectedMetrics: [{ metric: "task_success_rate", direction: "increase", minimumDelta: 0.01 }], riskLevel: "high", proposedBy: { type: "system", id: "test" },
    });
    const candidate = await candidates.validate({ commandId: "validate-workflow-trial", candidateId: proposed.candidateId, expectedContentHash: proposed.contentHash });
    const baseline = await trialEvolutionWorkflow(root, "workspace-a", "minimal-team", policy(), { trialId: "trial-a", caseId: "case-a", group: "target", assertions: ["brief the team"], variant: "baseline", candidateId: candidate.candidateId, candidateHash: candidate.contentHash, baselineRef: { id: "builtin:minimal-team", version: "1", contentHash: "builtin" } });
    expect(baseline).toBeUndefined();
    const preview = await trialEvolutionWorkflow(root, "workspace-a", "minimal-team", policy(), { trialId: "trial-a", caseId: "case-a", group: "target", assertions: ["brief the team"], variant: "candidate", candidateId: candidate.candidateId, candidateHash: candidate.contentHash, baselineRef: { id: "builtin:minimal-team", version: "1", contentHash: "builtin" } });
    expect(preview).toMatchObject({ stage: "trial", releaseId: candidate.candidateId, contentHash: candidate.contentHash, definition: { definitionVersion: 101 } });
    expect(await productionEvolutionWorkflow(root, "workspace-a", "minimal-team", policy())).toBeUndefined();
  });

  it("freezes Workflow Canary selected and control assignments at the task boundary", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-workflow-canary-"));
    const scope = { workspaceId: "workspace-a", ownerLevel: "project" as const };
    await writeWorkflow(root, 3, scope);
    const rollout = { percentage: 25, salt: "workflow-canary-salt" };
    await writeWorkflow(root, 4, scope, "canary", rollout);
    const selectedKey = findAssignmentKey(rollout, true); const controlKey = findAssignmentKey(rollout, false);
    const selected = await evolutionWorkflowForTask(root, "workspace-a", "minimal-team", policy(), selectedKey);
    expect(selected).toMatchObject({ workflow: { stage: "canary", definition: { definitionVersion: 4 } }, canaryAssignment: { selected: true, releaseId: "workflow-release-project-4" } });
    const control = await evolutionWorkflowForTask(root, "workspace-a", "minimal-team", policy(), controlKey);
    expect(control).toMatchObject({ workflow: { stage: "production", definition: { definitionVersion: 3 } }, canaryAssignment: { selected: false, releaseId: "workflow-release-project-4" } });
  });
});

async function writeWorkflow(root: string, version: number, scope: EvolutionScope, stage: "canary" | "production" = "production", rollout?: { percentage: number; salt: string }): Promise<void> {
  const artifact = JSON.stringify({ schemaVersion: 1, templateId: "minimal-team", definitionVersion: version, plannerAssignment: {}, amendmentTemplate: {}, initialChange: {} });
  const contentHash = hash(artifact); const release = { id: `workflow-release-${scope.ownerLevel}-${version}`, version: String(version), contentHash }; const promotionId = `workflow-promotion-${scope.ownerLevel}-${version}`;
  const artifactRef = `artifacts/${contentHash}/artifact.txt`; await write(path.join(root, ".autoagent", "evolution", artifactRef), artifact);
  await write(path.join(root, ".autoagent", "evolution", "releases", release.id, "manifest.json"), JSON.stringify({ schemaVersion: 1, release, stage, candidateId: `candidate-${version}`, candidateHash: contentHash, candidateKind: "workflow", target: "minimal-team", promotionId, artifactRef, scope, runtimeActive: true, validationPassed: true, validationChecks: [{ name: "workflow_contract", passed: true }] }));
  await write(path.join(root, ".autoagent", "evolution", "active", stage, `workflow-${version}.json`), JSON.stringify({ schemaVersion: 1, target: "minimal-team", stage, scope, generation: version, release, promotionId, active: true, updatedAt: new Date().toISOString(), ...(rollout ? { rollout } : {}) }));
}
function policy() { return { policyId: "policy", policyVersion: 1, contentHash: "policy-hash" }; }
async function write(file: string, content: string): Promise<void> { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, content, "utf8"); }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function findAssignmentKey(rollout: { percentage: number; salt: string }, selected: boolean): string { for (let index = 0; index < 1_000; index += 1) { const key = `task-${index}`; const bucket = Number.parseInt(hash(`${rollout.salt}\0${key}`).slice(0, 8), 16) % 100; if ((bucket < rollout.percentage) === selected) return key; } throw new Error("No assignment key found"); }
