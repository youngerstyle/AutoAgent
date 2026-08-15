import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { EvolutionCandidate, PromotionRecord } from "../../src/shared/contracts/evolution.js";
import { EvolutionActivationStore } from "../../src/server/evolution/activation-store.js";

describe("Evol activation and inheritance ledger", () => {
  it("does not call a promoted release activated until a later Runtime proves inheritance", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-activation-"));
    let tick = 0;
    const now = () => new Date(Date.UTC(2026, 7, 14, 0, 0, tick++));
    const store = new EvolutionActivationStore(root, now);
    const candidate = fixtureCandidate();
    const promotion = fixturePromotion();
    await store.recordPointerChanged(promotion, candidate, 4, candidate.mutationSet!.baseRef);
    expect(await store.list()).toEqual([expect.objectContaining({ status: "waiting_for_activation", desiredGeneration: 4, proofCount: 0 })]);

    const observation = {
      assetKind: "prompt" as const, target: candidate.target, releaseRef: promotion.toRelease,
      desiredGeneration: 4, actualGeneration: 4, runtimeKind: "turn" as const, runtimeRef: "turn-after-promotion",
      runtimeSnapshotHash: "a".repeat(64),
      traceRef: { kind: "trace" as const, ref: "trace-after-promotion", workspaceId: "workspace-a", agentId: "agent-a" },
    };
    const first = await store.observe(observation);
    const replay = await store.observe(observation);
    expect(replay).toEqual(first);
    expect(await store.list()).toEqual([expect.objectContaining({ status: "activated", proofCount: 1, firstInheritedAt: expect.any(String) })]);
    expect(await store.listProofs()).toHaveLength(1);

    await store.recordHealth(promotion.promotionId, { telemetryId: "telemetry-healthy", decision: "pass" });
    expect(await store.list()).toEqual([expect.objectContaining({ status: "activated", health: "healthy", healthTelemetryId: "telemetry-healthy" })]);

    await store.recordRollback(promotion);
    await store.recordRollback(promotion);
    expect(await store.list()).toEqual([expect.objectContaining({ status: "rolled_back", proofCount: 1 })]);

    const restored = await store.recordRestoration(promotion.promotionId, candidate.mutationSet!.baseRef, 5);
    expect(restored).toEqual(expect.objectContaining({ activationKind: "rollback_restore", status: "waiting_for_activation", desiredGeneration: 5 }));
    await store.observe({
      assetKind: "prompt", target: candidate.target, releaseRef: candidate.mutationSet!.baseRef,
      desiredGeneration: 5, actualGeneration: 5, runtimeKind: "turn", runtimeRef: "turn-after-rollback",
      runtimeSnapshotHash: "b".repeat(64),
      traceRef: { kind: "trace", ref: "trace-after-rollback", workspaceId: "workspace-a", agentId: "agent-a" },
    });
    expect(await store.list()).toEqual([
      expect.objectContaining({ activationKind: "release", status: "rolled_back", proofCount: 1 }),
      expect.objectContaining({ activationKind: "rollback_restore", status: "activated", proofCount: 1, releaseRef: candidate.mutationSet!.baseRef }),
    ]);
    expect(await store.listProofs()).toHaveLength(2);
  });

  it("rejects stale generations and runtime kinds that do not satisfy the declared lifecycle boundary", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-activation-boundary-"));
    const store = new EvolutionActivationStore(root);
    const candidate = { ...fixtureCandidate(), kind: "plugin" as const, riskLevel: "critical" as const, mutationSet: { ...fixtureCandidate().mutationSet!, assetKind: "plugin" as const, activationBoundary: "next_session" as const } };
    const promotion = { ...fixturePromotion(), candidateId: candidate.candidateId };
    await store.recordPointerChanged(promotion, candidate, 2);
    const base = { assetKind: "plugin" as const, target: candidate.target, releaseRef: promotion.toRelease, desiredGeneration: 2, actualGeneration: 2, runtimeSnapshotHash: "c".repeat(64) };
    await expect(store.observe({ ...base, runtimeKind: "turn", runtimeRef: "turn-a" })).rejects.toThrow("next_session activation cannot be proved by turn runtime");
    await expect(store.observe({ ...base, actualGeneration: 1, runtimeKind: "session", runtimeRef: "session-stale" })).rejects.toThrow("generation does not match");
    expect(await store.list()).toEqual([expect.objectContaining({ status: "waiting_for_activation", proofCount: 0 })]);
    await expect(store.observe({ ...base, runtimeKind: "session", runtimeRef: "session-a", runtimeSnapshotHash: "not-a-hash" })).rejects.toThrow("snapshot hash is invalid");
    expect(await store.observe({ ...base, runtimeKind: "session", runtimeRef: "session-a" })).toEqual(expect.objectContaining({ boundary: "next_session", runtimeKind: "session" }));
    expect(await store.list()).toEqual([expect.objectContaining({ status: "activated", proofCount: 1 })]);
  });
});

function fixtureCandidate(): EvolutionCandidate {
  const genesis = { id: "genesis:prompt", version: "0", contentHash: "0".repeat(64) };
  return {
    candidateId: "candidate-a", revision: 1, kind: "prompt", target: "evidence-discipline", title: "Evidence discipline",
    rationale: "Repeated conclusions mixed inference with observation.", artifactRef: "artifacts/hash/artifact.txt", contentHash: "a".repeat(64),
    hypothesis: "Explicit evidence discipline will reduce unsupported conclusions in later turns.",
    sourceRefs: [{ kind: "trace", ref: "source-trace", workspaceId: "workspace-a", agentId: "agent-a" }],
    scope: { workspaceId: "workspace-a" }, expectedMetrics: [{ metric: "evidence_completeness", direction: "increase" }],
    riskLevel: "high", status: "ready_for_eval", proposedBy: { type: "agent", id: "agent-a" },
    mutationSet: {
      assetKind: "prompt", target: "evidence-discipline", baseRef: genesis,
      candidateRef: { id: "candidate-a", version: "1", contentHash: "a".repeat(64) }, representation: "full",
      activationBoundary: "next_turn", compatibility: { runtime: "autoagent" }, rollbackRef: genesis,
    },
    createdAt: "2026-08-14T00:00:00.000Z", updatedAt: "2026-08-14T00:00:00.000Z",
  };
}

function fixturePromotion(): PromotionRecord {
  return {
    promotionId: "promotion-a", candidateId: "candidate-a", evaluationId: "evaluation-a",
    toRelease: { id: "release-a", version: "1", contentHash: "a".repeat(64) }, stage: "production",
    scope: { workspaceId: "workspace-a" }, approvedBy: { type: "human", id: "owner" },
    policyRef: { id: "policy", version: "1", contentHash: "p".repeat(64) }, status: "active", createdAt: "2026-08-14T00:00:00.000Z",
  };
}
