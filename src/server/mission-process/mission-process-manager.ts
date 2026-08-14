import { createHash, randomUUID } from "node:crypto";
import type {
  AgentEventCursor,
  AgentPort,
  GoalResolutionDecision,
  GoalResolutionStatus,
  SettleProposalResult,
} from "../../shared/contracts/agent-engine.js";
import type {
  ActiveMissionLink,
  MissionBaseline,
  MissionLink,
  MissionStartRequest,
  TeamBinding,
  TicketPort,
} from "../../shared/contracts/mission-control.js";
import type {
  TicketEventCursor,
  TicketDefinition,
  TicketHandoff,
  TicketId,
  PlanId,
  PlanIntent,
  PlanChangeSet,
  PlannedTicketAssignment,
  TicketRequiredInput,
} from "../../shared/contracts/ticket-engine.js";
import { compilePlanIntent, PlanIntentError, type PlanCompilerSnapshot } from "./plan-intent-compiler.js";
import type { MissionAggregate, MissionCursorRecord } from "./mission-store.js";
import { MissionStore, MissionStoreConflictError } from "./mission-store.js";
import {
  proposalToCompiledPlanCommand,
  planResultToGoalDecision,
  proposalToTicketCommand,
  ticketResultToGoalDecision,
  createMissionBaseline,
  missionAssuranceSource,
  validateMissionAssuranceReport,
  validateMissionCorrectionOwnership,
  validateMissionPlanAssurance,
  validateMissionSettlement,
  materializeMissionSettlement,
  materializeSimpleAssuranceCorrection,
  materializeSimpleAssuranceOutcome,
  materializeSimpleMissionSettlement,
  validateMissionTicketOutcome,
  type MissionTicketOutcome,
  type MissionAssuranceSource,
  type MissionSettlementEvidence,
  type SharedPlanContext,
  missionOutcomeInstruction,
} from "./ticket-agent-adapter.js";
import { orderedAncestorTicketIds } from "./ticket-context-lineage.js";
import { configuredToolsInclude } from "../../shared/tool-catalog.js";
import { compileMissionGoalOutputContract } from "./mission-output-contract.js";

export interface MissionAgentDirectory {
  get(agentId: string): AgentPort<MissionTicketOutcome>;
}

export class MissionRecoveryError extends Error {}

/** A completed Mission is an immutable historical run, not a reusable slot. */
export class MissionTerminalError extends Error {}

export function correctionTargetMissionCriterionIds(
  definition: Pick<TicketDefinition, "missionContribution" | "assurance" | "permissions">,
): string[] {
  // A correction changes the upstream delivery that produced the observed
  // behavior. Assurance and settlement Tickets only judge that behavior; using
  // either as a correction target creates nested "verify the verifier" chains
  // with no new execution work.
  if (definition.assurance || definition.permissions?.settleMission) return [];
  const criterionIds = definition.missionContribution?.missionCriterionIds ?? [];
  return criterionIds.filter((criterionId, index) => criterionIds.indexOf(criterionId) === index);
}

export class MissionProcessManager {
  private static readonly CLAIM_LEASE_MS = 30 * 60_000;
  private static readonly CLAIM_RENEWAL_LEAD_MS = 10 * 60_000;

  constructor(
    private readonly store: MissionStore,
    private readonly tickets: TicketPort,
    private readonly agents: MissionAgentDirectory,
    private readonly team: TeamBinding,
    private readonly plannerPrincipalId: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async startMission(input: MissionStartRequest): Promise<MissionAggregate> {
    if (input.missionId !== this.store.missionId) throw new Error("Mission identity mismatch");
    if (input.resolvedStart.teamBindingId !== this.team.teamBindingId) throw new Error("Team binding mismatch");
    if (input.teamBinding.contentHash !== this.team.contentHash) throw new Error("Team binding snapshot mismatch");
    if (!this.team.members.some((member) => member.principalId === input.ownerPrincipalId)) throw new Error("Mission owner is not a TeamBinding member");
    const commandId = stableId("plan_create", input.missionId);
    let aggregate = await this.store.read();
    if (!aggregate) {
      const planId = randomUUID() as PlanId;
      try {
        aggregate = await this.store.create({
          missionId: input.missionId,
          objective: input.objective,
          planId,
          planCreateCommandId: commandId,
          ownerPrincipalId: input.ownerPrincipalId,
          teamBinding: structuredClone(input.teamBinding),
          status: "starting",
        });
      } catch (error) {
        // A duplicate publish may race between the initial read and create.
        // The durable Mission is the idempotency record; reuse it instead of
        // turning a successful first request into a user-visible failure.
        if (!(error instanceof MissionStoreConflictError)) throw error;
        aggregate = await this.store.read();
        if (!aggregate) throw error;
      }
    }
    if (aggregate.record.objective !== input.objective) throw new Error("Mission objective mismatch");
    if (aggregate.record.teamBinding.contentHash !== this.team.contentHash) throw new Error("Persisted TeamBinding does not match runtime TeamBinding");
    if (aggregate.record.status === "completed") {
      throw new MissionTerminalError(
        `Mission ${aggregate.missionId} is completed; create a new Mission and Plan for a new run`,
      );
    }
    const planId = aggregate.record.planId;
    const replay = await this.tickets.getPlanCommandResult(planId, commandId);
    const result = replay ?? await this.tickets.createPlan({
      commandId,
      planId,
      actorPrincipalId: this.plannerPrincipalId,
      issuedAt: this.now().toISOString(),
      payload: { type: "create_plan", missionId: input.missionId, definition: input.resolvedStart.planDefinition },
    });
    if (!result.accepted) {
      return this.finalizeMissionStart(aggregate, "start_failed", result.reason);
    }
    return this.finalizeMissionStart(aggregate, "linked");
  }

  private async finalizeMissionStart(
    aggregate: MissionAggregate,
    status: "linked" | "start_failed",
    failure?: string,
  ): Promise<MissionAggregate> {
    let expected = aggregate;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (expected.record.status === status) return expected;
      try {
        return await this.store.transact(expected.version, (current) => ({
          ...current,
          version: current.version + 1,
          record: status === "linked"
            ? { ...current.record, status: "linked", linkedAt: this.now().toISOString() }
            : { ...current.record, status: "start_failed", failure: failure ?? "Plan creation was rejected" },
        }));
      } catch (error) {
        if (!(error instanceof MissionStoreConflictError) || attempt === 4) throw error;
        expected = await this.requireAggregate();
      }
    }
    return this.requireAggregate();
  }

  async tick(): Promise<MissionAggregate> {
    let aggregate = await this.requireAggregate();
    if (aggregate.record.status !== "linked") return aggregate;
    await this.tickets.scanExpiredClaims(this.now());
    aggregate = await this.reconcileAuthoritativeLinks(aggregate);
    aggregate = await this.renewActiveClaims(aggregate);
    aggregate = await this.reconcileResolvingLinks(aggregate);
    aggregate = await this.pumpTicketEvents(aggregate);
    aggregate = await this.reconcileReadyTickets(aggregate);
    aggregate = await this.pumpAgentEvents(aggregate);
    return aggregate;
  }

  async recover(): Promise<MissionAggregate> {
    let aggregate = await this.requireAggregate();
    for (const link of aggregate.links) {
      if (link.status === "dispatching" || link.status === "starting") {
        aggregate = await this.continueDispatch(aggregate, link.dispatchId);
      } else if (link.status === "resolving" && link.lastProposalId) {
        aggregate = await this.continueSettlement(aggregate, link.dispatchId, link.lastProposalId);
      }
    }
    aggregate = await this.replayPendingGoalResolutions(aggregate);
    return this.tick();
  }

  async resumeBlockedAgent(agentId: string): Promise<MissionAggregate> {
    const aggregate = await this.requireAggregate();
    const link = aggregate.links.find((item) => item.agentId === agentId && item.status === "blocked");
    if (!link || !isActiveLink(link)) return aggregate;
    return this.updateLink(aggregate, link.dispatchId, { ...link, status: "running" });
  }

  /**
   * Convert an unrecoverable Agent Engine execution failure into the same
   * durable Ticket lifecycle as any other missing external prerequisite.
   * The Ticket owns the claim and blocked ownership; Mission only coordinates
   * the Agent Goal and link. No role or business route is inferred here.
   */
  async blockAgentExecution(input: {
    agentId: string;
    turnId: string;
    reason: string;
    requiredInput: TicketRequiredInput;
  }): Promise<MissionAggregate> {
    let aggregate = await this.requireAggregate();
    if (aggregate.record.status !== "linked") return aggregate;
    const link = aggregate.links.find((item) => item.agentId === input.agentId && item.status === "running");
    if (!link || !isActiveLink(link)) return aggregate;
    const ticket = await this.tickets.getTicket(link.ticketId);
    if (!ticket || (ticket.status !== "running" && ticket.status !== "blocked")) return aggregate;
    const commandId = stableId("agent_execution_block", link.dispatchId, String(ticket.version), input.turnId);
    const proposalId = stableId("agent_execution_block_proposal", link.dispatchId, input.turnId);
    const command = {
      commandId,
      proposalId,
      planId: link.planId,
      ticketId: link.ticketId,
      expectedTicketVersion: ticket.version,
      actorPrincipalId: link.agentPrincipalId,
      executionRef: link.agentGoalId,
      authority: link.authority,
      issuedAt: this.now().toISOString(),
      payload: { type: "block" as const, reason: input.reason, requiredInput: structuredClone(input.requiredInput) },
    };
    const result = await this.tickets.getTicketCommandResult(link.planId, commandId)
      ?? await this.tickets.applyTicket(command);
    if (!result.accepted && result.code === "plan_paused") return aggregate;
    if (!result.accepted || result.ticketStatus !== "blocked") {
      // A concurrent Mission tick owns the newer authority. Reconcile from
      // the durable aggregate rather than attempting a second command.
      return this.recover();
    }
    // Ticket application and Mission link persistence live in separate durable
    // stores. Re-read the Mission after the Ticket command so a concurrent
    // event-pump update is not overwritten with a stale aggregate version.
    aggregate = await this.requireAggregate();
    const currentLink = aggregate.links.find((item) => item.dispatchId === link.dispatchId);
    if (!currentLink || !isActiveLink(currentLink)) return aggregate;
    const goal = await this.agents.get(currentLink.agentId).getGoal(currentLink.agentGoalId);
    if (goal && goal.status === "active") {
      await this.agents.get(currentLink.agentId).controlGoal({
        requestId: stableId("agent_execution_block_goal", currentLink.dispatchId, input.turnId),
        goalId: goal.spec.id,
        expectedGoalVersion: goal.version,
        action: "pause",
        reason: input.reason,
      });
    }
    if (currentLink.status === "blocked") return aggregate;
    aggregate = await this.updateLink(aggregate, currentLink.dispatchId, {
      ...currentLink,
      status: "blocked",
      authority: result.nextAuthority ?? ticket.activeAuthority ?? link.authority,
      ticketVersion: result.ticketVersion,
      claimLeaseUntil: undefined,
      lastCommandId: commandId,
    });
    return aggregate;
  }

  async current(): Promise<MissionAggregate> {
    return this.requireAggregate();
  }

  async markActiveLinksCancelled(): Promise<MissionAggregate> {
    const aggregate = await this.requireAggregate();
    const cancellable = aggregate.links.filter((link) => link.status !== "settled" && link.status !== "cancelled");
    if (!cancellable.length) return aggregate;
    const terminal = new Map<string, MissionLink>();
    for (const link of cancellable) {
      const [goal, ticket] = await Promise.all([
        link.agentGoalId ? this.agents.get(link.agentId).getGoal(link.agentGoalId) : undefined,
        this.tickets.getTicket(link.ticketId),
      ]);
      terminal.set(link.dispatchId, {
        ...link,
        status: "cancelled",
        finalTicketVersion: ticket?.version ?? link.ticketVersion,
        finalGoalVersion: goal?.version ?? 1,
        updatedAt: this.now().toISOString(),
      });
    }
    return this.store.transact(aggregate.version, (current) => ({
      ...current,
      version: current.version + 1,
      links: current.links.map((link) => terminal.get(link.dispatchId) ?? link),
    }));
  }

  private async pumpTicketEvents(aggregate: MissionAggregate): Promise<MissionAggregate> {
    const planId = aggregate.record.planId;
    const partition = `ticket:${planId}`;
    const saved = aggregate.cursors.find((item) => item.partition === partition);
    const page = await this.tickets.readEvents({
      planId,
      after: saved?.cursor as TicketEventCursor | undefined,
      limit: 100,
    });
    let current = aggregate;
    for (const event of page.events) {
      const lastVersion = saved?.appliedVersions[event.aggregateId] ?? 0;
      if (event.aggregateVersion > lastVersion && event.aggregateType === "ticket" && event.payload.type === "TicketReady") {
        current = await this.ensureDispatch(current, event.aggregateId as TicketId, event.aggregateVersion);
      }
    }
    return this.saveCursor(current, partition, page.nextCursor, page.events.map((event) => [event.aggregateId, event.aggregateVersion]));
  }

  private async ensureDispatch(
    aggregate: MissionAggregate,
    ticketId: TicketId,
    ticketVersion: number,
  ): Promise<MissionAggregate> {
    const authoritative = await this.requireAggregate();
    if (authoritative.version > aggregate.version) aggregate = authoritative;
    const [plan, ticket] = await Promise.all([
      this.tickets.getPlan(aggregate.record.planId),
      this.tickets.getTicket(ticketId),
    ]);
    if (new Set(["completed", "failed", "cancelled"]).has(plan.status) || ticket?.status !== "ready") {
      return aggregate;
    }
    const work = await this.tickets.getWorkItem(ticketId);
    if (!work) throw new Error(`Ticket work item ${ticketId} is missing`);
    aggregate = await this.ensureRequiredMissionContext(aggregate, ticketId, work.definition);
    if (work.definition.contextPolicy?.requiresMissionBaseline && !aggregate.record.baseline) {
      return aggregate;
    }
    const dispatchId = stableId("dispatch", aggregate.missionId, ticketId, String(ticketVersion));
    const existing = aggregate.links.find((item) => item.dispatchId === dispatchId);
    if (existing) return this.continueDispatch(aggregate, dispatchId);
    const member = selectMember(this.team, work.definition.assignment);
    if (!member) return aggregate;
    if (aggregate.links.some((link) => link.agentId === member.agentId && isActiveLink(link))) {
      return aggregate;
    }
    const link: MissionLink = {
      dispatchId,
      missionId: aggregate.missionId,
      planId: aggregate.record.planId,
      ticketId,
      ticketVersion,
      agentId: member.agentId,
      agentPrincipalId: member.principalId,
      claimRequestId: stableId("claim_request", dispatchId),
      goalStartKey: stableId("goal_start", dispatchId),
      updatedAt: this.now().toISOString(),
      status: "dispatching",
    };
    let expected = aggregate;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const persisted = await this.store.transact(expected.version, (current) => {
          if (current.links.some((item) => item.dispatchId === dispatchId)
            || current.links.some((item) => item.agentId === member.agentId && isActiveLink(item))) {
            return current;
          }
          return {
            ...current,
            version: current.version + 1,
            links: [...current.links, link],
          };
        });
        return persisted.links.some((item) => item.dispatchId === dispatchId)
          ? this.continueDispatch(persisted, dispatchId)
          : persisted;
      } catch (error) {
        if (!(error instanceof MissionStoreConflictError) || attempt === 4) throw error;
        expected = await this.requireAggregate();
        if (expected.links.some((item) => item.dispatchId === dispatchId)) {
          return this.continueDispatch(expected, dispatchId);
        }
      }
    }
    return this.requireAggregate();
  }

  private async reconcileReadyTickets(aggregate: MissionAggregate): Promise<MissionAggregate> {
    const plan = await this.tickets.getPlan(aggregate.record.planId);
    let current = aggregate;
    for (const ticketId of plan.graph.ticketIds) {
      const ticket = await this.tickets.getTicket(ticketId);
      if (ticket?.status === "ready") current = await this.ensureDispatch(current, ticketId, ticket.version);
    }
    return current;
  }

  private async continueDispatch(aggregate: MissionAggregate, dispatchId: string): Promise<MissionAggregate> {
    let link = aggregate.links.find((item) => item.dispatchId === dispatchId);
    if (!link) throw new Error("Mission link is missing");
    const agent = this.agents.get(link.agentId);
    if (link.status === "dispatching") {
      const claim = await this.tickets.getClaimByRequestId(link.claimRequestId) ?? await this.tickets.claimReady({
        requestId: link.claimRequestId,
        planId: link.planId,
        ticketId: link.ticketId,
        expectedTicketVersion: link.ticketVersion,
        principalId: link.agentPrincipalId,
        leaseDurationMs: MissionProcessManager.CLAIM_LEASE_MS,
      });
      if (!claim) return aggregate;
      aggregate = await this.updateLink(aggregate, dispatchId, {
        ...link,
        status: "starting",
        ticketVersion: claim.ticketVersion,
        attemptId: claim.attemptId,
        authority: { kind: "claim", claimId: claim.claimId, fencingToken: claim.fencingToken },
        claimLeaseUntil: claim.leaseUntil,
        updatedAt: this.now().toISOString(),
      });
      link = aggregate.links.find((item) => item.dispatchId === dispatchId)!;
    }
    if (link.status !== "starting") return aggregate;
    // Goal dispatch is a durable boundary. Refresh Mission state so context
    // assembly cannot miss a baseline committed by a concurrent settlement.
    aggregate = await this.requireAggregate();
    link = aggregate.links.find((item) => item.dispatchId === dispatchId);
    if (!link || link.status !== "starting") return aggregate;
    let threadId = link.agentThreadId;
    if (!threadId) {
      const thread = await agent.ensureThread({
        agentId: link.agentId,
        scopeId: aggregate.missionId,
        idempotencyKey: stableId("thread", aggregate.missionId, link.agentId),
      });
      threadId = thread.threadId;
      aggregate = await this.updateLink(aggregate, dispatchId, { ...link, agentThreadId: threadId });
      link = aggregate.links.find((item) => item.dispatchId === dispatchId)!;
    }
    let goalId = link.agentGoalId;
    if (!goalId) {
      const work = await this.tickets.getWorkItem(link.ticketId);
      if (!work) throw new Error("Ticket work item is missing");
      if (work.definition.contextPolicy?.includeOriginalRequest) {
        await agent.sendMessage({
          messageId: stableId("mission_objective", aggregate.missionId),
          threadId,
          senderPrincipalId: "human",
          deliveryKind: "context",
          content: aggregate.record.objective,
          createdAt: this.now().toISOString(),
        });
      }
      const member = this.team.members.find((item) => item.agentId === link.agentId)!;
      const requiredCapabilities = work.definition.assignment.requiredCapabilities ?? [];
      const missingCapabilities = requiredCapabilities.filter((capability) => !member.capabilities.includes(capability));
      const requiredTools = work.definition.assignment.requiredTools ?? [];
      const missingTools = requiredTools.filter((tool) => !configuredToolsInclude(member.enabledTools, tool));
      const assignmentIssue = missingCapabilities.length || missingTools.length
        ? `工单 ${link.ticketId} 的负责人不满足分配契约`
          + `${missingCapabilities.length ? `；缺少能力：${missingCapabilities.join("、")}` : ""}`
          + `${missingTools.length ? `；缺少工具：${missingTools.join("、")}` : ""}`
        : undefined;
      const upstreamDeliveries = await this.listUpstreamDeliveries(link.planId, link.ticketId);
      const settlementAssuranceSources = work.definition.permissions?.settleMission
        ? await this.listMissionAssuranceSources(link.planId, link.ticketId)
        : [];
      const inheritedEvidenceIds = collectEvidenceIds([upstreamDeliveries, settlementAssuranceSources]);
      const correctionTargets = await this.listCorrectionTargets(link.planId, link.ticketId);
      const authoritativeMission = await this.requireAggregate();
      const prior = await agent.getGoalByStartKey(link.goalStartKey);
      const goal = prior ?? await agent.startGoal({
        agentId: link.agentId,
        threadId,
        idempotencyKey: link.goalStartKey,
        spec: {
          id: stableId("goal", dispatchId),
          threadId,
          objective: assignmentIssue
            ? `${assignmentIssue}。记录分配阻塞事实，等待具备授权的 plan 维护者修订 Ticket DAG。`
            : work.definition.objective,
          successCriteria: assignmentIssue
            ? ["明确记录无法分配的能力", "调用 request_human_input，不伪装完成原工作"]
            : work.definition.successCriteria,
          contextRefs: [
            { kind: "mission", ref: aggregate.missionId },
            { kind: "plan", ref: link.planId },
            { kind: "ticket", ref: link.ticketId },
          ],
          outputContract: compileMissionGoalOutputContract(
            work.definition,
            authoritativeMission.record.baseline,
            correctionTargets,
          ),
          externalRef: link.ticketId,
          attemptId: link.attemptId,
          ...(inheritedEvidenceIds.length ? { evidencePolicy: { inheritedEvidenceIds } } : {}),
          createdAt: this.now().toISOString(),
        },
      });
      goalId = goal.spec.id;
      await agent.sendMessage({
        messageId: stableId("mission_instruction", dispatchId),
        threadId,
        goalId,
        senderPrincipalId: "mission-process",
        content: assignmentIssue
          ? `${assignmentIssue}。这是工单分配异常，不执行原工作；请调用 request_human_input，并说明缺失能力。`
          : missionOutcomeInstruction(
              work.definition.outputContract.schemaRef,
              [...new Set(this.team.members.flatMap((item) => item.capabilities))],
              correctionTargets,
              link.ticketId,
              await this.sharedPlanContext(link.planId, authoritativeMission.record.baseline),
              upstreamDeliveries,
              {
                ticket: {
                  ticketId: work.ticket.ticketId,
                  title: work.definition.title,
                  objective: work.definition.objective,
                   successCriteria: work.definition.successCriteria,
                   outputContract: work.definition.outputContract,
                   deliveryIncrement: work.definition.deliveryIncrement,
                   missionContribution: work.definition.missionContribution,
                  assurance: work.definition.assurance,
                  permissions: work.definition.permissions,
                  reworkRequests: await this.listReworkRequests(
                    link.planId,
                    work.definition.correction?.targetTicketId ?? link.ticketId,
                  ),
                },
              },
              work.definition.permissions?.settleMission && authoritativeMission.record.baseline
                ? await this.missionSettlementEvidence(link.planId, link.ticketId, authoritativeMission.record.baseline)
                : undefined,
            ),
        createdAt: this.now().toISOString(),
      });
    }
    if (!link.authority || !threadId || !goalId) throw new Error("Mission dispatch is incomplete");
    const active: ActiveMissionLink = {
      ...link,
      authority: link.authority,
      agentThreadId: threadId,
      agentGoalId: goalId,
      status: "running",
      updatedAt: this.now().toISOString(),
    };
    return this.updateLink(aggregate, dispatchId, active);
  }

  private async sharedPlanContext(planId: PlanId, missionBaseline?: MissionBaseline) {
    const plan = await this.tickets.getPlan(planId);
    const workItems = await Promise.all(plan.graph.ticketIds.map((ticketId) => this.tickets.getWorkItem(ticketId)));
    return {
      planId: String(plan.planId),
      version: plan.version,
      tickets: workItems.flatMap((work) => {
        if (!work) return [];
        const assuranceSource = work.ticket.status === "completed" && work.ticket.completion
          ? missionAssuranceSource(work.ticket.ticketId, work.ticket.completion.handoff)
          : undefined;
        return [{
          ticketId: String(work.ticket.ticketId),
          status: work.ticket.status,
          ...(work.ticket.status === "completed" && work.ticket.completion
            ? { completedAt: work.ticket.completion.completedAt }
            : {}),
          title: work.definition.title,
          objective: work.definition.objective,
          successCriteria: work.definition.successCriteria,
          outputContract: work.definition.outputContract,
          deliveryIncrement: work.definition.deliveryIncrement,
          missionContribution: work.definition.missionContribution,
          assurance: work.definition.assurance,
          ...(assuranceSource ? {
            satisfiedMissionCriterionIds: assuranceSource.criterionResults
              .filter((result) => result.status === "satisfied")
              .map((result) => result.criterionId),
          } : {}),
        }];
      }),
      dependencyEdges: plan.graph.dependencyEdges.map((edge) => ({
        fromTicketId: String(edge.fromTicketId),
        toTicketId: String(edge.toTicketId),
      })),
      failureResolutionEdges: (plan.graph.failureResolutionEdges ?? []).map((edge) => ({
        failedTicketId: String(edge.failedTicketId),
        resolutionTicketId: String(edge.resolutionTicketId),
      })),
      requiredTerminalTicketIds: plan.completionPolicy.requiredTerminalTicketIds.map(String),
      requiredTerminalCapabilities: this.team.deliveryPolicy?.requiredTerminalCapabilities ?? [],
      ...(missionBaseline ? { missionBaseline } : {}),
      teamMembers: this.team.members.map((member) => ({
        principalId: member.principalId,
        name: member.agentId,
        capabilities: member.capabilities,
        enabledTools: member.enabledTools,
      })),
    };
  }

  private async ensureRequiredMissionContext(
    aggregate: MissionAggregate,
    ticketId: TicketId,
    definition: TicketDefinition,
  ): Promise<MissionAggregate> {
    if (!definition.contextPolicy?.requiresMissionBaseline || aggregate.record.baseline) return aggregate;
    const plan = await this.tickets.getPlan(aggregate.record.planId);
    const ancestors = orderedAncestorTicketIds(plan.graph, ticketId);
    const workItems = await Promise.all(ancestors.map((ancestorId) => this.tickets.getWorkItem(ancestorId)));
    const source = [...workItems].reverse().find((work) => (
      work?.definition.contextPolicy?.establishesMissionBaseline === true
      && work.ticket.status === "completed"
      && work.ticket.completion
    ));
    if (!source?.ticket.completion) return aggregate;
    const baseline = createMissionBaseline(
      source.ticket.completion.handoff.output as MissionTicketOutcome,
      source.ticket.ticketId,
      1,
      source.ticket.completion.completedAt,
    );
    try {
      return await this.store.transact(aggregate.version, (current) => {
        if (current.record.baseline) return current;
        return {
          ...current,
          version: current.version + 1,
          record: { ...current.record, baseline },
        };
      });
    } catch (error) {
      if (!(error instanceof MissionStoreConflictError)) throw error;
      return this.requireAggregate();
    }
  }

  private async listUpstreamDeliveries(planId: PlanId, ticketId: TicketId) {
    const plan = await this.tickets.getPlan(planId);
    const upstreamIds = orderedAncestorTicketIds(plan.graph, ticketId);
    const workItems = await Promise.all(upstreamIds.map((upstreamId) => this.tickets.getWorkItem(upstreamId)));
    return workItems.flatMap((work) => work?.ticket.status === "completed" && work.ticket.completion ? [{
      ticketId: work.ticket.ticketId,
      title: work.definition.title,
      objective: work.definition.objective,
      successCriteria: work.definition.successCriteria,
      outputContract: work.definition.outputContract,
      handoff: work.ticket.completion.handoff,
      ...(work.ticket.attempts.at(-1)?.changeSet ? { changeSet: work.ticket.attempts.at(-1)!.changeSet } : {}),
    }] : []);
  }

  private async listMissionAssuranceSources(planId: PlanId, _ticketId: TicketId) {
    const plan = await this.tickets.getPlan(planId);
    const workItems = (await Promise.all(plan.graph.ticketIds.map((id) => this.tickets.getWorkItem(id))))
      .filter((work): work is NonNullable<typeof work> => Boolean(work));
    const latestContributionAt = new Map<string, number>();
    for (const work of workItems) {
      if (work.ticket.status !== "completed" || !work.ticket.completion) continue;
      const completedAt = Date.parse(work.ticket.completion.completedAt);
      for (const criterionId of work.definition.missionContribution?.missionCriterionIds ?? []) {
        latestContributionAt.set(
          criterionId,
          Math.max(latestContributionAt.get(criterionId) ?? Number.NEGATIVE_INFINITY, completedAt),
        );
      }
    }
    const candidates = workItems.flatMap((work, planOrder) => {
      if (work.ticket.status !== "completed" || !work.ticket.completion
        || work.definition.outputContract.schemaRef !== "mission-assurance-v1") return [];
      const source = missionAssuranceSource(work.ticket.ticketId, work.ticket.completion.handoff);
      return source ? [{ source, completedAt: Date.parse(work.ticket.completion.completedAt), planOrder }] : [];
    });
    const selectedByCriterion = new Map<string, {
      source: MissionAssuranceSource;
      completedAt: number;
      planOrder: number;
    }>();
    for (const candidate of candidates) {
      for (const result of candidate.source.criterionResults) {
        if (result.status !== "satisfied") continue;
        if (candidate.completedAt < (latestContributionAt.get(result.criterionId) ?? Number.NEGATIVE_INFINITY)) continue;
        const current = selectedByCriterion.get(result.criterionId);
        if (!current
          || candidate.completedAt > current.completedAt
          || (candidate.completedAt === current.completedAt && candidate.planOrder > current.planOrder)) {
          selectedByCriterion.set(result.criterionId, candidate);
        }
      }
    }
    const selectedByTicket = new Map<string, MissionAssuranceSource>();
    for (const [criterionId, candidate] of selectedByCriterion) {
      const key = String(candidate.source.ticketId);
      const result = candidate.source.criterionResults.find((item) => item.criterionId === criterionId)!;
      const current = selectedByTicket.get(key);
      selectedByTicket.set(key, current
        ? { ...current, criterionResults: [...current.criterionResults, result] }
        : { ...candidate.source, criterionResults: [result] });
    }
    return [...selectedByTicket.values()];
  }

  private async missionSettlementEvidence(planId: PlanId, ticketId: TicketId, baseline: MissionBaseline): Promise<MissionSettlementEvidence> {
    const sources = await this.listMissionAssuranceSources(planId, ticketId);
    return {
      baselineVersion: baseline.version,
      criteria: baseline.criteria.map((criterion) => ({
        criterionId: criterion.criterionId,
        criterionText: criterion.text,
        verification: criterion.verification,
        assuranceSources: sources.flatMap((source): MissionAssuranceSource[] => {
          const criterionResults = source.criterionResults.filter((result) => result.criterionId === criterion.criterionId);
          return criterionResults.length ? [{ ...source, criterionResults }] : [];
        }),
      })),
    };
  }

  private async listReworkRequests(planId: PlanId, ticketId: TicketId) {
    let after: TicketEventCursor | undefined;
    const matches: Array<{
      sourceTicketId: TicketId;
      reason: string;
      handoff: TicketHandoff;
      occurredAt: string;
    }> = [];
    for (;;) {
      const page = await this.tickets.readEvents({ planId, after, limit: 500 });
      for (const event of page.events) {
        if (event.aggregateType !== "plan" || event.payload.type !== "TicketCorrectionRequested") continue;
        if (String(event.payload.targetTicketId) !== String(ticketId)) continue;
        matches.push({
          sourceTicketId: event.payload.sourceTicketId,
          reason: event.payload.reason,
          handoff: structuredClone(event.payload.handoff),
          occurredAt: event.occurredAt,
        });
      }
      after = page.nextCursor as TicketEventCursor;
      if (page.events.length === 0) break;
    }
    const recent = matches.slice(-5);
    const titleEntries = await Promise.all([...new Set(recent.map((item) => String(item.sourceTicketId)))]
      .map(async (id) => {
        const work = await this.tickets.getWorkItem(id as TicketId);
        return [id, work?.definition.title] as const;
      }));
    const titles = new Map(titleEntries);
    return recent.map((item) => ({
      ...item,
      sourceTitle: titles.get(String(item.sourceTicketId)),
    }));
  }

  private async pumpAgentEvents(aggregate: MissionAggregate): Promise<MissionAggregate> {
    let current = aggregate;
    for (const agentId of [...new Set(current.links.map((item) => item.agentId))]) {
      const partition = `agent:${agentId}`;
      const saved = current.cursors.find((item) => item.partition === partition);
      const page = await this.agents.get(agentId).readEvents({
        agentId,
        after: saved?.cursor as AgentEventCursor | undefined,
        limit: 100,
      });
      for (const event of page.events) {
        if (event.aggregateType !== "agent_goal" || event.payload.type !== "GoalSettlementRequested") continue;
        const eventGoal = await this.agents.get(agentId).getGoal(event.payload.goalId);
        if (eventGoal?.status !== "resolving" || eventGoal.activeProposalId !== event.payload.proposalId) continue;
        const link = current.links.find((item) => item.agentGoalId === event.payload.goalId);
        if (!link || !isActiveLink(link) || !new Set(["running", "resolving"]).has(link.status)) continue;
        if (link.status !== "resolving" || link.lastProposalId !== event.payload.proposalId) {
          current = await this.updateLink(current, link.dispatchId, {
            ...link,
            status: "resolving",
            lastProposalId: event.payload.proposalId,
            updatedAt: this.now().toISOString(),
          });
        }
        current = await this.continueSettlement(current, link.dispatchId, event.payload.proposalId);
      }
      current = await this.saveCursor(current, partition, page.nextCursor, page.events.map((event) => [event.aggregateId, event.aggregateVersion]));
    }
    return current;
  }

  private async renewActiveClaims(aggregate: MissionAggregate): Promise<MissionAggregate> {
    let current = aggregate;
    for (const link of current.links) {
      if (!isActiveLink(link) || link.authority.kind !== "claim" || !link.claimLeaseUntil) continue;
      if (Date.parse(link.claimLeaseUntil) - this.now().getTime() > MissionProcessManager.CLAIM_RENEWAL_LEAD_MS) continue;
      const currentClaim = await this.tickets.getClaim(link.authority.claimId);
      if (!currentClaim || currentClaim.fencingToken !== link.authority.fencingToken) continue;
      const receipt = await this.tickets.renewClaim({
        requestId: stableId("renew_claim", link.authority.claimId, link.claimLeaseUntil),
        claimId: link.authority.claimId,
        fencingToken: link.authority.fencingToken,
        extendByMs: MissionProcessManager.CLAIM_LEASE_MS,
      });
      current = await this.updateLink(current, link.dispatchId, {
        ...link,
        ticketVersion: receipt.ticketVersion,
        claimLeaseUntil: receipt.leaseUntil,
      });
    }
    return current;
  }

  private async replayPendingGoalResolutions(aggregate: MissionAggregate): Promise<MissionAggregate> {
    let current = aggregate;
    for (const persisted of aggregate.links) {
      const link = current.links.find((item) => item.dispatchId === persisted.dispatchId);
      if (!link || !isActiveLink(link)) continue;
      const agent = this.agents.get(link.agentId);
      const goal = await agent.getGoal(link.agentGoalId);
      if (goal?.status !== "resolving" || !goal.activeProposalId) continue;
      const replay = await agent.retryProposalResolution(goal.activeProposalId);
      if (replay.goal.status !== "resolving" || replay.goal.activeProposalId !== goal.activeProposalId) {
        if (link.status === "resolving") {
          current = await this.updateLink(current, link.dispatchId, { ...link, status: "running" });
        }
        continue;
      }
      current = await this.updateLink(current, link.dispatchId, {
        ...link,
        status: "resolving",
        lastProposalId: goal.activeProposalId,
      });
      current = await this.continueSettlement(current, link.dispatchId, goal.activeProposalId);
    }
    return current;
  }

  private async reconcileAuthoritativeLinks(aggregate: MissionAggregate): Promise<MissionAggregate> {
    let current = aggregate;
    for (const persisted of aggregate.links) {
      const link = current.links.find((item) => item.dispatchId === persisted.dispatchId);
      if (!link || !isActiveLink(link)) continue;
      const agent = this.agents.get(link.agentId);
      const [ticket, goal] = await Promise.all([
        this.tickets.getTicket(link.ticketId),
        agent.getGoal(link.agentGoalId),
      ]);
      if (!ticket) throw new Error(`Ticket ${link.ticketId} is missing during Mission recovery`);

      if (goal?.status === "resolving" && goal.activeProposalId) {
        current = await this.updateLink(current, link.dispatchId, {
          ...link,
          status: "resolving",
          lastProposalId: goal.activeProposalId,
        });
        current = await this.continueSettlement(current, link.dispatchId, goal.activeProposalId);
        continue;
      }

      const goalIsTerminal = goal !== undefined
        && new Set(["completed", "failed", "cancelled"]).has(goal.status);
      const ticketIsTerminal = new Set(["completed", "returned", "failed", "cancelled"]).has(ticket.status);
      if (goalIsTerminal) {
        const proposal = link.lastProposalId ? await agent.getProposal(link.lastProposalId) : undefined;
        if (!proposal) {
          throw new MissionRecoveryError(
            `Mission Link ${link.dispatchId} has terminal Agent/Ticket state without its persisted Agent Proposal`,
          );
        }
        current = await this.updateLink(current, link.dispatchId, {
          ...link,
          status: "resolving",
          lastProposalId: proposal.proposalId,
        });
        current = await this.continueSettlement(current, link.dispatchId, proposal.proposalId);
        continue;
      }

      if (ticketIsTerminal) {
        const proposal = link.lastProposalId ? await agent.getProposal(link.lastProposalId) : undefined;
        if (!proposal) {
          throw new MissionRecoveryError(
            `Mission Link ${link.dispatchId} has terminal Ticket ${link.ticketId} without a persisted Agent settlement proposal`,
          );
        }
        current = await this.updateLink(current, link.dispatchId, {
          ...link,
          status: "resolving",
          lastProposalId: proposal.proposalId,
        });
        current = await this.continueSettlement(current, link.dispatchId, proposal.proposalId);
        continue;
      }

      if (ticket.status === "blocked" && ticket.activeAuthority?.kind === "blocked_owner") {
        current = await this.updateLink(current, link.dispatchId, {
          ...link,
          status: goal?.status === "active" ? "running" : "blocked",
          authority: ticket.activeAuthority,
          ticketVersion: ticket.version,
          claimLeaseUntil: undefined,
        });
        continue;
      }

      if ((ticket.status === "ready" || ticket.status === "pending") && link.authority.kind === "claim") {
        let finalGoalVersion = goal?.version;
        if (goal && !new Set(["completed", "failed", "cancelled"]).has(goal.status)) {
          const cancelled = await this.agents.get(link.agentId).controlGoal({
            requestId: stableId("lost_ticket_authority", link.dispatchId, String(ticket.version)),
            goalId: goal.spec.id,
            expectedGoalVersion: goal.version,
            action: "cancel",
            reason: "Ticket claim expired or was released; a new dispatch owns the next attempt",
          });
          finalGoalVersion = cancelled.version;
        }
        current = await this.updateLink(current, link.dispatchId, {
          ...link,
          status: "cancelled",
          finalTicketVersion: ticket.version,
          finalGoalVersion,
        });
        continue;
      }

      if (ticket.status === "running" && link.authority.kind === "claim") {
        const claim = await this.tickets.getClaim(link.authority.claimId);
        if (!claim || ticket.activeAuthority?.kind !== "claim"
          || ticket.activeAuthority.claimId !== link.authority.claimId
          || ticket.activeAuthority.fencingToken !== link.authority.fencingToken) {
          current = await this.cancelSupersededLink(current, link, ticket.version, goal);
        }
      }
    }
    return current;
  }

  private async cancelSupersededLink(
    aggregate: MissionAggregate,
    link: ActiveMissionLink,
    ticketVersion: number,
    goal: Awaited<ReturnType<AgentPort<MissionTicketOutcome>["getGoal"]>>,
  ): Promise<MissionAggregate> {
    let finalGoalVersion = goal?.version;
    if (goal && !new Set(["completed", "failed", "cancelled"]).has(goal.status)) {
      const cancelled = await this.agents.get(link.agentId).controlGoal({
        requestId: stableId("superseded_dispatch", link.dispatchId, String(ticketVersion)),
        goalId: goal.spec.id,
        expectedGoalVersion: goal.version,
        action: "cancel",
        reason: "Ticket authority moved to a newer dispatch",
      });
      finalGoalVersion = cancelled.version;
    }
    return this.updateLink(aggregate, link.dispatchId, {
      ...link,
      status: "cancelled",
      finalTicketVersion: ticketVersion,
      finalGoalVersion,
    });
  }

  private async continueSettlement(
    aggregate: MissionAggregate,
    dispatchId: string,
    proposalId: string,
  ): Promise<MissionAggregate> {
    const link = aggregate.links.find((item) => item.dispatchId === dispatchId);
    if (!link || link.status !== "resolving") return aggregate;
    const active = link as ActiveMissionLink;
    const agent = this.agents.get(link.agentId);
    const storedProposal = await agent.getProposal(proposalId);
    if (!storedProposal) throw new Error("Goal proposal is missing");
    const currentGoal = await agent.getGoal(link.agentGoalId);
    if (!currentGoal) throw new Error("Goal is missing");
    if (currentGoal.status === "resolving" && currentGoal.activeProposalId === proposalId) {
      const resolution = await agent.retryProposalResolution(proposalId);
      const resolvedGoal = resolution.goal;
      if (resolvedGoal.status !== "resolving" || resolvedGoal.activeProposalId !== proposalId) {
        if (resolvedGoal.status === "active" || resolvedGoal.status === "blocked" || resolvedGoal.status === "paused") {
          return this.updateLink(aggregate, dispatchId, {
            ...active,
            status: resolvedGoal.status === "blocked" ? "blocked" : "running",
            ...(resolvedGoal.status === "blocked" ? { claimLeaseUntil: undefined } : {}),
          });
        }
        return aggregate;
      }
    }
    const plan = await this.tickets.getPlan(link.planId);
    const goal = await agent.getGoal(link.agentGoalId);
    if (!goal) throw new Error("Goal is missing");
    const currentTicket = await this.tickets.getTicket(link.ticketId);
    if (!currentTicket) throw new Error("Ticket is missing");
    // The persisted Agent Goal is the settlement gate. A proposal can still
    // say "completed" after the Agent Engine has rejected it as correctable;
    // never project that stale proposal into a Ticket command. A paused Goal
    // is the one recoverable exception: if the Ticket already has a durable
    // terminal result, the process may finish the same settlement after an
    // interruption between the Ticket commit and the Goal commit.
    const ticketIsTerminal = new Set(["completed", "returned", "failed", "cancelled"]).has(currentTicket.status);
    if (goal.status === "active" || goal.status === "blocked" || (goal.status === "paused" && !ticketIsTerminal)) {
      return this.updateLink(aggregate, dispatchId, {
        ...active,
        status: goal.status === "blocked" ? "blocked" : goal.status === "paused" ? "paused" : "running",
        ...(goal.status !== "active" ? { claimLeaseUntil: undefined } : {}),
      });
    }
    if (await agent.hasPendingHumanTurn?.(goal.spec.id, storedProposal.turnId)) {
      const decisionId = stableId("pending_human_turn", proposalId);
      const settled = await this.settleAgentProposal(
        agent,
        link.agentGoalId,
        proposalId,
        decisionId,
        {
          accepted: false,
          disposition: "correctable",
          reason: "当前 Goal 收到了尚未处理的 human 消息；必须先按线程时间序处理该消息，再提交工单结论。",
        },
      );
      if (!settled.applied) return aggregate;
      return this.updateLink(aggregate, dispatchId, {
        ...active,
        status: "running",
        lastDecisionId: decisionId,
      });
    }
    const work = await this.tickets.getWorkItem(link.ticketId);
    if (!work) throw new Error("Ticket work item is missing");
    const schemaRef = goal.spec.outputContract?.schemaRef;
    const authoritativeMission = await this.requireAggregate();
    const missionBaseline = authoritativeMission.record.baseline ?? aggregate.record.baseline;
    const planContext = isPlanningSchema(schemaRef)
      ? await this.sharedPlanContext(link.planId, missionBaseline)
      : undefined;
    let proposal = storedProposal;
    if (proposal.status === "completed" && schemaRef === "mission-assurance-v1" && missionBaseline) {
      const correctionTargets = await this.listCorrectionTargets(link.planId, link.ticketId);
      const domainOutcome = proposal.domainOutcome?.disposition === "correction_required"
        ? materializeSimpleAssuranceCorrection(
            missionBaseline,
            proposal.domainOutcome,
            proposal.evidence,
            correctionTargets,
          )
        : materializeSimpleAssuranceOutcome(
            missionBaseline,
            work.definition.assurance?.missionCriterionIds ?? [],
            proposal.domainOutcome,
            proposal.evidence,
          );
      proposal = { ...proposal, domainOutcome };
    }
    let settlementMaterializationError: string | undefined;
    if (proposal.status === "completed" && work.definition.permissions?.settleMission
      && proposal.domainOutcome?.disposition !== "correction_required"
      && proposal.domainOutcome?.disposition !== "plan_change_required"
      && missionBaseline) {
      const assuranceSources = await this.listMissionAssuranceSources(link.planId, link.ticketId);
      if (!proposal.domainOutcome?.missionResolution) {
        const simple = materializeSimpleMissionSettlement(
          missionBaseline,
          proposal.domainOutcome,
          assuranceSources,
        );
        if (simple.valid) proposal = { ...proposal, domainOutcome: simple.outcome };
        else settlementMaterializationError = simple.reason;
      }
      const materialized = materializeMissionSettlement(
        missionBaseline,
        proposal.domainOutcome?.missionResolution,
        assuranceSources,
      );
      if (materialized.valid) {
        proposal = {
          ...proposal,
          domainOutcome: {
            ...proposal.domainOutcome,
            missionResolution: materialized.resolution,
          },
        };
      } else settlementMaterializationError = materialized.reason;
    }
    const validation = validateMissionTicketOutcome(
      schemaRef,
      proposal.status,
      proposal.domainOutcome,
      proposal.humanInputRequest,
      planContext,
    );
    const correctionTargets = validation.valid && proposal.status === "completed"
      && proposal.domainOutcome?.disposition === "correction_required"
      ? await this.listCorrectionTargets(link.planId, link.ticketId)
      : [];
    const correctionOwnership = validation.valid
      ? validateMissionCorrectionOwnership({
          ticketId: work.ticket.ticketId,
          title: work.definition.title,
          objective: work.definition.objective,
          successCriteria: work.definition.successCriteria,
          outputContract: work.definition.outputContract,
          missionContribution: work.definition.missionContribution,
          assurance: work.definition.assurance,
          permissions: work.definition.permissions,
        }, proposal.domainOutcome, correctionTargets)
      : undefined;
    const assignmentError = validation.valid
      ? await validateTeamAssignments(proposal.domainOutcome as MissionTicketOutcome, schemaRef, this.team, this.tickets, planContext)
      : undefined;
    let missionContractError: string | undefined;
    if (validation.valid && proposal.status === "completed" && work.definition.contextPolicy?.establishesMissionBaseline) {
      try {
        createMissionBaseline(
          proposal.domainOutcome as MissionTicketOutcome,
          link.ticketId,
          (aggregate.record.baseline?.version ?? 0) + 1,
          this.now().toISOString(),
        );
      } catch (error) {
        missionContractError = error instanceof Error ? error.message : String(error);
      }
    }
    if (validation.valid && proposal.status === "completed" && schemaRef === "mission-assurance-v1"
      && proposal.domainOutcome?.disposition !== "plan_change_required") {
      if (!aggregate.record.baseline) missionContractError = "Mission 尚未建立权威 baseline，不能提交 assurance";
      else {
        const assuranceValidation = validateMissionAssuranceReport(
          aggregate.record.baseline,
          proposal.domainOutcome?.disposition === "correction_required"
            ? (Array.isArray(proposal.domainOutcome.correctionMissionCriterionIds)
              ? proposal.domainOutcome.correctionMissionCriterionIds.filter(
                (criterionId): criterionId is string => typeof criterionId === "string" && criterionId.length > 0,
              )
              : [])
            : work.definition.assurance?.missionCriterionIds ?? [],
          proposal.domainOutcome,
          proposal.domainOutcome?.disposition === "correction_required" ? "correction" : "completion",
        );
        if (!assuranceValidation.valid) missionContractError = assuranceValidation.reason;
      }
    }
    if (validation.valid && proposal.status === "completed" && work.definition.permissions?.settleMission
      && proposal.domainOutcome?.disposition !== "correction_required"
      && proposal.domainOutcome?.disposition !== "plan_change_required") {
      const member = this.team.members.find((item) => item.principalId === link.agentPrincipalId);
      const required = this.team.deliveryPolicy?.requiredTerminalCapabilities ?? [];
      if (!member || !required.every((capability) => member.capabilities.includes(capability))) {
        missionContractError = `当前 Agent 没有 Mission 结算能力：${required.join("、")}`;
      } else if (!aggregate.record.baseline) missionContractError = "Mission 尚未建立权威 baseline，不能结算";
      else if (settlementMaterializationError) missionContractError = settlementMaterializationError;
      else {
        const resolution = (proposal.domainOutcome as MissionTicketOutcome | undefined)?.missionResolution;
        const settlementValidation = validateMissionSettlement(
          aggregate.record.baseline,
          resolution,
          await this.listMissionAssuranceSources(link.planId, link.ticketId),
        );
        if (!settlementValidation.valid) missionContractError = settlementValidation.reason;
      }
    }
    const correctionReason = validation.valid
      ? (correctionOwnership && !correctionOwnership.valid ? correctionOwnership.reason : assignmentError ?? missionContractError)
      : validation.reason;
    if (correctionReason) {
      const decisionId = stableId("invalid_goal_decision", proposalId);
      const settled = await this.settleAgentProposal(
        agent,
        link.agentGoalId,
        proposalId,
        decisionId,
        { accepted: false, disposition: "correctable", reason: correctionReason },
      );
      if (!settled.applied) return aggregate;
      return this.updateLink(aggregate, dispatchId, {
        ...active,
        status: "running",
        lastDecisionId: decisionId,
      });
    }
    const planCommand = schemaRef === "plan-intent-v1" && planContext
      ? proposalToCompiledPlanCommand(proposal as never, active, plan.version, this.now().toISOString(), planContext)
      : undefined;
    if (planCommand) {
      const planResult = await this.tickets.getPlanCommandResult(link.planId, planCommand.commandId)
        ?? await this.tickets.applyPlan(planCommand);
      if (!planResult.accepted) {
        const decisionId = stableId("plan_change_rejected", proposalId, planCommand.commandId);
        const rejection = planResultToGoalDecision(planResult);
        if (!rejection) throw new Error("Rejected Plan result must produce a Goal decision");
        const settled = await this.settleAgentProposal(agent, link.agentGoalId, proposalId, decisionId, rejection);
        if (!settled.applied) return aggregate;
        return this.updateLink(aggregate, dispatchId, {
          ...active,
          status: "running",
          lastDecisionId: decisionId,
        });
      }
    }
    const command = proposalToTicketCommand(proposal as never, active, this.now().toISOString());
    const result = await this.tickets.getTicketCommandResult(link.planId, command.commandId) ?? await this.tickets.applyTicket(command);
    const decisionId = stableId("goal_decision", proposalId, command.commandId);
    const decision = ticketResultToGoalDecision(proposal, result);
    if (!decision) {
      if (result.accepted) throw new Error("Accepted Ticket result must produce a Goal decision");
      return this.updateLink(aggregate, dispatchId, {
        ...active,
        ticketVersion: result.currentTicketVersion ?? active.ticketVersion,
        status: "resolving",
        lastCommandId: command.commandId,
      });
    }
    const settled = await this.settleAgentProposal(
      agent,
      link.agentGoalId,
      proposalId,
      decisionId,
      decision,
    );
    if (!settled.applied && settled.code === "version_conflict") return aggregate;
    let currentAggregate = aggregate;
    let settlementBaseline = currentAggregate.record.baseline;
    let recordMutation: ((record: MissionAggregate["record"]) => MissionAggregate["record"]) | undefined;
    if (result.accepted && result.ticketStatus === "completed") {
      if (work.definition.contextPolicy?.establishesMissionBaseline) {
        const baseline = createMissionBaseline(
          proposal.domainOutcome as MissionTicketOutcome,
          link.ticketId,
          (currentAggregate.record.baseline?.version ?? 0) + 1,
          this.now().toISOString(),
        );
        settlementBaseline = baseline;
        recordMutation = (record) => ({ ...record, baseline });
      }
      if (work.definition.permissions?.settleMission) {
        const baseline = settlementBaseline;
        if (!baseline) throw new Error("Mission baseline is missing during settlement");
        const resolution = (proposal.domainOutcome as MissionTicketOutcome).missionResolution as {
          baselineVersion: number;
          summary: string;
          criterionResults: Array<{
            criterionId: string;
            status: "satisfied";
            assuranceTicketIds: TicketId[];
            evidence: Array<{ evidenceId: string }>;
            anchorResults: Array<{
              anchorIndex: number;
              status: "satisfied";
              evidence: Array<{ evidenceId: string }>;
              verificationBasis: {
                summary: string;
                evidence: Array<{ evidenceId: string }>;
              };
              observations: string[];
              deviations: string[];
              note?: string;
            }>;
          }>;
          residualRisks: string[];
        };
        const linkedAt = "linkedAt" in currentAggregate.record ? currentAggregate.record.linkedAt : this.now().toISOString();
        const settlement = {
          ...structuredClone(resolution),
          acceptedByTicketId: link.ticketId,
          acceptedByPrincipalId: link.agentPrincipalId,
          settledAt: this.now().toISOString(),
        };
        recordMutation = (record) => ({
          ...record,
          status: "completed",
          linkedAt,
          baseline,
          settlement,
        });
      }
    }
    let nextLink: MissionLink;
    if (result.accepted && result.ticketStatus === "blocked") {
      nextLink = { ...active, status: "blocked", authority: result.nextAuthority ?? active.authority, claimLeaseUntil: undefined, lastCommandId: command.commandId, lastDecisionId: decisionId };
    } else if (!result.accepted && decision.accepted === false && decision.disposition === "correctable") {
      nextLink = { ...active, status: "running", lastCommandId: command.commandId, lastDecisionId: decisionId };
    } else if (!result.accepted) {
      nextLink = {
        ...active,
        status: "cancelled",
        lastCommandId: command.commandId,
        lastDecisionId: decisionId,
        finalTicketVersion: result.currentTicketVersion ?? active.ticketVersion,
        finalGoalVersion: settled.goal.version,
      };
    } else {
      nextLink = {
          ...active,
          status: "settled",
          lastCommandId: command.commandId,
          lastDecisionId: decisionId,
          finalTicketVersion: result.accepted ? result.ticketVersion : active.ticketVersion,
          finalGoalVersion: settled.goal.version,
      };
    }
    return this.updateLinkAndRecord(currentAggregate, dispatchId, nextLink, recordMutation);
  }

  private async listCorrectionTargets(planId: PlanId, ticketId: TicketId): Promise<Array<{ ticketId: TicketId; title: string; missionCriterionIds?: string[] }>> {
    const plan = await this.tickets.getPlan(planId);
    const incoming = new Map<string, TicketId[]>();
    for (const edge of plan.graph.dependencyEdges) {
      incoming.set(String(edge.toTicketId), [...(incoming.get(String(edge.toTicketId)) ?? []), edge.fromTicketId]);
    }
    const ancestorIds: TicketId[] = [];
    const seen = new Set<string>();
    const queue = [...(incoming.get(String(ticketId)) ?? [])];
    while (queue.length > 0) {
      const current = queue.pop()!;
      if (seen.has(String(current))) continue;
      seen.add(String(current));
      ancestorIds.push(current);
      queue.push(...(incoming.get(String(current)) ?? []));
    }
    const targets: Array<{ ticketId: TicketId; title: string; missionCriterionIds?: string[] }> = [];
    for (const ancestorId of ancestorIds) {
      const work = await this.tickets.getWorkItem(ancestorId);
      if (work?.ticket.status === "completed") {
        const missionCriterionIds = correctionTargetMissionCriterionIds(work.definition);
        targets.push({
          ticketId: ancestorId,
          title: work.definition.title,
          ...(missionCriterionIds.length ? { missionCriterionIds } : {}),
        });
      }
    }
    return targets;
  }

  private async reconcileResolvingLinks(aggregate: MissionAggregate): Promise<MissionAggregate> {
    let current = aggregate;
    for (const link of current.links) {
      if (link.status !== "resolving" || !link.lastProposalId) continue;
      const goal = await this.agents.get(link.agentId).getGoal(link.agentGoalId);
      if (goal?.status === "active" && !goal.activeProposalId) {
        current = await this.updateLink(current, link.dispatchId, { ...link, status: "running" });
        continue;
      }
      current = await this.continueSettlement(current, link.dispatchId, link.lastProposalId);
    }
    return current;
  }

  private async settleAgentProposal(
    agent: AgentPort<MissionTicketOutcome>,
    goalId: string,
    proposalId: string,
    decisionId: string,
    decision: GoalResolutionDecision<GoalResolutionStatus>,
  ): Promise<SettleProposalResult> {
    let goal = await agent.getGoal(goalId);
    if (!goal) throw new Error("Goal is missing");
    let settled = await agent.settleProposal({
      decisionId,
      proposalId,
      expectedGoalVersion: goal.version,
      decision,
    });
    if (settled.applied || settled.code !== "version_conflict") return settled;
    goal = await agent.getGoal(goalId);
    if (!goal || goal.status !== "resolving" || goal.activeProposalId !== proposalId) return settled;
    settled = await agent.settleProposal({
      decisionId,
      proposalId,
      expectedGoalVersion: goal.version,
      decision,
    });
    return settled;
  }

  private async updateLink(aggregate: MissionAggregate, dispatchId: string, next: MissionLink): Promise<MissionAggregate> {
    return this.updateLinkAndRecord(aggregate, dispatchId, next);
  }

  private async updateLinkAndRecord(
    aggregate: MissionAggregate,
    dispatchId: string,
    next: MissionLink,
    recordMutation?: (record: MissionAggregate["record"]) => MissionAggregate["record"],
  ): Promise<MissionAggregate> {
    let expected = aggregate;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        return await this.store.transact(expected.version, (current) => {
          const currentLink = current.links.find((item) => item.dispatchId === dispatchId);
          if (!currentLink) throw new Error("Mission link is missing");
          if (new Set(["settled", "cancelled"]).has(currentLink.status) && currentLink.status !== next.status) {
            return current;
          }
          return {
            ...current,
            version: current.version + 1,
            ...(recordMutation ? { record: recordMutation(current.record) } : {}),
            links: current.links.map((item) => {
              if (item.dispatchId !== dispatchId) return item;
              return { ...currentLink, ...next, updatedAt: this.now().toISOString() } as MissionLink;
            }),
          };
        });
      } catch (error) {
        if (!(error instanceof MissionStoreConflictError) || attempt === 4) throw error;
        expected = await this.requireAggregate();
      }
    }
    return this.requireAggregate();
  }

  private async saveCursor(
    aggregate: MissionAggregate,
    partition: string,
    cursor: unknown,
    versions: Array<[string, number]>,
  ): Promise<MissionAggregate> {
    if (!versions.length && aggregate.cursors.some((item) => item.partition === partition)) return aggregate;
    let expected = aggregate;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        return await this.store.transact(expected.version, (current) => {
          const previous = current.cursors.find((item) => item.partition === partition);
          const appliedVersions = { ...(previous?.appliedVersions ?? {}) };
          for (const [id, version] of versions) appliedVersions[id] = Math.max(appliedVersions[id] ?? 0, version);
          const next: MissionCursorRecord = { partition, cursor, appliedVersions };
          return {
            ...current,
            version: current.version + 1,
            cursors: [...current.cursors.filter((item) => item.partition !== partition), next],
          };
        });
      } catch (error) {
        if (!(error instanceof MissionStoreConflictError) || attempt === 4) throw error;
        expected = await this.requireAggregate();
      }
    }
    return this.requireAggregate();
  }

  private async requireAggregate(): Promise<MissionAggregate> {
    const aggregate = await this.store.read();
    if (!aggregate) throw new Error("Mission does not exist");
    return aggregate;
  }
}

function selectMember(team: TeamBinding, assignment: PlannedTicketAssignment) {
  const candidates = assignment.principalId
    ? team.members.filter((member) => member.principalId === assignment.principalId)
    : team.members;
  const capabilities = assignment.requiredCapabilities ?? [];
  const tools = assignment.requiredTools ?? [];
  return candidates.find((item) =>
    capabilities.every((capability) => item.capabilities.includes(capability))
    && tools.every((tool) => configuredToolsInclude(item.enabledTools, tool)));
}

export async function validateTeamAssignments(
  outcome: MissionTicketOutcome | undefined,
  schemaRef: string | undefined,
  team: TeamBinding,
  tickets?: Pick<TicketPort, "getWorkItem">,
  currentPlan?: SharedPlanContext,
): Promise<string | undefined> {
  if (schemaRef !== "plan-intent-v1") return undefined;
  let compiledChange: PlanChangeSet | undefined;
  if (!outcome?.intent || typeof outcome.intent !== "object" || Array.isArray(outcome.intent) || !currentPlan) {
    return "plan-intent-v1 缺少可编译的 intent 或当前 Plan 快照";
  }
  try {
    compiledChange = compilePlanIntent(outcome.intent as unknown as PlanIntent, {
        planId: currentPlan.planId,
        sourceTicketId: "plan-intent-validation" as TicketId,
        missionCriterionIds: currentPlan.missionBaseline?.criteria.map((criterion) => criterion.criterionId) ?? [],
        requiredTerminalCapabilities: currentPlan.requiredTerminalCapabilities ?? [],
        teamMembers: currentPlan.teamMembers.map((member) => ({
          principalId: member.principalId,
          capabilities: [...member.capabilities],
          enabledTools: [...member.enabledTools],
        })),
        tickets: currentPlan.tickets.map((ticket) => ({
          ticketId: ticket.ticketId as TicketId,
          status: ticket.status as PlanCompilerSnapshot["tickets"][number]["status"],
          ...(ticket.deliveryIncrement ? { deliveryIncrement: structuredClone(ticket.deliveryIncrement) } : {}),
          ...(ticket.assurance ? { assurance: structuredClone(ticket.assurance) } : {}),
        })),
        dependencyEdges: currentPlan.dependencyEdges.map((edge) => ({
          fromTicketId: edge.fromTicketId as TicketId,
          toTicketId: edge.toTicketId as TicketId,
        })),
        requiredTerminalTicketIds: currentPlan.requiredTerminalTicketIds.map((ticketId) => ticketId as TicketId),
        failureResolutionEdges: (currentPlan.failureResolutionEdges ?? []).map((edge) => ({
          failedTicketId: edge.failedTicketId as TicketId,
          resolutionTicketId: edge.resolutionTicketId as TicketId,
        })),
    });
  } catch (error) {
    return error instanceof PlanIntentError ? error.message : String(error);
  }
  const rawChange = compiledChange;
  if (!rawChange || typeof rawChange !== "object" || Array.isArray(rawChange)) return undefined;
  const change = rawChange as unknown as {
    additions: Array<{ clientRef: string; assignment: PlannedTicketAssignment; permissions?: { settleMission?: boolean } }>;
    requiredTerminalRefs: Array<{ clientRef?: string; ticketId?: TicketId }>;
  };
  for (const node of change.additions) {
    if (!membersForAssignment(team, node.assignment).length) {
      const required = node.assignment.requiredCapabilities ?? [];
      const requiredTools = node.assignment.requiredTools ?? [];
      const available = [...new Set(team.members.flatMap((member) => member.capabilities))].join("、");
      const availableTools = [...new Set(team.members.flatMap((member) => member.enabledTools))].join("、");
      return `新增 Ticket ${node.clientRef} 无可分配 Agent；要求能力：${required.join("、") || "未指定"}；要求工具：${requiredTools.join("、") || "无"}；团队可用能力：${available}；团队可用工具：${availableTools}`;
    }
  }
  const terminalCapabilities = team.deliveryPolicy?.requiredTerminalCapabilities ?? [];
  if (!change.requiredTerminalRefs.length) {
    return terminalCapabilities.length
      ? `团队交付策略要求至少一个可验收终点；终点负责人必须具备：${terminalCapabilities.join("、")}`
      : "计划必须包含至少一个拥有 Mission 结算权限的终点";
  }
  const additions = new Map(change.additions.map((node) => [node.clientRef, node]));
  for (const [index, ref] of change.requiredTerminalRefs.entries()) {
    let assignment: PlannedTicketAssignment | undefined;
    let settleMission = false;
    let label = ref.clientRef ?? ref.ticketId ?? `#${index + 1}`;
    if (ref.clientRef) {
      const addition = additions.get(ref.clientRef);
      assignment = addition?.assignment;
      settleMission = addition?.permissions?.settleMission === true;
    } else if (ref.ticketId && tickets) {
      const work = await tickets.getWorkItem(ref.ticketId);
      assignment = work?.definition.assignment;
      settleMission = work?.definition.permissions?.settleMission === true;
    }
    if (!settleMission) return `计划终点 ${label} 必须显式设置 permissions.settleMission=true`;
    if (terminalCapabilities.length && (!assignment || !membersForAssignment(team, assignment).some((member) => terminalCapabilities.every((capability) => member.capabilities.includes(capability))))) {
      return `计划终点 ${label} 不满足团队交付策略；终点负责人必须具备：${terminalCapabilities.join("、")}`;
    }
  }
  if (currentPlan?.missionBaseline) {
    const assurance = validateMissionPlanAssurance(currentPlan.missionBaseline, rawChange, currentPlan);
    if (!assurance.valid) return assurance.reason;
  }
  return undefined;
}

function membersForAssignment(team: TeamBinding, assignment: PlannedTicketAssignment) {
  const candidates = assignment.principalId
    ? team.members.filter((member) => member.principalId === assignment.principalId)
    : team.members;
  const required = assignment.requiredCapabilities ?? [];
  const requiredTools = assignment.requiredTools ?? [];
  return candidates.filter((member) =>
    required.every((capability) => member.capabilities.includes(capability))
    && requiredTools.every((tool) => configuredToolsInclude(member.enabledTools, tool)));
}

function collectEvidenceIds(value: unknown): string[] {
  const ids = new Set<string>();
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) {
      for (const entry of item) visit(entry);
      return;
    }
    if (!item || typeof item !== "object") return;
    for (const [key, entry] of Object.entries(item)) {
      if (key === "evidenceId" && typeof entry === "string" && entry) ids.add(entry);
      else visit(entry);
    }
  };
  visit(value);
  return [...ids];
}

function isActiveLink(link: MissionLink): link is ActiveMissionLink {
  return new Set(["running", "blocked", "resolving", "paused", "recovering"]).has(link.status);
}

function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash("sha256").update(JSON.stringify(parts)).digest("base64url")}`;
}

function isPlanningSchema(schemaRef: string | undefined): boolean {
  return schemaRef === "plan-intent-v1";
}
