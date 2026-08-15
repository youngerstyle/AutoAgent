import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentProfile, WorkspaceAgent } from "../../src/shared/types.js";
import type { EvolutionCandidate, PromotionRecord } from "../../src/shared/contracts/evolution.js";
import { productionEvolutionMemories, productionEvolutionSkills, runtimeEvolutionProjection } from "../../src/server/evolution/runtime-projection.js";
import { MemoryLifecycleStore } from "../../src/server/evolution/memory-lifecycle-store.js";
import { EvolutionReleaseRegistry } from "../../src/server/evolution/release-registry.js";
import { EvolutionActivationStore } from "../../src/server/evolution/activation-store.js";
import { inheritEvolvedProfileDefaults } from "../../src/server/runtime/runtime-host.js";

describe("evolution production runtime projection", () => {
  it("loads only an active, scoped, hash-verified production Skill with passing scanner provenance", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-runtime-evolution-"));
    const content = "---\nname: evolved-review\ndescription: Evidence-backed production review Skill.\n---\n# Evolved review\n\nUse authoritative evidence and preserve the release provenance for every conclusion.\n";
    const contentHash = hash(content);
    const releaseId = "release-production-a";
    const promotionId = "promotion-production-a";
    const artifactDir = path.join(root, ".autoagent", "evolution", "artifacts", contentHash);
    await mkdir(path.join(artifactDir, "manifests"), { recursive: true });
    await writeFile(path.join(artifactDir, "SKILL.md"), content, "utf8");
    const scannerManifestRef = path.join("artifacts", contentHash, "manifests", "candidate-a.json").replaceAll("\\", "/");
    const scannerManifest = {
      schemaVersion: 1, kind: "skill", name: "evolved-review", version: "1", entrypoint: "SKILL.md", contentHash,
      scope: { workspaceId: "workspace-a", roles: ["dev"], taskTypes: ["delivery-v1"], tools: ["readFile"] }, requiredTools: ["readFile"], riskLevel: "medium",
      sourceRefs: [{ kind: "evidence", ref: "evidence-a", workspaceId: "workspace-a" }], files: [{ path: "SKILL.md", sha256: contentHash }],
      compatibility: { runtime: "autoagent", manifestVersion: 1 }, declaredCapabilities: [],
      scanner: {
        scannerRef: { id: "autoagent-skill-scanner", version: "1.0.0", contentHash: "scanner-hash" },
        candidateHash: contentHash, decision: "pass", declaredCapabilities: [], detectedCapabilities: [], findings: [], scannedAt: "2026-08-14T00:00:00.000Z",
      },
    };
    await writeJson(path.join(root, ".autoagent", "evolution", scannerManifestRef), scannerManifest);
    await writeJson(path.join(root, ".autoagent", "evolution", "releases", releaseId, "manifest.json"), {
      schemaVersion: 1, release: { id: releaseId, version: "1", contentHash }, stage: "production",
      candidateId: "candidate-a", candidateHash: contentHash, candidateKind: "skill", target: "evolved-review",
      artifactRef: `artifacts/${contentHash}/artifact.txt`, artifactManifestRef: scannerManifestRef, artifactManifestHash: hash(canonical(scannerManifest)),
      evaluationId: "evaluation-a", telemetryId: "telemetry-a", scope: { workspaceId: "workspace-a", roles: ["dev"], taskTypes: ["delivery-v1"], tools: ["readFile"] },
      promotionId, runtimeActive: true, validationPassed: true,
      validationChecks: [{ name: "skill_static_scan", passed: true, message: "passed" }],
    });
    const pointerFile = path.join(root, ".autoagent", "evolution", "active", "production", "pointer-a.json");
    await writeJson(pointerFile, {
      schemaVersion: 1, target: "evolved-review", stage: "production", scope: { workspaceId: "workspace-a", roles: ["dev"], taskTypes: ["delivery-v1"], tools: ["readFile"] },
      generation: 1, release: { id: releaseId, version: "1", contentHash }, promotionId, active: true, updatedAt: "2026-08-14T00:01:00.000Z",
    });

    expect(await productionEvolutionSkills(root, "workspace-a", profile(), agent())).toEqual([]);
    expect(await productionEvolutionSkills(root, "workspace-a", profile(), agent(), { taskType: "other", tools: ["readFile"] })).toEqual([]);
    expect(await productionEvolutionSkills(root, "workspace-a", profile(), agent(), { taskType: "delivery-v1", tools: [] })).toEqual([]);
    const loaded = await productionEvolutionSkills(root, "workspace-a", profile(), agent(), { taskType: "delivery-v1", tools: ["readFile"] });
    expect(loaded).toEqual([{ name: "evolved-review", directory: artifactDir, releaseId, releaseVersion: "1", contentHash, generation: 1, stage: "production", ownerLevel: "project" }]);
    const memoryContent = "# Scoped operational memory\n\nApply the evidence-backed browser initialization lesson only when the same cause is observed again.";
    const memoryHash = hash(memoryContent);
    const memoryReleaseId = "release-memory-a";
    const memoryArtifactFile = path.join(root, ".autoagent", "evolution", "artifacts", memoryHash, "artifact.txt");
    await mkdir(path.dirname(memoryArtifactFile), { recursive: true });
    await writeFile(memoryArtifactFile, memoryContent, "utf8");
    await writeJson(path.join(root, ".autoagent", "evolution", "releases", memoryReleaseId, "manifest.json"), {
      schemaVersion: 1, release: { id: memoryReleaseId, version: "1", contentHash: memoryHash }, stage: "production",
      candidateId: "candidate-memory", candidateHash: memoryHash, candidateKind: "memory", target: "experience.tool.browser",
      artifactRef: `artifacts/${memoryHash}/artifact.txt`, evaluationId: "evaluation-memory", telemetryId: "telemetry-memory",
      scope: { workspaceId: "workspace-a", roles: ["dev"] }, promotionId: "promotion-memory", runtimeActive: true,
      validationPassed: true, validationChecks: [{ name: "memory_safety", passed: true, message: "passed" }],
    });
    await writeJson(path.join(root, ".autoagent", "evolution", "active", "production", "pointer-memory.json"), {
      schemaVersion: 1, target: "experience.tool.browser", stage: "production", scope: { workspaceId: "workspace-a", roles: ["dev"] },
      generation: 1, release: { id: memoryReleaseId, version: "1", contentHash: memoryHash }, promotionId: "promotion-memory", active: true,
      updatedAt: "2026-08-14T00:01:00.000Z",
    });
    await writeJson(path.join(root, ".autoagent", "evolution", "memory-lifecycle.jsonl"), {
      eventId: "memory-event-a", commandId: "register:promotion-memory", fingerprint: "fingerprint-a",
      occurredAt: "2026-08-14T00:01:00.000Z", type: "memory.registered",
      state: {
        releaseId: memoryReleaseId, releaseRef: { id: memoryReleaseId, version: "1", contentHash: memoryHash }, target: "experience.tool.browser",
        scope: { workspaceId: "workspace-a", roles: ["dev"] }, status: "active", pinned: false,
        registeredAt: "2026-08-14T00:01:00.000Z", updatedAt: "2026-08-14T00:01:00.000Z",
        useCount: 0, successfulEpisodeCount: 0, failedEpisodeCount: 0,
      },
    });
    expect(await productionEvolutionMemories(root, "workspace-a", profile(), agent())).toEqual([
      { target: "experience.tool.browser", content: memoryContent, releaseId: memoryReleaseId, releaseVersion: "1", contentHash: memoryHash, generation: 1, stage: "production", ownerLevel: "project" },
    ]);
    await new MemoryLifecycleStore("workspace-a", root).transition(
      "stale-memory", memoryReleaseId, "stale", "No recent successful use", { type: "system", id: "memory-lifecycle-maintainer/v1" },
    );
    expect(await productionEvolutionMemories(root, "workspace-a", profile(), agent())).toEqual([]);
    expect(await productionEvolutionSkills(root, "workspace-a", profile(), { ...agent(), roleInWorkspace: "qa" }, { taskType: "delivery-v1", tools: ["readFile"] })).toEqual([]);

    await writeJson(pointerFile, {
      schemaVersion: 1, target: "evolved-review", stage: "production", scope: { workspaceId: "workspace-a", roles: ["dev"], taskTypes: ["delivery-v1"], tools: ["readFile"] },
      generation: 2, previousRelease: { id: releaseId, version: "1", contentHash }, active: false, updatedAt: "2026-08-14T00:02:00.000Z",
    });
    expect(await productionEvolutionSkills(root, "workspace-a", profile(), agent(), { taskType: "delivery-v1", tools: ["readFile"] })).toEqual([]);
  });

  it("fails closed when an active production artifact no longer matches its immutable hash", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-runtime-tamper-"));
    const contentHash = hash("original");
    const releaseId = "release-tampered";
    const artifactDir = path.join(root, ".autoagent", "evolution", "artifacts", contentHash);
    await mkdir(path.join(artifactDir, "manifests"), { recursive: true });
    await writeFile(path.join(artifactDir, "SKILL.md"), "tampered", "utf8");
    const scannerManifest = {
      schemaVersion: 1, kind: "skill", name: "evolved-review", version: "1", entrypoint: "SKILL.md", contentHash,
      scope: { workspaceId: "workspace-a" }, requiredTools: [], riskLevel: "medium",
      sourceRefs: [{ kind: "evidence", ref: "evidence-a", workspaceId: "workspace-a" }], files: [{ path: "SKILL.md", sha256: contentHash }],
      compatibility: { runtime: "autoagent", manifestVersion: 1 }, declaredCapabilities: [],
      scanner: { candidateHash: contentHash, decision: "pass" },
    };
    await writeJson(path.join(artifactDir, "manifests", "candidate.json"), scannerManifest);
    await writeJson(path.join(root, ".autoagent", "evolution", "releases", releaseId, "manifest.json"), {
      schemaVersion: 1, release: { id: releaseId, version: "1", contentHash }, stage: "production", candidateId: "candidate",
      candidateHash: contentHash, candidateKind: "skill", target: "evolved-review", artifactRef: `artifacts/${contentHash}/artifact.txt`,
      artifactManifestRef: `artifacts/${contentHash}/manifests/candidate.json`, artifactManifestHash: hash(canonical(scannerManifest)), scope: { workspaceId: "workspace-a" }, promotionId: "promotion", runtimeActive: true,
      validationPassed: true, validationChecks: [{ name: "skill_static_scan", passed: true, message: "passed" }],
    });
    await writeJson(path.join(root, ".autoagent", "evolution", "active", "production", "pointer.json"), {
      schemaVersion: 1, target: "evolved-review", stage: "production", scope: { workspaceId: "workspace-a" }, generation: 1,
      release: { id: releaseId, version: "1", contentHash }, promotionId: "promotion", active: true, updatedAt: "2026-08-14T00:00:00.000Z",
    });
    await expect(productionEvolutionSkills(root, "workspace-a", profile(), agent())).rejects.toThrow("failed content verification");
  });

  it("projects activated Prompt and Agent Profile assets for the next Runtime session", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-runtime-declarative-"));
    await writeDeclarativeRelease(root, "prompt", "evidence-discipline", "Always distinguish observed facts from inference.", "prompt_safety", "prompt");
    await writeDeclarativeRelease(root, "agent_profile", "profile-dev", JSON.stringify({
      schemaVersion: 1, id: "profile-dev", soul: "Prefer the smallest evidence-backed change.", capabilities: ["delivery:implement"],
      defaultProvider: "anthropic", defaultModel: "claude-governed", defaultPolicy: { canReadWorkspace: true, canWriteWorkspace: false, canExecuteCommands: false, enabledTools: ["listFiles", "readFile"] },
    }), "agent_profile_contract", "profile");
    const projected = await runtimeEvolutionProjection(root, "workspace-a", profile(), agent(), { assignmentKey: "thread-a", tools: [] });
    expect(projected.prompts).toEqual([expect.objectContaining({ target: "evidence-discipline", content: "Always distinguish observed facts from inference.", generation: 1 })]);
    expect(projected.agentProfiles).toEqual([expect.objectContaining({ target: "profile-dev", profile: expect.objectContaining({
      soul: "Prefer the smallest evidence-backed change.", capabilities: ["delivery:implement"], defaultProvider: "anthropic", defaultModel: "claude-governed",
      defaultPolicy: expect.objectContaining({ canWriteWorkspace: false, enabledTools: ["listFiles", "readFile"] }),
    }) })]);
    expect(projected.resolvedReleases).toEqual(expect.arrayContaining([
      expect.objectContaining({ assetKind: "prompt", target: "evidence-discipline", ownerLevel: "project", stage: "production" }),
      expect.objectContaining({ assetKind: "agent_profile", target: "profile-dev", ownerLevel: "project", stage: "production" }),
    ]));
    expect(projected.snapshotHash).toMatch(/^[a-f0-9]{64}$/);
    expect((await runtimeEvolutionProjection(root, "workspace-a", profile(), agent(), { assignmentKey: "thread-a", tools: [] })).snapshotHash).toBe(projected.snapshotHash);
    const evolvedProfile = projected.agentProfiles[0]!.profile;
    expect(inheritEvolvedProfileDefaults(agent(), profile(), evolvedProfile)).toMatchObject({ provider: "anthropic", model: "claude-governed", policyOverride: { canWriteWorkspace: false } });
    expect(inheritEvolvedProfileDefaults({ ...agent(), provider: "openai", model: "explicit-model", policyOverride: { canReadWorkspace: true } }, profile(), evolvedProfile))
      .toMatchObject({ provider: "openai", model: "explicit-model", policyOverride: { canReadWorkspace: true } });
  });

  it("restores the previous immutable Prompt release and proves its new rollback generation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-runtime-rollback-"));
    const registry = new EvolutionReleaseRegistry(root);
    const activations = new EvolutionActivationStore(root);
    const first = await promptCandidate(root, 1, "Require observed evidence before making a release claim.");
    const firstPromotion = promptPromotion(first, 1);
    await registry.publish(firstPromotion, first);
    await activations.observe({ assetKind: "prompt", target: first.target, releaseRef: firstPromotion.toRelease, desiredGeneration: 1, actualGeneration: 1, runtimeKind: "turn", runtimeRef: "turn-v1", runtimeSnapshotHash: "1".repeat(64) });

    const second = await promptCandidate(root, 2, "Require only a model assertion before making a release claim.", firstPromotion.toRelease);
    const secondPromotion = promptPromotion(second, 2, firstPromotion.toRelease);
    await registry.publish(secondPromotion, second);
    await activations.observe({ assetKind: "prompt", target: second.target, releaseRef: secondPromotion.toRelease, desiredGeneration: 2, actualGeneration: 2, runtimeKind: "turn", runtimeRef: "turn-v2", runtimeSnapshotHash: "2".repeat(64) });
    await registry.rollback({ ...secondPromotion, status: "rolled_back", rolledBackAt: "2026-08-14T00:03:00.000Z" }, second);

    expect(await registry.current("production", second)).toMatchObject({ active: true, generation: 3, release: firstPromotion.toRelease, promotionId: firstPromotion.promotionId, previousRelease: secondPromotion.toRelease });
    const projected = await runtimeEvolutionProjection(root, "workspace-a", profile(), agent(), { assignmentKey: "rollback-turn", tools: [] });
    expect(projected.prompts).toEqual([expect.objectContaining({ content: "Require observed evidence before making a release claim.", releaseId: firstPromotion.toRelease.id, generation: 3 })]);
    await activations.observe({ assetKind: "prompt", target: first.target, releaseRef: firstPromotion.toRelease, desiredGeneration: 3, actualGeneration: 3, runtimeKind: "turn", runtimeRef: "turn-restored", runtimeSnapshotHash: "3".repeat(64) });
    expect(await activations.list()).toEqual([
      expect.objectContaining({ promotionId: firstPromotion.promotionId, status: "superseded" }),
      expect.objectContaining({ promotionId: secondPromotion.promotionId, status: "rolled_back" }),
      expect.objectContaining({ activationKind: "rollback_restore", rollbackOfPromotionId: secondPromotion.promotionId, status: "activated", releaseRef: firstPromotion.toRelease, desiredGeneration: 3 }),
    ]);
  });

  it("restores the previous Memory revision for a later turn and records a new proof", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-memory-rollback-"));
    const registry = new EvolutionReleaseRegistry(root);
    const activations = new EvolutionActivationStore(root);
    const lifecycle = new MemoryLifecycleStore("workspace-a", root);
    const first = await memoryCandidate(root, 1, "Require an actual Runtime inheritance trace before reporting activation.");
    const firstPromotion = memoryPromotion(first, 1);
    await registry.publish(firstPromotion, first);
    await lifecycle.register(firstPromotion, first);
    await activations.observe({ assetKind: "memory", target: first.target, releaseRef: firstPromotion.toRelease, desiredGeneration: 1, actualGeneration: 1, runtimeKind: "turn", runtimeRef: "memory-turn-v1", runtimeSnapshotHash: "4".repeat(64) });

    const second = await memoryCandidate(root, 2, "Treat a candidate proposal as if it were already active.", firstPromotion.toRelease);
    const secondPromotion = memoryPromotion(second, 2, firstPromotion.toRelease);
    await registry.publish(secondPromotion, second);
    await lifecycle.register(secondPromotion, second);
    await activations.observe({ assetKind: "memory", target: second.target, releaseRef: secondPromotion.toRelease, desiredGeneration: 2, actualGeneration: 2, runtimeKind: "turn", runtimeRef: "memory-turn-v2", runtimeSnapshotHash: "5".repeat(64) });

    const rolledBack = { ...secondPromotion, status: "rolled_back" as const, rolledBackAt: "2026-08-14T00:03:00.000Z" };
    await registry.rollback(rolledBack, second);
    await lifecycle.transition("archive-bad-memory", secondPromotion.toRelease.id, "archived", "Telemetry rejected this revision", { type: "system", id: "canary-monitor" });
    await lifecycle.transition("restore-good-memory", firstPromotion.toRelease.id, "active", "Restore previous known-good revision", { type: "system", id: "canary-monitor" });

    expect(await productionEvolutionMemories(root, "workspace-a", profile(), agent())).toEqual([
      expect.objectContaining({ content: "Require an actual Runtime inheritance trace before reporting activation.", releaseId: firstPromotion.toRelease.id, generation: 3 }),
    ]);
    await activations.observe({ assetKind: "memory", target: first.target, releaseRef: firstPromotion.toRelease, desiredGeneration: 3, actualGeneration: 3, runtimeKind: "turn", runtimeRef: "memory-turn-restored", runtimeSnapshotHash: "6".repeat(64) });
    expect((await activations.list()).find((item) => item.activationKind === "rollback_restore")).toMatchObject({ status: "activated", releaseRef: firstPromotion.toRelease, desiredGeneration: 3 });
    expect((await activations.listProofs()).at(-1)).toMatchObject({ assetKind: "memory", runtimeKind: "turn", runtimeRef: "memory-turn-restored", releaseRef: firstPromotion.toRelease });
  });
});

async function promptCandidate(root: string, revision: number, content: string, base?: PromotionRecord["toRelease"]): Promise<EvolutionCandidate> {
  const contentHash = hash(content);
  const candidateId = `candidate-prompt-${revision}`;
  const artifactRef = `artifacts/${contentHash}/artifact.txt`;
  await mkdir(path.dirname(path.join(root, ".autoagent", "evolution", artifactRef)), { recursive: true });
  await writeFile(path.join(root, ".autoagent", "evolution", artifactRef), content, "utf8");
  const baseRef = base ?? { id: "genesis:prompt", version: "0", contentHash: hash("") };
  return {
    candidateId, revision, kind: "prompt", target: "release-evidence", title: `Prompt ${revision}`,
    rationale: "Repeated release claims require an evidence-backed behavior constraint.", artifactRef, contentHash,
    hypothesis: "This prompt revision changes the rate of unsupported release claims in subsequent turns.",
    sourceRefs: [{ kind: "trace", ref: `trace-${revision}`, workspaceId: "workspace-a" }], scope: { workspaceId: "workspace-a", roles: ["dev"] },
    expectedMetrics: [{ metric: "evidence_completeness", direction: "increase" }], riskLevel: "high", status: "ready_for_eval",
    proposedBy: { type: "agent", id: "coordinator" }, createdAt: "2026-08-14T00:00:00.000Z", updatedAt: "2026-08-14T00:00:00.000Z",
    validation: { passed: true, checkedAt: "2026-08-14T00:00:00.000Z", checks: [{ name: "prompt_safety", passed: true, message: "passed" }] },
    mutationSet: { assetKind: "prompt", target: "release-evidence", baseRef, candidateRef: { id: candidateId, version: String(revision), contentHash }, representation: "full", activationBoundary: "next_turn", compatibility: { runtime: "autoagent" }, rollbackRef: baseRef },
  };
}
function promptPromotion(candidate: EvolutionCandidate, revision: number, fromRelease?: PromotionRecord["toRelease"]): PromotionRecord {
  return {
    promotionId: `promotion-prompt-${revision}`, candidateId: candidate.candidateId, evaluationId: `evaluation-${revision}`,
    ...(fromRelease ? { fromRelease } : {}), toRelease: { id: `release-prompt-${revision}`, version: String(revision), contentHash: candidate.contentHash },
    stage: "production", scope: candidate.scope, approvedBy: { type: "human", id: "owner" },
    policyRef: { id: "policy", version: "1", contentHash: hash("policy") }, status: "active", createdAt: `2026-08-14T00:0${revision}:00.000Z`,
  };
}

async function memoryCandidate(root: string, revision: number, content: string, base?: PromotionRecord["toRelease"]): Promise<EvolutionCandidate> {
  const contentHash = hash(content);
  const candidateId = `candidate-memory-${revision}`;
  const artifactRef = `artifacts/${contentHash}/artifact.txt`;
  await mkdir(path.dirname(path.join(root, ".autoagent", "evolution", artifactRef)), { recursive: true });
  await writeFile(path.join(root, ".autoagent", "evolution", artifactRef), content, "utf8");
  const baseRef = base ?? { id: "genesis:memory", version: "0", contentHash: hash("") };
  return {
    candidateId, revision, kind: "memory", target: "release-activation-evidence", title: `Memory ${revision}`,
    rationale: "Repeated release reports require a reusable evidence rule.", artifactRef, contentHash,
    hypothesis: "This memory revision changes unsupported activation reports in subsequent turns.",
    sourceRefs: [{ kind: "trace", ref: `memory-trace-${revision}`, workspaceId: "workspace-a" }], scope: { workspaceId: "workspace-a", roles: ["dev"] },
    expectedMetrics: [{ metric: "evidence_completeness", direction: "increase" }], riskLevel: "low", status: "ready_for_eval",
    proposedBy: { type: "system", id: "memory-consolidator/v1" }, createdAt: "2026-08-14T00:00:00.000Z", updatedAt: "2026-08-14T00:00:00.000Z",
    validation: { passed: true, checkedAt: "2026-08-14T00:00:00.000Z", checks: [{ name: "memory_safety", passed: true, message: "passed" }] },
    mutationSet: { assetKind: "memory", target: "release-activation-evidence", baseRef, candidateRef: { id: candidateId, version: String(revision), contentHash }, representation: "full", activationBoundary: "next_turn", compatibility: { runtime: "autoagent" }, rollbackRef: baseRef },
  };
}
function memoryPromotion(candidate: EvolutionCandidate, revision: number, fromRelease?: PromotionRecord["toRelease"]): PromotionRecord {
  return {
    promotionId: `promotion-memory-${revision}`, candidateId: candidate.candidateId, evaluationId: `memory-evaluation-${revision}`,
    ...(fromRelease ? { fromRelease } : {}), toRelease: { id: `release-memory-${revision}`, version: String(revision), contentHash: candidate.contentHash },
    stage: "production", scope: candidate.scope, approvedBy: { type: "human", id: "owner" }, policyRef: { id: "policy", version: "1", contentHash: hash("policy") },
    status: "active", createdAt: `2026-08-14T00:0${revision}:00.000Z`,
  };
}

async function writeDeclarativeRelease(root: string, kind: "prompt" | "agent_profile", target: string, content: string, validationCheck: string, suffix: string): Promise<void> {
  const contentHash = hash(content);
  const releaseId = `release-${suffix}`;
  const promotionId = `promotion-${suffix}`;
  const artifactRef = `artifacts/${contentHash}/artifact.txt`;
  await mkdir(path.dirname(path.join(root, ".autoagent", "evolution", artifactRef)), { recursive: true });
  await writeFile(path.join(root, ".autoagent", "evolution", artifactRef), content, "utf8");
  await writeJson(path.join(root, ".autoagent", "evolution", "releases", releaseId, "manifest.json"), {
    schemaVersion: 1, release: { id: releaseId, version: "1", contentHash }, stage: "production",
    candidateId: `candidate-${suffix}`, candidateHash: contentHash, candidateKind: kind, target, artifactRef,
    scope: { workspaceId: "workspace-a", roles: ["dev"] }, promotionId, runtimeActive: true, validationPassed: true,
    validationChecks: [
      { name: validationCheck, passed: true, message: "passed" },
      ...(kind === "agent_profile" ? [{ name: "agent_profile_runtime_authority", passed: true, message: "passed" }] : []),
    ],
  });
  await writeJson(path.join(root, ".autoagent", "evolution", "active", "production", `pointer-${suffix}.json`), {
    schemaVersion: 1, target, stage: "production", scope: { workspaceId: "workspace-a", roles: ["dev"] }, generation: 1,
    release: { id: releaseId, version: "1", contentHash }, promotionId, active: true, updatedAt: "2026-08-14T00:00:00.000Z",
  });
}

async function writeJson(file: string, value: unknown): Promise<void> { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, `${JSON.stringify(value)}\n`, "utf8"); }
function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
function profile(): AgentProfile { return { id: "profile-dev", name: "Dev", role: "dev", capabilities: [], defaultProvider: "mock", defaultModel: "mock", defaultPolicy: {} }; }
function agent(): WorkspaceAgent { return { id: "agent-dev", workspaceId: "workspace-a", profileId: "profile-dev", roleInWorkspace: "dev", agentDir: "agents/dev", status: "idle" }; }
