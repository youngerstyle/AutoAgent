import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { EvolutionCandidate, EvolutionSourcePatchArtifact, PromotionRecord, VersionedEvolutionRef } from "../../src/shared/contracts/evolution.js";
import type { EvolutionDeliveryProviders, EvolutionProviderAttestation } from "../../src/server/evolution/delivery-providers.js";
import { SourcePatchDeliveryPipeline } from "../../src/server/evolution/source-patch-delivery.js";
import { EvolutionActivationStore } from "../../src/server/evolution/activation-store.js";

describe("Evol Source Patch delivery", () => {
  it("activates only after checks, review, build, deployment, and runtime commit observation pass", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-source-delivery-"));
    const artifact = sourceArtifact();
    const candidate = await writeCandidate(root, artifact);
    const promotion = fixturePromotion(candidate);
    const providers = fakeProviders(artifact.baseCommit);
    const pipeline = new SourcePatchDeliveryPipeline(root, providers);

    const delivered = await pipeline.deliver("deliver-1", candidate, promotion);
    expect(delivered).toEqual(expect.objectContaining({ status: "verified", sourceCommit: "b".repeat(40), previousDeployment: expect.objectContaining({ id: "deployment-old" }) }));
    expect(delivered.attestations.map((item) => item.subject)).toEqual(["typecheck", "review", "merge", "build", "canary", "production", "runtime"]);
    expect(await new EvolutionActivationStore(root).list()).toEqual([expect.objectContaining({ assetKind: "source_patch", status: "activated", boundary: "next_deployment", proofCount: 1 })]);
    expect(await new EvolutionActivationStore(root).listProofs()).toEqual([expect.objectContaining({ runtimeKind: "deployment", runtimeRef: "deployment-new" })]);

    const rolledBack = await pipeline.rollback("rollback-1", delivered.deliveryId);
    expect(rolledBack.status).toBe("rolled_back");
    expect(await new EvolutionActivationStore(root).list()).toEqual([expect.objectContaining({ status: "rolled_back" })]);
  });

  it("fails closed when the repository moved beyond the declared base", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-source-delivery-stale-"));
    const artifact = sourceArtifact();
    const candidate = await writeCandidate(root, artifact);
    const providers = fakeProviders("f".repeat(40));
    await expect(new SourcePatchDeliveryPipeline(root, providers).deliver("deliver-stale", candidate, fixturePromotion(candidate)))
      .rejects.toThrow("SCM base changed");
    expect(providers.scm.prepareChange).not.toHaveBeenCalled();
    expect(await new EvolutionActivationStore(root).list()).toEqual([]);
  });

  it("resumes after the last attested gate without repeating merge", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-source-delivery-resume-"));
    const artifact = sourceArtifact();
    const candidate = await writeCandidate(root, artifact);
    const providers = fakeProviders(artifact.baseCommit);
    vi.mocked(providers.build.build).mockRejectedValueOnce(new Error("builder temporarily unavailable"));
    const pipeline = new SourcePatchDeliveryPipeline(root, providers);
    await expect(pipeline.deliver("deliver-attempt-1", candidate, fixturePromotion(candidate))).rejects.toThrow("builder temporarily unavailable");
    await expect(pipeline.deliver("deliver-attempt-2", candidate, fixturePromotion(candidate))).resolves.toEqual(expect.objectContaining({ status: "verified" }));
    expect(providers.scm.prepareChange).toHaveBeenCalledTimes(1);
    expect(providers.scm.merge).toHaveBeenCalledTimes(1);
    expect(providers.build.build).toHaveBeenCalledTimes(2);
  });
});

function fakeProviders(currentRevision: string): EvolutionDeliveryProviders {
  const oldDeployment: VersionedEvolutionRef = { id: "deployment-old", version: "7", contentHash: hash("old") };
  const newDeployment: VersionedEvolutionRef = { id: "deployment-new", version: "8", contentHash: hash("new") };
  const buildArtifact: VersionedEvolutionRef = { id: "image", version: "sha-b", contentHash: hash("image") };
  return {
    scm: {
      providerId: "fake-scm", currentRevision: vi.fn(async () => currentRevision),
      prepareChange: vi.fn(async ({ artifact }) => ({ provider: "fake-scm", repositoryId: artifact.repositoryId, baseCommit: artifact.baseCommit, changeRef: "change-1", candidateCommit: "a".repeat(40) })),
      requiredChecks: vi.fn(async (_change, names: string[]) => names.map((name) => attestation(name, "checks"))),
      review: vi.fn(async () => attestation("review", "reviewer")),
      merge: vi.fn(async () => ({ mergeCommit: "b".repeat(40), attestation: attestation("merge", "scm") })),
    },
    build: { providerId: "fake-build", build: vi.fn(async () => ({ artifactRef: buildArtifact, attestation: attestation("build", "builder") })) },
    deployment: {
      providerId: "fake-deployment", currentProduction: vi.fn(async () => oldDeployment),
      deployCanary: vi.fn(async () => ({ deploymentRef: newDeployment, attestation: attestation("canary", "deployer") })),
      promoteProduction: vi.fn(async () => attestation("production", "deployer")),
      actualRevision: vi.fn(async (deployment) => ({ sourceCommit: deployment.id === oldDeployment.id ? "9".repeat(40) : "b".repeat(40), runtimeSnapshotHash: hash(deployment.id), attestation: attestation("runtime", "runtime") })),
      rollback: vi.fn(async () => attestation("rollback", "deployer")),
    },
  };
}

async function writeCandidate(root: string, artifact: EvolutionSourcePatchArtifact): Promise<EvolutionCandidate> {
  const content = JSON.stringify(artifact);
  const contentHash = hash(content);
  const artifactRef = `artifacts/${contentHash}/artifact.txt`;
  const file = path.join(root, ".autoagent", "evolution", artifactRef);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
  const base = { id: `scm:${artifact.repositoryId}`, version: artifact.baseCommit, contentHash: hash(artifact.baseCommit) };
  return {
    candidateId: "candidate-source", revision: 1, kind: "source_patch", target: "autoagent-service", title: "Patch scheduler defect",
    rationale: "A traced scheduler defect requires a bounded source correction.", artifactRef, contentHash,
    hypothesis: "The source correction will remove the observed scheduler failure without regressing safety checks.",
    sourceRefs: [{ kind: "trace", ref: "trace-source", workspaceId: "workspace-a" }], scope: { workspaceId: "workspace-a" },
    expectedMetrics: [{ metric: "task_success_rate", direction: "increase" }], riskLevel: "critical", status: "ready_for_eval",
    proposedBy: { type: "agent", id: "coordinator" }, createdAt: "2026-08-14T00:00:00.000Z", updatedAt: "2026-08-14T00:00:00.000Z",
    validation: { passed: true, checkedAt: "2026-08-14T00:00:00.000Z", checks: [
      { name: "source_patch_contract", passed: true, message: "passed" }, { name: "source_patch_scope", passed: true, message: "passed" },
    ] },
    mutationSet: { assetKind: "source_patch", target: "autoagent-service", baseRef: base, candidateRef: { id: "candidate-source", version: "1", contentHash }, representation: "unified_diff", activationBoundary: "next_deployment", compatibility: { runtime: "autoagent" }, rollbackRef: base },
  };
}

function fixturePromotion(candidate: EvolutionCandidate): PromotionRecord {
  return {
    promotionId: "promotion-source", candidateId: candidate.candidateId, evaluationId: "evaluation-source",
    toRelease: { id: "release-source", version: "1", contentHash: candidate.contentHash }, stage: "production", scope: candidate.scope,
    approvedBy: { type: "human", id: "owner" }, policyRef: { id: "policy", version: "1", contentHash: hash("policy") }, status: "active", createdAt: "2026-08-14T00:00:00.000Z",
  };
}
function sourceArtifact(): EvolutionSourcePatchArtifact {
  return { schemaVersion: 1, repositoryId: "autoagent", baseCommit: "1".repeat(40), targetBranch: "main", files: ["src/fix.ts"], patch: "diff --git a/src/fix.ts b/src/fix.ts\n--- a/src/fix.ts\n+++ b/src/fix.ts\n@@ -1 +1 @@\n-old\n+new\n", requiredChecks: ["typecheck"] };
}
function attestation(subject: string, provider: string): EvolutionProviderAttestation {
  return { provider, subject, revision: "1", status: "passed", observedAt: "2026-08-14T00:00:00.000Z", evidenceRef: `evidence:${subject}` };
}
function hash(value: string) { return createHash("sha256").update(value, "utf8").digest("hex"); }
