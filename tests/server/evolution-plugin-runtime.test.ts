import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentProfile, WorkspaceAgent } from "../../src/shared/types.js";
import type { EvaluationCaseResult } from "../../src/shared/contracts/evolution.js";
import { AgentContextAssembler } from "../../src/server/agent-engine/context-assembler.js";
import { AgentEngine } from "../../src/server/agent-engine/agent-engine.js";
import { AgentStore } from "../../src/server/agent-engine/agent-store.js";
import { EvidenceLedger } from "../../src/server/agent-engine/evidence-ledger.js";
import { PiAgentRuntime } from "../../src/server/agent-engine/pi-runtime.js";
import { AgentToolRuntime } from "../../src/server/agent-engine/tool-runtime.js";
import { AgentTraceStore } from "../../src/server/agent-engine/trace-store.js";
import { EvolutionEvaluationStore } from "../../src/server/evolution/evaluation-store.js";
import { EvolutionStore } from "../../src/server/evolution/evolution-store.js";
import { EvolutionTelemetryStore } from "../../src/server/evolution/telemetry-store.js";
import { pluginToolName } from "../../src/server/evolution/plugin-host.js";
import { EvolutionAgentRuntimeAdapter } from "../../src/server/evolution-adapters/agent-runtime-adapter.js";
import { productionEvolutionExtensions } from "../../src/server/evolution/runtime-projection.js";
import { EvolutionActivationStore } from "../../src/server/evolution/activation-store.js";
import { ProviderRegistry } from "../../src/server/providers/provider-registry.js";

describe("Plugin Evolution in a real Pi session", () => {
  it("mounts and executes a production Plugin, then rebuilds the same thread and unloads it after rollback", async () => {
    const previousSandbox = process.env.AUTOAGENT_EVOLUTION_PLUGIN_SANDBOX_PROGRAM;
    delete process.env.AUTOAGENT_EVOLUTION_PLUGIN_SANDBOX_PROGRAM;
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-plugin-pi-"));
    await mkdir(path.join(root, "docs"), { recursive: true });
    await writeFile(path.join(root, "docs", "release.md"), "verified release evidence", "utf8");
    await appendEvidence(root);
    const candidates = new EvolutionStore("workspace-a", root, fixedNow);
    const proposed = await candidates.create({
      commandId: "plugin-runtime-candidate", kind: "plugin", target: "release_review", title: "Release review plugin",
      rationale: "Repeated release reviews need deterministic evidence extraction.",
      hypothesis: "The executable plugin will improve success while preserving safety and latency.", artifactContent: bundle(),
      sourceRefs: [{ kind: "evidence", ref: "source-evidence", workspaceId: "workspace-a" }],
      scope: { workspaceId: "workspace-a", roles: ["dev"], tools: ["readFile"] },
      expectedMetrics: [{ metric: "task_success_rate", direction: "increase", minimumDelta: 0 }], riskLevel: "critical",
      proposedBy: { type: "agent", id: "plugin-author" },
    });
    const candidate = await candidates.validate({ commandId: "plugin-runtime-validate", candidateId: proposed.candidateId, expectedContentHash: proposed.contentHash });
    const suiteRef = { id: "plugin-runtime-suite", version: "1", contentHash: "suite-hash" };
    await candidates.markReadyForEvaluation({ commandId: "plugin-runtime-bind", candidateId: candidate.candidateId, expectedContentHash: candidate.contentHash, suiteRef });
    const evaluations = new EvolutionEvaluationStore("workspace-a", root, candidates, fixedNow);
    const evaluation = await evaluations.recordEvaluation({
      commandId: "plugin-runtime-evaluation", candidateId: candidate.candidateId, expectedContentHash: candidate.contentHash,
      suiteRef, baselineRef: { id: "plugin-baseline", version: "1", contentHash: "baseline-hash" }, runtimeSnapshotRef: "runtime-v1",
      caseResults: evaluationCases(), evaluatorPrincipal: { type: "system", id: "independent-evaluator" }, grader: { id: "plugin-gate", version: "1", type: "deterministic" },
    });
    const policyRef = { id: "plugin-policy", version: "1", contentHash: "policy-hash" };
    const shadow = await evaluations.promote({ commandId: "plugin-runtime-shadow", candidateId: candidate.candidateId, evaluationId: evaluation.evaluationId, expectedContentHash: candidate.contentHash, stage: "shadow", approvedBy: { type: "human", id: "owner" }, policyRef });
    const canary = await evaluations.promote({ commandId: "plugin-runtime-canary", candidateId: candidate.candidateId, evaluationId: evaluation.evaluationId, expectedContentHash: candidate.contentHash, stage: "canary", fromPromotionId: shadow.promotionId, rolloutPercent: 25, approvedBy: { type: "human", id: "owner" }, policyRef });
    const telemetry = await new EvolutionTelemetryStore("workspace-a", root, candidates, evaluations, fixedNow).record({
      commandId: "plugin-runtime-telemetry", promotionId: canary.promotionId, recorder: { type: "system", id: "telemetry-monitor" },
      startedAt: "2026-08-14T00:00:00.000Z", endedAt: "2026-08-14T00:05:00.000Z",
      samples: Array.from({ length: 5 }, (_, index) => ({
        sampleId: `sample-${index}`, baseline: observation(), release: observation(),
        evidenceRefs: [{ kind: "evidence" as const, ref: `telemetry-${index}`, workspaceId: "workspace-a" }],
      })),
    });
    const production = await evaluations.promote({
      commandId: "plugin-runtime-production", candidateId: candidate.candidateId, evaluationId: evaluation.evaluationId,
      expectedContentHash: candidate.contentHash, stage: "production", fromPromotionId: canary.promotionId, telemetryId: telemetry.telemetryId,
      approvedBy: { type: "human", id: "owner" }, policyRef,
    });
    const activationStore = new EvolutionActivationStore(root, fixedNow);
    expect((await activationStore.list()).find((item) => item.promotionId === production.promotionId)).toMatchObject({
      status: "waiting_for_activation", boundary: "next_session", proofCount: 0,
    });

    const profile = runtimeProfile();
    const agent = runtimeAgent();
    expect(await productionEvolutionExtensions(root, "workspace-a", profile, agent, { tools: ["readFile"] })).toHaveLength(1);
    const store = new AgentStore(root, agent.id);
    const engine = new AgentEngine(store);
    const thread = await engine.ensureThread({ agentId: agent.id, scopeId: "plugin-runtime", idempotencyKey: "plugin-runtime" });
    const policy = { profile: "development" as const, workspaceRoot: root, canReadWorkspace: true, canWriteWorkspace: false, canExecuteCommands: false, allowHostAccess: false, enabledTools: ["readFile" as const] };
    const providers = new ProviderRegistry({ homeDir: path.join(root, ".provider-home"), retryCount: 0 });
    const toolName = pluginToolName("release_review", "summarize");
    const toolSets: string[][] = [];
    const histories: unknown[][] = [];
    providers.runModelTurnWithRetry = async (input) => {
      toolSets.push(input.tools.map((tool) => tool.name));
      histories.push(input.history);
      if (input.tools.some((tool) => tool.name === toolName) && !input.history.some((item) => item.type === "tool_result" && item.callId === "plugin-call")) {
        return { items: [{ type: "tool_call", callId: "plugin-call", name: toolName, arguments: { path: "docs/release.md" } }], usage: { totalTokens: 1 } };
      }
      return { items: [{ type: "assistant_message", content: "Plugin lifecycle observed." }], usage: { totalTokens: 1 } };
    };
    const runtime = new PiAgentRuntime(root, engine, store, new AgentContextAssembler(store), providers, new AgentToolRuntime(policy, ["readFile"]), new AgentTraceStore(root, agent.id), { now: fixedNow, turnTimeoutMs: 10_000, turnInactivityTimeoutMs: 10_000, evolution: new EvolutionAgentRuntimeAdapter(root, agent.workspaceId, { now: fixedNow }) });
    try {
      const firstMessage = "plugin-message-1";
      await engine.sendMessage({ messageId: firstMessage, turnId: "plugin-turn-1", threadId: thread.threadId, senderPrincipalId: "human", content: "Use the release review plugin.", createdAt: fixedNow().toISOString() });
      expect((await runtime.runSlice({ threadId: thread.threadId, turnId: "plugin-turn-1", triggerMessageId: firstMessage, profile, agent, policy, provider: "mock", model: "mock" })).status).toBe("waiting");
      expect(toolSets).toEqual(expect.arrayContaining([expect.arrayContaining([toolName])]));
      const firstSnapshot = await engine.getThread(thread.threadId);
      const payloads = await store.payloads(firstSnapshot.items.map((item) => item.payloadRef));
      const pluginResults = firstSnapshot.items.map((item) => payloads.get(item.payloadRef)).filter((item) => typeof item === "object" && item !== null && "type" in item && item.type === "tool_result");
      expect(pluginResults).toEqual(expect.arrayContaining([expect.objectContaining({ content: expect.stringContaining("verified release evidence") })]));
      const activated = (await activationStore.list()).find((item) => item.promotionId === production.promotionId);
      expect(activated).toMatchObject({ status: "activated", boundary: "next_session", proofCount: 1 });
      expect(await activationStore.listProofs(activated!.activationId)).toEqual([
        expect.objectContaining({ runtimeKind: "session", runtimeRef: expect.any(String), releaseRef: production.toRelease }),
      ]);

      await evaluations.rollback("plugin-runtime-rollback", production.promotionId, { type: "human", id: "owner" });
      expect((await activationStore.list()).find((item) => item.promotionId === production.promotionId)?.status).toBe("rolled_back");
      const secondMessage = "plugin-message-2";
      await engine.sendMessage({ messageId: secondMessage, turnId: "plugin-turn-2", threadId: thread.threadId, senderPrincipalId: "human", content: "Check extension availability again.", createdAt: "2026-08-14T00:11:00.000Z" });
      const before = toolSets.length;
      expect((await runtime.runSlice({ threadId: thread.threadId, turnId: "plugin-turn-2", triggerMessageId: secondMessage, profile, agent, policy, provider: "mock", model: "mock" })).status).toBe("waiting");
      expect(toolSets.slice(before).every((names) => !names.includes(toolName))).toBe(true);
    } finally {
      await runtime.dispose();
      if (previousSandbox === undefined) delete process.env.AUTOAGENT_EVOLUTION_PLUGIN_SANDBOX_PROGRAM;
      else process.env.AUTOAGENT_EVOLUTION_PLUGIN_SANDBOX_PROGRAM = previousSandbox;
    }
  });
});

function bundle(): string {
  return JSON.stringify({ schemaVersion: 1, manifest: {
    id: "release_review", version: "1.0.0", kind: "plugin", apiVersion: "autoagent.plugin/v1", entrypoint: "index.mjs",
    description: "Read one allowlisted release file and return its verified content.", permissions: { workspaceRead: ["docs/**"] },
    contributions: { tools: [{ name: "summarize", description: "Read and summarize release evidence.", inputSchema: { type: "object", additionalProperties: false, properties: { path: { type: "string" } }, required: ["path"] } }], guardrails: [] },
    lifecycle: { activation: "onDemand", invokeTimeoutMs: 2_000 },
  }, files: [{ path: "index.mjs", content: "export default { async health(){return {ok:true}}, async invokeTool({input,context}) { const result = await context.requestCapability('workspace.read',{path:input.path}); return {content:result.content,evidenceId:result.evidenceId}; } };\n" }] });
}
async function appendEvidence(root: string): Promise<void> {
  const ledger = new EvidenceLedger(root);
  for (const id of ["source-evidence", "eval-evidence", ...Array.from({ length: 5 }, (_, index) => `telemetry-${index}`)]) await ledger.append({
    evidenceId: id, agentId: "fixture", threadId: "fixture-thread", goalId: "fixture-goal", turnId: `turn-${id}`,
    toolCallId: `call-${id}`, toolName: "fixture", kind: "tool", capture: { status: "recorded" }, observation: { status: "observed", result: {} },
    workspaceRoot: root, createdAt: "2026-08-14T00:00:00.000Z", input: {},
  });
}
function evaluationCases(): EvaluationCaseResult[] {
  const value = observation();
  const evidenceRefs = [{ kind: "evidence" as const, ref: "eval-evidence", workspaceId: "workspace-a" }];
  return [
    { caseId: "target", group: "target", baseline: { ...value, success: false, qualityScore: 0 }, candidate: value, evidenceRefs },
    { caseId: "regression", group: "regression", baseline: value, candidate: value, evidenceRefs },
    { caseId: "safety", group: "safety", baseline: value, candidate: value, evidenceRefs },
  ];
}
function observation() { return { success: true, qualityScore: 1, costUsd: 0.01, costMeasured: true, latencyMs: 10, toolFailures: 0, policyViolations: 0, safetyViolations: 0 }; }
function runtimeProfile(): AgentProfile { return { id: "profile-dev", name: "Dev", role: "dev", capabilities: [], defaultProvider: "mock", defaultModel: "mock", defaultPolicy: {} }; }
function runtimeAgent(): WorkspaceAgent { return { id: "agent-dev", workspaceId: "workspace-a", profileId: "profile-dev", roleInWorkspace: "dev", agentDir: "agents/dev", status: "idle" }; }
function fixedNow(): Date { return new Date("2026-08-14T00:10:00.000Z"); }
