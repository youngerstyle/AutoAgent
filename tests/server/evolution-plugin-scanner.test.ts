import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { EvaluationCaseResult, RecordEvaluationInput } from "../../src/shared/contracts/evolution.js";
import { EvidenceLedger } from "../../src/server/agent-engine/evidence-ledger.js";
import { EvolutionEvaluationStore } from "../../src/server/evolution/evaluation-store.js";
import { EvolutionStore } from "../../src/server/evolution/evolution-store.js";
import { workspaceEvolutionPluginBundleDirectory } from "../../src/server/storage/paths.js";

describe("Plugin/Harness evolution supply chain", () => {
  it("validates and immutably materializes a namespaced executable Plugin bundle", async () => {
    const root = await workspace();
    const candidates = new EvolutionStore("workspace-a", root, fixedNow);
    const proposed = await candidates.create(candidateInput(validBundle()));
    const validated = await candidates.validate({ commandId: "validate-plugin", candidateId: proposed.candidateId, expectedContentHash: proposed.contentHash });

    expect(validated.status).toBe("validated");
    expect(validated.validation).toMatchObject({ passed: true, pluginScanner: { decision: "pass", candidateHash: proposed.contentHash } });
    expect(await readFile(path.join(workspaceEvolutionPluginBundleDirectory(root, proposed.contentHash), "index.mjs"), "utf8"))
      .toContain("invokeTool");
  });

  it("blocks network/process code, unsafe paths, and non-critical extensions", async () => {
    const root = await workspace();
    const candidates = new EvolutionStore("workspace-a", root, fixedNow);
    await expect(candidates.create({ ...candidateInput(validBundle()), commandId: "wrong-risk", riskLevel: "high" }))
      .rejects.toThrow("critical risk");
    const unsafe = JSON.stringify({
      ...JSON.parse(validBundle()),
      files: [{ path: "index.mjs", content: "import http from 'node:http'; export default { invokeTool(){ return eval('1') } };" }, { path: "../escape.mjs", content: "export default {};" }],
    });
    const proposed = await candidates.create({ ...candidateInput(unsafe), commandId: "unsafe-plugin" });
    const validated = await candidates.validate({ commandId: "validate-unsafe", candidateId: proposed.candidateId, expectedContentHash: proposed.contentHash });
    expect(validated.status).toBe("rejected");
    expect(validated.validation?.pluginScanner).toMatchObject({ decision: "block" });
    expect(validated.validation?.pluginScanner?.findings.map((item) => item.ruleId)).toEqual(expect.arrayContaining(["code.network", "code.dynamic", "bundle.file.path"]));
  });

  it("accepts a bounded Python entrypoint and rejects non-allowlisted Python imports", async () => {
    const root = await workspace();
    const candidates = new EvolutionStore("workspace-a", root, fixedNow);
    const pythonBundle = JSON.stringify({
      ...JSON.parse(validBundle()),
      manifest: { ...JSON.parse(validBundle()).manifest, entrypoint: "index.py" },
      files: [{ path: "index.py", content: "import json\n\ndef health(context): return {'ok': True}\ndef invoke_tool(name, input_value, context): return {'value': json.dumps(input_value)}\n" }],
    });
    const proposed = await candidates.create(candidateInput(pythonBundle));
    const validated = await candidates.validate({ commandId: "validate-python", candidateId: proposed.candidateId, expectedContentHash: proposed.contentHash });
    expect(validated.validation?.pluginScanner).toMatchObject({ decision: "pass" });

    const unsafePython = JSON.stringify({
      ...JSON.parse(pythonBundle),
      files: [{ path: "index.py", content: "import socket\n\ndef invoke_tool(name, input_value, context): return {}\n" }],
    });
    const unsafe = await candidates.create({ ...candidateInput(unsafePython), commandId: "unsafe-python" });
    const rejected = await candidates.validate({ commandId: "validate-unsafe-python", candidateId: unsafe.candidateId, expectedContentHash: unsafe.contentHash });
    expect(rejected.validation?.pluginScanner?.findings.map((item) => item.ruleId)).toContain("code.python_import");
  });

  it("allows a locally hosted Plugin canary after independent evaluation and human approval", async () => {
    const previousSandbox = process.env.AUTOAGENT_EVOLUTION_PLUGIN_SANDBOX_PROGRAM;
    delete process.env.AUTOAGENT_EVOLUTION_PLUGIN_SANDBOX_PROGRAM;
    const root = await workspace();
    const candidates = new EvolutionStore("workspace-a", root, fixedNow);
    const proposed = await candidates.create(candidateInput(validBundle()));
    const validated = await candidates.validate({ commandId: "validate-plugin", candidateId: proposed.candidateId, expectedContentHash: proposed.contentHash });
    const suiteRef = { id: "plugin-suite", version: "1", contentHash: "suite-hash" };
    await candidates.markReadyForEvaluation({ commandId: "bind-plugin", candidateId: validated.candidateId, expectedContentHash: validated.contentHash, suiteRef });
    const evaluations = new EvolutionEvaluationStore("workspace-a", root, candidates, fixedNow);
    const run = await evaluations.recordEvaluation(evaluationInput(validated.candidateId, validated.contentHash, suiteRef));
    const shadow = await evaluations.promote({
      commandId: "plugin-shadow", candidateId: validated.candidateId, evaluationId: run.evaluationId,
      expectedContentHash: validated.contentHash, stage: "shadow", approvedBy: { type: "system", id: "evolution-coordinator/v1" },
      policyRef: { id: "plugin-policy", version: "1", contentHash: "policy-hash" },
    });
    await expect(evaluations.promote({
      commandId: "plugin-canary-system", candidateId: validated.candidateId, evaluationId: run.evaluationId,
      expectedContentHash: validated.contentHash, stage: "canary", fromPromotionId: shadow.promotionId,
      approvedBy: { type: "system", id: "evolution-coordinator/v1" }, policyRef: { id: "plugin-policy", version: "1", contentHash: "policy-hash" },
    })).rejects.toMatchObject({ code: "EVOLUTION_APPROVAL_REQUIRED" });
    const canary = await evaluations.promote({
      commandId: "plugin-canary-local-host", candidateId: validated.candidateId, evaluationId: run.evaluationId,
      expectedContentHash: validated.contentHash, stage: "canary", fromPromotionId: shadow.promotionId,
      approvedBy: { type: "human", id: "owner" }, policyRef: { id: "plugin-policy", version: "1", contentHash: "policy-hash" },
    });
    expect(canary).toMatchObject({ stage: "canary", status: "active", approvedBy: { type: "human", id: "owner" } });
    if (previousSandbox !== undefined) process.env.AUTOAGENT_EVOLUTION_PLUGIN_SANDBOX_PROGRAM = previousSandbox;
  });
});

function candidateInput(artifactContent: string) {
  return {
    commandId: "plugin-candidate", kind: "plugin" as const, target: "release_review", title: "Release review plugin",
    rationale: "Repeated release reviews need a deterministic evidence summarizer.",
    hypothesis: "The plugin will improve target task success without increasing safety violations.", artifactContent,
    sourceRefs: [{ kind: "evidence" as const, ref: "source-evidence", workspaceId: "workspace-a" }],
    scope: { workspaceId: "workspace-a", tools: ["readFile"] },
    expectedMetrics: [{ metric: "task_success_rate", direction: "increase" as const, minimumDelta: 0 }],
    riskLevel: "critical" as const, proposedBy: { type: "agent" as const, id: "plugin-author" },
  };
}

function validBundle(): string {
  return JSON.stringify({
    schemaVersion: 1,
    manifest: {
      id: "release_review", version: "1.0.0", kind: "plugin", apiVersion: "autoagent.plugin/v1", entrypoint: "index.mjs",
      description: "Reads explicitly allowed release notes and produces a deterministic review summary.",
      permissions: { workspaceRead: ["docs/**"] },
      contributions: { tools: [{ name: "summarize", description: "Summarize one release note.", inputSchema: { type: "object", additionalProperties: false, properties: { path: { type: "string" } }, required: ["path"] } }], guardrails: [] },
      lifecycle: { activation: "onDemand", invokeTimeoutMs: 2_000 },
    },
    files: [{ path: "index.mjs", content: "export default { async health(){ return { ok: true }; }, async invokeTool({input, context}) { const result = await context.requestCapability('workspace.read', { path: input.path }); return { summary: result.content }; } };\n" }],
  });
}

async function workspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-plugin-evolution-"));
  const ledger = new EvidenceLedger(root);
  for (const evidenceId of ["source-evidence", "eval-evidence"]) await ledger.append({
    evidenceId, agentId: "evaluator", threadId: "thread", goalId: "goal", turnId: `turn-${evidenceId}`,
    toolCallId: `call-${evidenceId}`, toolName: "fixture", kind: "tool", capture: { status: "recorded" },
    observation: { status: "observed", result: { verified: true } }, workspaceRoot: root,
    createdAt: "2026-08-14T00:00:00.000Z", input: {},
  });
  return root;
}

function evaluationInput(candidateId: string, expectedContentHash: string, suiteRef: { id: string; version: string; contentHash: string }): RecordEvaluationInput {
  return {
    commandId: "plugin-evaluation", candidateId, expectedContentHash, suiteRef,
    baselineRef: { id: "plugin-baseline", version: "1", contentHash: "baseline-hash" }, runtimeSnapshotRef: "runtime-plugin-v1",
    caseResults: cases(), evaluatorPrincipal: { type: "system", id: "independent-plugin-evaluator" },
    grader: { id: "plugin-gate", version: "1", type: "deterministic" },
  };
}
function cases(): EvaluationCaseResult[] {
  const observation = { success: true, qualityScore: 1, costUsd: 0.01, costMeasured: true, latencyMs: 10, toolFailures: 0, policyViolations: 0, safetyViolations: 0 };
  const evidenceRefs = [{ kind: "evidence" as const, ref: "eval-evidence", workspaceId: "workspace-a" }];
  return [
    { caseId: "target", group: "target", baseline: { ...observation, success: false, qualityScore: 0 }, candidate: observation, evidenceRefs },
    { caseId: "regression", group: "regression", baseline: observation, candidate: observation, evidenceRefs },
    { caseId: "safety", group: "safety", baseline: observation, candidate: observation, evidenceRefs },
  ];
}
function fixedNow(): Date { return new Date("2026-08-14T00:10:00.000Z"); }
