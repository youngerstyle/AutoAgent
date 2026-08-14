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
import { MemoryConsolidator } from "./memory-consolidator.js";
import { PromptConsolidator } from "./prompt-consolidator.js";
import { SkillConsolidator } from "./skill-consolidator.js";
import { MemoryLifecycleStore } from "./memory-lifecycle-store.js";
import type { EvolutionWorkerStatus } from "../../shared/contracts/evolution.js";
import { CanaryTelemetryReconciler } from "./canary-telemetry-reconciler.js";
import { EvolutionTelemetryStore } from "./telemetry-store.js";
import type { EvolutionCandidate, EvolutionEvalSuite } from "../../shared/contracts/evolution.js";

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
      now?: () => Date;
      workerId?: string;
    } = {},
  ) {
    this.workerId = options.workerId ?? `evolution-coordinator:${os.hostname()}:${process.pid}`;
    this.statusValue = {
      running: false,
      evaluatorConfigured: Boolean(options.evaluatorProgramPath),
      workspacesScanned: 0,
      evaluationJobsProcessed: 0,
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
    let evaluationJobsProcessed = 0;
    const errors: string[] = [];
    for (const workspace of await this.workspaces.list()) {
      workspacesScanned += 1;
      try {
        await this.runMaintenance(workspace);
      } catch (error) {
        errors.push(`${workspace.id}/maintenance: ${safeMessage(error)}`);
      }
      try {
        evaluationJobsProcessed += await this.runEvaluations(workspace);
      } catch (error) {
        errors.push(`${workspace.id}/evaluation: ${safeMessage(error)}`);
      }
    }
    this.statusValue = {
      running: false,
      evaluatorConfigured: Boolean(this.options.evaluatorProgramPath),
      lastStartedAt: startedAt,
      lastCompletedAt: this.now().toISOString(),
      ...(errors.length ? { lastError: errors.join("; ").slice(0, 2_000) } : {}),
      workspacesScanned,
      evaluationJobsProcessed,
    };
  }

  private async runMaintenance(workspace: Awaited<ReturnType<WorkspaceStore["get"]>>): Promise<void> {
    const maintenanceIntervalMs = this.options.maintenanceIntervalMs ?? 5 * 60_000;
    if (!Number.isSafeInteger(maintenanceIntervalMs) || maintenanceIntervalMs < 10_000) throw new Error("Evolution maintenance interval must be at least ten seconds");
    const bucket = Math.floor(this.now().getTime() / maintenanceIntervalMs);
    const jobs = new ExtractionJobStore(workspace.id, workspace.rootPath, () => this.now());
    await jobs.enqueue(`evolution-coordinator:${workspace.id}:maintenance:${bucket}`);
    await new ExtractionRunner(workspace, jobs).runNext(`${this.workerId}:extraction`);
    const experience = new ExperienceStore(workspace.id, workspace.rootPath);
    const candidates = new EvolutionStore(workspace.id, workspace.rootPath, () => this.now());
    await new MemoryConsolidator(workspace.id, experience, candidates).consolidate(2);
    await new PromptConsolidator(workspace.id, experience, candidates).consolidate(2);
    await new SkillConsolidator(workspace.id, experience, candidates).consolidate(2);
    await this.prepareAutomatedEvaluations(workspace, candidates);
    await new MemoryLifecycleStore(workspace.id, workspace.rootPath, () => this.now()).maintain();
    await new CanaryTelemetryReconciler(workspace, () => this.now()).reconcile();
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
    await this.advanceAutomatedPromotions(workspace, candidates, evaluations, suites);
    return processed;
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
  ): Promise<void> {
    for (const evaluation of (await evaluations.listEvaluations()).filter((item) => item.decision === "pass")) {
      const suite = await suites.get(evaluation.suiteRef);
      if (!suite.automation) continue;
      const candidate = await candidates.get(evaluation.candidateId);
      let promotions = await evaluations.listPromotions();
      let shadow = promotions.find((item) => item.status === "active" && item.stage === "shadow" && item.candidateId === candidate.candidateId && item.toRelease.contentHash === candidate.contentHash);
      shadow ??= await evaluations.promote({
        commandId: `automatic-shadow:${evaluation.evaluationId}`,
        candidateId: candidate.candidateId, evaluationId: evaluation.evaluationId, expectedContentHash: candidate.contentHash,
        stage: "shadow", approvedBy: { type: "system", id: "evolution-coordinator/v1" }, policyRef: suite.automation.policyRef,
      });
      if (!(candidate.kind === "memory" && candidate.riskLevel === "low" && suite.automation.autoPromoteLowRiskMemory)) continue;
      promotions = await evaluations.listPromotions();
      let canary = promotions.find((item) => item.status === "active" && item.stage === "canary" && item.candidateId === candidate.candidateId && item.toRelease.contentHash === candidate.contentHash);
      canary ??= await evaluations.promote({
        commandId: `automatic-canary:${evaluation.evaluationId}`,
        candidateId: candidate.candidateId, evaluationId: evaluation.evaluationId, expectedContentHash: candidate.contentHash,
        stage: "canary", fromPromotionId: shadow.promotionId, approvedBy: { type: "system", id: "evolution-coordinator/v1" }, policyRef: suite.automation.policyRef,
      });
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
    }
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
