import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ScopePromotionStore } from "../../src/server/evolution/scope-promotion-store.js";

describe("Evolution scope promotion", () => {
  const releaseRef = { id: "release-a", version: "1", contentHash: "a".repeat(64) };
  const practiceRef = { id: "practice-a", version: "1", contentHash: "b".repeat(64) };

  it("promotes agent-project learning to the same stable Agent only through explicit human review", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "autoagent-agent-promotion-"));
    const store = verifiedStore(home, () => new Date("2026-08-15T05:00:00.000Z"));
    const input = {
      commandId: "promote-agent-a", companyId: "company-a",
      origin: { ownerLevel: "agent_project" as const, workspaceId: "workspace-a", profileId: "profile-a" },
      targetScope: { ownerLevel: "agent" as const, profileId: "profile-a" },
      originReleaseRef: releaseRef, practiceRef,
      inheritanceProofRefs: ["proof-b", "proof-a"], effectWindowRefs: ["effect-a"], generalizationRisks: [],
    };
    const proposal = await store.propose(input);
    expect((await store.propose(input)).proposalId).toBe(proposal.proposalId);
    await expect(store.transition("system-review", proposal.proposalId, "reviewed", { type: "system", id: "worker" })).rejects.toMatchObject({ code: "SCOPE_PROMOTION_HUMAN_REQUIRED" });
    const reviewed = await store.transition("human-review", proposal.proposalId, "reviewed", { type: "human", id: "owner" });
    expect(await store.transition("human-approve", reviewed.proposalId, "approved", { type: "human", id: "owner" })).toMatchObject({ status: "approved", targetScope: { ownerLevel: "agent", profileId: "profile-a" } });
  });

  it("requires a reviewed cross-project trial before company approval", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "autoagent-company-promotion-"));
    const store = verifiedStore(home);
    const proposal = await store.propose({
      commandId: "promote-company-a", companyId: "company-a",
      origin: { ownerLevel: "project", workspaceId: "workspace-a" }, targetScope: { ownerLevel: "company" },
      originReleaseRef: releaseRef, practiceRef, inheritanceProofRefs: ["proof-a"], effectWindowRefs: ["effect-a"],
      generalizationRisks: ["The result may depend on the source project's team structure"],
    });
    await expect(store.transition("approve-too-early", proposal.proposalId, "approved", { type: "human", id: "owner" })).rejects.toMatchObject({ code: "SCOPE_PROMOTION_CONFLICT" });
    await expect(store.transition("review-company-missing", proposal.proposalId, "reviewed", { type: "human", id: "owner" }))
      .rejects.toMatchObject({ code: "SCOPE_PROMOTION_CONFLICT" });
    const reviewedCompany = await store.transition("review-company", proposal.proposalId, "reviewed", { type: "human", id: "owner" }, passingCompanyReview());
    expect(reviewedCompany.companyReview).toMatchObject({ generalizability: { passed: true }, reviewedBy: { type: "human", id: "owner" } });
    await store.attachTrial("attach-company-trial", proposal.proposalId, "trial-a");
    await store.transition("trial-company", proposal.proposalId, "trial", { type: "system", id: "trial-worker" });
    await expect(store.transition("approve-without-evidence", proposal.proposalId, "approved", { type: "human", id: "owner" })).rejects.toMatchObject({ code: "SCOPE_PROMOTION_CONFLICT" });
    await store.attachTrialEvidence("attach-company-trial-evidence", proposal.proposalId, "trial-effect-a");
    expect(await store.transition("approve-company", proposal.proposalId, "approved", { type: "human", id: "owner" })).toMatchObject({ status: "approved" });
  });

  it("rejects illegal widening and foreign private-deployment identity", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "autoagent-invalid-promotion-"));
    const store = new ScopePromotionStore(home, "company-a");
    const base = { commandId: "invalid", companyId: "company-a", originReleaseRef: releaseRef, practiceRef, inheritanceProofRefs: ["proof"], effectWindowRefs: ["effect"], generalizationRisks: [] };
    await expect(store.propose({ ...base, origin: { ownerLevel: "agent_project", workspaceId: "workspace-a", profileId: "profile-a" }, targetScope: { ownerLevel: "agent", profileId: "profile-b" } })).rejects.toMatchObject({ code: "INVALID_SCOPE_PROMOTION" });
    await expect(store.propose({ ...base, commandId: "foreign", companyId: "company-b", origin: { ownerLevel: "agent", profileId: "profile-a" }, targetScope: { ownerLevel: "company" }, generalizationRisks: ["risk"] })).rejects.toMatchObject({ code: "INVALID_SCOPE_PROMOTION" });
  });
});

function verifiedStore(home: string, now: () => Date = () => new Date()): ScopePromotionStore {
  return new ScopePromotionStore(home, "company-a", now, async (input) => ({ verifierId: "test-ledger-verifier", verifiedAt: now().toISOString(), originRootId: input.origin.workspaceId ?? `agent:${input.origin.profileId}`, inheritanceProofCount: input.inheritanceProofRefs.length, effectWindowCount: input.effectWindowRefs.length }));
}

function passingCompanyReview() {
  return {
    generalizability: { passed: true, notes: "Trial population covers a different project and Agent." },
    redaction: { passed: true, notes: "Evidence references contain no project secrets or personal data." },
    applicability: { passed: true, notes: "The declared company scope and contraindications are bounded." },
    cost: { passed: true, notes: "Expected runtime and Provider cost is acceptable." },
    risk: { passed: true, notes: "Known regression and safety risks have mitigations." },
  };
}
