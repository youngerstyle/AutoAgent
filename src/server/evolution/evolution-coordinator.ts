import os from "node:os";
import type { WorkspaceStore } from "../storage/workspace-store.js";
import { EvolutionStore } from "./evolution-store.js";
import { EvolutionEvaluationStore } from "./evaluation-store.js";
import { EvolutionEvalSuiteStore } from "./eval-suite-store.js";
import { EvaluationJobStore } from "./evaluation-job-store.js";
import { EvaluationJobRunner } from "./evaluation-job-runner.js";
import { EvolutionEvaluationRunner } from "./evaluation-runner.js";
import { NodePermissionSandboxExecutor } from "./node-permission-sandbox-executor.js";
import { ExtractionJobStore } from "./extraction-job-store.js";
import { ExtractionRunner } from "./extraction-runner.js";
import { ExperienceStore } from "./experience-store.js";
import { EvolutionAssetSelector } from "./asset-selector.js";
import { MemoryLifecycleStore } from "./memory-lifecycle-store.js";
import type { EvolutionWorkerStatus } from "../../shared/contracts/evolution.js";
import { CanaryTelemetryReconciler } from "./canary-telemetry-reconciler.js";
import { CompanyTrialReconciler } from "./company-trial-reconciler.js";
import { EvolutionTelemetryStore } from "./telemetry-store.js";
import { EvolutionSignalIngestor } from "./evolution-signal-ingestor.js";
import { EvolutionReflectionWorker } from "./reflection-worker.js";
import { EvolutionDreamWorker } from "./dream-worker.js";
import { PracticeDraftStore } from "./practice-draft-store.js";
import { PracticeStore } from "./practice-store.js";
import { PracticeBindingStore } from "./practice-binding-store.js";
import { PracticeBindingCompiler } from "./practice-binding-compiler.js";
import { CompanyIdentityStore } from "../storage/company-identity-store.js";
import { ScopePromotionStore } from "./scope-promotion-store.js";
import { ScopePromotionCandidateCompiler } from "./scope-promotion-compiler.js";
import { SharedEvolutionReleaseRegistry } from "./shared-release-registry.js";
import { globalEvolutionLayerRoot } from "../storage/paths.js";
import type { EvolutionCandidate, EvolutionEvalSuite } from "../../shared/contracts/evolution.js";
import { PluginAuthoringWorker, type PluginArtifactAuthor } from "./plugin-authoring-worker.js";

export class EvolutionCoordinator {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private stopped = true;
  private readonly workerId: string;
  private statusValue: EvolutionWorkerStatus;

  constructor(
    private readonly workspaces: WorkspaceStore,
    private readonly options: {
      evaluatorProgramPath?: string;
      intervalMs?: number;
      maintenanceIntervalMs?: number;
      evaluationLeaseMs?: number;
      maxEvaluationJobsPerWorkspace?: number;
      maxReflectionSignalsPerWorkspace?: number;
      now?: () => Date;
      workerId?: string;
      pluginArtifactAuthor?: PluginArtifactAuthor;
    } = {},
  ) {
    this.workerId = options.workerId ?? `evolution-coordinator:${os.hostname()}:${process.pid}`;
    this.statusValue = {
      running: false,
      evaluatorConfigured: Boolean(options.evaluatorProgramPath),
      workspacesScanned: 0,
      reflectionSignalsProcessed: 0,
      dreamPracticesProduced: 0,
      practiceBindingsCreated: 0,
      scopePromotionArtifactsCreated: 0,
      evaluationJobsProcessed: 0,
      promotionTransitionsProcessed: 0,
    };
  }

  start(): void {
    if (!this.stopped) return;
    const intervalMs = this.options.intervalMs ?? 30_000;
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1_000) throw new Error("Evolution coordinator interval must be at least one second");
    this.stopped = false;
    void this.runOnce().catch((error) => this.recordUnhandled(error));
    this.timer = setInterval(() => void this.runOnce().catch((error) => this.recordUnhandled(error)), intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running?.catch(() => undefined);
    this.statusValue = { ...this.statusValue, running: false };
  }

  status(): EvolutionWorkerStatus { return structuredClone(this.statusValue); }

  runOnce(): Promise<void> {
    if (this.running) return this.running;
    const pending = this.runPass();
    const tracked = pending.finally(() => { if (this.running === tracked) this.running = undefined; });
    this.running = tracked;
    return tracked;
  }

  private async runPass(): Promise<void> {
    const startedAt = this.now().toISOString();
    this.statusValue = { ...this.statusValue, running: true, lastStartedAt: startedAt, lastError: undefined };
    let workspacesScanned = 0;
    let reflectionSignalsProcessed = 0;
    let dreamPracticesProduced = 0;
    let practiceBindingsCreated = 0;
    let scopePromotionArtifactsCreated = 0;
    let evaluationJobsProcessed = 0;
    let promotionTransitionsProcessed = 0;
    const errors: string[] = [];
    for (const workspace of await this.workspaces.list()) {
      workspacesScanned += 1;
      try {
        await this.runMaintenance(workspace);
      } catch (error) {
        errors.push(`${workspace.id}/maintenance: ${safeMessage(error)}`);
      }
      try {
        reflectionSignalsProcessed += await this.runReflections(workspace);
      } catch (error) {
        errors.push(`${workspace.id}/reflection: ${safeMessage(error)}`);
      }
      try {
        dreamPracticesProduced += await this.runDream(workspace);
      } catch (error) {
        errors.push(`${workspace.id}/dream: ${safeMessage(error)}`);
      }
      try {
        practiceBindingsCreated += await this.runBindings(workspace);
      } catch (error) {
        errors.push(`${workspace.id}/binding: ${safeMessage(error)}`);
      }
      try {
        scopePromotionArtifactsCreated += await this.runProjectScopePromotions(workspace);
      } catch (error) {
        errors.push(`${workspace.id}/scope-promotion: ${safeMessage(error)}`);
      }
      try {
        evaluationJobsProcessed += await this.runEvaluations(workspace);
      } catch (error) {
        errors.push(`${workspace.id}/evaluation: ${safeMessage(error)}`);
      }
      try {
      promotionTransitionsProcessed += await this.runPromotions(workspace);
      } catch (error) {
        errors.push(`${workspace.id}/promotion: ${safeMessage(error)}`);
      }
    }
    try {
      scopePromotionArtifactsCreated += await this.runSharedScopePromotions();
    } catch (error) {
      errors.push(`company/scope-promotion: ${safeMessage(error)}`);
    }
    this.statusValue = {
      running: false,
      evaluatorConfigured: Boolean(this.options.evaluatorProgramPath),
      lastStartedAt: startedAt,
      lastCompletedAt: this.now().toISOString(),
      ...(errors.length ? { lastError: errors.join("; ").slice(0, 2_000) } : {}),
      workspacesScanned,
      reflectionSignalsProcessed,
      dreamPracticesProduced,
      practiceBindingsCreated,
      scopePromotionArtifactsCreated,
      evaluationJobsProcessed,
      promotionTransitionsProcessed,
    };
  }

  private async runReflections(workspace: Awaited<ReturnType<WorkspaceStore["get"]>>): Promise<number> {
    const limit = this.options.maxReflectionSignalsPerWorkspace ?? 4;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Evolution reflection drain limit is invalid");
    const worker = new EvolutionReflectionWorker(workspace.id, workspace.rootPath);
    let processed = 0;
    while (processed < limit && await worker.runNext(`${this.workerId}:reflection`)) processed += 1;
    return processed;
  }

  private async runDream(workspace: Awaited<ReturnType<WorkspaceStore["get"]>>): Promise<number> {
    const result = await new EvolutionDreamWorker(
      workspace.id,
      new PracticeDraftStore(workspace.id, workspace.rootPath, () => this.now()),
      new PracticeStore(workspace.id, workspace.rootPath, () => this.now()),
    ).run(2);
    return result.practicesProduced;
  }

  private async runBindings(workspace: Awaited<ReturnType<WorkspaceStore["get"]>>): Promise<number> {
    const result = await new PracticeBindingCompiler(
      workspace.id,
      new PracticeStore(workspace.id, workspace.rootPath, () => this.now()),
      new PracticeBindingStore(workspace.rootPath, () => this.now()),
      new EvolutionStore(workspace.id, workspace.rootPath, () => this.now()),
    ).compile();
    if (this.options.pluginArtifactAuthor) await new PluginAuthoringWorker(workspace.id, workspace.rootPath, this.options.pluginArtifactAuthor, () => this.now()).run();
    return result.bindingsProposed;
  }

  private async promotionContext(): Promise<{ companyId: string; proposals: ScopePromotionStore }> {
    const identity = await new CompanyIdentityStore(this.workspaces.homePath(), () => this.now()).getOrCreate();
    return { companyId: identity.companyId, proposals: new ScopePromotionStore(this.workspaces.homePath(), identity.companyId, () => this.now()) };
  }

  private async runProjectScopePromotions(workspace: Awaited<ReturnType<WorkspaceStore["get"]>>): Promise<number> {
    const { proposals } = await this.promotionContext();
    return (await new ScopePromotionCandidateCompiler(workspace.id, workspace.rootPath, proposals, new EvolutionStore(workspace.id, workspace.rootPath, () => this.now())).compileApprovedProjectPromotions()).candidatesCreated.length;
  }

  private async runSharedScopePromotions(): Promise<number> {
    const { companyId, proposals } = await this.promotionContext();
    const registry = new SharedEvolutionReleaseRegistry(this.workspaces.homePath(), companyId, proposals, () => this.now());
    let published = 0;
    for (const proposal of (await proposals.list()).filter((item) => item.status === "approved" && ["agent", "company"].includes(item.targetScope.ownerLevel))) {
      let sourceRoot: string;
      if (proposal.origin.ownerLevel === "agent") sourceRoot = globalEvolutionLayerRoot(this.workspaces.homePath(), "agent", proposal.origin.profileId!);
      else if (proposal.origin.workspaceId) sourceRoot = (await this.workspaces.get(proposal.origin.workspaceId)).rootPath;
      else throw new Error(`Scope promotion source is unresolved: ${proposal.proposalId}`);
      if ((await registry.publishApproved(proposal.proposalId, sourceRoot)).published) published += 1;
    }
    return published;
  }

  private async runMaintenance(workspace: Awaited<ReturnType<WorkspaceStore["get"]>>): Promise<void> {
    const maintenanceIntervalMs = this.options.maintenanceIntervalMs ?? 5 * 60_000;
    if (!Number.isSafeInteger(maintenanceIntervalMs) || maintenanceIntervalMs < 10_000) throw new Error("Evolution maintenance interval must be at least ten seconds");
    const bucket = Math.floor(this.now().getTime() / maintenanceIntervalMs);
    const jobs = new ExtractionJobStore(workspace.id, workspace.rootPath, () => this.now());
    await jobs.enqueue(`evolution-coordinator:${workspace.id}:maintenance:${bucket}`);
    await new ExtractionRunner(workspace, jobs).runNext(`${this.workerId}:extraction`);
    await new EvolutionSignalIngestor(workspace.id, workspace.rootPath).ingest();
    const experience = new ExperienceStore(workspace.id, workspace.rootPath);
    const candidates = new EvolutionStore(workspace.id, workspace.rootPath, () => this.now());
    const selectionEvaluations = new EvolutionEvaluationStore(workspace.id, workspace.rootPath, candidates, () => this.now());
    const selectionTelemetry = new EvolutionTelemetryStore(workspace.id, workspace.rootPath, candidates, selectionEvaluations, () => this.now());
    await new EvolutionAssetSelector(workspace.id, workspace.rootPath, experience, candidates, selectionTelemetry, () => this.now()).select(3);
    await this.prepareAutomatedEvaluations(workspace, candidates);
    await new MemoryLifecycleStore(workspace.id, workspace.rootPath, () => this.now()).maintain();
    await new CanaryTelemetryReconciler(workspace, () => this.now()).reconcile();
    await new CompanyTrialReconciler(this.workspaces.homePath(), workspace, () => this.now()).reconcile();
  }

  private async runEvaluations(workspace: Awaited<ReturnType<WorkspaceStore["get"]>>): Promise<number> {
    const programPath = this.options.evaluatorProgramPath;
    if (!programPath) return 0;
    const candidates = new EvolutionStore(workspace.id, workspace.rootPath, () => this.now());
    const evaluations = new EvolutionEvaluationStore(workspace.id, workspace.rootPath, candidates, () => this.now());
    const suites = new EvolutionEvalSuiteStore(workspace.id, workspace.rootPath, () => this.now());
    const jobs = new EvaluationJobStore(workspace.id, workspace.rootPath, () => this.now());
    const executor = new NodePermissionSandboxExecutor(workspace.id, workspace.rootPath, programPath, { now: () => this.now() });
    const runner = new EvaluationJobRunner(
      jobs,
      evaluations,
      new EvolutionEvaluationRunner(workspace.id, candidates, suites, evaluations, executor),
      this.options.evaluationLeaseMs ?? 30_000,
    );
    const limit = this.options.maxEvaluationJobsPerWorkspace ?? 4;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Evolution evaluation drain limit is invalid");
    let processed = 0;
    while (processed < limit) {
      const job = await runner.runNext(`${this.workerId}:evaluation`);
      if (!job) break;
      processed += 1;
    }
    return processed;
  }

  private async runPromotions(workspace: Awaited<ReturnType<WorkspaceStore["get"]>>): Promise<number> {
    const candidates = new EvolutionStore(workspace.id, workspace.rootPath, () => this.now());
    return this.advanceAutomatedPromotions(
      workspace,
      candidates,
      new EvolutionEvaluationStore(workspace.id, workspace.rootPath, candidates, () => this.now()),
      new EvolutionEvalSuiteStore(workspace.id, workspace.rootPath, () => this.now()),
    );
  }

  private async prepareAutomatedEvaluations(
    workspace: Awaited<ReturnType<WorkspaceStore["get"]>>,
    candidates: EvolutionStore,
  ): Promise<void> {
    for (const candidate of await candidates.list()) {
      if (candidate.status === "proposed") {
        await candidates.validate({
          commandId: `automatic-validation:${candidate.candidateId}:${candidate.contentHash}`,
          candidateId: candidate.candidateId,
          expectedContentHash: candidate.contentHash,
        });
      }
    }
    const suites = new EvolutionEvalSuiteStore(workspace.id, workspace.rootPath, () => this.now());
    const jobs = new EvaluationJobStore(workspace.id, workspace.rootPath, () => this.now());
    const suiteValues = await Promise.all((await suites.list()).map((ref) => suites.get(ref)));
    for (const candidate of await candidates.list()) {
      if (!["validated", "ready_for_eval"].includes(candidate.status)) continue;
      for (const suite of suiteValues.filter((value) => automationMatches(value, candidate))) {
        await candidates.markReadyForEvaluation({
          commandId: `automatic-suite-binding:${candidate.candidateId}:${suite.suiteRef.contentHash}`,
          candidateId: candidate.candidateId,
          expectedContentHash: candidate.contentHash,
          suiteRef: suite.suiteRef,
        });
        await jobs.enqueue(`automatic-evaluation:${candidate.candidateId}:${suite.suiteRef.contentHash}`, {
          candidateId: candidate.candidateId,
          expectedContentHash: candidate.contentHash,
          suiteRef: suite.suiteRef,
          baselineRef: suite.automation!.baselineRef,
          runtimeSnapshotRef: suite.automation!.runtimeSnapshotRef,
          evaluatorPrincipal: { type: "system", id: "evolution-evaluation-worker" },
        });
      }
    }
  }

  private async advanceAutomatedPromotions(
    workspace: Awaited<ReturnType<WorkspaceStore["get"]>>,
    candidates: EvolutionStore,
    evaluations: EvolutionEvaluationStore,
    suites: EvolutionEvalSuiteStore,
  ): Promise<number> {
    let transitions = 0;
    for (const evaluation of (await evaluations.listEvaluations()).filter((item) => item.decision === "pass")) {
      const suite = await suites.get(evaluation.suiteRef);
      if (!suite.automation) continue;
      const candidate = await candidates.get(evaluation.candidateId);
      let promotions = await evaluations.listPromotions();
      let shadow = promotions.find((item) => item.status === "active" && item.stage === "shadow" && item.candidateId === candidate.candidateId && item.toRelease.contentHash === candidate.contentHash);
      if (!shadow) {
        shadow = await evaluations.promote({
          commandId: `automatic-shadow:${evaluation.evaluationId}`,
          candidateId: candidate.candidateId, evaluationId: evaluation.evaluationId, expectedContentHash: candidate.contentHash,
          stage: "shadow", approvedBy: { type: "system", id: "evolution-coordinator/v1" }, policyRef: suite.automation.policyRef,
        });
        transitions += 1;
      }
      if (!(candidate.kind === "memory" && candidate.riskLevel === "low" && suite.automation.autoPromoteLowRiskMemory)) continue;
      promotions = await evaluations.listPromotions();
      let canary = promotions.find((item) => item.status === "active" && item.stage === "canary" && item.candidateId === candidate.candidateId && item.toRelease.contentHash === candidate.contentHash);
      if (!canary) {
        canary = await evaluations.promote({
          commandId: `automatic-canary:${evaluation.evaluationId}`,
          candidateId: candidate.candidateId, evaluationId: evaluation.evaluationId, expectedContentHash: candidate.contentHash,
          stage: "canary", fromPromotionId: shadow.promotionId, approvedBy: { type: "system", id: "evolution-coordinator/v1" }, policyRef: suite.automation.policyRef,
        });
        transitions += 1;
      }
      const telemetry = (await new EvolutionTelemetryStore(workspace.id, workspace.rootPath, candidates, evaluations, () => this.now()).list(candidate.candidateId))
        .find((item) => item.decision === "pass" && item.releaseRef.id === canary.toRelease.id && item.candidateHash === candidate.contentHash);
      if (!telemetry) continue;
      promotions = await evaluations.listPromotions();
      if (promotions.some((item) => item.status === "active" && item.stage === "production" && item.candidateId === candidate.candidateId && item.toRelease.contentHash === candidate.contentHash)) continue;
      await evaluations.promote({
        commandId: `automatic-production:${evaluation.evaluationId}:${telemetry.telemetryId}`,
        candidateId: candidate.candidateId, evaluationId: evaluation.evaluationId, expectedContentHash: candidate.contentHash,
        stage: "production", fromPromotionId: canary.promotionId, telemetryId: telemetry.telemetryId,
        approvedBy: { type: "system", id: "evolution-coordinator/v1" }, policyRef: suite.automation.policyRef,
      });
      transitions += 1;
    }
    return transitions;
  }

  private recordUnhandled(error: unknown): void {
    this.statusValue = { ...this.statusValue, running: false, lastError: safeMessage(error).slice(0, 2_000) };
    console.error("Evolution coordinator pass failed", error);
  }

  private now(): Date { return (this.options.now ?? (() => new Date()))(); }
}

function automationMatches(suite: EvolutionEvalSuite, candidate: EvolutionCandidate): boolean {
  return Boolean(suite.automation?.kinds.includes(candidate.kind)
    && (!suite.automation.targets?.length || suite.automation.targets.includes(candidate.target)));
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, " ");
}
