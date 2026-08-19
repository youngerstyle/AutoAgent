import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WorkspaceStore } from "../../src/server/storage/workspace-store.js";
import { EvolutionCoordinator } from "../../src/server/evolution/evolution-coordinator.js";
import { ExtractionJobStore } from "../../src/server/evolution/extraction-job-store.js";
import { EvolutionStore } from "../../src/server/evolution/evolution-store.js";
import { PlatformEvolutionSourceVerifier, platformEvolutionStore } from "../../src/server/evolution-adapters/platform-source-verifier.js";
import { EvolutionEvalSuiteStore } from "../../src/server/evolution/eval-suite-store.js";
import { EvaluationJobStore } from "../../src/server/evolution/evaluation-job-store.js";
import { EvidenceLedger } from "../../src/server/agent-engine/evidence-ledger.js";
import { EvolutionEvaluationStore } from "../../src/server/evolution/evaluation-store.js";
import { EvolutionTelemetryStore } from "../../src/server/evolution/telemetry-store.js";
import { PracticeDraftStore } from "../../src/server/evolution/practice-draft-store.js";
import { EvolutionPhaseJobStore } from "../../src/server/evolution/phase-job-store.js";

describe("EvolutionCoordinator", () => {
  it("maintains idle workspaces and consumes server-configured sandbox evaluation jobs", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "autoagent-evolution-coordinator-home-"));
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-evolution-coordinator-workspace-"));
    const workspaces = new WorkspaceStore(home);
    const workspace = await workspaces.create({ name: "Idle workspace", rootPath: root, policyProfile: "development" });
    const now = () => new Date("2026-08-14T03:00:00.000Z");
    const candidates = platformEvolutionStore(workspace.id, root, now);
    await new EvidenceLedger(root).append({
      evidenceId: "source-evidence", agentId: "proposer", threadId: "source-thread", goalId: "source-goal", turnId: "source-turn",
      toolCallId: "source-call", toolName: "fixture", kind: "tool", capture: { status: "recorded" },
      observation: { status: "observed", result: { repeatedFailure: true } }, input: {}, workspaceRoot: root, createdAt: now().toISOString(),
    });
    const proposed = await candidates.create({
      commandId: "coordinator-candidate", kind: "skill", target: "evidence-review", title: "Evidence review",
      rationale: "Repeated reviews omitted authoritative evidence.",
      hypothesis: "The Skill increases task success without safety regression.",
      artifactContent: "---\nname: evidence-review\ndescription: Review delivery evidence before accepting work.\n---\n# Evidence review\n\nCheck authoritative evidence and report unresolved risks.\n",
      sourceRefs: [{ kind: "evidence", ref: "source-evidence", workspaceId: workspace.id }],
      scope: { workspaceId: workspace.id },
      expectedMetrics: [{ metric: "task_success_rate", direction: "increase", minimumDelta: 0.1 }],
      riskLevel: "medium", proposedBy: { type: "agent", id: "proposer" },
    });
    const inputRef = { kind: "evidence" as const, ref: "sealed-eval-input", workspaceId: workspace.id };
    await new EvidenceLedger(root).append({
      evidenceId: inputRef.ref, agentId: "agent-a", threadId: "thread-a", goalId: "goal-a", turnId: "turn-a",
      toolCallId: "tool-a", toolName: "fixture", kind: "tool", capture: { status: "recorded" },
      observation: { status: "observed", result: { expected: "safe" } }, input: { task: "evaluate" },
      workspaceRoot: root, createdAt: now().toISOString(),
    });
    const suite = await new EvolutionEvalSuiteStore(workspace.id, root, now).create({
      id: "coordinator-suite", version: "1", title: "Coordinator suite",
      cases: [
        { caseId: "target", group: "target", partition: "historical", inputRef, assertions: ["task succeeds"] },
        { caseId: "regression", group: "regression", partition: "sealed_holdout", inputRef, assertions: ["quality is preserved"] },
        { caseId: "safety", group: "safety", partition: "sealed_holdout", inputRef, assertions: ["sandbox denies network"] },
      ],
      automation: {
        kinds: ["skill"], targets: ["evidence-review"],
        baselineRef: { id: "baseline", version: "1", contentHash: "baseline-hash" },
        runtimeSnapshotRef: "runtime-snapshot",
        policyRef: { id: "automation-policy", version: "1", contentHash: "policy-hash" },
      },
    });
    const evaluationJobs = new EvaluationJobStore(workspace.id, root, now);
    const program = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "evolution-eval-worker.mjs");
    const coordinator = new EvolutionCoordinator(workspaces, {
      sourceVerificationPort: (item) => new PlatformEvolutionSourceVerifier(item.id, item.rootPath),
      evaluatorProgramPath: program, now, maintenanceIntervalMs: 10_000, workerId: "coordinator-test",
    });

    await coordinator.runOnce();

    expect(await new ExtractionJobStore(workspace.id, root, now).list()).toEqual([
      expect.objectContaining({ status: "succeeded", attempts: 1 }),
    ]);
    expect(await evaluationJobs.list()).toEqual([
      expect.objectContaining({ status: "succeeded", attempts: 1, result: { decision: "pass", evaluationId: expect.any(String) } }),
    ]);
    expect(await candidates.get(proposed.candidateId)).toMatchObject({ status: "ready_for_eval", evaluationSuiteRefs: [suite.suiteRef] });
    const ready = await candidates.get(proposed.candidateId);
    expect(await new EvolutionEvaluationStore(workspace.id, root, candidates, now).listPromotions()).toEqual([
      expect.objectContaining({ candidateId: ready.candidateId, stage: "shadow", status: "active", approvedBy: { type: "system", id: "evolution-coordinator/v1" } }),
    ]);
    expect(coordinator.status()).toMatchObject({
      running: false, evaluatorConfigured: true, workspacesScanned: 1, reflectionSignalsProcessed: 0, dreamPracticesProduced: 0, practiceBindingsCreated: 0, scopePromotionArtifactsCreated: 0, evaluationJobsProcessed: 1, promotionTransitionsProcessed: 1,
    });
    expect(coordinator.status().releaseBlockers).toEqual([
      expect.objectContaining({ candidateId: ready.candidateId, code: "approval_required", status: "ready_for_eval" }),
    ]);
    expect(coordinator.status()).not.toHaveProperty("lastError");
  });

  it("coalesces overlapping passes and reports evaluator availability without requiring an active RuntimeHost", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "autoagent-evolution-coordinator-empty-"));
    const coordinator = new EvolutionCoordinator(new WorkspaceStore(home), { now: () => new Date("2026-08-14T04:00:00.000Z") });
    const first = coordinator.runOnce();
    const second = coordinator.runOnce();
    expect(second).toBe(first);
    await first;
    expect(coordinator.status()).toMatchObject({ evaluatorConfigured: false, evaluationMode: "unavailable", releaseBlockers: [], workspacesScanned: 0, reflectionSignalsProcessed: 0, dreamPracticesProduced: 0, practiceBindingsCreated: 0, scopePromotionArtifactsCreated: 0, evaluationJobsProcessed: 0, promotionTransitionsProcessed: 0 });
  });

  it("autonomously advances a low-risk Memory through evaluation, canary, measured telemetry, and production", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "autoagent-evolution-memory-home-"));
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-evolution-memory-workspace-"));
    const workspaces = new WorkspaceStore(home);
    const workspace = await workspaces.create({ name: "Learning workspace", rootPath: root, policyProfile: "development" });
    const now = () => new Date("2026-08-14T07:00:00.000Z");
    const ledger = new EvidenceLedger(root);
    await appendEvidence(ledger, "memory-source", root);
    await appendEvidence(ledger, "memory-eval-input", root);
    const candidates = platformEvolutionStore(workspace.id, root, now);
    const candidate = await candidates.create({
      commandId: "automatic-memory", kind: "memory", target: "experience.release.verification", title: "Verify release evidence",
      rationale: "Repeated releases omitted immutable evidence verification.", hypothesis: "The scoped lesson improves task success without safety regression.",
      artifactContent: "# Scoped release verification\n\nCheck immutable evidence, scope, active pointer, and rollback provenance before accepting a release. Apply only in this workspace.",
      sourceRefs: [{ kind: "evidence", ref: "memory-source", workspaceId: workspace.id }], scope: { workspaceId: workspace.id },
      expectedMetrics: [{ metric: "task_success_rate", direction: "increase", minimumDelta: 0.1 }], riskLevel: "low",
      proposedBy: { type: "system", id: "memory-consolidator/v1" },
    });
    const inputRef = { kind: "evidence" as const, ref: "memory-eval-input", workspaceId: workspace.id };
    await new EvolutionEvalSuiteStore(workspace.id, root, now).create({
      id: "automatic-memory-suite", version: "1", title: "Automatic Memory gate",
      cases: [
        { caseId: "target", group: "target", partition: "historical", inputRef, assertions: ["task succeeds"] },
        { caseId: "regression", group: "regression", partition: "sealed_holdout", inputRef, assertions: ["quality is preserved"] },
        { caseId: "safety", group: "safety", partition: "sealed_holdout", inputRef, assertions: ["sandbox denies network"] },
      ],
      automation: {
        kinds: ["memory"], targets: [candidate.target], baselineRef: { id: "baseline", version: "1", contentHash: "baseline-hash" },
        runtimeSnapshotRef: "runtime-snapshot", policyRef: { id: "memory-policy", version: "1", contentHash: "policy-hash" },
        autoPromoteLowRiskMemory: true,
      },
    });
    const program = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "evolution-eval-worker.mjs");
    const coordinator = new EvolutionCoordinator(workspaces, {
      evaluatorProgramPath: program, now, maintenanceIntervalMs: 10_000, workerId: "memory-test",
      sourceVerificationPort: (item) => new PlatformEvolutionSourceVerifier(item.id, item.rootPath),
    });
    await coordinator.runOnce();
    const evaluations = new EvolutionEvaluationStore(workspace.id, root, candidates, now);
    const canary = (await evaluations.listPromotions()).find((item) => item.stage === "canary")!;
    expect(canary).toMatchObject({ status: "active", approvedBy: { type: "system", id: "evolution-coordinator/v1" } });
    expect((await evaluations.listPromotions()).some((item) => item.stage === "production")).toBe(false);

    const measured = { success: true, qualityScore: 1, costUsd: 0.01, costMeasured: true, latencyMs: 10, toolFailures: 0, policyViolations: 0, safetyViolations: 0 };
    for (let index = 0; index < 5; index += 1) await appendEvidence(ledger, `memory-telemetry-${index}`, root);
    await new EvolutionTelemetryStore(workspace.id, root, candidates, evaluations, now).record({
      commandId: "measured-memory-telemetry", promotionId: canary.promotionId, recorder: { type: "system", id: "cost-aware-monitor" },
      startedAt: "2026-08-14T06:00:00.000Z", endedAt: "2026-08-14T06:30:00.000Z",
      samples: Array.from({ length: 5 }, (_, index) => ({ sampleId: `memory-sample-${index}`, baseline: { ...measured, success: false, qualityScore: 0 }, release: measured, evidenceRefs: [{ kind: "evidence" as const, ref: `memory-telemetry-${index}`, workspaceId: workspace.id }] })),
    });
    await coordinator.runOnce();
    expect((await evaluations.listPromotions()).find((item) => item.stage === "production")).toMatchObject({
      status: "active", candidateId: candidate.candidateId, approvedBy: { type: "system", id: "evolution-coordinator/v1" },
    });
  });

  it("defers sub-threshold Dream work while busy and admits it through a configured maintenance window", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "autoagent-evolution-schedule-home-"));
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-evolution-schedule-workspace-"));
    const workspaces = new WorkspaceStore(home); const workspace = await workspaces.create({ name: "Busy workspace", rootPath: root, policyProfile: "development" });
    const now = () => new Date("2026-08-14T03:00:00.000Z");
    await new PracticeDraftStore(workspace.id, root, now).create({
      commandId: "single-draft", signalId: "signal-a", statement: "Brief the authoritative document", trigger: "Multi-agent execution starts",
      procedure: "Brief, acknowledge, then execute", expectedOutcome: [{ metric: "task_success_rate", direction: "increase", minimumDelta: 0.01 }],
      observedComponents: ["workflow"], applicability: { ownerLevel: "agent_project", workspaceId: workspace.id, profileId: "profile-a" }, contraindications: [],
      sourceEpisodeRefs: ["episode-a"], sourceRefs: [{ kind: "evidence", ref: "evidence-a", workspaceId: workspace.id, profileId: "profile-a" }],
    });
    await new EvolutionCoordinator(workspaces, { now, maintenanceIntervalMs: 10_000, isWorkspaceIdle: () => false }).runOnce();
    expect(await new EvolutionPhaseJobStore(workspace.id, root, now).list()).toEqual([]);
    await new EvolutionCoordinator(workspaces, { now, maintenanceIntervalMs: 10_000, isWorkspaceIdle: () => false, maintenanceWindowUtc: { startHour: 3, endHour: 4 } }).runOnce();
    // A later pass in the same maintenance bucket must replay the durable
    // consolidation command instead of failing on a changed wall-clock input.
    await new EvolutionCoordinator(workspaces, { now, maintenanceIntervalMs: 10_000, isWorkspaceIdle: () => false, maintenanceWindowUtc: { startHour: 3, endHour: 4 } }).runOnce();
    expect(await new EvolutionPhaseJobStore(workspace.id, root, now).list()).toEqual([expect.objectContaining({ kind: "consolidation", scheduleReason: "maintenance", status: "succeeded" })]);
  });
});

async function appendEvidence(ledger: EvidenceLedger, evidenceId: string, root: string) {
  await ledger.append({ evidenceId, agentId: "fixture", threadId: "thread", goalId: "goal", turnId: evidenceId, toolCallId: evidenceId, toolName: "fixture", kind: "tool", capture: { status: "recorded" }, observation: { status: "observed", result: {} }, input: {}, workspaceRoot: root, createdAt: "2026-08-14T06:00:00.000Z" });
}
