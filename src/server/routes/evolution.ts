import { randomUUID } from "node:crypto";
import { Router } from "express";
import type { CreateEvolutionCandidateInput } from "../../shared/contracts/evolution.js";
import { EvolutionStore } from "../evolution/evolution-store.js";
import { EvolutionEvaluationStore } from "../evolution/evaluation-store.js";
import { ExperienceStore } from "../evolution/experience-store.js";
import { ExtractionJobStore } from "../evolution/extraction-job-store.js";
import { ExtractionRunner } from "../evolution/extraction-runner.js";
import { EvolutionEvalSuiteStore } from "../evolution/eval-suite-store.js";
import { EvaluationJobStore } from "../evolution/evaluation-job-store.js";
import { EvolutionReleaseRegistry } from "../evolution/release-registry.js";
import { EvolutionTelemetryStore } from "../evolution/telemetry-store.js";
import { MemoryLifecycleStore } from "../evolution/memory-lifecycle-store.js";
import { MemoryUsageReconciler } from "../evolution/memory-usage-reconciler.js";
import { asyncHandler, HttpError } from "../errors.js";
import type { WorkspaceStore } from "../storage/workspace-store.js";
import type { EvolutionWorkerStatus } from "../../shared/contracts/evolution.js";
import { EvolutionActivationStore } from "../evolution/activation-store.js";
import { EvolutionAssetSelector } from "../evolution/asset-selector.js";
import { PracticeDraftStore } from "../evolution/practice-draft-store.js";
import { PracticeStore } from "../evolution/practice-store.js";
import { PracticeBindingStore } from "../evolution/practice-binding-store.js";
import { CompanyIdentityStore } from "../storage/company-identity-store.js";
import { ScopePromotionStore } from "../evolution/scope-promotion-store.js";
import { SharedEvolutionReleaseRegistry } from "../evolution/shared-release-registry.js";
import { ScopePromotionEvidenceService } from "../evolution/scope-promotion-evidence.js";
import { CompanyTrialStore } from "../evolution/company-trial-store.js";
import { CompanyTrialReleaseRegistry } from "../evolution/company-trial-registry.js";
import { CompanyTrialEvidenceStore } from "../evolution/company-trial-evidence-store.js";
import { PluginAuthoringJobStore } from "../evolution/plugin-authoring-job-store.js";
import { globalEvolutionLayerRoot } from "../storage/paths.js";
import { listWorkspaceAgents } from "../agents/roster.js";

export function createEvolutionRouter(workspaces: WorkspaceStore, workerStatus?: () => EvolutionWorkerStatus) {
  const router = Router({ mergeParams: true });
  const storeFor = async (workspaceId: string) => {
    const workspace = await workspaces.get(workspaceId);
    const organizationWorkspaceIds = workspace.organization
      ? (await workspaces.list()).filter((item) => item.organization?.id === workspace.organization!.id).map((item) => item.id)
      : [];
    const candidates = new EvolutionStore(workspace.id, workspace.rootPath, undefined, {
      organizationId: workspace.organization?.id,
      organizationWorkspaceIds,
    });
    return { candidates, evaluations: new EvolutionEvaluationStore(workspace.id, workspace.rootPath, candidates), suites: new EvolutionEvalSuiteStore(workspace.id, workspace.rootPath) };
  };

  router.get("/worker", (_req, res) => res.json({
    worker: workerStatus?.() ?? { running: false, evaluatorConfigured: false, workspacesScanned: 0, reflectionSignalsProcessed: 0, dreamPracticesProduced: 0, practiceBindingsCreated: 0, scopePromotionArtifactsCreated: 0, evaluationJobsProcessed: 0, promotionTransitionsProcessed: 0 },
  }));

  router.get("/candidates", asyncHandler(async (req, res) => res.json({ candidates: await (await storeFor(String(req.params.workspaceId))).candidates.list() })));
  router.get("/eval-suites", asyncHandler(async (req, res) => res.json({ suites: await (await storeFor(String(req.params.workspaceId))).suites.list() })));
  router.post("/eval-suites", asyncHandler(async (req, res) => {
    const workspaceId = String(req.params.workspaceId);
    const cases = Array.isArray(req.body?.cases) ? req.body.cases.map((item: Record<string, unknown>) => ({
      ...item,
      inputRef: item.inputRef && typeof item.inputRef === "object" ? { ...(item.inputRef as Record<string, unknown>), workspaceId } : item.inputRef,
    })) : req.body?.cases;
    const suite = await (await storeFor(workspaceId)).suites.create({ id: req.body?.id, version: req.body?.version, title: req.body?.title, cases, ...(req.body?.automation ? { automation: req.body.automation } : {}) });
    res.status(201).json({ suite });
  }));
  router.get("/evaluation-jobs", asyncHandler(async (req, res) => {
    const workspace = await workspaces.get(String(req.params.workspaceId));
    res.json({ jobs: await new EvaluationJobStore(workspace.id, workspace.rootPath).list() });
  }));
  router.get("/memories", asyncHandler(async (req, res) => {
    const workspace = await workspaces.get(String(req.params.workspaceId));
    res.json({ memories: await new MemoryLifecycleStore(workspace.id, workspace.rootPath).list() });
  }));
  router.post("/memories/:releaseId/pin", asyncHandler(async (req, res) => {
    const workspace = await workspaces.get(String(req.params.workspaceId));
    const state = await new MemoryLifecycleStore(workspace.id, workspace.rootPath).pin(
      typeof req.body?.commandId === "string" ? req.body.commandId : randomUUID(), String(req.params.releaseId),
      req.body?.pinned === true, { type: "human", id: principalId(req) },
    );
    res.json({ memory: state });
  }));
  router.post("/memories/:releaseId/restore", asyncHandler(async (req, res) => {
    const workspace = await workspaces.get(String(req.params.workspaceId));
    const state = await new MemoryLifecycleStore(workspace.id, workspace.rootPath).transition(
      typeof req.body?.commandId === "string" ? req.body.commandId : randomUUID(), String(req.params.releaseId), "active",
      typeof req.body?.reason === "string" && req.body.reason.trim() ? req.body.reason : "Human restored after review",
      { type: "human", id: principalId(req) },
    );
    res.json({ memory: state });
  }));
  router.post("/memories/maintenance", asyncHandler(async (req, res) => {
    const workspace = await workspaces.get(String(req.params.workspaceId));
    const memories = await new MemoryLifecycleStore(workspace.id, workspace.rootPath).maintain({
      ...(req.body?.staleAfterDays !== undefined ? { staleAfterDays: Number(req.body.staleAfterDays) } : {}),
      ...(req.body?.archiveAfterDays !== undefined ? { archiveAfterDays: Number(req.body.archiveAfterDays) } : {}),
    });
    res.json({ memories });
  }));
  router.post("/memories/reconcile-usage", asyncHandler(async (req, res) => {
    const workspace = await workspaces.get(String(req.params.workspaceId));
    res.json({ result: await new MemoryUsageReconciler(workspace).reconcile() });
  }));
  router.post("/candidates/:candidateId/evaluation-jobs", asyncHandler(async (req, res) => {
    const workspaceId = String(req.params.workspaceId);
    const stores = await storeFor(workspaceId);
    const candidate = await stores.candidates.get(String(req.params.candidateId));
    const expectedContentHash = String(req.body?.expectedContentHash ?? "");
    if (!["validated", "ready_for_eval"].includes(candidate.status) || candidate.contentHash !== expectedContentHash) throw new HttpError(409, "Evaluation job requires the validated immutable candidate revision", "EVOLUTION_CONFLICT");
    await stores.suites.get(req.body?.suiteRef);
    const commandId = typeof req.body?.commandId === "string" ? req.body.commandId : randomUUID();
    await stores.candidates.markReadyForEvaluation({ commandId: `${commandId}:candidate-ready`, candidateId: candidate.candidateId, expectedContentHash, suiteRef: req.body.suiteRef });
    const workspace = await workspaces.get(workspaceId);
    const job = await new EvaluationJobStore(workspace.id, workspace.rootPath).enqueue(
      commandId,
      {
        candidateId: candidate.candidateId, expectedContentHash, suiteRef: req.body.suiteRef,
        baselineRef: req.body.baselineRef, runtimeSnapshotRef: req.body.runtimeSnapshotRef,
        evaluatorPrincipal: { type: "system", id: "evolution-evaluation-worker" },
      },
      req.body?.maxAttempts === undefined ? 3 : Number(req.body.maxAttempts),
    );
    res.status(202).json({ job });
  }));
  router.get("/episodes", asyncHandler(async (req, res) => {
    const workspace = await workspaces.get(String(req.params.workspaceId));
    const store = new ExperienceStore(workspace.id, workspace.rootPath);
    res.json({ episodes: await store.listEpisodes(), attributions: await store.listAttributions() });
  }));
  router.get("/practices", asyncHandler(async (req, res) => {
    const workspace = await workspaces.get(String(req.params.workspaceId));
    res.json({
      drafts: await new PracticeDraftStore(workspace.id, workspace.rootPath).list(),
      practices: await new PracticeStore(workspace.id, workspace.rootPath).list(),
      bindings: await new PracticeBindingStore(workspace.rootPath).list(),
      pluginAuthoringJobs: await new PluginAuthoringJobStore(workspace.rootPath).list(),
    });
  }));
  router.get("/scope-promotions", asyncHandler(async (_req, res) => {
    const identity = await new CompanyIdentityStore(workspaces.homePath()).getOrCreate();
    const proposals = new ScopePromotionStore(workspaces.homePath(), identity.companyId);
    const trials = new CompanyTrialStore(workspaces.homePath(), identity.companyId);
    const evidence = new CompanyTrialEvidenceStore(workspaces.homePath(), identity.companyId, trials, proposals);
    res.json({ company: identity, proposals: await proposals.list(), trials: await trials.list(), trialEvidence: await evidence.list() });
  }));
  router.post("/scope-promotions/:proposalId/trials", asyncHandler(async (req, res) => {
    const identity = await new CompanyIdentityStore(workspaces.homePath()).getOrCreate();
    const proposals = new ScopePromotionStore(workspaces.homePath(), identity.companyId);
    const proposal = await proposals.get(String(req.params.proposalId));
    const target = await workspaces.get(String(req.body?.targetWorkspaceId ?? ""));
    const targetProfileId = String(req.body?.targetProfileId ?? "");
    const targetAgent = (await listWorkspaceAgents(target)).find((agent) => agent.profileId === targetProfileId);
    if (!targetAgent) throw new HttpError(409, "Company trial target Agent is not assigned to the target project", "COMPANY_TRIAL_AGENT_NOT_FOUND");
    const sourceRoot = proposal.origin.ownerLevel === "agent"
      ? globalEvolutionLayerRoot(workspaces.homePath(), "agent", proposal.origin.profileId ?? "")
      : (await workspaces.get(proposal.origin.workspaceId ?? "")).rootPath;
    const trial = await new CompanyTrialReleaseRegistry(workspaces.homePath(), identity.companyId, proposals).deploy({
      commandId: typeof req.body?.commandId === "string" ? req.body.commandId : randomUUID(), proposalId: proposal.proposalId,
      sourceRoot, targetWorkspaceId: target.id, targetWorkspaceRoot: target.rootPath, targetProfileId, targetAgentId: targetAgent.id,
      ...(req.body?.percentage !== undefined ? { percentage: Number(req.body.percentage) } : {}),
      ...(typeof req.body?.salt === "string" ? { salt: req.body.salt } : {}),
      ...(req.body?.minimumSamplesPerArm !== undefined ? { minimumSamplesPerArm: Number(req.body.minimumSamplesPerArm) } : {}),
    });
    res.status(201).json({ trial, proposal: await proposals.get(proposal.proposalId) });
  }));
  router.post("/scope-promotions", asyncHandler(async (req, res) => {
    const workspaceId = String(req.params.workspaceId);
    await workspaces.get(workspaceId);
    const identity = await new CompanyIdentityStore(workspaces.homePath()).getOrCreate();
    const registeredWorkspaces = (await workspaces.list()).map((item) => ({ id: item.id, rootPath: item.rootPath }));
    const targetScope = { ...(req.body?.targetScope ?? {}) };
    if (targetScope.ownerLevel === "project" || targetScope.ownerLevel === "agent_project") targetScope.workspaceId = workspaceId;
    const evidence = new ScopePromotionEvidenceService(workspaces.homePath(), identity.companyId, registeredWorkspaces);
    const proposal = await new ScopePromotionStore(workspaces.homePath(), identity.companyId, undefined, evidence.verifier()).propose({
      commandId: typeof req.body?.commandId === "string" ? req.body.commandId : randomUUID(), companyId: identity.companyId,
      origin: req.body?.origin, targetScope, originReleaseRef: req.body?.originReleaseRef, practiceRef: req.body?.practiceRef,
      inheritanceProofRefs: req.body?.inheritanceProofRefs, effectWindowRefs: req.body?.effectWindowRefs, generalizationRisks: req.body?.generalizationRisks ?? [],
    });
    res.status(201).json({ proposal });
  }));
  router.post("/scope-promotions/:proposalId/transition", asyncHandler(async (req, res) => {
    const identity = await new CompanyIdentityStore(workspaces.homePath()).getOrCreate();
    const proposal = await new ScopePromotionStore(workspaces.homePath(), identity.companyId).transition(
      typeof req.body?.commandId === "string" ? req.body.commandId : randomUUID(), String(req.params.proposalId), req.body?.status,
      { type: "human", id: principalId(req) },
    );
    res.json({ proposal });
  }));
  router.post("/scope-promotions/:proposalId/rollback", asyncHandler(async (req, res) => {
    const identity = await new CompanyIdentityStore(workspaces.homePath()).getOrCreate();
    const proposals = new ScopePromotionStore(workspaces.homePath(), identity.companyId);
    const pointer = await new SharedEvolutionReleaseRegistry(workspaces.homePath(), identity.companyId, proposals).rollback(
      String(req.params.proposalId), { type: "human", id: principalId(req) },
    );
    res.json({ pointer });
  }));
  router.post("/episodes/reconcile", asyncHandler(async (req, res) => {
    const workspace = await workspaces.get(String(req.params.workspaceId));
    const jobs = new ExtractionJobStore(workspace.id, workspace.rootPath);
    const commandId = typeof req.body?.commandId === "string" ? req.body.commandId : randomUUID();
    const queued = await jobs.enqueue(commandId);
    const job = queued.status === "succeeded" ? queued : await new ExtractionRunner(workspace, jobs).runNext(`api:${principalId(req)}`) ?? queued;
    res.status(job.status === "succeeded" ? 200 : 202).json({ job });
  }));
  router.get("/extraction-jobs", asyncHandler(async (req, res) => {
    const workspace = await workspaces.get(String(req.params.workspaceId));
    res.json({ jobs: await new ExtractionJobStore(workspace.id, workspace.rootPath).list() });
  }));
  router.get("/asset-selections", asyncHandler(async (req, res) => {
    const workspace = await workspaces.get(String(req.params.workspaceId));
    const stores = await storeFor(workspace.id);
    const experience = new ExperienceStore(workspace.id, workspace.rootPath);
    const telemetry = new EvolutionTelemetryStore(workspace.id, workspace.rootPath, stores.candidates, stores.evaluations);
    res.json({ selections: await new EvolutionAssetSelector(workspace.id, workspace.rootPath, experience, stores.candidates, telemetry).list() });
  }));
  router.post("/asset-selections/reconcile", asyncHandler(async (req, res) => {
    const workspace = await workspaces.get(String(req.params.workspaceId));
    const stores = await storeFor(workspace.id);
    const experience = new ExperienceStore(workspace.id, workspace.rootPath);
    const telemetry = new EvolutionTelemetryStore(workspace.id, workspace.rootPath, stores.candidates, stores.evaluations);
    const result = await new EvolutionAssetSelector(workspace.id, workspace.rootPath, experience, stores.candidates, telemetry).select(
      req.body?.minimumEpisodes === undefined ? 3 : Number(req.body.minimumEpisodes),
    );
    res.json({ result });
  }));
  router.get("/candidates/:candidateId", asyncHandler(async (req, res) => res.json({ candidate: await (await storeFor(String(req.params.workspaceId))).candidates.get(String(req.params.candidateId)) })));
  router.post("/candidates", asyncHandler(async (req, res) => {
    const workspaceId = String(req.params.workspaceId);
    const input = {
      ...req.body,
      commandId: typeof req.body?.commandId === "string" ? req.body.commandId : randomUUID(),
      proposedBy: { type: "human", id: "api-user" },
      scope: { ...(req.body?.scope ?? {}), workspaceId },
      sourceRefs: Array.isArray(req.body?.sourceRefs) ? req.body.sourceRefs.map((ref: object) => ({ ...ref, workspaceId })) : req.body?.sourceRefs,
    } as CreateEvolutionCandidateInput;
    const candidate = await (await storeFor(workspaceId)).candidates.create(input);
    res.status(201).json({ candidate });
  }));
  router.post("/candidates/:candidateId/validate", asyncHandler(async (req, res) => {
    const candidate = await (await storeFor(String(req.params.workspaceId))).candidates.validate({
      commandId: typeof req.body?.commandId === "string" ? req.body.commandId : randomUUID(),
      candidateId: String(req.params.candidateId),
      expectedContentHash: String(req.body?.expectedContentHash ?? ""),
    });
    res.json({ candidate });
  }));
  router.get("/candidates/:candidateId/evaluations", asyncHandler(async (req, res) => {
    res.json({ evaluations: await (await storeFor(String(req.params.workspaceId))).evaluations.listEvaluations(String(req.params.candidateId)) });
  }));
  router.get("/candidates/:candidateId/telemetry", asyncHandler(async (req, res) => {
    const workspaceId = String(req.params.workspaceId);
    const stores = await storeFor(workspaceId);
    const workspace = await workspaces.get(workspaceId);
    res.json({ telemetry: await new EvolutionTelemetryStore(workspace.id, workspace.rootPath, stores.candidates, stores.evaluations).list(String(req.params.candidateId)) });
  }));
  router.get("/candidates/:candidateId/active-releases", asyncHandler(async (req, res) => {
    const workspaceId = String(req.params.workspaceId);
    const stores = await storeFor(workspaceId);
    const workspace = await workspaces.get(workspaceId);
    const candidate = await stores.candidates.get(String(req.params.candidateId));
    const registry = new EvolutionReleaseRegistry(workspace.rootPath);
    res.json({ canary: await registry.current("canary", candidate), production: await registry.current("production", candidate) });
  }));
  router.post("/candidates/:candidateId/promotions", asyncHandler(async (req, res) => {
    const record = await (await storeFor(String(req.params.workspaceId))).evaluations.promote({
      ...req.body,
      commandId: typeof req.body?.commandId === "string" ? req.body.commandId : randomUUID(),
      candidateId: String(req.params.candidateId),
      approvedBy: { type: "human", id: principalId(req) },
    });
    res.status(201).json({ promotion: record });
  }));
  router.get("/releases", asyncHandler(async (req, res) => {
    res.json({ releases: await (await storeFor(String(req.params.workspaceId))).evaluations.listPromotions() });
  }));
  router.get("/activations", asyncHandler(async (req, res) => {
    const workspace = await workspaces.get(String(req.params.workspaceId));
    const store = new EvolutionActivationStore(workspace.rootPath);
    res.json({ activations: await store.list(), proofs: await store.listProofs() });
  }));
  router.post("/releases/:promotionId/rollback", asyncHandler(async (req, res) => {
    const record = await (await storeFor(String(req.params.workspaceId))).evaluations.rollback(
      typeof req.body?.commandId === "string" ? req.body.commandId : randomUUID(),
      String(req.params.promotionId),
      { type: "human", id: principalId(req) },
    );
    res.json({ promotion: record });
  }));
  return router;
}

function principalId(req: { header(name: string): string | undefined }): string {
  return req.header("x-autoagent-principal-id")?.trim() || "api-user";
}
