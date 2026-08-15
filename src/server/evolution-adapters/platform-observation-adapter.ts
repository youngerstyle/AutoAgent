import type { AuthoritativeEpisodeFacts, EvolutionSourceRef, ExperienceEpisode } from "../../shared/contracts/evolution.js";
import type { Workspace } from "../../shared/types.js";
import { AgentStore } from "../agent-engine/agent-store.js";
import { EvidenceLedger } from "../evidence/evidence-ledger.js";
import { AgentTraceStore } from "../agent-engine/trace-store.js";
import { listWorkspaceAgents } from "../agents/roster.js";
import type { EvolutionCompactionObservation, EvolutionEpisodeObservationBatch, EvolutionMemoryUsageObservation, EvolutionObservationPort, EvolutionRuntimeTelemetryObservation } from "../evolution/observation-port.js";
import { MissionStore } from "../mission-process/mission-store.js";
import { RuntimeHostStore } from "../runtime/runtime-host-store.js";
import { TicketStore } from "../tickets/ticket-store.js";

/** Platform adapter; all knowledge of the three operational frameworks lives here. */
export class PlatformEvolutionObservationAdapter implements EvolutionObservationPort {
  constructor(private readonly workspace: Workspace) {}

  async collectEpisodeFacts(): Promise<EvolutionEpisodeObservationBatch> {
    const runtimeTasks = await new RuntimeHostStore(this.workspace.rootPath).list();
    const agents = await listWorkspaceAgents(this.workspace);
    const agentAggregates = new Map(await Promise.all(agents.map(async (agent) => [agent.id, await new AgentStore(this.workspace.rootPath, agent.id).read()] as const)));
    const facts: AuthoritativeEpisodeFacts[] = [];
    let inspectedWorkItems = 0;
    let skippedWorkItems = 0;
    for (const task of runtimeTasks) {
      const mission = await new MissionStore(this.workspace.rootPath, task.missionId).read();
      if (!mission) continue;
      const tickets = new TicketStore(this.workspace.rootPath, task.taskId, task.runId);
      for (const planId of await tickets.listPlanIds()) {
        const aggregate = await tickets.read(planId);
        if (!aggregate) continue;
        for (const ticket of aggregate.tickets) {
          inspectedWorkItems += 1;
          if (!isTerminalTicketStatus(ticket.status)) { skippedWorkItems += 1; continue; }
          const link = mission.links.filter((item) => item.ticketId === ticket.ticketId && item.agentGoalId && item.attemptId)
            .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
          if (!link?.agentGoalId || !link.attemptId || !link.agentThreadId) { skippedWorkItems += 1; continue; }
          const attempt = ticket.attempts.find((item) => item.attemptId === link.attemptId);
          const agent = agentAggregates.get(link.agentId);
          const goal = agent?.goals.find((item) => item.spec.id === link.agentGoalId);
          const profileId = mission.record.teamBinding.members.find((member) => member.agentId === link.agentId)?.profileId
            ?? agents.find((item) => item.id === link.agentId)?.profileId;
          if (!attempt || !goal || !profileId || !isTerminalGoalStatus(goal.status)) { skippedWorkItems += 1; continue; }
          const sourceRefs = refsFor(this.workspace.id, task.taskId, task.runId, ticket.ticketId, link, profileId, attempt.evidence?.map((item) => item.evidenceId) ?? []);
          const failures = await failureFacts(this.workspace, link.agentId, link.agentThreadId, link.agentGoalId, link.attemptId);
          facts.push({
            commandId: `reconcile:${ticket.ticketId}:${attempt.attemptId}:${ticket.version}`,
            workspaceId: this.workspace.id, taskId: task.taskId, taskRunId: task.runId,
            ticket: { ticketId: ticket.ticketId, attemptId: attempt.attemptId, status: ticket.status, startedAt: attempt.startedAt, updatedAt: attempt.endedAt ?? ticket.completion?.completedAt ?? link.updatedAt },
            goal: { goalId: goal.spec.id, agentId: link.agentId, profileId, status: goal.status },
            sourceRefs, ...(failures.length ? { failures } : {}),
          });
        }
      }
    }
    return { inspectedWorkItems, skippedWorkItems, facts };
  }

  async collectMemoryUsage(episodes: ExperienceEpisode[]): Promise<EvolutionMemoryUsageObservation[]> {
    const agents = await listWorkspaceAgents(this.workspace);
    const aggregates = new Map(await Promise.all(agents.map(async (agent) => [agent.id, await new AgentStore(this.workspace.rootPath, agent.id).read()] as const)));
    const observations: EvolutionMemoryUsageObservation[] = [];
    for (const episode of episodes) {
      const goal = aggregates.get(episode.agentId)?.goals.find((item) => item.spec.id === episode.goalId);
      if (!goal) continue;
      const loadedMemories = new Map<string, EvolutionSourceRef>();
      for (const trace of await new AgentTraceStore(this.workspace.rootPath, episode.agentId).list(goal.spec.threadId)) {
        if (trace.goalId !== episode.goalId || trace.kind !== "context" || !isRecord(trace.data) || !Array.isArray(trace.data.evolutionMemories)) continue;
        for (const item of trace.data.evolutionMemories) {
          if (!isRecord(item) || typeof item.releaseId !== "string" || !item.releaseId) continue;
          loadedMemories.set(item.releaseId, { kind: "trace", ref: trace.traceId, workspaceId: this.workspace.id, taskId: episode.taskId, taskRunId: episode.taskRunId, agentId: episode.agentId });
        }
      }
      if (loadedMemories.size) observations.push({
        episodeId: episode.episodeId, outcome: episode.outcome, occurredAt: episode.endedAt,
        sourceRefs: structuredClone(episode.sourceRefs),
        loadedMemories: [...loadedMemories].map(([releaseId, traceRef]) => ({ releaseId, traceRef })),
      });
    }
    return observations;
  }

  async collectCompactions(afterSequences: Record<string, number>): Promise<EvolutionCompactionObservation[]> {
    const result: EvolutionCompactionObservation[] = [];
    for (const agent of await listWorkspaceAgents(this.workspace)) {
      const aggregate = await new AgentStore(this.workspace.rootPath, agent.id).read();
      for (const thread of aggregate.threads) for (const item of thread.items) {
        if (item.kind !== "compaction" || item.sequence <= (afterSequences[agent.id] ?? 0)) continue;
        result.push({ agentId: agent.id, profileId: agent.profileId, threadId: thread.threadId, itemId: item.itemId, sequence: item.sequence, occurredAt: item.createdAt });
      }
    }
    return result.sort((left, right) => left.sequence - right.sequence || left.occurredAt.localeCompare(right.occurredAt));
  }

  async collectRuntimeTelemetry(agentId?: string): Promise<EvolutionRuntimeTelemetryObservation[]> {
    const agentIds = agentId ? [agentId] : (await listWorkspaceAgents(this.workspace)).map((agent) => agent.id);
    const result: EvolutionRuntimeTelemetryObservation[] = [];
    for (const currentAgentId of agentIds) for (const trace of await new AgentTraceStore(this.workspace.rootPath, currentAgentId).list()) {
      if (!trace.goalId) continue;
      const assignments = trace.kind === "context" && isRecord(trace.data) && Array.isArray(trace.data.evolutionCanaryAssignments)
        ? trace.data.evolutionCanaryAssignments.filter(isRuntimeAssignment).map((item) => ({ target: typeof item.target === "string" ? item.target : "", promotionId: item.promotionId, releaseId: item.releaseId, selected: item.selected }))
        : [];
      const usage = trace.kind === "provider_response" && isRecord(trace.data) && [trace.data.inputTokens, trace.data.outputTokens, trace.data.totalTokens].every(isNonNegativeNumber)
        ? { inputTokens: Number(trace.data.inputTokens), outputTokens: Number(trace.data.outputTokens), totalTokens: Number(trace.data.totalTokens) }
        : undefined;
      if (assignments.length || usage) result.push({ agentId: currentAgentId, traceId: trace.traceId, threadId: trace.threadId, turnId: trace.turnId, goalId: trace.goalId, assignments, ...(usage ? { usage } : {}) });
    }
    return result;
  }

  async verifyRuntimeAssignment(input: { agentId: string; traceId: string; promotionId: string; releaseId: string; selected: boolean }): Promise<boolean> {
    const trace = (await new AgentTraceStore(this.workspace.rootPath, input.agentId).list()).find((item) => item.traceId === input.traceId);
    if (!trace || trace.kind !== "context" || !isRecord(trace.data) || !Array.isArray(trace.data.evolutionCanaryAssignments)) return false;
    return trace.data.evolutionCanaryAssignments.some((item) => isRuntimeAssignment(item) && item.promotionId === input.promotionId && item.releaseId === input.releaseId && item.selected === input.selected);
  }
}

function refsFor(workspaceId: string, taskId: string, taskRunId: string, ticketId: string, link: { missionId: string; agentId: string; lastProposalId?: string; lastDecisionId?: string }, profileId: string, evidenceIds: string[]): EvolutionSourceRef[] {
  const base = { workspaceId, taskId, taskRunId, agentId: link.agentId, profileId };
  return [
    { kind: "mission", ref: link.missionId, ...base }, { kind: "ticket", ref: ticketId, ...base },
    ...(link.lastProposalId ? [{ kind: "goal_proposal" as const, ref: link.lastProposalId, ...base }] : []),
    ...(link.lastDecisionId ? [{ kind: "goal_decision" as const, ref: link.lastDecisionId, ...base }] : []),
    ...evidenceIds.map((ref) => ({ kind: "evidence" as const, ref, ...base })),
  ];
}

async function failureFacts(workspace: Workspace, agentId: string, threadId: string, goalId: string, attemptId: string): Promise<NonNullable<AuthoritativeEpisodeFacts["failures"]>> {
  const failures: NonNullable<AuthoritativeEpisodeFacts["failures"]> = [];
  for (const trace of await new AgentTraceStore(workspace.rootPath, agentId).list(threadId)) {
    if (trace.goalId !== goalId || trace.kind !== "error" || !isRecord(trace.data)) continue;
    if (trace.data.reason === "provider_error") failures.push({ component: "provider", symptom: String(trace.data.status ?? "provider_error"), cause: String(trace.data.message ?? "Provider execution failed"), sourceRefs: [{ kind: "trace", ref: trace.traceId, workspaceId: workspace.id, agentId }] });
  }
  for (const fact of await new EvidenceLedger(workspace.rootPath).listForGoal({ agentId, goalId, attemptId })) {
    const error = fact.capture.error;
    if (!error) continue;
    failures.push({
      component: error.category === "policy" ? "policy" : error.category === "tool" ? "tool" : "environment",
      symptom: `${fact.toolName} evidence capture ${fact.capture.status}`, cause: error.message,
      sourceRefs: [{ kind: "evidence", ref: fact.evidenceId, workspaceId: workspace.id, agentId }],
    });
  }
  return failures;
}

function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function isRuntimeAssignment(value: unknown): value is { target?: string; promotionId: string; releaseId: string; selected: boolean } { return isRecord(value) && (value.target === undefined || typeof value.target === "string") && typeof value.promotionId === "string" && typeof value.releaseId === "string" && typeof value.selected === "boolean"; }
function isNonNegativeNumber(value: unknown): boolean { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
function isTerminalTicketStatus(status: string): status is "completed" | "returned" | "failed" | "cancelled" { return ["completed", "returned", "failed", "cancelled"].includes(status); }
function isTerminalGoalStatus(status: string): status is "completed" | "failed" | "cancelled" { return ["completed", "failed", "cancelled"].includes(status); }
