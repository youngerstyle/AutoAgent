import { createHash } from "node:crypto";
import { createId } from "../../shared/ids.js";
import type { LoopDebugLog, WorkspaceSnapshot } from "../../shared/types.js";
import type { AgentMessageAttachment } from "../../shared/contracts/agent-engine.js";
import type { AgentProfileStore } from "../agents/profile-store.js";
import type { ProviderRegistry } from "../providers/provider-registry.js";
import type { WorkspaceStore } from "../storage/workspace-store.js";
import type { PlanPolicyStore } from "../tickets/plan-policy-store.js";
import type { PlanPolicyRef } from "../../shared/contracts/ticket-engine.js";
import type { Workspace } from "../../shared/types.js";
import { RuntimeHost, planHasRunnableTickets, runtimeTaskStatusFor } from "./runtime-host.js";
import { RuntimeHostStore, type RuntimeWorkflowSnapshot } from "./runtime-host-store.js";
import { MissionStore } from "../mission-process/mission-store.js";
import { TicketStore, type TicketAggregate } from "../tickets/ticket-store.js";
import { StaffingRequestStore } from "../staffing/staffing-request-store.js";
import { DEFAULT_MINIMAL_TEAM_POLICY_CONFIG, seedMinimalTeamPlanPolicy } from "../tickets/plan-policy-config.js";
import { RuntimeExecutionGate, RuntimeHostScheduler } from "./runtime-scheduler.js";
import { ensureProjectOwner, migrateAndValidateWorkspaceAgentProfiles } from "../agents/roster.js";
import { EvolutionCoordinator } from "../evolution/evolution-coordinator.js";
import { PlatformEvolutionObservationAdapter } from "../evolution-adapters/platform-observation-adapter.js";
import { EvolutionPlatformRuntimeAdapter } from "../evolution-adapters/platform-runtime-adapter.js";
import { PlatformEvolutionSourceVerifier } from "../evolution-adapters/platform-source-verifier.js";
import type { EvolutionTrialRuntimeContext, EvolutionWorkerStatus } from "../../shared/contracts/evolution.js";
import type { OrganizationMemorySource, SharedEvolutionLayerSource } from "../evolution/runtime-projection.js";
import { productionEvolutionRuntimeConfig, runtimeConfigSnapshotHash, type RuntimeEvolutionConfig } from "../evolution/runtime-config-projection.js";
import { EvolutionActivationStore } from "../evolution/activation-store.js";
import { CompanyIdentityStore } from "../storage/company-identity-store.js";
import { globalEvolutionLayerRoot } from "../storage/paths.js";
import { ProviderPluginArtifactAuthor } from "../evolution/plugin-authoring-worker.js";
import { ProviderPracticeReflector } from "../evolution/practice-reflector.js";
import { PlatformEvolutionTrialRouter, type EvolutionTrialRuntimeFacade } from "../evolution-adapters/platform-trial-adapter.js";
import { EvidenceLedger } from "../evidence/evidence-ledger.js";
import { AgentTraceStore } from "../agent-engine/trace-store.js";
import { EvolutionPairedTrialStore } from "../evolution/paired-trial-store.js";

export class RuntimeHostRegistry {
  private readonly hosts = new Map<string, RuntimeHost>();
  private readonly pendingHosts = new Map<string, Promise<RuntimeHost>>();
  private readonly scheduler: RuntimeHostScheduler;
  private readonly executionGate: RuntimeExecutionGate;
  private readonly evolutionCoordinator: EvolutionCoordinator;
  private readonly bootId = createId("boot");
  private readonly evolutionRuntimeConfigs = new Map<string, RuntimeEvolutionConfig>();
  private evolutionRuntimeConfigsInitialized = false;

  constructor(
    private readonly workspaces: WorkspaceStore,
    private readonly profiles: AgentProfileStore,
    private readonly providers: ProviderRegistry,
    private readonly policyStore: PlanPolicyStore,
    private readonly policyRef: PlanPolicyRef,
    private readonly restoreConcurrency = 2,
    options: { executionConcurrency?: number; evolutionEvaluatorProgramPath?: string; evolutionWorkerIntervalMs?: number } = {},
  ) {
    const executionConcurrency = options.executionConcurrency ?? 2;
    this.scheduler = new RuntimeHostScheduler(executionConcurrency);
    this.executionGate = new RuntimeExecutionGate(executionConcurrency);
    const trialRuntime: EvolutionTrialRuntimeFacade = {
      available: (workspaceId) => this.evolutionTrialRuntimeAvailable(workspaceId),
      start: (input) => this.startEvolutionTrialRuntimeTask(input),
      observe: (input) => this.observeEvolutionTrialRuntimeTask(input),
    };
    this.evolutionCoordinator = new EvolutionCoordinator(workspaces, {
      observationPort: (workspace) => new PlatformEvolutionObservationAdapter(workspace),
      sourceVerificationPort: (workspace) => new PlatformEvolutionSourceVerifier(workspace.id, workspace.rootPath),
      evaluatorProgramPath: options.evolutionEvaluatorProgramPath,
      intervalMs: options.evolutionWorkerIntervalMs,
      pluginArtifactAuthor: new ProviderPluginArtifactAuthor(providers),
      practiceReflector: new ProviderPracticeReflector(providers),
      trialPort: new PlatformEvolutionTrialRouter(workspaces, trialRuntime),
      isWorkspaceIdle: async (workspaceId) => {
        const host = this.hosts.get(workspaceId);
        if (!host) return true;
        return !["running", "waiting"].includes((await host.snapshot()).status);
      },
    });
  }

  evolutionStatus(): EvolutionWorkerStatus { return this.evolutionCoordinator.status(); }

  private async evolutionTrialRuntimeAvailable(workspaceId: string): Promise<boolean> {
    await this.workspaces.get(workspaceId);
    const status = await this.providers.status();
    return status.openai.configured || status.anthropic.configured;
  }

  private async startEvolutionTrialRuntimeTask(input: Parameters<EvolutionTrialRuntimeFacade["start"]>[0]): Promise<void> {
    const workspace = await this.workspaces.get(input.workspaceId);
    const store = new RuntimeHostStore(workspace.rootPath);
    const existing = await store.get(input.taskId);
    if (existing) {
      if (existing.objective !== input.objective || JSON.stringify(existing.evolutionTrial) !== JSON.stringify(input.trial)) throw new Error("Evolution trial Runtime task identity conflict");
      return;
    }
    const host = await this.host(input.workspaceId, true);
    await host.createTask({ taskId: input.taskId, title: input.title, objective: input.objective, evolutionTrial: input.trial });
  }

  private async observeEvolutionTrialRuntimeTask(input: Parameters<EvolutionTrialRuntimeFacade["observe"]>[0]): ReturnType<EvolutionTrialRuntimeFacade["observe"]> {
    const workspace = await this.workspaces.get(input.workspaceId);
    const record = await new RuntimeHostStore(workspace.rootPath).get(input.taskId);
    if (!record) return { status: "pending" };
    if (record.runtimeError?.source === "staffing") return { status: "infrastructure_failed", message: `Staffing infrastructure failed: ${record.runtimeError.message}` };
    const staffing = await new StaffingRequestStore(workspace.rootPath).getByTask(record.taskId);
    if (!record.workflowSnapshot && staffing && ["blocked", "failed"].includes(staffing.status)) return { status: "infrastructure_failed", message: `Staffing infrastructure is ${staffing.status}: ${staffing.blockReason ?? "no reason recorded"}` };
    const mission = await new MissionStore(workspace.rootPath, record.missionId).read();
    const ticketAggregate = mission
      ? await new TicketStore(workspace.rootPath, record.taskId, record.runId).read(mission.record.planId)
      : undefined;
    const infrastructureFailure = evolutionTrialInfrastructureFailure(ticketAggregate);
    if (infrastructureFailure) return { status: "infrastructure_failed", message: infrastructureFailure };
    const trialPlanTerminal = ticketAggregate
      ? ["blocked", "completed", "failed", "cancelled"].includes(ticketAggregate.plan.status)
      : false;
    if (["active", "paused", "waiting"].includes(record.status) && !trialPlanTerminal) return { status: "running" };
    const taskCompleted = record.status === "completed" || ticketAggregate?.plan.status === "completed";
    const assessment = assessEvolutionTrial(record.evolutionTrial, record.workflowSnapshot, taskCompleted, ticketAggregate);
    const goalsByAgent = new Map<string, Set<string>>();
    for (const link of mission?.links ?? []) if (link.agentGoalId) {
      const goals = goalsByAgent.get(link.agentId) ?? new Set<string>(); goals.add(link.agentGoalId); goalsByAgent.set(link.agentId, goals);
    }
    let inputTokens = 0; let outputTokens = 0; let totalTokens = 0; let usageMeasured = false; let costUsd = 0; let costMeasured = true;
    for (const [agentId, goalIds] of goalsByAgent) for (const trace of await new AgentTraceStore(workspace.rootPath, agentId).list()) {
      if (trace.kind !== "provider_response" || !trace.goalId || !goalIds.has(trace.goalId) || !isRecord(trace.data)) continue;
      const inputValue = finite(trace.data.inputTokens); const outputValue = finite(trace.data.outputTokens); const totalValue = finite(trace.data.totalTokens);
      if (inputValue !== undefined && outputValue !== undefined && totalValue !== undefined) { inputTokens += inputValue; outputTokens += outputValue; totalTokens += totalValue; usageMeasured = true; }
      const costValue = finite(trace.data.costUsd); if (trace.data.costMeasured === true && costValue !== undefined) costUsd += costValue; else costMeasured = false;
    }
    const evidenceId = `evidence_trial_task_${createHash("sha256").update(`${workspace.id}\0${record.taskId}\0${record.updatedAt}`).digest("hex").slice(0, 32)}`;
    const ledger = new EvidenceLedger(workspace.rootPath);
    if (!await ledger.get(evidenceId)) await ledger.append({
      evidenceId, agentId: "evolution-trial-runtime", threadId: `trial:${record.evolutionTrial?.trialId ?? record.taskId}`,
      goalId: `trial-task:${record.taskId}`, turnId: record.runId, toolCallId: `trial-task:${record.taskId}`,
      toolName: "runtime-host-trial-observer", kind: "tool", capture: { status: "recorded" },
      observation: { status: "observed", result: { taskId: record.taskId, runId: record.runId, missionId: record.missionId, status: record.status, planStatus: ticketAggregate?.plan.status, workflowSnapshot: record.workflowSnapshot, assessment } },
      input: { evolutionTrial: record.evolutionTrial }, workspaceRoot: workspace.rootPath, createdAt: record.updatedAt,
    });
    return {
      status: taskCompleted ? "succeeded" : "failed",
      observation: {
        success: assessment.success, qualityScore: assessment.qualityScore, costUsd, costMeasured: usageMeasured && costMeasured,
        ...(usageMeasured ? { inputTokens, outputTokens, totalTokens } : {}),
        latencyMs: Math.max(0, Date.parse(record.updatedAt) - Date.parse(record.createdAt)), toolFailures: record.runtimeError ? 1 : 0,
        policyViolations: 0, safetyViolations: 0, evidenceCompleteness: record.workflowSnapshot ? 1 : 0,
      },
      evidenceRefs: [{ kind: "evidence", ref: evidenceId, workspaceId: workspace.id, taskId: record.taskId, taskRunId: record.runId }],
    };
  }

  /**
   * Freeze Runtime Config desired state at process boot. Promotions after this
   * call remain waiting until a new registry/process is constructed.
   */
  async initializeEvolutionRuntimeConfigs(): Promise<void> {
    if (this.evolutionRuntimeConfigsInitialized) return;
    const resolved = new Map<string, RuntimeEvolutionConfig>();
    const observations: Promise<unknown>[] = [];
    const identity = await new CompanyIdentityStore(this.workspaces.homePath()).getOrCreate();
    const companyLayerRoot = globalEvolutionLayerRoot(this.workspaces.homePath(), "company", identity.companyId);
    for (const workspace of await this.workspaces.list()) {
      const config = await productionEvolutionRuntimeConfig(workspace.rootPath, workspace.id, companyLayerRoot);
      if (!config) continue;
      resolved.set(workspace.id, config);
      observations.push(new EvolutionActivationStore(config.sourceRoot).observe({
        assetKind: "runtime_config", target: config.target,
        releaseRef: { id: config.releaseId, version: config.releaseVersion, contentHash: config.contentHash },
        desiredGeneration: config.generation, actualGeneration: config.generation,
        runtimeKind: "process", runtimeRef: this.bootId,
        runtimeSnapshotHash: runtimeConfigSnapshotHash(config),
        ownerLevel: config.ownerLevel,
        traceRef: { kind: "evidence", ref: `boot:${this.bootId}`, workspaceId: workspace.id },
      }));
    }
    await Promise.all(observations);
    for (const [workspaceId, config] of resolved) this.evolutionRuntimeConfigs.set(workspaceId, config);
    this.evolutionRuntimeConfigsInitialized = true;
  }

  async snapshotByWorkspace(workspaceId: string): Promise<WorkspaceSnapshot> {
    const host = await this.host(workspaceId, false);
    return host.snapshot();
  }

  async startTask(input: { workspaceId: string; goal: string; title?: string }): Promise<WorkspaceSnapshot> {
    const host = await this.host(input.workspaceId, true);
    await host.createTask({
      taskId: createId("task"),
      title: input.title?.trim() || input.goal.trim().slice(0, 40) || "新任务",
      objective: input.goal.trim(),
    });
    return host.snapshot();
  }

  async pauseTask(workspaceId: string, taskId: string): Promise<WorkspaceSnapshot> {
    const host = await this.host(workspaceId, false);
    await host.pauseTask(taskId);
    return host.snapshot();
  }

  async resumeTask(workspaceId: string, taskId: string): Promise<WorkspaceSnapshot> {
    const host = await this.host(workspaceId, true);
    await host.resumeTask(taskId);
    return host.snapshot();
  }

  async stopTask(workspaceId: string, taskId: string): Promise<WorkspaceSnapshot> {
    const host = await this.host(workspaceId, false);
    await host.cancelTask(taskId, "human stopped the task");
    return host.snapshot();
  }

  async followUpTask(workspaceId: string, taskId: string, message: string): Promise<WorkspaceSnapshot> {
    const host = await this.host(workspaceId, true);
    return host.sendTaskMessage(taskId, message);
  }

  async sendAgentMessage(workspaceId: string, taskId: string, agentId: string, message: string, messageId?: string, attachments?: AgentMessageAttachment[]): Promise<WorkspaceSnapshot> {
    const host = await this.host(workspaceId, true);
    return host.sendAgentMessage(taskId, agentId, message, messageId, attachments);
  }

  async loopDebugLogByWorkspace(workspaceId: string): Promise<LoopDebugLog> {
    const snapshot = await this.snapshotByWorkspace(workspaceId);
    return {
      task: snapshot.activeTask,
      taskRun: snapshot.activeTaskRun,
      entries: snapshot.recentEvents.map((event) => ({
        id: event.id,
        kind: "flow",
        timestamp: event.timestamp,
        actor: event.actorId ?? "system",
        title: event.summary,
        content: JSON.stringify(event.payload),
        sequence: event.sequence,
      })),
    };
  }

  async stopAll(): Promise<void> {
    const pending = await Promise.allSettled(this.pendingHosts.values());
    const hosts = [
      ...this.hosts.values(),
      ...pending.flatMap((result) => result.status === "fulfilled" ? [result.value] : []),
    ];
    this.hosts.clear();
    this.pendingHosts.clear();
    await Promise.allSettled([...new Set(hosts)].map((host) => host.stop()));
    await this.evolutionCoordinator.stop();
    await this.scheduler.stop();
  }

  async removeWorkspace(
    workspaceId: string,
    options: { deleteLocalFolder?: boolean } = {},
  ): Promise<Workspace> {
    const pending = this.pendingHosts.get(workspaceId);
    const host = this.hosts.get(workspaceId) ?? (pending ? await pending : undefined);
    this.hosts.delete(workspaceId);
    this.pendingHosts.delete(workspaceId);
    if (host) await host.stop();
    return this.workspaces.remove(workspaceId, options);
  }

  async startAll(): Promise<{
    restoredWorkspaceIds: string[];
    failedWorkspaces: Array<{
      workspaceId: string;
      workspaceName: string;
      rootPath: string;
      error: string;
    }>;
  }> {
    this.evolutionCoordinator.start();
    const workspaces = await this.workspaces.list();
    const failures: Array<{ workspace: Workspace; reason: unknown }> = [];
    const restoredWorkspaceIds: string[] = [];
    let cursor = 0;
    const worker = async () => {
      while (cursor < workspaces.length) {
        const workspace = workspaces[cursor++];
        if (!workspace) return;
        try {
          if (await this.workspaceNeedsScheduler(workspace)) {
            await this.host(workspace.id, true);
            restoredWorkspaceIds.push(workspace.id);
          }
        } catch (reason) {
          failures.push({ workspace, reason });
        }
      }
    };
    const workerCount = Math.min(this.restoreConcurrency, workspaces.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return {
      restoredWorkspaceIds,
      failedWorkspaces: failures.map((failure) => ({
        workspaceId: failure.workspace.id,
        workspaceName: failure.workspace.name,
        rootPath: failure.workspace.rootPath,
        error: failure.reason instanceof Error ? failure.reason.message : String(failure.reason),
      })),
    };
  }

  /**
   * Restoration is a fact check, not a replay request. A completed Plan with
   * a linked Mission is readable history and must not create a RuntimeHost or
   * a background scheduler during process startup.
   */
  private async workspaceNeedsScheduler(workspace: Workspace): Promise<boolean> {
    const runtimeStore = new RuntimeHostStore(workspace.rootPath);
    await reconcileTerminalEvolutionTrialTasks(workspace, runtimeStore);
    const staffingStore = new StaffingRequestStore(workspace.rootPath);
    for (const record of await runtimeStore.list()) {
      if (record.status !== "active") continue;
      const mission = await new MissionStore(workspace.rootPath, record.missionId).read();
      if (!mission) {
        const staffing = await staffingStore.getByTask(record.taskId);
        if (staffing && !new Set(["blocked", "failed", "completed"]).has(staffing.status)) return true;
        continue;
      }
      const ticketAggregate = await new TicketStore(workspace.rootPath, record.taskId, record.runId).read(mission.record.planId);
      if (!ticketAggregate) return true;
      const nextStatus = runtimeTaskStatusFor(ticketAggregate.plan.status, mission.record.status);
      if (nextStatus !== record.status) {
        await runtimeStore.save({ ...record, status: nextStatus, updatedAt: new Date().toISOString() });
      }
      if (nextStatus === "active" && planHasRunnableTickets(ticketAggregate.tickets)) return true;
    }
    return false;
  }

  private async host(workspaceId: string, startScheduler: boolean): Promise<RuntimeHost> {
    const existing = this.hosts.get(workspaceId);
    if (existing) {
      if (startScheduler) await existing.start();
      return existing;
    }
    let pending = this.pendingHosts.get(workspaceId);
    if (!pending) {
      pending = this.createHost(workspaceId, startScheduler);
      this.pendingHosts.set(workspaceId, pending);
    }
    const host = await pending;
    if (startScheduler) await host.start();
    return host;
  }

  private async createHost(workspaceId: string, startScheduler: boolean): Promise<RuntimeHost> {
    try {
      const workspace = await this.workspaces.get(workspaceId);
      await reconcileTerminalEvolutionTrialTasks(workspace, new RuntimeHostStore(workspace.rootPath));
      const profiles = await this.profiles.list();
      await migrateAndValidateWorkspaceAgentProfiles(workspace, profiles);
      await ensureProjectOwner(workspace, profiles);
      await seedMinimalTeamPlanPolicy(this.policyStore, DEFAULT_MINIMAL_TEAM_POLICY_CONFIG);
      const host = new RuntimeHost(workspace, this.profiles, this.providers, this.policyStore, this.policyRef, {
        scheduler: this.scheduler,
        schedulerKey: workspace.id,
        executionGate: this.executionGate,
        evolution: new EvolutionPlatformRuntimeAdapter(workspace.rootPath, workspace.id, {
          organizationMemorySources: () => resolveOrganizationMemorySources(this.workspaces, workspace.id),
          sharedEvolutionLayerSources: (profileId) => resolveSharedEvolutionLayerSources(this.workspaces.homePath(), profileId),
        }),
        ...this.evolutionRuntimeConfigs.get(workspace.id)?.settings,
      });
      if (startScheduler) {
        await host.start();
      } else {
        await host.hydrate();
      }
      this.hosts.set(workspaceId, host);
      return host;
    } finally {
      this.pendingHosts.delete(workspaceId);
    }
  }

}

const TERMINAL_PAIRED_TRIAL_STATUSES = new Set(["succeeded", "failed", "inconclusive"]);
const TERMINAL_RUNTIME_TASK_STATUSES = new Set(["completed", "failed", "cancelled"]);

/**
 * A Runtime task is an execution owned by its paired trial. Once that owner is
 * terminal (or no longer exists), process recovery may retain the task as
 * audit history but must not schedule another Agent turn for it.
 */
export async function reconcileTerminalEvolutionTrialTasks(
  workspace: Workspace,
  runtimeStore = new RuntimeHostStore(workspace.rootPath),
  now: () => Date = () => new Date(),
): Promise<string[]> {
  const trials = new Map((await new EvolutionPairedTrialStore(workspace.id, workspace.rootPath).list())
    .map((trial) => [trial.trialId, trial]));
  const reconciled: string[] = [];
  for (const record of await runtimeStore.list()) {
    if (!record.evolutionTrial || TERMINAL_RUNTIME_TASK_STATUSES.has(record.status)) continue;
    const trial = trials.get(record.evolutionTrial.trialId);
    if (trial && !TERMINAL_PAIRED_TRIAL_STATUSES.has(trial.status)) continue;
    const timestamp = now().toISOString();
    await runtimeStore.save({
      ...record,
      status: "cancelled",
      runtimeError: {
        source: "scheduler",
        at: timestamp,
        message: trial
          ? `Evolution trial ${trial.trialId} is ${trial.status}; recovery suppressed this Runtime task.`
          : `Evolution trial ${record.evolutionTrial.trialId} is missing; recovery suppressed this orphan Runtime task.`,
      },
      updatedAt: timestamp,
    });
    reconciled.push(record.taskId);
  }
  return reconciled;
}

function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function finite(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined; }

export function assessEvolutionTrial(
  trial: EvolutionTrialRuntimeContext | undefined,
  workflow: RuntimeWorkflowSnapshot | undefined,
  taskCompleted: boolean,
  aggregate: TicketAggregate | undefined,
): { success: boolean; qualityScore: number; bindingVerified: boolean; matchedAssertions: string[]; completedTicketIds: string[] } {
  const completedTicketIds = (aggregate?.tickets ?? []).filter((ticket) => ticket.status === "completed").map((ticket) => ticket.ticketId);
  if (!trial || trial.group !== "target") {
    return { success: taskCompleted, qualityScore: taskCompleted ? 1 : 0, bindingVerified: true, matchedAssertions: [], completedTicketIds };
  }
  const bindingVerified = trial.variant === "baseline" || Boolean(
    workflow?.source === "evolution"
    && workflow.stage === "trial"
    && workflow.releaseRef.id === trial.candidateId
    && workflow.releaseRef.contentHash === trial.candidateHash,
  );
  const completed = new Set<string>((aggregate?.tickets ?? []).filter((ticket) => ticket.status === "completed" && trialTicketHandoffVerified(ticket)).map((ticket) => ticket.ticketId));
  const practiceExecutionVerified = (aggregate?.tickets ?? []).some((ticket) => ticket.status === "completed" && trialPracticeHandoffVerified(ticket));
  const executedText = Object.entries(aggregate?.definitionsByTicketId ?? {})
    .filter(([ticketId]) => completed.has(ticketId))
    .flatMap(([, definition]) => [definition.title, definition.objective, ...definition.successCriteria])
    .map(normalizeTrialText)
    .filter(Boolean);
  const textMatchedAssertions = trial.assertions.filter((assertion) => {
    const expected = normalizeTrialText(assertion);
    if (!expected) return false;
    const stablePrefix = expected.slice(0, Math.min(expected.length, 64));
    return executedText.some((actual) => actual.includes(expected) || expected.includes(actual) || (stablePrefix.length >= 24 && actual.includes(stablePrefix)));
  });
  // A candidate target Practice is generated from this frozen assertion set
  // and loaded by immutable candidate hash. Once that exact binding produces
  // a criterion-complete, evidence-backed Practice handoff, reparaphrasing its
  // Ticket definition must not turn the deterministic gate into fuzzy NLP.
  const matchedAssertions = trial.variant === "candidate" && bindingVerified && practiceExecutionVerified
    ? [...trial.assertions]
    : textMatchedAssertions;
  const qualityScore = trial.assertions.length > 0 ? matchedAssertions.length / trial.assertions.length : 0;
  const success = trial.variant === "candidate"
    ? bindingVerified && practiceExecutionVerified && matchedAssertions.length > 0
    : taskCompleted && matchedAssertions.length > 0;
  return { success, qualityScore, bindingVerified, matchedAssertions, completedTicketIds };
}

function trialTicketHandoffVerified(ticket: TicketAggregate["tickets"][number]): boolean {
  const attempt = [...(ticket.attempts ?? [])].reverse().find((item) => item.status === "completed" && item.handoff);
  if (!attempt?.handoff || attempt.handoff.criterionResults.some((item) => item.status !== "satisfied")) return false;
  const output = attempt.handoff.output;
  if (isRecord(output) && (output.schemaRef === "evolution-practice-result-v1" || output.schema === "evolution-practice-result-v1")) {
    const executionResult = isRecord(output.executionResult) ? output.executionResult : undefined;
    const result = output.result ?? executionResult?.result ?? executionResult?.status;
    const embeddedEvidence = isRecord(output.evidence) ? output.evidence : undefined;
    const authoritativeEmbeddedEvidence = embeddedEvidence?.authoritative === true
      && Array.isArray(embeddedEvidence.references)
      && embeddedEvidence.references.some((reference) => typeof reference === "string" && reference.trim());
    const resultEvidence = isRecord(result) ? result.authoritativeEvidence : undefined;
    const platformEvidenceRefs = Array.isArray(output.authoritativeEvidence)
      ? output.authoritativeEvidence
      : Array.isArray(resultEvidence) ? resultEvidence : [];
    const platformEvidence = platformEvidenceRefs.some((reference) => isRecord(reference)
        && typeof reference.evidenceId === "string"
        && reference.evidenceId.trim());
    return output.executed === true
      && result !== undefined
      && result !== "not_applicable"
      && (attempt.handoff.evidence.length > 0 || authoritativeEmbeddedEvidence || platformEvidence);
  }
  return true;
}

function trialPracticeHandoffVerified(ticket: TicketAggregate["tickets"][number]): boolean {
  const attempt = [...(ticket.attempts ?? [])].reverse().find((item) => item.status === "completed" && item.handoff);
  const output = attempt?.handoff?.output;
  return isRecord(output)
    && (output.schemaRef === "evolution-practice-result-v1" || output.schema === "evolution-practice-result-v1")
    && trialTicketHandoffVerified(ticket);
}

export function evolutionTrialInfrastructureFailure(aggregate: TicketAggregate | undefined): string | undefined {
  for (const ticket of aggregate?.tickets ?? []) {
    const attempt = [...ticket.attempts].reverse().find((item) => item.status === "blocked" && item.requiredInput);
    if (attempt?.requiredInput?.details?.source === "agent_engine.provider") {
      return `Provider infrastructure blocked Ticket ${ticket.ticketId}: ${attempt.reason ?? attempt.requiredInput.description}`;
    }
  }
  return undefined;
}

function normalizeTrialText(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export async function resolveSharedEvolutionLayerSources(homeDir: string, profileId: string): Promise<SharedEvolutionLayerSource[]> {
  const identity = await new CompanyIdentityStore(homeDir).getOrCreate();
  return [
    { layerRoot: globalEvolutionLayerRoot(homeDir, "company", identity.companyId), ownerLevel: "company", ownerId: identity.companyId, companyId: identity.companyId },
    { layerRoot: globalEvolutionLayerRoot(homeDir, "agent", profileId), ownerLevel: "agent", ownerId: profileId, companyId: identity.companyId },
  ];
}

export async function resolveOrganizationMemorySources(
  workspaces: WorkspaceStore,
  targetWorkspaceId: string,
): Promise<OrganizationMemorySource[]> {
  const target = await workspaces.get(targetWorkspaceId);
  if (!target.organization) return [];
  const trusted = new Set(target.organization.trustedMemoryWorkspaceIds);
  return (await workspaces.list())
    .filter((workspace) => trusted.has(workspace.id) && workspace.organization?.id === target.organization!.id)
    .map((workspace) => ({ workspaceId: workspace.id, workspaceRoot: workspace.rootPath, organizationId: target.organization!.id }))
    .sort((left, right) => left.workspaceId.localeCompare(right.workspaceId));
}
