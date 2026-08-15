import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentProfile, WorkspaceAgent } from "../../src/shared/types.js";
import { isCanaryAssignment, runtimeEvolutionProjection } from "../../src/server/evolution/runtime-projection.js";

describe("Plugin canary runtime projection", () => {
  it("mounts an extension only for the stable selected cohort", async () => {
    const previous = process.env.AUTOAGENT_EVOLUTION_PLUGIN_SANDBOX_PROGRAM;
    delete process.env.AUTOAGENT_EVOLUTION_PLUGIN_SANDBOX_PROGRAM;
    try {
      const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-plugin-canary-"));
      const source = "export default { async health(){return {ok:true}}, async invokeTool(){return {ok:true}} };\n";
      const candidateHash = hash("immutable-plugin-bundle");
      const fileHash = hash(source);
      const releaseId = "plugin-canary-release";
      const promotionId = "plugin-canary-promotion";
      const scope = { workspaceId: "workspace-a", roles: ["dev"], tools: ["readFile"] };
      const manifestRef = `artifacts/${candidateHash}/manifests/candidate.json`;
      const manifest = {
        schemaVersion: 1, kind: "plugin", name: "canary_review", version: "1.0.0", apiVersion: "autoagent.plugin/v1", entrypoint: "index.mjs",
        contentHash: candidateHash, scope, riskLevel: "critical", sourceRefs: [], permissions: { workspaceRead: [] },
        contributions: { tools: [{ name: "inspect", description: "Inspect canary.", inputSchema: { type: "object", additionalProperties: false } }], guardrails: [] },
        lifecycle: { activation: "onDemand", invokeTimeoutMs: 2_000 }, files: [{ path: "index.mjs", sha256: fileHash, bytes: Buffer.byteLength(source) }],
        compatibility: { runtime: "autoagent", manifestVersion: 1, hostApi: "autoagent.plugin/v1" },
        scanner: { scannerRef: { id: "scanner", version: "1", contentHash: "scanner-hash" }, candidateHash, decision: "pass", declaredCapabilities: [], detectedCapabilities: [], findings: [], scannedAt: "2026-08-14T00:00:00.000Z" },
      };
      await writeJson(path.join(root, ".autoagent", "evolution", manifestRef), manifest);
      await writeJson(path.join(root, ".autoagent", "evolution", "artifacts", candidateHash, "bundle", "index.mjs"), source, false);
      await writeJson(path.join(root, ".autoagent", "evolution", "releases", releaseId, "manifest.json"), {
        schemaVersion: 1, release: { id: releaseId, version: "1-canary", contentHash: candidateHash }, stage: "canary",
        candidateId: "candidate-a", candidateHash, candidateKind: "plugin", target: "canary_review", artifactRef: `artifacts/${candidateHash}/artifact.txt`,
        artifactManifestRef: manifestRef, artifactManifestHash: hash(canonical(manifest)), evaluationId: "evaluation-a", scope,
        promotionId, runtimeActive: true, validationPassed: true, validationChecks: [{ name: "plugin_static_scan", passed: true, message: "passed" }],
      });
      const rollout = { percentage: 25, salt: "plugin-canary-salt" };
      await writeJson(path.join(root, ".autoagent", "evolution", "active", "canary", "pointer.json"), {
        schemaVersion: 1, target: "canary_review", stage: "canary", scope, generation: 1,
        release: { id: releaseId, version: "1-canary", contentHash: candidateHash }, promotionId, active: true, rollout, updatedAt: "2026-08-14T00:00:00.000Z",
      });
      const selected = findKey(rollout, true);
      const control = findKey(rollout, false);
      const first = await project(root, selected);
      const replay = await project(root, selected);
      const unselected = await project(root, control);
      expect(first.plugins).toHaveLength(1);
      expect(replay.plugins.map((item) => item.releaseId)).toEqual(first.plugins.map((item) => item.releaseId));
      expect(unselected.plugins).toEqual([]);
      expect(first.canaryAssignments).toContainEqual(expect.objectContaining({ promotionId, selected: true }));
      expect(unselected.canaryAssignments).toContainEqual(expect.objectContaining({ promotionId, selected: false }));
    } finally {
      if (previous === undefined) delete process.env.AUTOAGENT_EVOLUTION_PLUGIN_SANDBOX_PROGRAM;
      else process.env.AUTOAGENT_EVOLUTION_PLUGIN_SANDBOX_PROGRAM = previous;
    }
  });
});

function project(root: string, assignmentKey: string) {
  return runtimeEvolutionProjection(root, "workspace-a", profile(), agent(), { assignmentKey, tools: ["readFile"] });
}
function findKey(rollout: { percentage: number; salt: string }, selected: boolean): string {
  for (let index = 0; index < 10_000; index += 1) {
    const value = `thread-${index}:goal`;
    if (isCanaryAssignment(rollout, value) === selected) return value;
  }
  throw new Error("Unable to find canary fixture key");
}
async function writeJson(file: string, value: unknown, json = true): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, json ? `${JSON.stringify(value)}\n` : String(value), "utf8");
}
function profile(): AgentProfile { return { id: "profile", name: "Dev", role: "dev", capabilities: [], defaultProvider: "mock", defaultModel: "mock", defaultPolicy: {} }; }
function agent(): WorkspaceAgent { return { id: "agent", workspaceId: "workspace-a", profileId: "profile", roleInWorkspace: "dev", agentDir: "agents/dev", status: "idle" }; }
function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
