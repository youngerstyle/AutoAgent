import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ScopePromotionStore } from "../../src/server/evolution/scope-promotion-store.js";
import { SharedEvolutionReleaseRegistry } from "../../src/server/evolution/shared-release-registry.js";
import { runtimeEvolutionProjection } from "../../src/server/evolution/runtime-projection.js";
import type { AgentProfile, WorkspaceAgent } from "../../src/shared/types.js";
import type { EvolutionScope } from "../../src/shared/contracts/evolution.js";
import { CompanyIdentityStore } from "../../src/server/storage/company-identity-store.js";
import { resolveSharedEvolutionLayerSources } from "../../src/server/runtime/runtime-host-registry.js";

describe("shared Agent and Company evolution releases", () => {
  it("publishes an approved local release into the stable Agent layer idempotently", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "autoagent-shared-home-"));
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "autoagent-shared-workspace-"));
    const content = "# Scoped operational memory\n\nBrief the authoritative document before collaborative execution begins.";
    const contentHash = createHash("sha256").update(content).digest("hex");
    const originRelease = { id: "origin-release", version: "1", contentHash };
    await writeOriginRelease(workspaceRoot, originRelease, content);
    const proposals = new ScopePromotionStore(home, "company-a", () => new Date("2026-08-15T06:00:00.000Z"));
    const proposal = await proposals.propose({
      commandId: "share-agent", companyId: "company-a",
      origin: { ownerLevel: "agent_project", workspaceId: "workspace-a", profileId: "profile-a" },
      targetScope: { ownerLevel: "agent", profileId: "profile-a" }, originReleaseRef: originRelease,
      practiceRef: { id: "practice-a", version: "1", contentHash: "b".repeat(64) },
      inheritanceProofRefs: ["proof-a"], effectWindowRefs: ["effect-a"], generalizationRisks: [],
    });
    await proposals.transition("review-agent", proposal.proposalId, "reviewed", { type: "human", id: "owner" });
    await proposals.transition("approve-agent", proposal.proposalId, "approved", { type: "human", id: "owner" });
    const registry = new SharedEvolutionReleaseRegistry(home, "company-a", proposals, () => new Date("2026-08-15T06:01:00.000Z"));

    const first = await registry.publishApproved(proposal.proposalId, workspaceRoot);
    const replay = await registry.publishApproved(proposal.proposalId, workspaceRoot);

    expect(first.layerRoot).toContain(path.join("layers", "agent", "profile-a"));
    expect(first.manifest).toMatchObject({ candidateKind: "memory", candidateHash: contentHash, scope: { ownerLevel: "agent", profileId: "profile-a" }, scopePromotionProposalId: proposal.proposalId, originReleaseRef: originRelease });
    expect(first.pointer).toMatchObject({ active: true, generation: 1, scope: { ownerLevel: "agent", profileId: "profile-a" } });
    expect(replay.pointer).toEqual(first.pointer);
    const otherWorkspace = await mkdtemp(path.join(os.tmpdir(), "autoagent-shared-target-"));
    const source = { layerRoot: first.layerRoot, ownerLevel: "agent" as const, ownerId: "profile-a", companyId: "company-a" };
    const inherited = await runtimeEvolutionProjection(otherWorkspace, "workspace-b", profile("profile-a"), agent("workspace-b", "profile-a"), { assignmentKey: "turn-a", sharedReleaseSources: [source] });
    expect(inherited.memories).toEqual([expect.objectContaining({ content, ownerLevel: "agent", releaseId: first.manifest.release.id })]);
    expect(inherited.resolvedReleases).toEqual([expect.objectContaining({ assetKind: "memory", ownerLevel: "agent", target: "practice.memory.briefing" })]);
    const peer = await runtimeEvolutionProjection(otherWorkspace, "workspace-b", profile("profile-b"), agent("workspace-b", "profile-b"), { assignmentKey: "turn-peer", sharedReleaseSources: [source] });
    expect(peer.memories).toEqual([]);
    await expect(registry.rollback(proposal.proposalId, { type: "system", id: "worker" })).rejects.toMatchObject({ code: "EVOLUTION_APPROVAL_REQUIRED" });
    expect(await registry.rollback(proposal.proposalId, { type: "human", id: "owner" })).toMatchObject({ active: false, generation: 2, previousRelease: first.manifest.release });
    const afterRollback = await runtimeEvolutionProjection(otherWorkspace, "workspace-b", profile("profile-a"), agent("workspace-b", "profile-a"), { assignmentKey: "turn-after-rollback", sharedReleaseSources: [source] });
    expect(afterRollback.memories).toEqual([]);
  });

  it("refuses unapproved promotion and a source release whose immutable hash does not match", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "autoagent-shared-reject-home-"));
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "autoagent-shared-reject-workspace-"));
    const contentHash = "a".repeat(64);
    await writeOriginRelease(workspaceRoot, { id: "origin-release", version: "1", contentHash }, "tampered content");
    const proposals = new ScopePromotionStore(home, "company-a");
    const proposal = await proposals.propose({
      commandId: "share-unapproved", companyId: "company-a", origin: { ownerLevel: "agent_project", workspaceId: "workspace-a", profileId: "profile-a" },
      targetScope: { ownerLevel: "agent", profileId: "profile-a" }, originReleaseRef: { id: "origin-release", version: "1", contentHash },
      practiceRef: { id: "practice-a", version: "1", contentHash: "b".repeat(64) }, inheritanceProofRefs: ["proof"], effectWindowRefs: ["effect"], generalizationRisks: [],
    });
    const registry = new SharedEvolutionReleaseRegistry(home, "company-a", proposals);
    await expect(registry.publishApproved(proposal.proposalId, workspaceRoot)).rejects.toMatchObject({ code: "SCOPE_PROMOTION_NOT_APPROVED" });
    await proposals.transition("review", proposal.proposalId, "reviewed", { type: "human", id: "owner" });
    await proposals.transition("approve", proposal.proposalId, "approved", { type: "human", id: "owner" });
    await expect(registry.publishApproved(proposal.proposalId, workspaceRoot)).rejects.toThrow("immutable content verification");
  });

  it("makes an approved Company release a new-project default without crossing private deployments", async () => {
    const firstHome = await mkdtemp(path.join(os.tmpdir(), "autoagent-company-layer-a-"));
    const secondHome = await mkdtemp(path.join(os.tmpdir(), "autoagent-company-layer-b-"));
    const firstCompany = await new CompanyIdentityStore(firstHome).getOrCreate();
    const secondCompany = await new CompanyIdentityStore(secondHome).getOrCreate();
    const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "autoagent-company-source-"));
    const content = "# Company operational memory\n\nBrief the authoritative document before any multi-agent project execution.";
    const contentHash = createHash("sha256").update(content).digest("hex");
    const originRelease = { id: "project-release", version: "1", contentHash };
    await writeOriginRelease(sourceRoot, originRelease, content, { workspaceId: "workspace-source", ownerLevel: "project" });
    const proposals = new ScopePromotionStore(firstHome, firstCompany.companyId);
    const proposal = await proposals.propose({
      commandId: "share-company", companyId: firstCompany.companyId,
      origin: { ownerLevel: "project", workspaceId: "workspace-source" }, targetScope: { ownerLevel: "company" },
      originReleaseRef: originRelease, practiceRef: { id: "practice-company", version: "1", contentHash: "d".repeat(64) },
      inheritanceProofRefs: ["proof-source"], effectWindowRefs: ["effect-source"], generalizationRisks: ["May vary with project topology"],
    });
    await proposals.transition("company-review", proposal.proposalId, "reviewed", { type: "human", id: "owner" });
    await proposals.transition("company-trial", proposal.proposalId, "trial", { type: "system", id: "trial-worker" });
    await proposals.transition("company-approve", proposal.proposalId, "approved", { type: "human", id: "owner" });
    await new SharedEvolutionReleaseRegistry(firstHome, firstCompany.companyId, proposals).publishApproved(proposal.proposalId, sourceRoot);

    const newProjectRoot = await mkdtemp(path.join(os.tmpdir(), "autoagent-company-new-project-"));
    const firstProjection = await runtimeEvolutionProjection(newProjectRoot, "brand-new-workspace", profile("unrelated-profile"), agent("brand-new-workspace", "unrelated-profile"), {
      assignmentKey: "new-project-turn", sharedReleaseSources: await resolveSharedEvolutionLayerSources(firstHome, "unrelated-profile"),
    });
    expect(firstProjection.memories).toEqual([expect.objectContaining({ content, ownerLevel: "company" })]);

    const isolatedProjection = await runtimeEvolutionProjection(newProjectRoot, "brand-new-workspace", profile("unrelated-profile"), agent("brand-new-workspace", "unrelated-profile"), {
      assignmentKey: "isolated-turn", sharedReleaseSources: await resolveSharedEvolutionLayerSources(secondHome, "unrelated-profile"),
    });
    expect(secondCompany.companyId).not.toBe(firstCompany.companyId);
    expect(isolatedProjection.memories).toEqual([]);
  });
});

async function writeOriginRelease(root: string, release: { id: string; version: string; contentHash: string }, content: string, scope: EvolutionScope = { workspaceId: "workspace-a", ownerLevel: "agent_project", profileId: "profile-a" }): Promise<void> {
  const evolution = path.join(root, ".autoagent", "evolution");
  const artifactRef = path.join("artifacts", release.contentHash, "artifact.txt");
  await mkdir(path.dirname(path.join(evolution, artifactRef)), { recursive: true });
  await writeFile(path.join(evolution, artifactRef), content, "utf8");
  await mkdir(path.join(evolution, "releases", release.id), { recursive: true });
  await writeFile(path.join(evolution, "releases", release.id, "manifest.json"), JSON.stringify({
    schemaVersion: 1, release, stage: "production", candidateId: "candidate-a", candidateHash: release.contentHash,
    candidateKind: "memory", target: "practice.memory.briefing", artifactRef, evaluationId: "evaluation-a", scope,
    promotionId: "promotion-a", runtimeActive: true, validationPassed: true, validationChecks: [{ name: "memory_safety", passed: true, message: "safe" }],
  }), "utf8");
}

function profile(id: string): AgentProfile { return { id, name: id, role: "dev", capabilities: [], defaultProvider: "mock", defaultModel: "mock", defaultPolicy: {} }; }
function agent(workspaceId: string, profileId: string): WorkspaceAgent { return { id: `${workspaceId}-${profileId}`, workspaceId, profileId, roleInWorkspace: "dev", agentDir: `agents/${profileId}`, status: "idle" }; }
