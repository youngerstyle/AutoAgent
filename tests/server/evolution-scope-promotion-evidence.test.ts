import { appendFile, mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ScopePromotionEvidenceService } from "../../src/server/evolution/scope-promotion-evidence.js";
import { EvolutionActivationStore } from "../../src/server/evolution/activation-store.js";
import { workspaceEvolutionReleaseFile, workspaceEvolutionTelemetryFile } from "../../src/server/storage/paths.js";
import { writeJson } from "../../src/server/storage/json.js";

describe("scope promotion evidence verification", () => {
  it("accepts only an active Release with real inheritance and passing effect ledgers", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "autoagent-evidence-home-"));
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-evidence-workspace-"));
    const release = { id: "release-a", version: "1", contentHash: "a".repeat(64) };
    const scope = { workspaceId: "workspace-a", ownerLevel: "agent_project" as const, profileId: "profile-a" };
    await writeJson(workspaceEvolutionReleaseFile(root, release.id), {
      schemaVersion: 1, release, stage: "production", candidateId: "candidate-a", candidateHash: release.contentHash,
      candidateKind: "memory", target: "practice.memory.brief", artifactRef: "artifacts/a/artifact.txt", evaluationId: "evaluation-a",
      scope, promotionId: "promotion-a", runtimeActive: true, validationPassed: true, validationChecks: [],
    });
    const pointerFile = path.join(root, ".autoagent", "evolution", "active", "production", "pointer.json");
    await writeJson(pointerFile, { schemaVersion: 1, target: "practice.memory.brief", stage: "production", scope, generation: 1, release, promotionId: "promotion-a", active: true, updatedAt: "2026-08-15T06:00:00.000Z" });
    const activations = new EvolutionActivationStore(root, () => new Date("2026-08-15T06:01:00.000Z"));
    await activations.recordSharedPointer({ promotionId: "promotion-a", candidateId: "candidate-a", assetKind: "memory", target: "practice.memory.brief", scope, releaseRef: release, desiredGeneration: 1 });
    const proof = await activations.observe({
      assetKind: "memory", target: "practice.memory.brief", ownerLevel: "agent_project", releaseRef: release,
      desiredGeneration: 1, actualGeneration: 1, runtimeKind: "turn", runtimeRef: "turn-a", runtimeSnapshotHash: "c".repeat(64),
      traceRef: { kind: "trace", ref: "trace-a", workspaceId: "workspace-a", agentId: "agent-a", profileId: "profile-a" },
    });
    const telemetryFile = workspaceEvolutionTelemetryFile(root);
    await mkdir(path.dirname(telemetryFile), { recursive: true });
    await appendFile(telemetryFile, `${JSON.stringify({ commandId: "telemetry-a", fingerprint: "fingerprint-a", telemetry: {
      telemetryId: "telemetry-a", releaseRef: release, candidateId: "candidate-a", candidateHash: release.contentHash, stage: "canary",
      sampleSize: 5, samples: [], aggregateMetrics: [], decision: "pass", recorder: { type: "system", id: "worker" },
      startedAt: "2026-08-15T05:00:00.000Z", endedAt: "2026-08-15T06:00:00.000Z", createdAt: "2026-08-15T06:00:00.000Z",
    } })}\n`, "utf8");
    const service = new ScopePromotionEvidenceService(home, "company-a", [{ id: "workspace-a", rootPath: root }], () => new Date("2026-08-15T06:02:00.000Z"));
    const input = {
      origin: scope, originReleaseRef: release, inheritanceProofRefs: [proof!.proofId], effectWindowRefs: ["telemetry-a"],
    };
    await expect(service.verify(input)).resolves.toMatchObject({ verifierId: "scope-promotion-evidence/v1", originRootId: "workspace-a", inheritanceProofCount: 1, effectWindowCount: 1 });
    await expect(service.verify({ ...input, inheritanceProofRefs: ["invented-proof"] })).rejects.toMatchObject({ code: "INVALID_SCOPE_PROMOTION_EVIDENCE" });
    await expect(service.verify({ ...input, effectWindowRefs: ["invented-effect"] })).rejects.toMatchObject({ code: "INVALID_SCOPE_PROMOTION_EVIDENCE" });
  });
});
