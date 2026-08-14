export const EVOLUTION_ARTIFACT_KINDS = ["memory", "skill", "prompt", "workflow", "plugin", "harness"] as const;
export type EvolutionArtifactKind = typeof EVOLUTION_ARTIFACT_KINDS[number];

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
}

export interface EvolutionScope {
  workspaceId: string;
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

export interface ExperienceEpisode {
  episodeId: string;
  workspaceId: string;
  taskId: string;
  taskRunId: string;
  ticketId: string;
  attemptId: string;
  goalId: string;
  agentId: string;
  outcome: ExperienceOutcome;
  sourceRefs: EvolutionSourceRef[];
  startedAt: string;
  endedAt: string;
  contentHash: string;
}

export type AttributionComponent = "memory" | "prompt" | "skill" | "tool" | "provider" | "plan" | "policy" | "environment" | "unknown";

export interface ExperienceAttribution {
  attributionId: string;
  episodeId: string;
  symptom: string;
  component: AttributionComponent;
  cause: string;
  confidence: number;
  sourceRefs: EvolutionSourceRef[];
  counterEvidenceRefs: EvolutionSourceRef[];
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
    status: "completed" | "failed" | "blocked" | "cancelled" | "active" | "paused" | "resolving";
  };
  sourceRefs: EvolutionSourceRef[];
  failures?: Array<{
    component: Exclude<AttributionComponent, "unknown">;
    symptom: string;
    cause: string;
    sourceRefs: EvolutionSourceRef[];
  }>;
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
  createdAt: string;
  updatedAt: string;
  validation?: {
    passed: boolean;
    checkedAt: string;
    checks: EvolutionValidationCheck[];
    scanner?: SkillScanReport;
    artifactManifestRef?: string;
    artifactManifestHash?: string;
  };
  evaluationSuiteRefs?: VersionedEvolutionRef[];
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
