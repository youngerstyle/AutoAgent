import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ScopePromotionStore } from "../../src/server/evolution/scope-promotion-store.js";
import { SharedEvolutionReleaseRegistry } from "../../src/server/evolution/shared-release-registry.js";

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
});

async function writeOriginRelease(root: string, release: { id: string; version: string; contentHash: string }, content: string): Promise<void> {
  const evolution = path.join(root, ".autoagent", "evolution");
  const artifactRef = path.join("artifacts", release.contentHash, "artifact.txt");
  await mkdir(path.dirname(path.join(evolution, artifactRef)), { recursive: true });
  await writeFile(path.join(evolution, artifactRef), content, "utf8");
  await mkdir(path.join(evolution, "releases", release.id), { recursive: true });
  await writeFile(path.join(evolution, "releases", release.id, "manifest.json"), JSON.stringify({
    schemaVersion: 1, release, stage: "production", candidateId: "candidate-a", candidateHash: release.contentHash,
    candidateKind: "memory", target: "practice.memory.briefing", artifactRef, evaluationId: "evaluation-a", scope: { workspaceId: "workspace-a", ownerLevel: "agent_project", profileId: "profile-a" },
    promotionId: "promotion-a", runtimeActive: true, validationPassed: true, validationChecks: [{ name: "memory_safety", passed: true, message: "safe" }],
  }), "utf8");
}
