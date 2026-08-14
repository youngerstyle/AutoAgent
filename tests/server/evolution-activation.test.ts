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
      runtimeSnapshotHash: "runtime-snapshot-hash",
      traceRef: { kind: "trace" as const, ref: "trace-after-promotion", workspaceId: "workspace-a", agentId: "agent-a" },
    };
    const first = await store.observe(observation);
    const replay = await store.observe(observation);
    expect(replay).toEqual(first);
    expect(await store.list()).toEqual([expect.objectContaining({ status: "activated", proofCount: 1, firstInheritedAt: expect.any(String) })]);
    expect(await store.listProofs()).toHaveLength(1);

    await store.recordRollback(promotion);
    await store.recordRollback(promotion);
    expect(await store.list()).toEqual([expect.objectContaining({ status: "rolled_back", proofCount: 1 })]);
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
