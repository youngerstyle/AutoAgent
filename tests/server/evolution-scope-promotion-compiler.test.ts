import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EvolutionStore } from "../../src/server/evolution/evolution-store.js";
import { platformEvolutionStore } from "../../src/server/evolution-adapters/platform-source-verifier.js";
import { ScopePromotionCandidateCompiler } from "../../src/server/evolution/scope-promotion-compiler.js";
import { ScopePromotionStore } from "../../src/server/evolution/scope-promotion-store.js";

describe("project scope promotion compiler", () => {
  it("creates a new project Candidate without mutating or bypassing the origin Release", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "autoagent-project-promotion-home-"));
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-project-promotion-root-"));
    const candidates = platformEvolutionStore("workspace-a", root, () => new Date("2026-08-15T07:00:00.000Z"));
    const origin = await candidates.create({
      commandId: "origin-candidate", kind: "memory", target: "practice.memory.briefing", title: "Brief collaborators",
      rationale: "Two independent episodes support the local practice.", hypothesis: "Briefing collaborators improves task success without safety regression.",
      artifactContent: "# Scoped operational memory\n\nBrief the authoritative document and confirm acknowledgement before execution.",
      sourceRefs: [{ kind: "human_feedback", ref: "feedback-a", workspaceId: "workspace-a", profileId: "profile-a" }],
      scope: { workspaceId: "workspace-a", ownerLevel: "agent_project", profileId: "profile-a" }, expectedMetrics: [{ metric: "task_success_rate", direction: "increase" }],
      riskLevel: "low", proposedBy: { type: "system", id: "practice-binding-compiler/v1" }, practiceRef: { id: "practice-a", version: "1", contentHash: "b".repeat(64) },
    });
    const release = { id: "origin-release", version: "1", contentHash: origin.contentHash };
    await mkdir(path.dirname(path.join(root, ".autoagent", "evolution", "releases", release.id, "manifest.json")), { recursive: true });
    await writeFile(path.join(root, ".autoagent", "evolution", "releases", release.id, "manifest.json"), JSON.stringify({
      schemaVersion: 1, release, stage: "production", candidateId: origin.candidateId, candidateHash: origin.contentHash,
      scope: origin.scope, runtimeActive: true, validationPassed: true,
    }), "utf8");
    const proposals = new ScopePromotionStore(home, "company-a", undefined, async (input) => ({ verifierId: "test-ledger-verifier", verifiedAt: new Date().toISOString(), originRootId: "workspace-a", inheritanceProofCount: input.inheritanceProofRefs.length, effectWindowCount: input.effectWindowRefs.length }));
    const proposal = await proposals.propose({
      commandId: "project-promotion", companyId: "company-a",
      origin: { ownerLevel: "agent_project", workspaceId: "workspace-a", profileId: "profile-a" }, targetScope: { ownerLevel: "project", workspaceId: "workspace-a" },
      originReleaseRef: release, practiceRef: origin.practiceRef!, inheritanceProofRefs: ["proof-a"], effectWindowRefs: ["effect-a"], generalizationRisks: [],
    });
    await proposals.transition("project-review", proposal.proposalId, "reviewed", { type: "human", id: "owner" });
    await proposals.transition("project-approve", proposal.proposalId, "approved", { type: "human", id: "owner" });
    const compiler = new ScopePromotionCandidateCompiler("workspace-a", root, proposals, candidates);

    const result = await compiler.compileApprovedProjectPromotions();

    expect(result.candidatesCreated).toHaveLength(1);
    expect(result.candidatesCreated[0]).toMatchObject({ status: "proposed", kind: "memory", target: origin.target, scope: { workspaceId: "workspace-a", ownerLevel: "project" }, practiceRef: origin.practiceRef });
    expect(result.candidatesCreated[0]!.scope).not.toHaveProperty("profileId");
    expect(await candidates.get(origin.candidateId)).toMatchObject({ scope: { ownerLevel: "agent_project", profileId: "profile-a" }, contentHash: origin.contentHash });
    expect((await compiler.compileApprovedProjectPromotions()).candidatesCreated[0]!.candidateId).toBe(result.candidatesCreated[0]!.candidateId);
    expect(await candidates.list()).toHaveLength(2);
  });
});
