import type { AuthoritativeEpisodeFacts, EvolutionSourceRef } from "../../shared/contracts/evolution.js";
import type { Workspace } from "../../shared/types.js";
import { AgentStore } from "../agent-engine/agent-store.js";
import { EvidenceLedger } from "../agent-engine/evidence-ledger.js";
import { AgentTraceStore } from "../agent-engine/trace-store.js";
import { listWorkspaceAgents } from "../agents/roster.js";
import { MissionStore } from "../mission-process/mission-store.js";
import { RuntimeHostStore } from "../runtime/runtime-host-store.js";
import { TicketStore } from "../tickets/ticket-store.js";
import { projectExperience } from "./experience-projector.js";
import { ExperienceStore } from "./experience-store.js";
import { MemoryUsageReconciler } from "./memory-usage-reconciler.js";

export interface ExperienceReconcileResult {
  inspectedTickets: number;
  recordedEpisodes: number;
  skippedTickets: number;
  memoryUsagesRecorded?: number;
}

export class ExperienceReconciler {
  constructor(private readonly workspace: Workspace, private readonly now: () => Date = () => new Date()) {}

  async reconcile(): Promise<ExperienceReconcileResult> {
    const runtimeTasks = await new RuntimeHostStore(this.workspace.rootPath).list();
    const agents = await listWorkspaceAgents(this.workspace);
    const agentAggregates = new Map(await Promise.all(agents.map(async (agent) => [agent.id, await new AgentStore(this.workspace.rootPath, agent.id).read()] as const)));
    const experience = new ExperienceStore(this.workspace.id, this.workspace.rootPath);
    let inspectedTickets = 0;
    let recordedEpisodes = 0;
    let skippedTickets = 0;

    for (const task of runtimeTasks) {
      const mission = await new MissionStore(this.workspace.rootPath, task.missionId).read();
      if (!mission) continue;
      const tickets = new TicketStore(this.workspace.rootPath, task.taskId, task.runId);
      for (const planId of await tickets.listPlanIds()) {
        const aggregate = await tickets.read(planId);
        if (!aggregate) continue;
        for (const ticket of aggregate.tickets) {
          inspectedTickets += 1;
          if (!isTerminalTicketStatus(ticket.status)) { skippedTickets += 1; continue; }
          const links = mission.links.filter((link) => link.ticketId === ticket.ticketId && link.agentGoalId && link.attemptId);
          const link = links.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
          if (!link?.agentGoalId || !link.attemptId || !link.agentThreadId) { skippedTickets += 1; continue; }
          const attempt = ticket.attempts.find((item) => item.attemptId === link.attemptId);
          const agent = agentAggregates.get(link.agentId);
          const goal = agent?.goals.find((item) => item.spec.id === link.agentGoalId);
          if (!attempt || !goal || !isTerminalGoalStatus(goal.status)) { skippedTickets += 1; continue; }
          const sourceRefs = refsFor(this.workspace.id, task.taskId, task.runId, ticket.ticketId, link, attempt.evidence?.map((item) => item.evidenceId) ?? []);
          const failures = await failureFacts(this.workspace, link.agentId, link.agentThreadId, link.agentGoalId, link.attemptId);
          const facts: AuthoritativeEpisodeFacts = {
            commandId: `reconcile:${ticket.ticketId}:${attempt.attemptId}:${ticket.version}`,
            workspaceId: this.workspace.id,
            taskId: task.taskId,
            taskRunId: task.runId,
            ticket: {
              ticketId: ticket.ticketId,
              attemptId: attempt.attemptId,
              status: ticket.status,
              startedAt: attempt.startedAt,
              updatedAt: attempt.endedAt ?? ticket.completion?.completedAt ?? link.updatedAt,
            },
            goal: { goalId: goal.spec.id, agentId: link.agentId, status: goal.status },
            sourceRefs,
            ...(failures.length ? { failures } : {}),
          };
          await experience.record(facts.commandId, projectExperience(facts, this.now));
          recordedEpisodes += 1;
        }
      }
    }
    const memoryUsage = await new MemoryUsageReconciler(this.workspace).reconcile();
    return { inspectedTickets, recordedEpisodes, skippedTickets, memoryUsagesRecorded: memoryUsage.recordedUsages };
  }
}

function refsFor(
  workspaceId: string,
  taskId: string,
  taskRunId: string,
  ticketId: string,
  link: { missionId: string; agentId: string; lastProposalId?: string; lastDecisionId?: string },
  evidenceIds: string[],
): EvolutionSourceRef[] {
  const base = { workspaceId, taskId, taskRunId, agentId: link.agentId };
  return [
    { kind: "mission", ref: link.missionId, ...base },
    { kind: "ticket", ref: ticketId, ...base },
    ...(link.lastProposalId ? [{ kind: "goal_proposal" as const, ref: link.lastProposalId, ...base }] : []),
    ...(link.lastDecisionId ? [{ kind: "goal_decision" as const, ref: link.lastDecisionId, ...base }] : []),
    ...evidenceIds.map((ref) => ({ kind: "evidence" as const, ref, ...base })),
  ];
}

async function failureFacts(workspace: Workspace, agentId: string, threadId: string, goalId: string, attemptId: string): Promise<NonNullable<AuthoritativeEpisodeFacts["failures"]>> {
  const failures: NonNullable<AuthoritativeEpisodeFacts["failures"]> = [];
  for (const trace of await new AgentTraceStore(workspace.rootPath, agentId).list(threadId)) {
    if (trace.goalId !== goalId || trace.kind !== "error" || !isRecord(trace.data)) continue;
    if (trace.data.reason === "provider_error") failures.push({
      component: "provider",
      symptom: String(trace.data.status ?? "provider_error"),
      cause: String(trace.data.message ?? "Provider execution failed"),
      sourceRefs: [{ kind: "trace", ref: trace.traceId, workspaceId: workspace.id, agentId }],
    });
  }
  for (const fact of await new EvidenceLedger(workspace.rootPath).listForGoal({ agentId, goalId, attemptId })) {
    const error = fact.capture.error;
    if (!error) continue;
    const component = error.category === "policy" ? "policy" : error.category === "tool" ? "tool" : "environment";
    failures.push({
      component,
      symptom: `${fact.toolName} evidence capture ${fact.capture.status}`,
      cause: error.message,
      sourceRefs: [{ kind: "evidence", ref: fact.evidenceId, workspaceId: workspace.id, agentId }],
    });
  }
  return failures;
}

function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function isTerminalTicketStatus(status: string): status is "completed" | "returned" | "failed" | "cancelled" { return ["completed", "returned", "failed", "cancelled"].includes(status); }
function isTerminalGoalStatus(status: string): status is "completed" | "failed" | "cancelled" { return ["completed", "failed", "cancelled"].includes(status); }
