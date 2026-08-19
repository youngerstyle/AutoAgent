import { createHash } from "node:crypto";
import path from "node:path";

export interface StoragePaths {
  home: string;
}

export function globalProfilesDir(home: string): string {
  return path.join(home, "profiles");
}

export function globalProvidersFile(home: string): string {
  return path.join(home, "providers.json");
}

export function globalAgentProfilesFile(home: string): string {
  return path.join(home, "agent-profiles.json");
}

export function globalWorkspacesFile(home: string): string {
  return path.join(home, "workspaces.json");
}

export function globalCompanyIdentityFile(home: string): string {
  return path.join(home, "company.json");
}

export function globalCompanyEvolutionDir(home: string): string {
  return path.join(home, "evolution");
}

export function globalCompanyEvolutionPromotionProposalsFile(home: string): string {
  return path.join(globalCompanyEvolutionDir(home), "scope-promotion-proposals.jsonl");
}

export function globalCompanyEvolutionTrialsFile(home: string): string {
  return path.join(globalCompanyEvolutionDir(home), "company-trials.jsonl");
}

export function globalCompanyEvolutionTrialEvidenceFile(home: string): string {
  return path.join(globalCompanyEvolutionDir(home), "company-trial-evidence.jsonl");
}

export function globalEvolutionLayerRoot(home: string, ownerLevel: "agent" | "company", ownerId: string): string {
  return path.join(globalCompanyEvolutionDir(home), "layers", ownerLevel, ownerId);
}

export function sharedEvolutionPracticesFile(layerRoot: string): string {
  return path.join(workspaceAutoAgentDir(layerRoot), "evolution", "shared-practices.jsonl");
}

export function workspaceAutoAgentDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".autoagent");
}

export function workspaceEvolutionLedgerFile(workspaceRoot: string): string {
  return path.join(workspaceAutoAgentDir(workspaceRoot), "evolution", "ledger.jsonl");
}

export function workspaceEvolutionArtifactFile(workspaceRoot: string, contentHash: string): string {
  return path.join(workspaceAutoAgentDir(workspaceRoot), "evolution", "artifacts", contentHash, "artifact.txt");
}

export function workspaceEvolutionArtifactManifestFile(workspaceRoot: string, contentHash: string, candidateId: string): string {
  return path.join(workspaceAutoAgentDir(workspaceRoot), "evolution", "artifacts", contentHash, "manifests", `${candidateId}.json`);
}

export function workspaceEvolutionSkillEntrypointFile(workspaceRoot: string, contentHash: string): string {
  return path.join(workspaceAutoAgentDir(workspaceRoot), "evolution", "artifacts", contentHash, "SKILL.md");
}

export function workspaceEvolutionPluginBundleDirectory(workspaceRoot: string, contentHash: string): string {
  return path.join(workspaceAutoAgentDir(workspaceRoot), "evolution", "artifacts", contentHash, "bundle");
}

export function workspaceEvolutionEpisodesFile(workspaceRoot: string): string {
  return path.join(workspaceAutoAgentDir(workspaceRoot), "evolution", "episodes.jsonl");
}

export function workspaceEvolutionAttributionsFile(workspaceRoot: string): string {
  return path.join(workspaceAutoAgentDir(workspaceRoot), "evolution", "attributions.jsonl");
}

export function workspaceEvolutionSignalsFile(workspaceRoot: string): string {
  return path.join(workspaceAutoAgentDir(workspaceRoot), "evolution", "signals.jsonl");
}

export function workspaceEvolutionPhaseJobsFile(workspaceRoot: string): string {
  return path.join(workspaceAutoAgentDir(workspaceRoot), "evolution", "phase-jobs.jsonl");
}

export function workspaceEvolutionPhaseJobLeaseFile(workspaceRoot: string, jobId: string): string {
  return path.join(workspaceAutoAgentDir(workspaceRoot), "evolution", "leases", "phase-jobs", `${jobId}.json`);
}

export function workspaceEvolutionPracticeDraftsFile(workspaceRoot: string): string {
  return path.join(workspaceAutoAgentDir(workspaceRoot), "evolution", "practice-drafts.jsonl");
}

export function workspaceEvolutionPracticesFile(workspaceRoot: string): string {
  return path.join(workspaceAutoAgentDir(workspaceRoot), "evolution", "practices.jsonl");
}

export function workspaceEvolutionPracticeBindingsFile(workspaceRoot: string): string {
  return path.join(workspaceAutoAgentDir(workspaceRoot), "evolution", "practice-bindings.jsonl");
}

export function workspaceEvolutionPluginAuthoringJobsFile(workspaceRoot: string): string {
  return path.join(workspaceAutoAgentDir(workspaceRoot), "evolution", "plugin-authoring-jobs.jsonl");
}

export function workspaceEvolutionSignalCursorFile(workspaceRoot: string): string {
  return path.join(workspaceAutoAgentDir(workspaceRoot), "evolution", "signal-cursor.json");
}

export function workspaceEvolutionSignalLeaseFile(workspaceRoot: string, signalId: string): string {
  return path.join(workspaceAutoAgentDir(workspaceRoot), "evolution", "leases", "signals", `${signalId}.json`);
}

export function workspaceEvolutionAssetSelectionsFile(workspaceRoot: string): string {
  return path.join(workspaceAutoAgentDir(workspaceRoot), "evolution", "asset-selections.jsonl");
}

export function workspaceEvolutionExtractionJobsFile(workspaceRoot: string): string {
  return path.join(workspaceAutoAgentDir(workspaceRoot), "evolution", "extraction-jobs.jsonl");
}

export function workspaceEvolutionExtractionLeaseFile(workspaceRoot: string, jobId: string): string {
  return path.join(workspaceAutoAgentDir(workspaceRoot), "evolution", "leases", "extraction", `${jobId}.json`);
}

export function workspaceEvolutionEvalSuiteFile(workspaceRoot: string, contentHash: string): string {
  return path.join(workspaceAutoAgentDir(workspaceRoot), "evolution", "eval-suites", contentHash, "suite.json");
}

export function workspaceEvolutionEvalSuiteIndexFile(workspaceRoot: string): string {
  return path.join(workspaceAutoAgentDir(workspaceRoot), "evolution", "eval-suites", "index.jsonl");
}

export function workspaceEvolutionEvaluationsFile(workspaceRoot: string): string {
  return path.join(workspaceAutoAgentDir(workspaceRoot), "evolution", "evaluations.jsonl");
}

export function workspaceEvolutionEvaluationJobsFile(workspaceRoot: string): string {
  return path.join(workspaceAutoAgentDir(workspaceRoot), "evolution", "evaluation-jobs.jsonl");
}

export function workspaceEvolutionEvaluationLeaseFile(workspaceRoot: string, jobId: string): string {
  return path.join(workspaceAutoAgentDir(workspaceRoot), "evolution", "leases", "evaluation", `${jobId}.json`);
}

export function workspaceEvolutionEvaluationCommandFile(workspaceRoot: string, commandHash: string): string {
  return path.join(workspaceAutoAgentDir(workspaceRoot), "evolution", "evaluation-commands", `${commandHash}.json`);
}

export function workspaceEvolutionPairedTrialsFile(workspaceRoot: string): string {
  return path.join(workspaceAutoAgentDir(workspaceRoot), "evolution", "paired-trials.jsonl");
}

export function workspaceEvolutionPairedTrialCommandFile(workspaceRoot: string, commandHash: string): string {
  return path.join(workspaceAutoAgentDir(workspaceRoot), "evolution", "paired-trial-commands", `${commandHash}.json`);
}

export function workspaceEvolutionPromotionsFile(workspaceRoot: string): string {
  return path.join(workspaceAutoAgentDir(workspaceRoot), "evolution", "promotions.jsonl");
}

export function workspaceEvolutionActivationLedgerFile(workspaceRoot: string): string {
  return path.join(workspaceAutoAgentDir(workspaceRoot), "evolution", "activations.jsonl");
}

export function workspaceEvolutionTelemetryFile(workspaceRoot: string): string {
  return path.join(workspaceAutoAgentDir(workspaceRoot), "evolution", "telemetry.jsonl");
}

export function workspaceEvolutionMemoryLifecycleFile(workspaceRoot: string): string {
  return path.join(workspaceAutoAgentDir(workspaceRoot), "evolution", "memory-lifecycle.jsonl");
}

export function workspaceEvolutionActiveReleaseFile(workspaceRoot: string, stage: "canary" | "production", pointerKey: string): string {
  return path.join(workspaceAutoAgentDir(workspaceRoot), "evolution", "active", stage, `${pointerKey}.json`);
}

export function workspaceEvolutionReleaseFile(workspaceRoot: string, releaseId: string): string {
  return path.join(workspaceAutoAgentDir(workspaceRoot), "evolution", "releases", releaseId, "manifest.json");
}

export function workspaceFile(workspaceRoot: string): string {
  return path.join(workspaceAutoAgentDir(workspaceRoot), "workspace.json");
}

export function workspaceEventCursorFile(workspaceRoot: string): string {
  return path.join(workspaceAutoAgentDir(workspaceRoot), "event-cursor.json");
}

export function workspaceAgentDir(workspaceRoot: string, workspaceAgentId: string): string {
  return path.join(workspaceAutoAgentDir(workspaceRoot), "agents", workspaceAgentId);
}

export function workspaceAgentFile(workspaceRoot: string, workspaceAgentId: string): string {
  return path.join(workspaceAgentDir(workspaceRoot, workspaceAgentId), "agent.json");
}

export function workspaceAgentSessionsDir(workspaceRoot: string, workspaceAgentId: string): string {
  return path.join(workspaceAgentDir(workspaceRoot, workspaceAgentId), "sessions");
}

export function workspaceAttachmentsDir(workspaceRoot: string): string {
  return path.join(workspaceAutoAgentDir(workspaceRoot), "attachments");
}

export function agentEngineDir(workspaceRoot: string, agentId: string): string {
  const root = path.resolve(workspaceAutoAgentDir(workspaceRoot), "agent-engine");
  const key = createHash("sha256").update(agentId).digest("base64url");
  const directory = path.resolve(root, key);
  if (!directory.startsWith(`${root}${path.sep}`)) throw new Error("Agent Engine path escaped its storage root");
  return directory;
}

export function agentEngineRolloutFile(workspaceRoot: string, agentId: string): string {
  return path.join(agentEngineDir(workspaceRoot, agentId), "rollout.jsonl");
}

/**
 * Read-only projection used to resume a long append-only rollout quickly.
 * The rollout remains the source of truth; this file can always be rebuilt.
 */
export function agentEngineRolloutIndexFile(workspaceRoot: string, agentId: string): string {
  return path.join(agentEngineDir(workspaceRoot, agentId), "rollout.index.json");
}

export function agentEngineLegacyAggregateFile(workspaceRoot: string, agentId: string): string {
  return path.join(
    path.resolve(workspaceAutoAgentDir(workspaceRoot), "agent-engine"),
    `${createHash("sha256").update(agentId).digest("base64url")}.json`,
  );
}

export function agentEngineLockFile(workspaceRoot: string, agentId: string): string {
  return path.join(agentEngineDir(workspaceRoot, agentId), ".lock");
}

export function agentEngineExecutionLeaseFile(workspaceRoot: string, agentId: string): string {
  return path.join(agentEngineDir(workspaceRoot, agentId), ".execution.lock");
}

export function agentEngineTraceDir(workspaceRoot: string, agentId: string): string {
  return path.join(agentEngineDir(workspaceRoot, agentId), "traces");
}

export function agentEngineTraceRolloutFile(workspaceRoot: string, agentId: string): string {
  return path.join(agentEngineDir(workspaceRoot, agentId), "traces.jsonl");
}

export function agentEngineTraceFile(workspaceRoot: string, agentId: string, traceId: string): string {
  return path.join(
    agentEngineTraceDir(workspaceRoot, agentId),
    `${createHash("sha256").update(traceId).digest("base64url")}.json`,
  );
}

export function missionProcessFile(workspaceRoot: string, missionId: string): string {
  const root = path.resolve(workspaceAutoAgentDir(workspaceRoot), "mission-process");
  return path.join(root, `${createHash("sha256").update(missionId).digest("base64url")}.json`);
}

export function runtimeHostFile(workspaceRoot: string): string {
  return path.join(workspaceAutoAgentDir(workspaceRoot), "runtime-host.json");
}

export function workspaceAgentThreadsDir(workspaceRoot: string, workspaceAgentId: string): string {
  return path.join(workspaceAgentDir(workspaceRoot, workspaceAgentId), "threads");
}

export function workspaceAgentThreadFile(workspaceRoot: string, workspaceAgentId: string, taskRunId: string): string {
  return path.join(workspaceAgentThreadsDir(workspaceRoot, workspaceAgentId), `${taskRunId}.jsonl`);
}

export function workspaceAgentContextDir(workspaceRoot: string, workspaceAgentId: string): string {
  return path.join(workspaceAgentDir(workspaceRoot, workspaceAgentId), "context");
}

export function workspaceAgentContextFile(workspaceRoot: string, workspaceAgentId: string, taskRunId: string): string {
  return path.join(workspaceAgentContextDir(workspaceRoot, workspaceAgentId), `${taskRunId}.json`);
}

export function workspaceAgentMemoryFile(workspaceRoot: string, workspaceAgentId: string): string {
  return path.join(workspaceAgentDir(workspaceRoot, workspaceAgentId), "memory.json");
}

export function taskRunDir(workspaceRoot: string, taskId: string, taskRunId: string): string {
  return path.join(workspaceAutoAgentDir(workspaceRoot), "tasks", taskId, "runs", taskRunId);
}

export function eventsFile(workspaceRoot: string, taskId: string, taskRunId: string): string {
  return path.join(taskRunDir(workspaceRoot, taskId, taskRunId), "events.jsonl");
}

export function loopTraceFile(workspaceRoot: string, taskId: string, taskRunId: string): string {
  return path.join(taskRunDir(workspaceRoot, taskId, taskRunId), "loop-trace.jsonl");
}

export function stateFile(workspaceRoot: string, taskId: string, taskRunId: string): string {
  return path.join(taskRunDir(workspaceRoot, taskId, taskRunId), "state.json");
}

export function ticketEngineFile(
  workspaceRoot: string,
  taskId: string,
  taskRunId: string,
  planId: string,
): string {
  const engineRoot = path.resolve(workspaceAutoAgentDir(workspaceRoot), "ticket-engine");
  const file = path.join(
    engineRoot,
    "tasks",
    ticketEngineStorageKey(taskId),
    "runs",
    ticketEngineStorageKey(taskRunId),
    "plans",
    `${ticketEngineStorageKey(planId)}.json`,
  );
  const resolved = path.resolve(file);
  if (!resolved.startsWith(`${engineRoot}${path.sep}`)) {
    throw new Error("Ticket Engine path escaped its storage root");
  }
  return resolved;
}

export function ticketEngineLockFile(
  workspaceRoot: string,
  taskId: string,
  taskRunId: string,
  planId: string,
): string {
  return `${ticketEngineFile(workspaceRoot, taskId, taskRunId, planId)}.lock`;
}

function ticketEngineStorageKey(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

export function artifactsDir(workspaceRoot: string, taskId: string, taskRunId: string): string {
  return path.join(taskRunDir(workspaceRoot, taskId, taskRunId), "artifacts");
}
