import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentProfile, WorkspaceAgent } from "../../src/shared/types.js";
import { productionEvolutionMemories, productionEvolutionSkills, runtimeEvolutionProjection } from "../../src/server/evolution/runtime-projection.js";
import { MemoryLifecycleStore } from "../../src/server/evolution/memory-lifecycle-store.js";

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
    expect(loaded).toEqual([{ name: "evolved-review", directory: artifactDir, releaseId, releaseVersion: "1", contentHash, generation: 1, stage: "production" }]);
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
      { target: "experience.tool.browser", content: memoryContent, releaseId: memoryReleaseId, releaseVersion: "1", contentHash: memoryHash, generation: 1, stage: "production" },
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
    await writeDeclarativeRelease(root, "agent_profile", "profile-dev", JSON.stringify({ schemaVersion: 1, id: "profile-dev", soul: "Prefer the smallest evidence-backed change.", capabilities: ["delivery:implement"] }), "agent_profile_contract", "profile");
    const projected = await runtimeEvolutionProjection(root, "workspace-a", profile(), agent(), { assignmentKey: "thread-a", tools: [] });
    expect(projected.prompts).toEqual([expect.objectContaining({ target: "evidence-discipline", content: "Always distinguish observed facts from inference.", generation: 1 })]);
    expect(projected.agentProfiles).toEqual([expect.objectContaining({ target: "profile-dev", profile: expect.objectContaining({ soul: "Prefer the smallest evidence-backed change.", capabilities: ["delivery:implement"] }) })]);
  });
});

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
    validationChecks: [{ name: validationCheck, passed: true, message: "passed" }],
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
