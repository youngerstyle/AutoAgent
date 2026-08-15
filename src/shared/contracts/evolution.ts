export const EVOLUTION_ARTIFACT_KINDS = ["memory", "skill", "agent_profile", "prompt", "workflow", "runtime_config", "plugin", "harness"] as const;
export type EvolutionArtifactKind = typeof EVOLUTION_ARTIFACT_KINDS[number];

export const EVOLUTION_ACTIVATION_BOUNDARIES = ["next_turn", "next_session", "next_task", "next_restart"] as const;
export type EvolutionActivationBoundary = typeof EVOLUTION_ACTIVATION_BOUNDARIES[number];

export const DEFAULT_EVOLUTION_ACTIVATION_BOUNDARY: Record<EvolutionArtifactKind, EvolutionActivationBoundary> = {
  memory: "next_turn",
  prompt: "next_turn",
  skill: "next_turn",
  agent_profile: "next_session",
  plugin: "next_session",
  harness: "next_session",
  workflow: "next_task",
  runtime_config: "next_restart",
};

export const EVOLUTION_SOURCE_KINDS = [
  "trace", "evidence", "goal_proposal", "goal_decision", "ticket", "mission", "human_feedback",
] as const;
export type EvolutionSourceKind = typeof EVOLUTION_SOURCE_KINDS[number];

export type EvolutionRiskLevel = "low" | "medium" | "high" | "critical";
export type EvolutionCandidateStatus = "proposed" | "validated" | "rejected" | "ready_for_eval";

export interface EvolutionSourceRef {
  kind: EvolutionSourceKind;
  ref: string;
  workspaceId: string;
  taskId?: string;
  taskRunId?: string;
  agentId?: string;
  profileId?: string;
}

export interface EvolutionScope {
  workspaceId: string;
  ownerLevel?: "agent_project" | "agent" | "project" | "company";
  profileId?: string;
  organization?: {
    id: string;
    /** Explicit target workspaces; each target must independently trust the source workspace. */
    workspaceIds: string[];
  };
  roles?: string[];
  taskTypes?: string[];
  tools?: string[];
  providers?: string[];
  models?: string[];
}

export interface MetricExpectation {
  metric: string;
  direction: "increase" | "decrease" | "maintain";
  minimumDelta?: number;
  maximumRegression?: number;
}

export interface EvolutionPrincipalRef {
  type: "agent" | "human" | "system";
  id: string;
}

export type ExperienceOutcome = "succeeded" | "returned" | "failed" | "blocked" | "cancelled";

export type EvolutionSignalTrigger = "terminal_outcome" | "user_correction" | "recovered_failure" | "novel_success"
  | "practice_feedback" | "context_compaction" | "effect_observation" | "manual";
export type EvolutionSignalStatus = "pending" | "running" | "retry_wait" | "succeeded" | "dead_letter";

export interface EvolutionSignal {
  signalId: string;
  commandId: string;
  workspaceId: string;
  profileId?: string;
  episodeId?: string;
  trigger: EvolutionSignalTrigger;
  priority: 0 | 1 | 2 | 3 | 4;
  sourceRefs: EvolutionSourceRef[];
  salience: number;
  novelty: number;
  status: EvolutionSignalStatus;
  attempts: number;
  maxAttempts: number;
  occurredAt: string;
  createdAt: string;
  updatedAt: string;
  nextAttemptAt?: string;
  lease?: { token: string; workerId: string; heartbeatAt: string; expiresAt: string };
  lastError?: { category: "transient" | "terminal"; message: string };
}

export interface EvolutionPracticeScope {
  ownerLevel: "agent_project" | "agent" | "project" | "company";
  workspaceId?: string;
  profileId?: string;
  roles?: string[];
  taskTypes?: string[];
}

export interface EvolutionPracticeDraft {
  draftId: string;
  commandId: string;
  signalId: string;
  statement: string;
  trigger: string;
  procedure: string;
  expectedOutcome: MetricExpectation[];
  /** Optional only for drafts persisted before Practice/Binding separation. */
  observedComponents?: AttributionComponent[];
  applicability: EvolutionPracticeScope;
  contraindications: string[];
  sourceEpisodeRefs: string[];
  sourceRefs: EvolutionSourceRef[];
  provenanceHash: string;
  status: "draft" | "consolidated" | "rejected";
  createdAt: string;
  updatedAt: string;
}

export interface EvolutionPractice {
  practiceId: string;
  version: number;
  statement: string;
  trigger: string;
  procedure: string;
  expectedOutcome: MetricExpectation[];
  observedComponents: AttributionComponent[];
  applicability: EvolutionPracticeScope;
  contraindications: string[];
  sourceDraftRefs: string[];
  sourceEpisodeRefs: string[];
  sourceRefs: EvolutionSourceRef[];
  provenanceHash: string;
  status: "candidate" | "released" | "retired" | "rejected";
  createdAt: string;
  updatedAt: string;
}

export interface ExperienceEpisode {
  episodeId: string;
  workspaceId: string;
  taskId: string;
  taskRunId: string;
  ticketId: string;
  attemptId: string;
  goalId: string;
  agentId: string;
  /** Stable company-level Agent identity captured before a Workspace instance can disappear. */
  profileId: string;
  outcome: ExperienceOutcome;
  sourceRefs: EvolutionSourceRef[];
  startedAt: string;
  endedAt: string;
  contentHash: string;
}

export type AttributionComponent = "memory" | "prompt" | "skill" | "agent_profile" | "workflow" | "runtime_config" | "tool" | "provider" | "plan" | "policy" | "environment" | "unknown";

export interface FailedEvolutionAttemptRef {
  telemetryId: string;
  candidateId: string;
  releaseRef: VersionedEvolutionRef;
}

export interface ExperienceAttribution {
  attributionId: string;
  episodeId: string;
  symptom: string;
  component: AttributionComponent;
  cause: string;
  confidence: number;
  sourceRefs: EvolutionSourceRef[];
  counterEvidenceRefs: EvolutionSourceRef[];
  /** A verified failed lower-level release that justifies considering a more invasive asset. */
  failedEvolutionAttempts?: FailedEvolutionAttemptRef[];
  scope: EvolutionScope;
  createdAt: string;
  redaction?: { count: number; policyRef: string };
}

export type ExtractionJobStatus = "pending" | "running" | "retry_wait" | "succeeded" | "dead_letter";

export interface ExtractionJob {
  jobId: string;
  commandId: string;
  workspaceId: string;
  kind: "experience_reconcile";
  status: ExtractionJobStatus;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
  nextAttemptAt?: string;
  lease?: { token: string; workerId: string; heartbeatAt: string; expiresAt: string };
  result?: { inspectedTickets: number; recordedEpisodes: number; skippedTickets: number; memoryUsagesRecorded?: number };
  lastError?: { category: "transient" | "terminal"; message: string };
}

export interface AuthoritativeEpisodeFacts {
  commandId: string;
  workspaceId: string;
  taskId: string;
  taskRunId: string;
  ticket: {
    ticketId: string;
    attemptId: string;
    status: "completed" | "returned" | "failed" | "dead_letter" | "cancelled" | "pending" | "running" | "blocked";
    startedAt: string;
    updatedAt: string;
  };
  goal: {
    goalId: string;
    agentId: string;
    profileId: string;
    status: "completed" | "failed" | "blocked" | "cancelled" | "active" | "paused" | "resolving";
  };
  sourceRefs: EvolutionSourceRef[];
  failures?: Array<{
    component: Exclude<AttributionComponent, "unknown">;
    symptom: string;
    cause: string;
    sourceRefs: EvolutionSourceRef[];
    failedEvolutionAttempts?: FailedEvolutionAttemptRef[];
  }>;
}

export interface EvolutionAssetSelectionRecord {
  selectionId: string;
  workspaceId: string;
  selectedKind: "agent_profile" | "workflow" | "runtime_config";
  status: "eligible_for_authoring" | "insufficient_evidence";
  episodeIds: string[];
  attributionIds: string[];
  verifiedFailedAttempts: FailedEvolutionAttemptRef[];
  reason: string;
  createdAt: string;
}

export interface EvolutionValidationCheck {
  name: string;
  passed: boolean;
  message: string;
}

export type SkillCapability = "network" | "shell" | "process" | "filesystem-write";
export type SkillScanSeverity = "low" | "medium" | "high" | "critical";

export interface SkillScanFinding {
  ruleId: string;
  severity: SkillScanSeverity;
  message: string;
  line?: number;
}

export interface SkillScanReport {
  scannerRef: VersionedEvolutionRef;
  candidateHash: string;
  decision: "pass" | "review" | "block";
  declaredCapabilities: SkillCapability[];
  detectedCapabilities: SkillCapability[];
  findings: SkillScanFinding[];
  scannedAt: string;
}

export interface SkillArtifactManifest {
  schemaVersion: 1;
  kind: "skill";
  name: string;
  version: string;
  entrypoint: "SKILL.md";
  contentHash: string;
  scope: EvolutionScope;
  requiredTools: string[];
  riskLevel: EvolutionRiskLevel;
  sourceRefs: EvolutionSourceRef[];
  files: Array<{ path: "SKILL.md"; sha256: string }>;
  compatibility: { runtime: "autoagent"; manifestVersion: 1 };
  declaredCapabilities: SkillCapability[];
  scanner: SkillScanReport;
}

export type PluginCapability = "workspace.read";
export type PluginContributionKind = "plugin" | "harness";

export interface PluginToolContribution {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface PluginGuardrailContribution {
  name: string;
  phase: "pre_tool" | "post_tool";
  tools: string[];
}

export interface PluginBundleManifest {
  id: string;
  version: string;
  kind: PluginContributionKind;
  apiVersion: "autoagent.plugin/v1";
  entrypoint: string;
  description: string;
  permissions: { workspaceRead: string[] };
  contributions: { tools: PluginToolContribution[]; guardrails: PluginGuardrailContribution[] };
  lifecycle: { activation: "onDemand"; invokeTimeoutMs: number };
}

export interface PluginBundle {
  schemaVersion: 1;
  manifest: PluginBundleManifest;
  files: Array<{ path: string; content: string }>;
}

export interface PluginScanFinding {
  ruleId: string;
  severity: SkillScanSeverity;
  message: string;
  path?: string;
  line?: number;
}

export interface PluginScanReport {
  scannerRef: VersionedEvolutionRef;
  candidateHash: string;
  decision: "pass" | "review" | "block";
  declaredCapabilities: PluginCapability[];
  detectedCapabilities: string[];
  findings: PluginScanFinding[];
  scannedAt: string;
}

export interface PluginArtifactManifest {
  schemaVersion: 1;
  kind: PluginContributionKind;
  name: string;
  version: string;
  apiVersion: "autoagent.plugin/v1";
  entrypoint: string;
  contentHash: string;
  scope: EvolutionScope;
  riskLevel: "critical";
  sourceRefs: EvolutionSourceRef[];
  permissions: PluginBundleManifest["permissions"];
  contributions: PluginBundleManifest["contributions"];
  lifecycle: PluginBundleManifest["lifecycle"];
  files: Array<{ path: string; sha256: string; bytes: number }>;
  compatibility: { runtime: "autoagent"; manifestVersion: 1; hostApi: "autoagent.plugin/v1" };
  scanner: PluginScanReport;
}

export interface EvolutionCandidate {
  candidateId: string;
  revision: number;
  kind: EvolutionArtifactKind;
  target: string;
  title: string;
  rationale: string;
  baseVersion?: string;
  artifactRef: string;
  contentHash: string;
  hypothesis: string;
  sourceRefs: EvolutionSourceRef[];
  scope: EvolutionScope;
  expectedMetrics: MetricExpectation[];
  riskLevel: EvolutionRiskLevel;
  status: EvolutionCandidateStatus;
  proposedBy: EvolutionPrincipalRef;
  practiceRef?: VersionedEvolutionRef;
  mutationSet?: EvolutionMutationSet;
  createdAt: string;
  updatedAt: string;
  validation?: {
    passed: boolean;
    checkedAt: string;
    checks: EvolutionValidationCheck[];
    scanner?: SkillScanReport;
    pluginScanner?: PluginScanReport;
    artifactManifestRef?: string;
    artifactManifestHash?: string;
  };
  evaluationSuiteRefs?: VersionedEvolutionRef[];
}

export interface EvolutionMutationSet {
  assetKind: EvolutionArtifactKind;
  target: string;
  baseRef: VersionedEvolutionRef;
  candidateRef: VersionedEvolutionRef;
  representation: "full" | "json_patch";
  activationBoundary: EvolutionActivationBoundary;
  compatibility: Record<string, string>;
  rollbackRef: VersionedEvolutionRef;
}

/**
 * Workspace runtime tuning that is safe to inherit at process restart.
 * Credentials, provider/model selection, policy, filesystem paths, and code
 * loading are intentionally outside this contract.
 */
export interface EvolutionRuntimeConfigArtifact {
  schemaVersion: 1;
  target: "runtime-host";
  settings: {
    intervalMs?: number;
    providerRetryBaseMs?: number;
    providerRetryMaxMs?: number;
    staffingProviderFailureLimit?: number;
    staffingProviderRetryBaseMs?: number;
    staffingProviderRetryMaxMs?: number;
  };
}

export interface EvolutionAgentProfileArtifact {
  schemaVersion: 1;
  id: string;
  identity?: string;
  soul?: string;
  agentMd?: string;
  capabilities?: string[];
  defaultSkills?: string[];
  defaultProvider?: "mock" | "openai" | "anthropic";
  defaultModel?: string;
  defaultPolicy?: {
    canReadWorkspace?: boolean;
    canWriteWorkspace?: boolean;
    canExecuteCommands?: boolean;
    enabledTools?: Array<"listFiles" | "readFile" | "readImage" | "writeFile" | "editFile" | "shell" | "startService" | "pollProcess" | "browser">;
    allowHostAccess?: boolean;
    commandAllowlist?: string[];
  };
}

export interface CreateEvolutionCandidateInput {
  commandId: string;
  kind: EvolutionArtifactKind;
  target: string;
  title: string;
  rationale: string;
  hypothesis: string;
  artifactContent: string;
  baseVersion?: string;
  sourceRefs: EvolutionSourceRef[];
  scope: EvolutionScope;
  expectedMetrics: MetricExpectation[];
  riskLevel: EvolutionRiskLevel;
  proposedBy: EvolutionPrincipalRef;
  practiceRef?: VersionedEvolutionRef;
}

export interface EvolutionPracticeBinding {
  bindingId: string;
  practiceRef: VersionedEvolutionRef;
  kind: EvolutionArtifactKind;
  target: string;
  status: "proposed" | "candidate_created" | "rejected";
  candidateRef?: VersionedEvolutionRef;
  createdAt: string;
  updatedAt: string;
}

export interface ValidateEvolutionCandidateInput {
  commandId: string;
  candidateId: string;
  expectedContentHash: string;
}

export interface VersionedEvolutionRef {
  id: string;
  version: string;
  contentHash: string;
}

export interface EvaluationObservation {
  success: boolean;
  qualityScore: number;
  costUsd: number;
  /** False means the value is only a placeholder and must not satisfy a cost gate. */
  costMeasured: boolean;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  qaReturns?: number;
  repeatedToolCalls?: number;
  humanInterventions?: number;
  evidenceCompleteness?: number;
  latencyMs: number;
  toolFailures: number;
  policyViolations: number;
  safetyViolations: number;
}

export interface EvaluationCaseResult {
  caseId: string;
  group: "target" | "regression" | "safety";
  partition?: "historical" | "sealed_holdout";
  baseline: EvaluationObservation;
  candidate: EvaluationObservation;
  evidenceRefs: EvolutionSourceRef[];
}

export interface MetricResult {
  metric: string;
  baseline: number;
  candidate: number;
  delta: number;
  passed: boolean;
  measured?: boolean;
}

export interface EvaluationRun {
  evaluationId: string;
  candidateId: string;
  candidateHash: string;
  suiteRef: VersionedEvolutionRef;
  baselineRef: VersionedEvolutionRef;
  runtimeSnapshotRef: string;
  caseResults: EvaluationCaseResult[];
  aggregateMetrics: MetricResult[];
  decision: "pass" | "fail" | "inconclusive";
  evaluatorPrincipal: EvolutionPrincipalRef;
  grader: { id: string; version: string; type: "deterministic" };
  createdAt: string;
}

export interface EvaluationJobRequest {
  candidateId: string;
  expectedContentHash: string;
  suiteRef: VersionedEvolutionRef;
  baselineRef: VersionedEvolutionRef;
  runtimeSnapshotRef: string;
  evaluatorPrincipal: EvolutionPrincipalRef;
}

export interface EvaluationJob {
  jobId: string;
  commandId: string;
  requestFingerprint: string;
  workspaceId: string;
  status: ExtractionJobStatus;
  attempts: number;
  maxAttempts: number;
  request: EvaluationJobRequest;
  createdAt: string;
  updatedAt: string;
  nextAttemptAt?: string;
  lease?: { token: string; workerId: string; heartbeatAt: string; expiresAt: string };
  result?: { evaluationId: string; decision: EvaluationRun["decision"] };
  lastError?: { category: "transient" | "terminal"; message: string };
}

export interface EvolutionWorkerStatus {
  running: boolean;
  evaluatorConfigured: boolean;
  lastStartedAt?: string;
  lastCompletedAt?: string;
  lastError?: string;
  workspacesScanned: number;
  reflectionSignalsProcessed: number;
  dreamPracticesProduced: number;
  practiceBindingsCreated: number;
  evaluationJobsProcessed: number;
}

export interface RecordEvaluationInput {
  commandId: string;
  candidateId: string;
  expectedContentHash: string;
  suiteRef: VersionedEvolutionRef;
  baselineRef: VersionedEvolutionRef;
  runtimeSnapshotRef: string;
  caseResults: EvaluationCaseResult[];
  evaluatorPrincipal: EvolutionPrincipalRef;
  grader: { id: string; version: string; type: "deterministic" };
}

export interface EvolutionEvalCase {
  caseId: string;
  group: "target" | "regression" | "safety";
  partition: "historical" | "sealed_holdout";
  inputRef: EvolutionSourceRef;
  assertions: string[];
}

export interface EvolutionEvalSuite {
  suiteRef: VersionedEvolutionRef;
  title: string;
  cases: EvolutionEvalCase[];
  automation?: {
    kinds: EvolutionArtifactKind[];
    targets?: string[];
    baselineRef: VersionedEvolutionRef;
    runtimeSnapshotRef: string;
    policyRef: VersionedEvolutionRef;
    autoPromoteLowRiskMemory?: boolean;
  };
  createdAt: string;
}

export interface PromotionRecord {
  promotionId: string;
  candidateId: string;
  evaluationId: string;
  fromRelease?: VersionedEvolutionRef;
  toRelease: VersionedEvolutionRef;
  stage: "shadow" | "canary" | "production";
  scope: EvolutionScope;
  approvedBy: EvolutionPrincipalRef;
  policyRef: VersionedEvolutionRef;
  status: "active" | "rolled_back" | "superseded";
  createdAt: string;
  rolledBackAt?: string;
  supersededAt?: string;
  supersededByPromotionId?: string;
  telemetryId?: string;
  sourcePromotionId?: string;
  rollout?: { percentage: number; salt: string };
}

export interface PromoteEvolutionCandidateInput {
  commandId: string;
  candidateId: string;
  evaluationId: string;
  expectedContentHash: string;
  stage: "shadow" | "canary" | "production";
  approvedBy: EvolutionPrincipalRef;
  policyRef: VersionedEvolutionRef;
  fromPromotionId?: string;
  telemetryId?: string;
  rolloutPercent?: number;
}

export interface ReleaseTelemetrySample {
  sampleId: string;
  baseline: EvaluationObservation;
  release: EvaluationObservation;
  evidenceRefs: EvolutionSourceRef[];
}

export interface ReleaseTelemetry {
  telemetryId: string;
  releaseRef: VersionedEvolutionRef;
  candidateId: string;
  candidateHash: string;
  stage: "canary";
  sampleSize: number;
  samples: ReleaseTelemetrySample[];
  aggregateMetrics: MetricResult[];
  decision: "pass" | "fail" | "inconclusive";
  recorder: EvolutionPrincipalRef;
  startedAt: string;
  endedAt: string;
  createdAt: string;
}

export interface RecordReleaseTelemetryInput {
  commandId: string;
  promotionId: string;
  samples: ReleaseTelemetrySample[];
  recorder: EvolutionPrincipalRef;
  startedAt: string;
  endedAt: string;
}

export interface ActiveReleasePointer {
  schemaVersion: 1;
  target: string;
  stage: "canary" | "production";
  scope: EvolutionScope;
  generation: number;
  release?: VersionedEvolutionRef;
  previousRelease?: VersionedEvolutionRef;
  promotionId?: string;
  active: boolean;
  updatedAt: string;
  rollout?: { percentage: number; salt: string };
}

export type EvolutionActivationStatus = "waiting_for_activation" | "activated" | "degraded" | "rolled_back" | "superseded";

export interface EvolutionActivationRecord {
  activationId: string;
  promotionId: string;
  activationKind?: "release" | "rollback_restore";
  rollbackOfPromotionId?: string;
  candidateId: string;
  assetKind: EvolutionArtifactKind;
  target: string;
  stage: "canary" | "production";
  boundary: EvolutionActivationBoundary;
  desiredGeneration: number;
  releaseRef: VersionedEvolutionRef;
  previousRelease?: VersionedEvolutionRef;
  scope: EvolutionScope;
  status: EvolutionActivationStatus;
  requestedAt: string;
  pointerChangedAt?: string;
  firstInheritedAt?: string;
  lastInheritedAt?: string;
  health?: "healthy" | "degraded" | "inconclusive";
  healthTelemetryId?: string;
  healthObservedAt?: string;
  rolledBackAt?: string;
  supersededAt?: string;
  proofCount: number;
}

export interface EvolutionInheritanceProof {
  proofId: string;
  activationId: string;
  assetKind: EvolutionArtifactKind;
  target: string;
  boundary: EvolutionActivationBoundary;
  releaseRef: VersionedEvolutionRef;
  desiredGeneration: number;
  actualGeneration: number;
  runtimeKind: "turn" | "session" | "task" | "process" | "deployment";
  runtimeRef: string;
  runtimeSnapshotHash: string;
  traceRef?: EvolutionSourceRef;
  observedAt: string;
}

export type MemoryLifecycleStatus = "active" | "stale" | "archived";

export interface MemoryLifecycleState {
  releaseId: string;
  releaseRef: VersionedEvolutionRef;
  target: string;
  scope: EvolutionScope;
  status: MemoryLifecycleStatus;
  pinned: boolean;
  registeredAt: string;
  updatedAt: string;
  useCount: number;
  successfulEpisodeCount: number;
  failedEpisodeCount: number;
  lastUsedAt?: string;
  lastSuccessfulAt?: string;
  lastEpisodeId?: string;
  lastOutcome?: ExperienceOutcome;
}

export interface RecordMemoryUsageInput {
  commandId: string;
  releaseId: string;
  episodeId: string;
  outcome: ExperienceOutcome;
  sourceRefs: EvolutionSourceRef[];
  occurredAt: string;
}

export type EvolutionLedgerEvent =
  | {
      eventId: string;
      commandId: string;
      type: "candidate.proposed";
      occurredAt: string;
      candidate: EvolutionCandidate;
    }
  | {
      eventId: string;
      commandId: string;
      type: "candidate.validated";
      occurredAt: string;
      candidateId: string;
      expectedContentHash: string;
      validation: NonNullable<EvolutionCandidate["validation"]>;
    }
  | {
      eventId: string;
      commandId: string;
      type: "candidate.evaluation_requested";
      occurredAt: string;
      candidateId: string;
      expectedContentHash: string;
      suiteRef: VersionedEvolutionRef;
    };
