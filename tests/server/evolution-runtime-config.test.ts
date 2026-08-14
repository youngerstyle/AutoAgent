import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { bootstrapServer } from "../../src/server/bootstrap.js";
import type { EvolutionCandidate, PromotionRecord } from "../../src/shared/contracts/evolution.js";
import { EvolutionActivationStore } from "../../src/server/evolution/activation-store.js";
import { WorkspaceStore } from "../../src/server/storage/workspace-store.js";
import type { RuntimeHostRegistry } from "../../src/server/runtime/runtime-host-registry.js";

describe("Evol Runtime Config restart boundary", () => {
  it("freezes config at boot and only activates a later promotion on the next boot", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "autoagent-runtime-config-home-"));
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-runtime-config-workspace-"));
    const workspace = await new WorkspaceStore(home).create({ name: "Runtime config", rootPath: root, policyProfile: "development" });
    const activation = new EvolutionActivationStore(root);

    const first = await writeRuntimeConfigRelease(root, workspace.id, 1, { intervalMs: 750 });
    await activation.recordPointerChanged(first.promotion, first.candidate, 1, first.candidate.mutationSet!.baseRef);
    const app = await bootstrapServer(config(home), { restoreRuntimeHosts: false });
    expect(await activation.list()).toEqual([expect.objectContaining({ promotionId: first.promotion.promotionId, status: "activated", proofCount: 1 })]);
    expect(await activation.listProofs()).toEqual([expect.objectContaining({ runtimeKind: "process", actualGeneration: 1 })]);

    const second = await writeRuntimeConfigRelease(root, workspace.id, 2, { intervalMs: 500, providerRetryBaseMs: 1_000, providerRetryMaxMs: 5_000 });
    await activation.recordPointerChanged(second.promotion, second.candidate, 2, first.promotion.toRelease);
    await (app.locals.runtimeHostRegistry as RuntimeHostRegistry).initializeEvolutionRuntimeConfigs();
    expect((await activation.list()).find((item) => item.promotionId === second.promotion.promotionId)).toEqual(expect.objectContaining({ status: "waiting_for_activation", proofCount: 0 }));

    await bootstrapServer(config(home), { restoreRuntimeHosts: false });
    expect((await activation.list()).find((item) => item.promotionId === second.promotion.promotionId)).toEqual(expect.objectContaining({ status: "activated", proofCount: 1 }));
    expect((await activation.listProofs()).find((item) => item.desiredGeneration === 2)).toEqual(expect.objectContaining({ runtimeKind: "process", actualGeneration: 2 }));
  });
});

async function writeRuntimeConfigRelease(root: string, workspaceId: string, generation: number, settings: Record<string, number>) {
  const artifact = JSON.stringify({ schemaVersion: 1, target: "runtime-host", settings });
  const contentHash = hash(artifact);
  const releaseId = `release-runtime-config-${generation}`;
  const promotionId = `promotion-runtime-config-${generation}`;
  const candidateId = `candidate-runtime-config-${generation}`;
  const artifactRef = `artifacts/${contentHash}/artifact.txt`;
  await writeText(path.join(root, ".autoagent", "evolution", artifactRef), artifact);
  await writeJson(path.join(root, ".autoagent", "evolution", "releases", releaseId, "manifest.json"), {
    schemaVersion: 1, release: { id: releaseId, version: String(generation), contentHash }, stage: "production",
    candidateId, candidateHash: contentHash, candidateKind: "runtime_config", target: "runtime-host", artifactRef,
    scope: { workspaceId }, promotionId, runtimeActive: true, validationPassed: true,
    validationChecks: [{ name: "runtime_config_contract", passed: true, message: "passed" }, { name: "runtime_config_bounds", passed: true, message: "passed" }],
  });
  const release = { id: releaseId, version: String(generation), contentHash };
  await writeJson(path.join(root, ".autoagent", "evolution", "active", "production", "runtime-host.json"), {
    schemaVersion: 1, target: "runtime-host", stage: "production", scope: { workspaceId }, generation,
    release, promotionId, active: true, updatedAt: new Date().toISOString(),
  });
  const base = generation === 1 ? { id: "genesis:runtime-config", version: "0", contentHash: hash("") } : { id: `release-runtime-config-${generation - 1}`, version: String(generation - 1), contentHash: "previous" };
  const candidate: EvolutionCandidate = {
    candidateId, revision: generation, kind: "runtime_config", target: "runtime-host", title: "Runtime tuning",
    rationale: "Observed retry and scheduler behavior requires bounded runtime tuning.", artifactRef, contentHash,
    hypothesis: "The bounded runtime settings improve scheduling without changing policy or credentials.",
    sourceRefs: [{ kind: "trace", ref: `trace-${generation}`, workspaceId }], scope: { workspaceId },
    expectedMetrics: [{ metric: "latency_ms", direction: "decrease" }], riskLevel: "high", status: "ready_for_eval",
    proposedBy: { type: "agent", id: "coordinator" }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    mutationSet: { assetKind: "runtime_config", target: "runtime-host", baseRef: base, candidateRef: { id: candidateId, version: String(generation), contentHash }, representation: "full", activationBoundary: "next_restart", compatibility: { runtime: "autoagent" }, rollbackRef: base },
  };
  const promotion: PromotionRecord = {
    promotionId, candidateId, evaluationId: `evaluation-${generation}`, toRelease: release, stage: "production", scope: { workspaceId },
    approvedBy: { type: "human", id: "owner" }, policyRef: { id: "policy", version: "1", contentHash: hash("policy") }, status: "active", createdAt: new Date().toISOString(),
  };
  return { candidate, promotion };
}

function config(home: string) {
  return { port: 0, autoAgentHome: home, useMockProvider: true, providerRetryCount: 0, runtimeRestoreConcurrency: 1, runtimeExecutionConcurrency: 1, evolutionWorkerIntervalMs: 30_000 };
}
async function writeText(file: string, value: string) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, value, "utf8"); }
async function writeJson(file: string, value: unknown) { await writeText(file, JSON.stringify(value)); }
function hash(value: string) { return createHash("sha256").update(value, "utf8").digest("hex"); }
