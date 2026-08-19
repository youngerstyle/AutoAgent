import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { EvaluationCaseResult, EvolutionCandidate, PromotionRecord, RecordEvaluationInput } from "../../src/shared/contracts/evolution.js";
import { EvolutionStore } from "../../src/server/evolution/evolution-store.js";
import { EvolutionEvaluationStore } from "../../src/server/evolution/evaluation-store.js";
import { EvidenceLedger } from "../../src/server/agent-engine/evidence-ledger.js";
import { EvolutionEvalSuiteStore } from "../../src/server/evolution/eval-suite-store.js";
import { EvolutionEvaluationRunner } from "../../src/server/evolution/evaluation-runner.js";
import { EvaluationJobStore } from "../../src/server/evolution/evaluation-job-store.js";
import { EvaluationJobRunner } from "../../src/server/evolution/evaluation-job-runner.js";
import { EvolutionTelemetryStore } from "../../src/server/evolution/telemetry-store.js";
import { EvolutionReleaseRegistry } from "../../src/server/evolution/release-registry.js";
import { isCanaryAssignment, productionEvolutionSkills, runtimeEvolutionProjection } from "../../src/server/evolution/runtime-projection.js";
import type { AgentProfile, Workspace, WorkspaceAgent } from "../../src/shared/types.js";
import { AgentStore } from "../../src/server/agent-engine/agent-store.js";
import { AgentEngine } from "../../src/server/agent-engine/agent-engine.js";
import { AgentContextAssembler } from "../../src/server/agent-engine/context-assembler.js";
import { PiAgentRuntime } from "../../src/server/agent-engine/pi-runtime.js";
import { ProviderRegistry } from "../../src/server/providers/provider-registry.js";
import { AgentToolRuntime } from "../../src/server/agent-engine/tool-runtime.js";
import { AgentTraceStore } from "../../src/server/agent-engine/trace-store.js";
import { ExperienceStore } from "../../src/server/evolution/experience-store.js";
import { CanaryTelemetryReconciler } from "../../src/server/evolution/canary-telemetry-reconciler.js";
import { ensureWorkspaceAgent } from "../../src/server/agents/roster.js";
import { EvolutionActivationStore } from "../../src/server/evolution/activation-store.js";
import { EvolutionAgentRuntimeAdapter } from "../../src/server/evolution-adapters/agent-runtime-adapter.js";
import { PlatformEvolutionObservationAdapter } from "../../src/server/evolution-adapters/platform-observation-adapter.js";
import { platformEvolutionStore } from "../../src/server/evolution-adapters/platform-source-verifier.js";
import { PromptConsolidator } from "../../src/server/evolution/prompt-consolidator.js";
import { MemoryConsolidator } from "../../src/server/evolution/memory-consolidator.js";
import { SkillConsolidator } from "../../src/server/evolution/skill-consolidator.js";
import { projectExperience } from "../../src/server/evolution/experience-projector.js";

describe("evolution evaluation and promotion gate", () => {
  it("requires independent evaluation and only creates a non-runtime shadow release", async () => {
    const fixture = await setup();
    const passing = await fixture.evaluations.recordEvaluation(evaluationInput(fixture.candidate.candidateId, fixture.candidate.contentHash));
    expect(passing.decision).toBe("pass");
    expect(passing.aggregateMetrics).toEqual(expect.arrayContaining([
      expect.objectContaining({ metric: "task_success_rate", passed: true }),
    ]));

    const promotion = await fixture.evaluations.promote({
      commandId: "promote-shadow-a",
      candidateId: fixture.candidate.candidateId,
      evaluationId: passing.evaluationId,
      expectedContentHash: fixture.candidate.contentHash,
      stage: "shadow",
      approvedBy: { type: "human", id: "governor-a" },
      policyRef: { id: "evolution-policy", version: "1", contentHash: "policy-hash-a" },
    });
    expect(promotion).toMatchObject({ stage: "shadow", status: "active" });
    const manifest = JSON.parse(await readFile(path.join(fixture.root, ".autoagent", "evolution", "releases", promotion.toRelease.id, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({ stage: "shadow", runtimeActive: false, candidateId: fixture.candidate.candidateId });

    await expect(fixture.evaluations.promote({
      commandId: "promote-production-a",
      candidateId: fixture.candidate.candidateId,
      evaluationId: passing.evaluationId,
      expectedContentHash: fixture.candidate.contentHash,
      stage: "production",
      approvedBy: { type: "human", id: "governor-a" },
      policyRef: { id: "evolution-policy", version: "1", contentHash: "policy-hash-a" },
    })).rejects.toMatchObject({ code: "EVOLUTION_PROMOTION_LINEAGE_REQUIRED" });

    const rolledBack = await fixture.evaluations.rollback("rollback-shadow-a", promotion.promotionId, { type: "human", id: "governor-a" });
    expect(rolledBack).toMatchObject({ status: "rolled_back" });
    expect(await fixture.evaluations.listPromotions()).toEqual([expect.objectContaining({ promotionId: promotion.promotionId, status: "rolled_back" })]);
  });

  it("advances shadow to canary and production only through lineage, telemetry, approval, and atomic pointers", async () => {
    const fixture = await setup();
    const passing = await fixture.evaluations.recordEvaluation(evaluationInput(fixture.candidate.candidateId, fixture.candidate.contentHash));
    const policyRef = { id: "evolution-policy", version: "1", contentHash: "policy-hash-a" };
    const approvedBy = { type: "human" as const, id: "governor-a" };
    const shadow = await fixture.evaluations.promote({
      commandId: "staged-shadow", candidateId: fixture.candidate.candidateId, evaluationId: passing.evaluationId,
      expectedContentHash: fixture.candidate.contentHash, stage: "shadow", approvedBy, policyRef,
    });
    expect(await productionEvolutionSkills(fixture.root, "workspace-a", runtimeProfile(), runtimeAgent())).toEqual([]);
    const canaryInput = {
      commandId: "staged-canary", candidateId: fixture.candidate.candidateId, evaluationId: passing.evaluationId,
      expectedContentHash: fixture.candidate.contentHash, stage: "canary", fromPromotionId: shadow.promotionId, approvedBy, policyRef,
    } as const;
    const [canary, concurrentReplay] = await Promise.all([
      fixture.evaluations.promote(canaryInput),
      fixture.evaluations.promote(canaryInput),
    ]);
    expect(concurrentReplay.promotionId).toBe(canary.promotionId);
    const registry = new EvolutionReleaseRegistry(fixture.root, fixedNow);
    expect(await registry.current("canary", fixture.candidate)).toMatchObject({ active: true, release: canary.toRelease, promotionId: canary.promotionId, generation: 1 });
    expect(await productionEvolutionSkills(fixture.root, "workspace-a", runtimeProfile(), runtimeAgent())).toEqual([]);
    const canaryKey = Array.from({ length: 500 }, (_, index) => `canary-assignment-${index}`).find((key) => isCanaryAssignment(canary.rollout!, key))!;
    const controlKey = Array.from({ length: 500 }, (_, index) => `control-assignment-${index}`).find((key) => !isCanaryAssignment(canary.rollout!, key))!;
    expect((await runtimeEvolutionProjection(fixture.root, "workspace-a", runtimeProfile(), runtimeAgent(), { assignmentKey: canaryKey })).canaryReleases)
      .toEqual([{ target: "failure-retrospective", releaseId: canary.toRelease.id, contentHash: fixture.candidate.contentHash }]);
    expect((await runtimeEvolutionProjection(fixture.root, "workspace-a", runtimeProfile(), runtimeAgent(), { assignmentKey: controlKey })).canaryReleases).toEqual([]);
    expect((await fixture.evaluations.promote(canaryInput)).promotionId).toBe(canary.promotionId);
    expect(await registry.current("canary", fixture.candidate)).toMatchObject({ generation: 1 });
    await expect(fixture.evaluations.promote({ ...canaryInput, commandId: "staged-canary-rival" }))
      .rejects.toMatchObject({ code: "EVOLUTION_CONFLICT" });

    await expect(fixture.evaluations.promote({
      commandId: "production-without-telemetry", candidateId: fixture.candidate.candidateId, evaluationId: passing.evaluationId,
      expectedContentHash: fixture.candidate.contentHash, stage: "production", fromPromotionId: canary.promotionId, approvedBy, policyRef,
    })).rejects.toMatchObject({ code: "EVOLUTION_TELEMETRY_REQUIRED" });

    const telemetryStore = new EvolutionTelemetryStore("workspace-a", fixture.root, fixture.candidates, fixture.evaluations, fixedNow);
    const safe = { success: true, qualityScore: 1, costUsd: 1, costMeasured: true, latencyMs: 100, toolFailures: 0, policyViolations: 0, safetyViolations: 0 };
    const telemetry = await telemetryStore.record({
      commandId: "canary-telemetry-a", promotionId: canary.promotionId,
      recorder: { type: "system", id: "runtime-telemetry-aggregator" },
      startedAt: "2026-08-14T00:00:00.000Z", endedAt: "2026-08-14T00:09:00.000Z",
      samples: Array.from({ length: 5 }, (_, index) => ({
        sampleId: `sample-${index}`, baseline: { ...safe, success: false, qualityScore: 0 }, release: { ...safe },
        evidenceRefs: [{ kind: "evidence" as const, ref: `telemetry-evidence-${index}`, workspaceId: "workspace-a" }],
      })),
    });
    expect(telemetry).toMatchObject({ decision: "pass", sampleSize: 5, releaseRef: canary.toRelease });
    const production = await fixture.evaluations.promote({
      commandId: "staged-production", candidateId: fixture.candidate.candidateId, evaluationId: passing.evaluationId,
      expectedContentHash: fixture.candidate.contentHash, stage: "production", fromPromotionId: canary.promotionId,
      telemetryId: telemetry.telemetryId, approvedBy, policyRef,
    });
    expect(await registry.current("production", fixture.candidate)).toMatchObject({ active: true, release: production.toRelease, promotionId: production.promotionId, generation: 1 });
    expect(await registry.current("canary", fixture.candidate)).toMatchObject({ active: false, previousRelease: canary.toRelease, generation: 2 });
    expect((await fixture.evaluations.listPromotions()).find((item) => item.promotionId === canary.promotionId)).toMatchObject({
      status: "superseded", supersededByPromotionId: production.promotionId,
    });
    expect(await productionEvolutionSkills(fixture.root, "workspace-a", runtimeProfile(), runtimeAgent())).toEqual([
      expect.objectContaining({ name: "failure-retrospective", releaseId: production.toRelease.id, contentHash: fixture.candidate.contentHash }),
    ]);
    expect(await runPiAgentAndReadEvolutionReleases(fixture.root, "production-session")).toEqual([
      expect.objectContaining({ name: "failure-retrospective", releaseId: production.toRelease.id, contentHash: fixture.candidate.contentHash, generation: 1, stage: "production" }),
    ]);
    expect((await new EvolutionActivationStore(fixture.root, fixedNow).list()).find((item) => item.promotionId === production.promotionId))
      .toMatchObject({ status: "activated", health: "healthy", healthTelemetryId: telemetry.telemetryId });

    const rolledBack = await fixture.evaluations.rollback("rollback-production", production.promotionId, approvedBy);
    expect(rolledBack.status).toBe("rolled_back");
    expect(await registry.current("production", fixture.candidate)).toMatchObject({ active: false, previousRelease: production.toRelease, generation: 2 });
    expect(await productionEvolutionSkills(fixture.root, "workspace-a", runtimeProfile(), runtimeAgent())).toEqual([]);
    expect(await runPiAgentAndReadEvolutionReleases(fixture.root, "post-rollback-session")).toEqual([]);
  });

  it("rejects self-evaluation and safety/regression failures", async () => {
    const fixture = await setup();
    await expect(fixture.evaluations.recordEvaluation({
      ...evaluationInput(fixture.candidate.candidateId, fixture.candidate.contentHash),
      commandId: "self-evaluation",
      evaluatorPrincipal: { type: "agent", id: "agent-proposer" },
    })).rejects.toMatchObject({ code: "EVOLUTION_DUTY_CONFLICT" });

    const unsafeCases = cases();
    unsafeCases.find((item) => item.group === "safety")!.candidate.safetyViolations = 1;
    const failed = await fixture.evaluations.recordEvaluation({
      ...evaluationInput(fixture.candidate.candidateId, fixture.candidate.contentHash),
      commandId: "unsafe-evaluation",
      caseResults: unsafeCases,
    });
    expect(failed.decision).toBe("fail");
    await expect(fixture.evaluations.promote({
      commandId: "promote-unsafe",
      candidateId: fixture.candidate.candidateId,
      evaluationId: failed.evaluationId,
      expectedContentHash: fixture.candidate.contentHash,
      stage: "shadow",
      approvedBy: { type: "human", id: "governor-a" },
      policyRef: { id: "evolution-policy", version: "1", contentHash: "policy-hash-a" },
    })).rejects.toMatchObject({ code: "EVOLUTION_EVALUATION_REQUIRED" });
  });

  it("gives governing Agents propose/query tools but no validate, evaluate, promote, or rollback authority", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-evolution-agent-tools-"));
    const observedTools: string[][] = [];
    await runPiAgentAndReadEvolutionReleases(root, "governance-tools", ["company:evolve"], observedTools);
    expect(observedTools[0]).toEqual(expect.arrayContaining(["propose_evolution_candidate", "query_evolution_status"]));
    expect(observedTools[0]).not.toEqual(expect.arrayContaining(["validate_evolution_candidate", "evaluate_evolution_candidate", "promote_evolution_candidate", "rollback_evolution_release"]));
  });

  it("builds canary telemetry only from real terminal Episode cohorts recorded in Agent traces", async () => {
    const fixture = await setup();
    const passing = await fixture.evaluations.recordEvaluation(evaluationInput(fixture.candidate.candidateId, fixture.candidate.contentHash));
    const policyRef = { id: "evolution-policy", version: "1", contentHash: "policy-hash-a" };
    const approvedBy = { type: "human" as const, id: "governor-a" };
    const shadow = await fixture.evaluations.promote({
      commandId: "cohort-shadow", candidateId: fixture.candidate.candidateId, evaluationId: passing.evaluationId,
      expectedContentHash: fixture.candidate.contentHash, stage: "shadow", approvedBy, policyRef,
    });
    const canary = await fixture.evaluations.promote({
      commandId: "cohort-canary", candidateId: fixture.candidate.candidateId, evaluationId: passing.evaluationId,
      expectedContentHash: fixture.candidate.contentHash, stage: "canary", fromPromotionId: shadow.promotionId,
      rolloutPercent: 25, approvedBy, policyRef,
    });
    const workspace = { id: "workspace-a", name: "Workspace", rootPath: fixture.root, policyProfile: "development" as const, createdAt: fixedNow().toISOString() };
    await ensureWorkspaceAgent(workspace, runtimeProfile(), "agent-dev");
    await recordCanaryCohorts(workspace, fixture.candidate, canary, true, "passing");

    const result = await new CanaryTelemetryReconciler(workspace, fixedNow, new PlatformEvolutionObservationAdapter(workspace)).reconcile();
    expect(result.recordedTelemetry).toEqual([
      expect.objectContaining({ releaseRef: canary.toRelease, sampleSize: 5, decision: "pass", recorder: { type: "system", id: "evolution-canary-monitor/v1" } }),
    ]);
    expect((await fixture.evaluations.listPromotions()).find((item) => item.promotionId === canary.promotionId)?.status).toBe("active");
    expect((await new CanaryTelemetryReconciler(workspace, fixedNow, new PlatformEvolutionObservationAdapter(workspace)).reconcile()).recordedTelemetry[0]?.telemetryId)
      .toBe(result.recordedTelemetry[0]?.telemetryId);
  });

  it("automatically rolls back a canary when terminal Episode cohorts fail the telemetry gate", async () => {
    const fixture = await setup();
    const passing = await fixture.evaluations.recordEvaluation(evaluationInput(fixture.candidate.candidateId, fixture.candidate.contentHash));
    const policyRef = { id: "evolution-policy", version: "1", contentHash: "policy-hash-a" };
    const approvedBy = { type: "human" as const, id: "governor-a" };
    const shadow = await fixture.evaluations.promote({
      commandId: "rollback-cohort-shadow", candidateId: fixture.candidate.candidateId, evaluationId: passing.evaluationId,
      expectedContentHash: fixture.candidate.contentHash, stage: "shadow", approvedBy, policyRef,
    });
    const canary = await fixture.evaluations.promote({
      commandId: "rollback-cohort-canary", candidateId: fixture.candidate.candidateId, evaluationId: passing.evaluationId,
      expectedContentHash: fixture.candidate.contentHash, stage: "canary", fromPromotionId: shadow.promotionId,
      rolloutPercent: 25, approvedBy, policyRef,
    });
    const workspace = { id: "workspace-a", name: "Workspace", rootPath: fixture.root, policyProfile: "development" as const, createdAt: fixedNow().toISOString() };
    await ensureWorkspaceAgent(workspace, runtimeProfile(), "agent-dev");
    await recordCanaryCohorts(workspace, fixture.candidate, canary, false, "failing");

    const result = await new CanaryTelemetryReconciler(workspace, fixedNow, new PlatformEvolutionObservationAdapter(workspace)).reconcile();

    expect(result.recordedTelemetry[0]).toMatchObject({ decision: "fail", releaseRef: canary.toRelease });
    expect((await fixture.evaluations.listPromotions()).find((item) => item.promotionId === canary.promotionId))
      .toMatchObject({ status: "rolled_back", approvedBy: { type: "system", id: "evolution-canary-monitor/v1" } });
    expect((await new EvolutionActivationStore(fixture.root, fixedNow).list()).find((item) => item.promotionId === canary.promotionId))
      .toMatchObject({ status: "rolled_back", health: "degraded", healthTelemetryId: result.recordedTelemetry[0]!.telemetryId });
    expect(await new EvolutionReleaseRegistry(fixture.root, fixedNow).current("canary", fixture.candidate))
      .toMatchObject({ active: false, previousRelease: canary.toRelease, generation: 2 });
  });

  it("evolves a Prompt from terminal Episodes, inherits it in a later Pi turn, and rolls it back from real cohort telemetry", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-prompt-loop-"));
    await new EvidenceLedger(root).append({
      evidenceId: "prompt-human-feedback", agentId: "reviewer", threadId: "review-thread", goalId: "review-goal",
      turnId: "review-turn", toolCallId: "review-call", toolName: "human-review", kind: "tool",
      capture: { status: "recorded" }, observation: { status: "observed", result: { promptDefect: true } },
      workspaceRoot: root, createdAt: "2026-08-14T00:08:00.000Z", input: {},
    });
    const experience = new ExperienceStore("workspace-a", root);
    const failure = {
      component: "prompt" as const, symptom: "The turn claimed activation without an inheritance proof",
      cause: "The active prompt does not require runtime inheritance evidence before claiming activation",
      sourceRefs: [{ kind: "human_feedback" as const, ref: "prompt-human-feedback", workspaceId: "workspace-a" }],
    };
    for (let index = 0; index < 2; index += 1) {
      const suffix = String(index + 1);
      await experience.record(`prompt-source-${suffix}`, projectExperience({
        commandId: `prompt-project-${suffix}`, workspaceId: "workspace-a", taskId: `source-task-${suffix}`, taskRunId: `source-run-${suffix}`,
        ticket: { ticketId: `source-ticket-${suffix}`, attemptId: `source-attempt-${suffix}`, status: "failed", startedAt: `2026-08-14T00:0${suffix}:00.000Z`, updatedAt: `2026-08-14T00:0${suffix}:30.000Z` },
        goal: { goalId: `source-goal-${suffix}`, agentId: "agent-dev", profileId: "profile-dev", status: "failed" },
        sourceRefs: [{ kind: "human_feedback", ref: "prompt-human-feedback", workspaceId: "workspace-a" }], failures: [failure],
      }, fixedNow));
    }
    const candidates = platformEvolutionStore("workspace-a", root, fixedNow);
    const proposed = (await new PromptConsolidator("workspace-a", experience, candidates).consolidate(2)).candidates[0]!;
    expect(proposed).toMatchObject({ kind: "prompt", proposedBy: { type: "system", id: "prompt-consolidator/v1" } });
    const validated = await candidates.validate({ commandId: "validate-prompt-loop", candidateId: proposed.candidateId, expectedContentHash: proposed.contentHash });
    expect(validated.validation?.passed).toBe(true);
    const suiteRef = { id: "prompt-loop-suite", version: "1", contentHash: "prompt-loop-suite-hash" };
    await candidates.markReadyForEvaluation({ commandId: "bind-prompt-loop", candidateId: proposed.candidateId, expectedContentHash: proposed.contentHash, suiteRef });
    const evaluations = new EvolutionEvaluationStore("workspace-a", root, candidates, fixedNow);
    const evidenceRefs = [{ kind: "evidence" as const, ref: "prompt-human-feedback", workspaceId: "workspace-a" }];
    const safeBaseline = { success: true, qualityScore: 1, costUsd: 0, costMeasured: true, latencyMs: 10, toolFailures: 0, policyViolations: 0, safetyViolations: 0, evidenceCompleteness: 0 };
    const safeCandidate = { ...safeBaseline, evidenceCompleteness: 1 };
    const evaluation = await evaluations.recordEvaluation({
      commandId: "evaluate-prompt-loop", candidateId: proposed.candidateId, expectedContentHash: proposed.contentHash, suiteRef,
      baselineRef: { id: "prompt-baseline", version: "1", contentHash: "prompt-baseline-hash" }, runtimeSnapshotRef: "prompt-runtime-snapshot",
      caseResults: [
        { caseId: "target", group: "target", baseline: { ...safeBaseline, success: false, qualityScore: 0 }, candidate: safeCandidate, evidenceRefs },
        { caseId: "regression", group: "regression", baseline: safeBaseline, candidate: safeCandidate, evidenceRefs },
        { caseId: "safety", group: "safety", baseline: safeBaseline, candidate: safeCandidate, evidenceRefs },
      ], evaluatorPrincipal: { type: "system", id: "deterministic-evaluator" }, grader: { id: "evolution-gate", version: "1", type: "deterministic" },
    });
    const approvedBy = { type: "human" as const, id: "governor" };
    const policyRef = { id: "evolution-policy", version: "1", contentHash: "policy-hash" };
    const shadow = await evaluations.promote({ commandId: "prompt-shadow", candidateId: proposed.candidateId, evaluationId: evaluation.evaluationId, expectedContentHash: proposed.contentHash, stage: "shadow", approvedBy, policyRef });
    const canary = await evaluations.promote({ commandId: "prompt-canary", candidateId: proposed.candidateId, evaluationId: evaluation.evaluationId, expectedContentHash: proposed.contentHash, stage: "canary", fromPromotionId: shadow.promotionId, rolloutPercent: 25, approvedBy, policyRef });

    let inherited = false;
    for (let index = 0; index < 100 && !inherited; index += 1) {
      const context = await runPiAgentAndReadEvolutionContext(root, `prompt-canary-turn-${index}`);
      inherited = Array.isArray(context.evolutionPrompts) && context.evolutionPrompts.some((item) => typeof item === "object" && item !== null && (item as { releaseId?: string }).releaseId === canary.toRelease.id);
    }
    expect(inherited).toBe(true);
    expect((await new EvolutionActivationStore(root, fixedNow).listProofs()).some((proof) => proof.assetKind === "prompt" && proof.releaseRef.id === canary.toRelease.id && proof.runtimeKind === "turn")).toBe(true);

    const workspace: Workspace = { id: "workspace-a", name: "Prompt loop", rootPath: root, policyProfile: "development", createdAt: fixedNow().toISOString() };
    await ensureWorkspaceAgent(workspace, runtimeProfile(), "agent-dev");
    await recordCanaryCohorts(workspace, proposed, canary, false, "prompt-loop-failing");
    const telemetry = await new CanaryTelemetryReconciler(workspace, fixedNow, new PlatformEvolutionObservationAdapter(workspace)).reconcile();
    expect(telemetry.recordedTelemetry[0]).toMatchObject({ decision: "fail", candidateId: proposed.candidateId });
    expect((await new EvolutionActivationStore(root, fixedNow).list()).find((item) => item.promotionId === canary.promotionId))
      .toMatchObject({ status: "rolled_back", health: "degraded", proofCount: expect.any(Number) });
  });

  it("evolves a Skill from terminal Episodes, loads it in a later Pi turn, and unloads it after rollback", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-skill-loop-"));
    await appendEvolutionEvidence(root, "skill-source", { skillDefect: true });
    const experience = new ExperienceStore("workspace-a", root);
    const failure = {
      component: "skill" as const,
      symptom: "Release review omitted rollback verification",
      cause: "The active release-review Skill does not verify the previous known-good revision",
      sourceRefs: [{ kind: "evidence" as const, ref: "skill-source", workspaceId: "workspace-a" }],
    };
    for (let index = 0; index < 2; index += 1) {
      const suffix = String(index + 1);
      await experience.record(`skill-source-${suffix}`, projectExperience({
        commandId: `skill-project-${suffix}`, workspaceId: "workspace-a", taskId: `skill-task-${suffix}`, taskRunId: `skill-run-${suffix}`,
        ticket: { ticketId: `skill-ticket-${suffix}`, attemptId: `skill-attempt-${suffix}`, status: "failed", startedAt: `2026-08-14T00:0${suffix}:00.000Z`, updatedAt: `2026-08-14T00:0${suffix}:30.000Z` },
        goal: { goalId: `skill-goal-${suffix}`, agentId: "agent-dev", profileId: "profile-dev", status: "failed" },
        sourceRefs: failure.sourceRefs, failures: [failure],
      }, fixedNow));
    }
    const candidates = platformEvolutionStore("workspace-a", root, fixedNow);
    const candidate = (await new SkillConsolidator("workspace-a", experience, candidates).consolidate(2)).candidates[0]!;
    expect(candidate).toMatchObject({ kind: "skill", proposedBy: { type: "system", id: "skill-consolidator/v1" } });
    const lifecycle = await promoteLocalAssetToProduction(root, candidates, candidate, "skill-loop");

    expect(await runPiAgentAndReadEvolutionReleases(root, "skill-loop-inherited")).toEqual([
      expect.objectContaining({ name: candidate.target, releaseId: lifecycle.production.toRelease.id, contentHash: candidate.contentHash }),
    ]);
    expect((await new EvolutionActivationStore(root, fixedNow).listProofs()).some((proof) => proof.assetKind === "skill" && proof.releaseRef.id === lifecycle.production.toRelease.id && proof.runtimeKind === "turn")).toBe(true);

    await lifecycle.evaluations.rollback("skill-loop-rollback", lifecycle.production.promotionId, { type: "human", id: "governor" });
    expect(await runPiAgentAndReadEvolutionReleases(root, "skill-loop-after-rollback")).toEqual([]);
    expect((await new EvolutionActivationStore(root, fixedNow).list()).find((item) => item.promotionId === lifecycle.production.promotionId)).toMatchObject({ status: "rolled_back" });
  });

  it("evolves Memory from terminal Episodes and restores the previous release in a later Pi turn", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-memory-loop-"));
    await appendEvolutionEvidence(root, "memory-source", { repeatedProviderFailure: true });
    const experience = new ExperienceStore("workspace-a", root);
    const failure = {
      component: "memory" as const,
      symptom: "The same transient provider failure was diagnosed repeatedly",
      cause: "A scoped retry lesson was not retained between turns",
      sourceRefs: [{ kind: "evidence" as const, ref: "memory-source", workspaceId: "workspace-a" }],
    };
    for (let index = 0; index < 2; index += 1) {
      const suffix = String(index + 1);
      await experience.record(`memory-source-${suffix}`, projectExperience({
        commandId: `memory-project-${suffix}`, workspaceId: "workspace-a", taskId: `memory-task-${suffix}`, taskRunId: `memory-run-${suffix}`,
        ticket: { ticketId: `memory-ticket-${suffix}`, attemptId: `memory-attempt-${suffix}`, status: "failed", startedAt: `2026-08-14T00:0${suffix}:00.000Z`, updatedAt: `2026-08-14T00:0${suffix}:30.000Z` },
        goal: { goalId: `memory-goal-${suffix}`, agentId: "agent-dev", profileId: "profile-dev", status: "failed" },
        sourceRefs: failure.sourceRefs, failures: [failure],
      }, fixedNow));
    }
    const attributions = await experience.listAttributions();
    const episodeIds = [...new Set(attributions.map((item) => item.episodeId))].sort();
    const clusterHash = createHash("sha256").update(JSON.stringify({ component: "memory", cause: failure.cause.toLowerCase(), episodeIds })).digest("hex");
    const target = `experience.memory.${clusterHash.slice(0, 12)}`;
    const candidates = platformEvolutionStore("workspace-a", root, fixedNow);
    const baseline = await candidates.create({
      commandId: "memory-baseline", kind: "memory", target, title: "Previous scoped retry lesson",
      rationale: "Keep the last known-good scoped lesson available for rollback.", hypothesis: "The scoped lesson prevents repeated diagnosis.",
      artifactContent: "# Scoped operational memory\n\nRetry transient provider failures only after confirming the current error is retryable.",
      sourceRefs: failure.sourceRefs, scope: { workspaceId: "workspace-a" },
      expectedMetrics: [{ metric: "task_success_rate", direction: "increase", minimumDelta: 0.01 }],
      riskLevel: "low", proposedBy: { type: "human", id: "governor" },
    });
    const baselineLifecycle = await promoteLocalAssetToProduction(root, candidates, baseline, "memory-baseline");
    expect(((await runPiAgentAndReadEvolutionContext(root, "memory-baseline-turn")).evolutionMemories as Array<{ releaseId: string }>)).toEqual([
      expect.objectContaining({ releaseId: baselineLifecycle.production.toRelease.id }),
    ]);

    const evolved = (await new MemoryConsolidator("workspace-a", experience, candidates).consolidate(2)).candidates[0]!;
    expect(evolved).toMatchObject({ kind: "memory", target, proposedBy: { type: "system", id: "memory-consolidator/v1" } });
    expect(evolved.mutationSet?.baseRef).toEqual(baselineLifecycle.production.toRelease);
    const evolvedLifecycle = await promoteLocalAssetToProduction(root, candidates, evolved, "memory-evolved");
    expect(((await runPiAgentAndReadEvolutionContext(root, "memory-evolved-turn")).evolutionMemories as Array<{ releaseId: string }>)).toEqual([
      expect.objectContaining({ releaseId: evolvedLifecycle.production.toRelease.id }),
    ]);

    await evolvedLifecycle.evaluations.rollback("memory-evolved-rollback", evolvedLifecycle.production.promotionId, { type: "human", id: "governor" });
    expect(((await runPiAgentAndReadEvolutionContext(root, "memory-restored-turn")).evolutionMemories as Array<{ releaseId: string }>)).toEqual([
      expect.objectContaining({ releaseId: baselineLifecycle.production.toRelease.id }),
    ]);
    expect((await new EvolutionActivationStore(root, fixedNow).listProofs()).some((proof) => proof.assetKind === "memory" && proof.releaseRef.id === baselineLifecycle.production.toRelease.id && proof.runtimeKind === "turn" && proof.desiredGeneration === 3)).toBe(true);
  });

  it("drains an existing Pi session before an activated Agent Profile is inherited", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-profile-session-boundary-"));
    const baseProfile = runtimeProfile();
    const workspaceAgent = runtimeAgent();
    const store = new AgentStore(root, workspaceAgent.id);
    const engine = new AgentEngine(store);
    const thread = await engine.ensureThread({ agentId: workspaceAgent.id, scopeId: "profile-boundary", idempotencyKey: "profile-boundary" });
    const traces = new AgentTraceStore(root, workspaceAgent.id);
    const providers = new ProviderRegistry({ homeDir: path.join(root, ".provider-home"), retryCount: 0 });
    const policy = { profile: "development" as const, workspaceRoot: root, canReadWorkspace: true, canWriteWorkspace: false, canExecuteCommands: false, allowHostAccess: false, enabledTools: [] };
    const runtime = new PiAgentRuntime(
      root, engine, store, new AgentContextAssembler(store), providers,
      new AgentToolRuntime(policy, []), traces, { now: fixedNow, turnTimeoutMs: 10_000, turnInactivityTimeoutMs: 10_000, evolution: new EvolutionAgentRuntimeAdapter(root, workspaceAgent.workspaceId, { now: fixedNow }) },
    );
    try {
      await engine.sendMessage({ messageId: "profile-message-1", turnId: "profile-turn-1", threadId: thread.threadId, senderPrincipalId: "human", content: "Start with the current profile.", createdAt: fixedNow().toISOString() });
      await runtime.runSlice({ threadId: thread.threadId, turnId: "profile-turn-1", triggerMessageId: "profile-message-1", profile: baseProfile, agent: workspaceAgent, policy, provider: "mock", model: "mock" });
      const firstSessionId = sessionIdForTurn(await traces.list(thread.threadId), "profile-turn-1");

      const artifactContent = JSON.stringify({ schemaVersion: 1, id: baseProfile.id, soul: "Use the newly approved evidence discipline in new sessions." });
      const contentHash = createHash("sha256").update(artifactContent).digest("hex");
      const artifactRef = `artifacts/${contentHash}/artifact.txt`;
      await mkdir(path.dirname(path.join(root, ".autoagent", "evolution", artifactRef)), { recursive: true });
      await writeFile(path.join(root, ".autoagent", "evolution", artifactRef), artifactContent, "utf8");
      const baseRef = { id: "genesis:agent_profile", version: "0", contentHash: createHash("sha256").update("").digest("hex") };
      const candidate = {
        candidateId: "candidate-profile-boundary", revision: 1, kind: "agent_profile" as const, target: baseProfile.id,
        title: "Session profile boundary", rationale: "Repeated evidence shows a profile-level behavior change is required.", artifactRef, contentHash,
        hypothesis: "New sessions will inherit the approved profile while an existing session is never mutated in place.",
        sourceRefs: [{ kind: "evidence" as const, ref: "profile-evidence", workspaceId: "workspace-a" }], scope: { workspaceId: "workspace-a", roles: ["dev"] },
        expectedMetrics: [{ metric: "task_success_rate", direction: "increase" as const }], riskLevel: "high" as const, status: "ready_for_eval" as const,
        proposedBy: { type: "agent" as const, id: "coordinator" }, createdAt: fixedNow().toISOString(), updatedAt: fixedNow().toISOString(),
        validation: { passed: true, checkedAt: fixedNow().toISOString(), checks: [{ name: "agent_profile_contract", passed: true, message: "passed" }] },
        mutationSet: { assetKind: "agent_profile" as const, target: baseProfile.id, baseRef, candidateRef: { id: "candidate-profile-boundary", version: "1", contentHash }, representation: "full" as const, activationBoundary: "next_session" as const, compatibility: { runtime: "autoagent" }, rollbackRef: baseRef },
      } satisfies EvolutionCandidate;
      const promotion = {
        promotionId: "promotion-profile-boundary", candidateId: candidate.candidateId, evaluationId: "evaluation-profile-boundary",
        toRelease: { id: "release-profile-boundary", version: "1", contentHash }, stage: "production" as const, scope: candidate.scope,
        approvedBy: { type: "human" as const, id: "governor" }, policyRef: { id: "policy", version: "1", contentHash: "policy-hash" }, status: "active" as const, createdAt: fixedNow().toISOString(),
      } satisfies PromotionRecord;
      await new EvolutionReleaseRegistry(root, fixedNow).publish(promotion, candidate);

      await engine.sendMessage({ messageId: "profile-message-2", turnId: "profile-turn-2", threadId: thread.threadId, senderPrincipalId: "human", content: "Continue after profile activation.", createdAt: fixedNow().toISOString() });
      await runtime.runSlice({ threadId: thread.threadId, turnId: "profile-turn-2", triggerMessageId: "profile-message-2", profile: baseProfile, agent: workspaceAgent, policy, provider: "mock", model: "mock" });
      const secondSessionId = sessionIdForTurn(await traces.list(thread.threadId), "profile-turn-2");
      expect(secondSessionId).not.toBe(firstSessionId);
      expect(await new EvolutionActivationStore(root, fixedNow).listProofs()).toEqual([
        expect.objectContaining({ assetKind: "agent_profile", runtimeKind: "session", runtimeRef: secondSessionId, releaseRef: promotion.toRelease }),
      ]);
    } finally {
      await runtime.dispose();
    }
  });

  it("runs a versioned suite through a sandboxed executor instead of accepting client scores", async () => {
    const fixture = await setup();
    const suites = new EvolutionEvalSuiteStore("workspace-a", fixture.root, fixedNow);
    const inputRef = { kind: "evidence" as const, ref: "eval-evidence", workspaceId: "workspace-a" };
    const suite = await suites.create({ id: "suite-controlled", version: "1", title: "Controlled gate", cases: [
      { caseId: "target-a", group: "target", partition: "historical", inputRef, assertions: ["task succeeds"] },
      { caseId: "regression-a", group: "regression", partition: "sealed_holdout", inputRef, assertions: ["quality is preserved"] },
      { caseId: "safety-a", group: "safety", partition: "sealed_holdout", inputRef, assertions: ["no safety violations"] },
    ] });
    await fixture.candidates.markReadyForEvaluation({ commandId: "bind-controlled-suite", candidateId: fixture.candidate.candidateId, expectedContentHash: fixture.candidate.contentHash, suiteRef: suite.suiteRef });
    await expect(suites.create({ id: "suite-controlled", version: "1", title: "Mutated in place", cases: suite.cases }))
      .rejects.toMatchObject({ code: "EVOLUTION_EVAL_SUITE_VERSION_CONFLICT" });
    await expect(suites.create({ id: "suite-without-holdout", version: "1", title: "Invalid gate", cases: suite.cases.map((item) => ({ ...item, partition: "historical" as const })) }))
      .rejects.toMatchObject({ code: "INVALID_EVOLUTION_EVAL_SUITE" });
    expect(await suites.list()).toEqual([suite.suiteRef]);
    const safe = { success: true, qualityScore: 1, costUsd: 1, costMeasured: true, latencyMs: 100, toolFailures: 0, policyViolations: 0, safetyViolations: 0 };
    const calls: string[] = [];
    const runner = new EvolutionEvaluationRunner("workspace-a", fixture.candidates, suites, fixture.evaluations, {
      isolation: "sandboxed",
      async execute(input) {
        calls.push(`${input.case.caseId}:${input.variant}`);
        return {
          observation: input.variant === "baseline" && input.case.group === "target" ? { ...safe, success: false, qualityScore: 0 } : { ...safe },
          evidenceRefs: [inputRef],
        };
      },
    });
    const run = await runner.run({
      commandId: "controlled-run", candidateId: fixture.candidate.candidateId, expectedContentHash: fixture.candidate.contentHash,
      suiteRef: suite.suiteRef, baselineRef: { id: "baseline", version: "1", contentHash: "baseline-hash" },
      runtimeSnapshotRef: "runtime-snapshot-a", evaluatorPrincipal: { type: "system", id: "isolated-eval-runner" },
    });
    expect(run.decision).toBe("pass");
    expect(calls).toHaveLength(6);
    expect(run.suiteRef).toEqual(suite.suiteRef);

    const jobs = new EvaluationJobStore("workspace-a", fixture.root, fixedNow);
    const request = {
      candidateId: fixture.candidate.candidateId, expectedContentHash: fixture.candidate.contentHash,
      suiteRef: suite.suiteRef, baselineRef: { id: "baseline", version: "1", contentHash: "baseline-hash" },
      runtimeSnapshotRef: "runtime-snapshot-a", evaluatorPrincipal: { type: "system" as const, id: "isolated-eval-runner" },
    };
    await jobs.enqueue("queued-evaluation", request);
    const completed = await new EvaluationJobRunner(jobs, fixture.evaluations, runner).runNext("worker-a");
    expect(completed).toMatchObject({ status: "succeeded", result: { decision: "pass" } });

    const recovery = await jobs.enqueue("crash-recovery-evaluation", request);
    await runner.run({ ...request, commandId: `evaluation-job:${recovery.jobId}` });
    const callsBeforeRecovery = calls.length;
    const recovered = await new EvaluationJobRunner(jobs, fixture.evaluations, runner).runNext("worker-b");
    expect(recovered).toMatchObject({ jobId: recovery.jobId, status: "succeeded" });
    expect(calls).toHaveLength(callsBeforeRecovery);
  });
});

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-evaluation-"));
  await new EvidenceLedger(root).append({
    evidenceId: "eval-evidence", agentId: "evaluator-agent", threadId: "eval-thread", goalId: "eval-goal",
    attemptId: "eval-attempt", turnId: "eval-turn", toolCallId: "eval-call", toolName: "eval-runner", kind: "tool",
    capture: { status: "recorded" }, observation: { status: "observed", result: { verified: true } },
    workspaceRoot: root, createdAt: "2026-08-14T00:09:00.000Z", input: { suite: "suite-a" },
  });
  await new EvidenceLedger(root).append({
    evidenceId: "evidence-a", agentId: "agent-proposer", threadId: "source-thread", goalId: "source-goal",
    turnId: "source-turn", toolCallId: "source-call", toolName: "source", kind: "tool", capture: { status: "recorded" },
    observation: { status: "observed", result: { repeatedFailure: true } }, workspaceRoot: root,
    createdAt: "2026-08-14T00:08:00.000Z", input: {},
  });
  for (let index = 0; index < 5; index += 1) await new EvidenceLedger(root).append({
    evidenceId: `telemetry-evidence-${index}`, agentId: "runtime-telemetry", threadId: "canary-thread", goalId: "canary-goal",
    attemptId: `canary-attempt-${index}`, turnId: `canary-turn-${index}`, toolCallId: `canary-call-${index}`,
    toolName: "runtime-telemetry", kind: "tool", capture: { status: "recorded" },
    observation: { status: "observed", result: { sample: index } }, workspaceRoot: root,
    createdAt: `2026-08-14T00:0${index}:00.000Z`, input: { sample: index },
  });
  const candidates = platformEvolutionStore("workspace-a", root, fixedNow);
  const proposed = await candidates.create({
    commandId: "candidate-a",
    kind: "skill",
    target: "failure-retrospective",
    title: "Evidence-first retrospective",
    rationale: "Repeated attempts omitted the same required evidence.",
    hypothesis: "The candidate will increase task success rate by at least ten percent.",
    artifactContent: "---\nname: failure-retrospective\ndescription: Evidence-first retrospective for repeated delivery failures.\n---\n# Failure retrospective\n\nUse authoritative evidence to isolate one repeated cause, propose a bounded correction, and verify it against target, regression, and safety cases before reuse.\n",
    sourceRefs: [{ kind: "evidence", ref: "evidence-a", workspaceId: "workspace-a" }],
    scope: { workspaceId: "workspace-a", roles: ["dev"] },
    expectedMetrics: [{ metric: "task_success_rate", direction: "increase", minimumDelta: 0.1 }],
    riskLevel: "medium",
    proposedBy: { type: "agent", id: "agent-proposer" },
  });
  const validated = await candidates.validate({ commandId: "validate-a", candidateId: proposed.candidateId, expectedContentHash: proposed.contentHash });
  const candidate = await candidates.markReadyForEvaluation({
    commandId: "bind-suite-a", candidateId: validated.candidateId, expectedContentHash: validated.contentHash,
    suiteRef: { id: "suite-a", version: "1", contentHash: "suite-hash-a" },
  });
  return { root, candidate, candidates, evaluations: new EvolutionEvaluationStore("workspace-a", root, candidates, fixedNow) };
}

function evaluationInput(candidateId: string, expectedContentHash: string): RecordEvaluationInput {
  return {
    commandId: "evaluation-a",
    candidateId,
    expectedContentHash,
    suiteRef: { id: "suite-a", version: "1", contentHash: "suite-hash-a" },
    baselineRef: { id: "skill-baseline", version: "1", contentHash: "baseline-hash-a" },
    runtimeSnapshotRef: "runtime-snapshot-a",
    caseResults: cases(),
    evaluatorPrincipal: { type: "system", id: "deterministic-evaluator" },
    grader: { id: "evolution-gate", version: "1", type: "deterministic" },
  };
}

function cases(): EvaluationCaseResult[] {
  const evidenceRefs = [{ kind: "evidence" as const, ref: "eval-evidence", workspaceId: "workspace-a" }];
  const safe = { success: true, qualityScore: 1, costUsd: 1, costMeasured: true, latencyMs: 100, toolFailures: 0, policyViolations: 0, safetyViolations: 0 };
  return [
    { caseId: "target-a", group: "target", baseline: { ...safe, success: false, qualityScore: 0 }, candidate: { ...safe }, evidenceRefs },
    { caseId: "regression-a", group: "regression", baseline: { ...safe }, candidate: { ...safe }, evidenceRefs },
    { caseId: "safety-a", group: "safety", baseline: { ...safe }, candidate: { ...safe }, evidenceRefs },
  ];
}

function fixedNow(): Date { return new Date("2026-08-14T00:10:00.000Z"); }

async function appendEvolutionEvidence(root: string, evidenceId: string, result: Record<string, unknown>): Promise<void> {
  await new EvidenceLedger(root).append({
    evidenceId, agentId: "evolution-reviewer", threadId: `${evidenceId}-thread`, goalId: `${evidenceId}-goal`,
    turnId: `${evidenceId}-turn`, toolCallId: `${evidenceId}-call`, toolName: "evolution-review", kind: "tool",
    capture: { status: "recorded" }, observation: { status: "observed", result },
    workspaceRoot: root, createdAt: fixedNow().toISOString(), input: {},
  });
}

async function promoteLocalAssetToProduction(root: string, candidates: EvolutionStore, candidate: EvolutionCandidate, suffix: string) {
  const evalEvidenceId = `${suffix}-eval-evidence`;
  await appendEvolutionEvidence(root, evalEvidenceId, { candidateId: candidate.candidateId, passed: true });
  const telemetryEvidenceIds = Array.from({ length: 5 }, (_, index) => `${suffix}-telemetry-evidence-${index}`);
  for (const [index, evidenceId] of telemetryEvidenceIds.entries()) await appendEvolutionEvidence(root, evidenceId, { candidateId: candidate.candidateId, sample: index });
  const validated = await candidates.validate({ commandId: `${suffix}-validate`, candidateId: candidate.candidateId, expectedContentHash: candidate.contentHash });
  expect(validated.validation?.passed).toBe(true);
  const suiteRef = { id: `${suffix}-suite`, version: "1", contentHash: createHash("sha256").update(`${suffix}-suite`).digest("hex") };
  await candidates.markReadyForEvaluation({ commandId: `${suffix}-bind`, candidateId: candidate.candidateId, expectedContentHash: candidate.contentHash, suiteRef });
  const evaluations = new EvolutionEvaluationStore("workspace-a", root, candidates, fixedNow);
  const evidenceRefs = [{ kind: "evidence" as const, ref: evalEvidenceId, workspaceId: "workspace-a" }];
  const safe = { success: true, qualityScore: 1, costUsd: 0, costMeasured: true, latencyMs: 10, toolFailures: 0, policyViolations: 0, safetyViolations: 0, evidenceCompleteness: 1 };
  const evaluation = await evaluations.recordEvaluation({
    commandId: `${suffix}-evaluation`, candidateId: candidate.candidateId, expectedContentHash: candidate.contentHash, suiteRef,
    baselineRef: { id: `${suffix}-baseline`, version: "1", contentHash: createHash("sha256").update(`${suffix}-baseline`).digest("hex") },
    runtimeSnapshotRef: `${suffix}-runtime`, evaluatorPrincipal: { type: "system", id: "deterministic-evaluator" },
    grader: { id: "evolution-gate", version: "1", type: "deterministic" },
    caseResults: [
      { caseId: `${suffix}-target`, group: "target", baseline: { ...safe, success: false, qualityScore: 0 }, candidate: safe, evidenceRefs },
      { caseId: `${suffix}-regression`, group: "regression", baseline: safe, candidate: safe, evidenceRefs },
      { caseId: `${suffix}-safety`, group: "safety", baseline: safe, candidate: safe, evidenceRefs },
    ],
  });
  const approvedBy = { type: "human" as const, id: "governor" };
  const policyRef = { id: "evolution-policy", version: "1", contentHash: "policy-hash" };
  const shadow = await evaluations.promote({ commandId: `${suffix}-shadow`, candidateId: candidate.candidateId, evaluationId: evaluation.evaluationId, expectedContentHash: candidate.contentHash, stage: "shadow", approvedBy, policyRef });
  const canary = await evaluations.promote({ commandId: `${suffix}-canary`, candidateId: candidate.candidateId, evaluationId: evaluation.evaluationId, expectedContentHash: candidate.contentHash, stage: "canary", fromPromotionId: shadow.promotionId, rolloutPercent: 25, approvedBy, policyRef });
  const telemetry = await new EvolutionTelemetryStore("workspace-a", root, candidates, evaluations, fixedNow).record({
    commandId: `${suffix}-telemetry`, promotionId: canary.promotionId, recorder: { type: "system", id: "runtime-telemetry-aggregator" },
    startedAt: "2026-08-14T00:00:00.000Z", endedAt: "2026-08-14T00:09:00.000Z",
    samples: telemetryEvidenceIds.map((evidenceId, index) => ({
      sampleId: `${suffix}-sample-${index}`, baseline: { ...safe, success: false, qualityScore: 0 }, release: safe,
      evidenceRefs: [{ kind: "evidence" as const, ref: evidenceId, workspaceId: "workspace-a" }],
    })),
  });
  const production = await evaluations.promote({
    commandId: `${suffix}-production`, candidateId: candidate.candidateId, evaluationId: evaluation.evaluationId,
    expectedContentHash: candidate.contentHash, stage: "production", fromPromotionId: canary.promotionId,
    telemetryId: telemetry.telemetryId, approvedBy, policyRef,
  });
  return { evaluations, production };
}
function runtimeProfile(): AgentProfile { return { id: "profile-dev", name: "Dev", role: "dev", capabilities: [], defaultProvider: "mock", defaultModel: "mock", defaultPolicy: {} }; }
function runtimeAgent(): WorkspaceAgent { return { id: "agent-dev", workspaceId: "workspace-a", profileId: "profile-dev", roleInWorkspace: "dev", agentDir: "agents/dev", status: "idle" }; }
function sessionIdForTurn(traces: Awaited<ReturnType<AgentTraceStore["list"]>>, turnId: string): string {
  const value = traces.find((trace) => trace.turnId === turnId && trace.kind === "context"
    && typeof trace.data === "object" && trace.data !== null && typeof (trace.data as { sessionId?: unknown }).sessionId === "string")?.data as { sessionId?: string } | undefined;
  if (!value?.sessionId) throw new Error(`Pi session trace missing for ${turnId}`);
  return value.sessionId;
}

async function runPiAgentAndReadEvolutionReleases(
  root: string,
  scopeId: string,
  capabilities: AgentProfile["capabilities"] = [],
  observedTools?: string[][],
): Promise<unknown[]> {
  const context = await runPiAgentAndReadEvolutionContext(root, scopeId, capabilities, observedTools);
  return (context.evolutionReleases as unknown[] | undefined) ?? [];
}

async function runPiAgentAndReadEvolutionContext(
  root: string,
  scopeId: string,
  capabilities: AgentProfile["capabilities"] = [],
  observedTools?: string[][],
): Promise<Record<string, unknown>> {
  const profile = { ...runtimeProfile(), capabilities };
  const agent = runtimeAgent();
  const store = new AgentStore(root, agent.id);
  const engine = new AgentEngine(store);
  const thread = await engine.ensureThread({ agentId: agent.id, scopeId, idempotencyKey: scopeId });
  const messageId = `message-${scopeId}`;
  await engine.sendMessage({
    messageId, turnId: `turn-${scopeId}`, threadId: thread.threadId, senderPrincipalId: "human",
    content: "Inspect the current evidence context.", createdAt: "2026-08-14T00:10:00.000Z",
  });
  const policy = {
    profile: "development" as const, workspaceRoot: root, canReadWorkspace: true, canWriteWorkspace: false,
    canExecuteCommands: false, allowHostAccess: false, enabledTools: [],
  };
  const traces = new AgentTraceStore(root, agent.id);
  const providers = new ProviderRegistry({ homeDir: path.join(root, ".provider-home"), retryCount: 0 });
  if (observedTools) providers.runModelTurnWithRetry = async (input) => {
    observedTools.push(input.tools.map((tool) => tool.name));
    return { items: [{ type: "assistant_message", content: "Observed governance tools." }], usage: { totalTokens: 1 } };
  };
  const runtime = new PiAgentRuntime(
    root, engine, store, new AgentContextAssembler(store), providers,
    new AgentToolRuntime(policy, []), traces, { now: fixedNow, turnTimeoutMs: 10_000, turnInactivityTimeoutMs: 10_000, evolution: new EvolutionAgentRuntimeAdapter(root, agent.workspaceId, { now: fixedNow }) },
  );
  try {
    const result = await runtime.runSlice({
      threadId: thread.threadId, turnId: `turn-${scopeId}`, triggerMessageId: messageId,
      profile, agent, policy, provider: "mock", model: "mock",
    });
    expect(result.status).toBe("waiting");
    const recordedTraces = await traces.list(thread.threadId);
    const contextTrace = recordedTraces.find((trace) => trace.kind === "context"
      && typeof trace.data === "object" && trace.data !== null && "evolutionReleases" in trace.data);
    expect(contextTrace).toBeDefined();
    expect(recordedTraces.find((trace) => trace.kind === "provider_response")?.data).toMatchObject({
      costUsd: 0, costMeasured: false, totalTokens: expect.any(Number),
    });
    return contextTrace!.data as Record<string, unknown>;
  } finally {
    await runtime.dispose();
  }
}

async function recordCanaryCohorts(
  workspace: Workspace,
  candidate: EvolutionCandidate,
  canary: PromotionRecord,
  releaseSucceeds: boolean,
  prefix: string,
): Promise<void> {
  const experience = new ExperienceStore(workspace.id, workspace.rootPath);
  const traces = new AgentTraceStore(workspace.rootPath, "agent-dev");
  for (let index = 0; index < 10; index += 1) {
    const selected = index >= 5;
    const goalId = `${prefix}-cohort-goal-${index}`;
    const episodeId = `${prefix}-cohort-episode-${index}`;
    const traceId = `${prefix}-cohort-trace-${index}`;
    const minute = 11 + index;
    await experience.record(`${prefix}-cohort-experience-${index}`, {
      episode: {
        episodeId, workspaceId: workspace.id, taskId: `${prefix}-task-${index}`, taskRunId: `${prefix}-run-${index}`,
        ticketId: `${prefix}-ticket-${index}`, attemptId: `${prefix}-attempt-${index}`, goalId, agentId: "agent-dev", profileId: "profile-dev",
        outcome: (selected ? releaseSucceeds : !releaseSucceeds) ? "succeeded" : "failed",
        sourceRefs: [{ kind: "trace", ref: traceId, workspaceId: workspace.id, agentId: "agent-dev" }],
        startedAt: `2026-08-14T00:${String(minute).padStart(2, "0")}:00.000Z`,
        endedAt: `2026-08-14T00:${String(minute).padStart(2, "0")}:01.000Z`, contentHash: `${index}`.padStart(64, "0"),
      },
      attributions: [],
    });
    await traces.append({
      traceId, agentId: "agent-dev", threadId: `${prefix}-thread-${index}`, goalId,
      turnId: `${prefix}-turn-${index}`, kind: "context", createdAt: `2026-08-14T00:${String(minute).padStart(2, "0")}:00.000Z`,
      data: { evolutionCanaryAssignments: [{ target: candidate.target, promotionId: canary.promotionId, releaseId: canary.toRelease.id, selected }] },
    });
    await traces.append({
      traceId: `${traceId}-usage`, agentId: "agent-dev", threadId: `${prefix}-thread-${index}`, goalId,
      turnId: `${prefix}-turn-${index}`, kind: "provider_response", createdAt: `2026-08-14T00:${String(minute).padStart(2, "0")}:00.500Z`,
      data: { inputTokens: 10 + index, outputTokens: 5, totalTokens: 15 + index, costUsd: 0, costMeasured: false },
    });
  }
}
