import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EvidenceLedger } from "../../src/server/agent-engine/evidence-ledger.js";
import { AgentEngine } from "../../src/server/agent-engine/agent-engine.js";
import { AgentStore } from "../../src/server/agent-engine/agent-store.js";
import { AgentContextAssembler } from "../../src/server/agent-engine/context-assembler.js";
import { PiAgentRuntime } from "../../src/server/agent-engine/pi-runtime.js";
import { AgentToolRuntime } from "../../src/server/agent-engine/tool-runtime.js";
import { AgentTraceStore } from "../../src/server/agent-engine/trace-store.js";
import { EvolutionEvaluationStore } from "../../src/server/evolution/evaluation-store.js";
import { EvolutionStore } from "../../src/server/evolution/evolution-store.js";
import { resolveOrganizationMemoryConflicts, runtimeEvolutionProjection } from "../../src/server/evolution/runtime-projection.js";
import { EvolutionTelemetryStore } from "../../src/server/evolution/telemetry-store.js";
import { resolveOrganizationMemorySources } from "../../src/server/runtime/runtime-host-registry.js";
import { WorkspaceStore } from "../../src/server/storage/workspace-store.js";
import { ProviderRegistry } from "../../src/server/providers/provider-registry.js";
import type { AgentProfile, WorkspaceAgent } from "../../src/shared/types.js";

describe("organization Memory governance", () => {
  it("fails closed when trusted organization sources disagree on the same Memory target", () => {
    const first = { target: "release-rule", content: "A", releaseId: "release-a", releaseVersion: "1", contentHash: "hash-a", generation: 1, stage: "production" as const, ownerLevel: "company" as const, sourceWorkspaceId: "source-a", layer: "organization" as const };
    const second = { target: "release-rule", content: "B", releaseId: "release-b", releaseVersion: "1", contentHash: "hash-b", generation: 1, stage: "production" as const, ownerLevel: "company" as const, sourceWorkspaceId: "source-b", layer: "organization" as const };
    expect(resolveOrganizationMemoryConflicts([first, second])).toEqual({ memories: [], conflicts: ["release-rule"] });
  });

  it("requires bilateral scope/trust and stops injection immediately after target revocation", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "autoagent-org-memory-home-"));
    const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "autoagent-org-memory-source-"));
    const targetRoot = await mkdtemp(path.join(os.tmpdir(), "autoagent-org-memory-target-"));
    const workspaces = new WorkspaceStore(home);
    const source = await workspaces.create({ name: "Source", rootPath: sourceRoot, policyProfile: "development" });
    const target = await workspaces.create({ name: "Target", rootPath: targetRoot, policyProfile: "development" });
    await workspaces.configureOrganizationMemory(source.id, { id: "org-a", trustedMemoryWorkspaceIds: [] });
    await workspaces.configureOrganizationMemory(target.id, { id: "org-a", trustedMemoryWorkspaceIds: [source.id] });

    const now = () => new Date("2026-08-14T06:00:00.000Z");
    const ledger = new EvidenceLedger(sourceRoot);
    await appendEvidence(ledger, "org-source-evidence", source.id, sourceRoot);
    const candidates = new EvolutionStore(source.id, sourceRoot, now, {
      organizationId: "org-a", organizationWorkspaceIds: [source.id, target.id],
    });
    const proposed = await candidates.create({
      commandId: "org-memory-propose", kind: "memory", target: "organization.release-governance",
      title: "Organization release governance", rationale: "Repeated releases need a stable organization-wide evidence rule.",
      hypothesis: "Reusing the rule improves task success without increasing policy or safety violations.",
      artifactContent: "# Organization release governance\n\nBefore accepting a release, verify its immutable evidence and rollback pointer. Apply only inside the explicitly authorized organization scope.",
      sourceRefs: [{ kind: "evidence", ref: "org-source-evidence", workspaceId: source.id }],
      scope: { workspaceId: source.id, organization: { id: "org-a", workspaceIds: [target.id] }, roles: ["dev"] },
      expectedMetrics: [{ metric: "task_success_rate", direction: "increase", minimumDelta: 0.1 }],
      riskLevel: "high", proposedBy: { type: "human", id: "organization-governor" },
    });
    const validated = await candidates.validate({ commandId: "org-memory-validate", candidateId: proposed.candidateId, expectedContentHash: proposed.contentHash });
    const candidate = await candidates.markReadyForEvaluation({ commandId: "org-memory-bind-suite", candidateId: validated.candidateId, expectedContentHash: validated.contentHash, suiteRef: { id: "org-suite", version: "1", contentHash: "org-suite-hash" } });
    const evaluations = new EvolutionEvaluationStore(source.id, sourceRoot, candidates, now);
    const observation = { success: true, qualityScore: 1, costUsd: 1, costMeasured: true, latencyMs: 10, toolFailures: 0, policyViolations: 0, safetyViolations: 0 };
    const evaluation = await evaluations.recordEvaluation({
      commandId: "org-memory-evaluate", candidateId: candidate.candidateId, expectedContentHash: candidate.contentHash,
      suiteRef: { id: "org-suite", version: "1", contentHash: "org-suite-hash" },
      baselineRef: { id: "baseline", version: "1", contentHash: "baseline-hash" }, runtimeSnapshotRef: "runtime-snapshot",
      caseResults: (["target", "regression", "safety"] as const).map((group) => ({
        caseId: group, group, baseline: { ...observation, success: group !== "target", qualityScore: group === "target" ? 0 : 1 },
        candidate: observation, evidenceRefs: [{ kind: "evidence" as const, ref: "org-source-evidence", workspaceId: source.id }],
      })),
      evaluatorPrincipal: { type: "system", id: "independent-evaluator" }, grader: { id: "deterministic", version: "1", type: "deterministic" },
    });
    const approvedBy = { type: "human" as const, id: "organization-governor" };
    const policyRef = { id: "organization-evolution-policy", version: "1", contentHash: "policy-hash" };
    const shadow = await evaluations.promote({ commandId: "org-shadow", candidateId: candidate.candidateId, evaluationId: evaluation.evaluationId, expectedContentHash: candidate.contentHash, stage: "shadow", approvedBy, policyRef });
    const canary = await evaluations.promote({ commandId: "org-canary", candidateId: candidate.candidateId, evaluationId: evaluation.evaluationId, expectedContentHash: candidate.contentHash, stage: "canary", fromPromotionId: shadow.promotionId, approvedBy, policyRef });
    for (let index = 0; index < 5; index += 1) await appendEvidence(ledger, `org-telemetry-${index}`, source.id, sourceRoot);
    const telemetry = await new EvolutionTelemetryStore(source.id, sourceRoot, candidates, evaluations, now).record({
      commandId: "org-telemetry", promotionId: canary.promotionId, recorder: { type: "system", id: "canary-monitor" },
      startedAt: "2026-08-14T05:00:00.000Z", endedAt: "2026-08-14T05:30:00.000Z",
      samples: Array.from({ length: 5 }, (_, index) => ({ sampleId: `sample-${index}`, baseline: { ...observation, success: false, qualityScore: 0 }, release: observation, evidenceRefs: [{ kind: "evidence" as const, ref: `org-telemetry-${index}`, workspaceId: source.id }] })),
    });
    await evaluations.promote({ commandId: "org-production", candidateId: candidate.candidateId, evaluationId: evaluation.evaluationId, expectedContentHash: candidate.contentHash, stage: "production", fromPromotionId: canary.promotionId, telemetryId: telemetry.telemetryId, approvedBy, policyRef });

    const trusted = await projection(targetRoot, target.id, await resolveOrganizationMemorySources(workspaces, target.id));
    expect(trusted.memories).toEqual([expect.objectContaining({ target: candidate.target, contentHash: candidate.contentHash, sourceWorkspaceId: source.id, layer: "organization" })]);
    expect(trusted.organizationConflicts).toEqual([]);

    const session = await createTargetSession(targetRoot, target.id, workspaces);
    await session.turn("before-revocation");
    expect(await session.latestEvolutionMemories()).toEqual([expect.objectContaining({ target: candidate.target, contentHash: candidate.contentHash })]);
    await workspaces.configureOrganizationMemory(target.id, undefined);
    await session.turn("after-revocation");
    expect(await session.latestEvolutionMemories()).toEqual([]);
    await session.dispose();
    const revoked = await projection(targetRoot, target.id, await resolveOrganizationMemorySources(workspaces, target.id));
    expect(revoked.memories).toEqual([]);
  });
});

async function projection(root: string, workspaceId: string, organizationMemorySources: Awaited<ReturnType<typeof resolveOrganizationMemorySources>>) {
  return runtimeEvolutionProjection(root, workspaceId, profile(), agent(workspaceId), { assignmentKey: "thread:goal", tools: [], organizationMemorySources });
}
async function appendEvidence(ledger: EvidenceLedger, evidenceId: string, workspaceId: string, root: string) {
  await ledger.append({ evidenceId, agentId: "agent", threadId: "thread", goalId: "goal", turnId: evidenceId, toolCallId: evidenceId, toolName: "fixture", kind: "tool", capture: { status: "recorded" }, observation: { status: "observed", result: { workspaceId } }, workspaceRoot: root, createdAt: "2026-08-14T05:00:00.000Z", input: {} });
}
async function createTargetSession(root: string, workspaceId: string, workspaces: WorkspaceStore) {
  const runtimeAgent = agent(workspaceId);
  const store = new AgentStore(root, runtimeAgent.id);
  const engine = new AgentEngine(store);
  const thread = await engine.ensureThread({ agentId: runtimeAgent.id, scopeId: "organization-memory-session", idempotencyKey: "organization-memory-session" });
  const traces = new AgentTraceStore(root, runtimeAgent.id);
  const providers = new ProviderRegistry({ homeDir: path.join(root, ".provider-home"), retryCount: 0 });
  const policy = { profile: "development" as const, workspaceRoot: root, canReadWorkspace: true, canWriteWorkspace: false, canExecuteCommands: false, allowHostAccess: false, enabledTools: [] };
  const runtime = new PiAgentRuntime(root, engine, store, new AgentContextAssembler(store), providers, new AgentToolRuntime(policy, []), traces, {
    now: () => new Date("2026-08-14T06:00:00.000Z"),
    organizationMemorySources: () => resolveOrganizationMemorySources(workspaces, workspaceId),
  });
  let sequence = 0;
  let latestTurnId = "";
  return {
    async turn(label: string) {
      sequence += 1;
      const messageId = `message-${label}`;
      const turnId = `turn-${label}`;
      latestTurnId = turnId;
      await engine.sendMessage({ messageId, turnId, threadId: thread.threadId, senderPrincipalId: "human", content: label, createdAt: `2026-08-14T06:0${sequence}:00.000Z` });
      await runtime.runSlice({ threadId: thread.threadId, turnId, triggerMessageId: messageId, profile: profile(), agent: runtimeAgent, policy, provider: "mock", model: "mock" });
    },
    latestEvolutionMemories() {
      return traces.list(thread.threadId).then((records) => {
        const contexts = records.filter((trace) => trace.turnId === latestTurnId && trace.kind === "context" && trace.data && typeof trace.data === "object" && "evolutionMemories" in trace.data);
        return ((contexts.at(-1)?.data as { evolutionMemories?: unknown[] } | undefined)?.evolutionMemories ?? []);
      });
    },
    dispose: () => runtime.dispose(),
  };
}
function profile(): AgentProfile { return { id: "profile", name: "Developer", role: "dev", capabilities: [], defaultProvider: "mock", defaultModel: "mock", defaultPolicy: { canReadWorkspace: true, canWriteWorkspace: false, canExecuteCommands: false } }; }
function agent(workspaceId: string): WorkspaceAgent { return { id: "agent", workspaceId, profileId: "profile", roleInWorkspace: "dev", status: "idle", agentDir: "agent" }; }
