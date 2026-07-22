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
  TicketId,
  PlanId,
} from "../../shared/contracts/ticket-engine.js";
import type { MissionAggregate, MissionCursorRecord } from "./mission-store.js";
import { MissionStore, MissionStoreConflictError } from "./mission-store.js";
import {
  proposalToPlanChangeCommand,
  planResultToGoalDecision,
  proposalToTicketCommand,
  ticketResultToGoalDecision,
  createMissionBaseline,
  validateMissionSettlement,
  validateMissionTicketOutcome,
  type MissionTicketOutcome,
  missionOutcomeInstruction,
} from "./ticket-agent-adapter.js";
import { orderedAncestorTicketIds } from "./ticket-context-lineage.js";

export interface MissionAgentDirectory {
  get(agentId: string): AgentPort<MissionTicketOutcome>;
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
      aggregate = await this.store.create({
        missionId: input.missionId,
        objective: input.objective,
        planId,
        planCreateCommandId: commandId,
        ownerPrincipalId: input.ownerPrincipalId,
        teamBinding: structuredClone(input.teamBinding),
        status: "starting",
      });
    }
    if (aggregate.record.objective !== input.objective) throw new Error("Mission objective mismatch");
    if (aggregate.record.teamBinding.contentHash !== this.team.contentHash) throw new Error("Persisted TeamBinding does not match runtime TeamBinding");
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
      return this.store.transact(aggregate.version, (current) => ({
        ...current,
        version: current.version + 1,
        record: { ...current.record, status: "start_failed", failure: result.reason },
      }));
    }
    if (aggregate.record.status === "linked") return aggregate;
    return this.store.transact(aggregate.version, (current) => ({
      ...current,
      version: current.version + 1,
      record: { ...current.record, status: "linked", linkedAt: this.now().toISOString() },
    }));
  }

  async tick(): Promise<MissionAggregate> {
    let aggregate = await this.requireAggregate();
    if (aggregate.record.status !== "linked") return aggregate;
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
    return this.tick();
  }

  async resumeBlockedAgent(agentId: string): Promise<MissionAggregate> {
    const aggregate = await this.requireAggregate();
    const link = aggregate.links.find((item) => item.agentId === agentId && item.status === "blocked");
    if (!link || !isActiveLink(link)) return aggregate;
    return this.updateLink(aggregate, link.dispatchId, { ...link, status: "running" });
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
    const [plan, ticket] = await Promise.all([
      this.tickets.getPlan(aggregate.record.planId),
      this.tickets.getTicket(ticketId),
    ]);
    if (new Set(["completed", "failed", "cancelled"]).has(plan.status) || ticket?.status !== "ready") {
      return aggregate;
    }
    const dispatchId = stableId("dispatch", aggregate.missionId, ticketId, String(ticketVersion));
    const existing = aggregate.links.find((item) => item.dispatchId === dispatchId);
    if (existing) return this.continueDispatch(aggregate, dispatchId);
    const work = await this.tickets.getWorkItem(ticketId);
    if (!work) throw new Error(`Ticket work item ${ticketId} is missing`);
    const member = selectMember(this.team, work.definition.assignment.principalId, work.definition.assignment.requiredCapabilities ?? []);
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
    const persisted = await this.store.transact(aggregate.version, (current) => ({
      ...current,
      version: current.version + 1,
      links: [...current.links, link],
    }));
    return this.continueDispatch(persisted, dispatchId);
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
        authority: { kind: "claim", claimId: claim.claimId, fencingToken: claim.fencingToken },
        claimLeaseUntil: claim.leaseUntil,
        updatedAt: this.now().toISOString(),
      });
      link = aggregate.links.find((item) => item.dispatchId === dispatchId)!;
    }
    if (link.status !== "starting") return aggregate;
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
      const assignmentIssue = missingCapabilities.length
        ? `工单 ${link.ticketId} 要求团队中不存在的能力：${missingCapabilities.join("、")}`
        : undefined;
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
          outputContract: work.definition.outputContract,
          externalRef: link.ticketId,
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
              await this.listCorrectionTargets(link.planId, link.ticketId),
              link.ticketId,
              await this.sharedPlanContext(link.planId, aggregate.record.baseline),
              await this.listUpstreamDeliveries(link.planId, link.ticketId),
              {
                ticket: {
                  ticketId: work.ticket.ticketId,
                  title: work.definition.title,
                  objective: work.definition.objective,
                  successCriteria: work.definition.successCriteria,
                  outputContract: work.definition.outputContract,
                  permissions: work.definition.permissions,
                  reworkRequests: await this.listReworkRequests(link.planId, link.ticketId),
                },
              },
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
      tickets: workItems.flatMap((work) => work ? [{
        ticketId: String(work.ticket.ticketId),
        status: work.ticket.status,
        title: work.definition.title,
        objective: work.definition.objective,
        successCriteria: work.definition.successCriteria,
        outputContract: work.definition.outputContract,
      }] : []),
      dependencyEdges: plan.graph.dependencyEdges.map((edge) => ({
        fromTicketId: String(edge.fromTicketId),
        toTicketId: String(edge.toTicketId),
      })),
      requiredTerminalTicketIds: plan.completionPolicy.requiredTerminalTicketIds.map(String),
      requiredTerminalCapabilities: this.team.deliveryPolicy?.requiredTerminalCapabilities ?? [],
      ...(missionBaseline ? { missionBaseline } : {}),
      teamMembers: this.team.members.map((member) => ({
        principalId: member.principalId,
        name: member.agentId,
        capabilities: member.capabilities,
      })),
    };
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
    }] : []);
  }

  private async listReworkRequests(planId: PlanId, ticketId: TicketId) {
    let after: TicketEventCursor | undefined;
    const matches: Array<{
      sourceTicketId: TicketId;
      reason: string;
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
        if (event.aggregateType !== "agent_goal" || event.payload.type !== "GoalProposalCreated") continue;
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

  private async continueSettlement(
    aggregate: MissionAggregate,
    dispatchId: string,
    proposalId: string,
  ): Promise<MissionAggregate> {
    const link = aggregate.links.find((item) => item.dispatchId === dispatchId);
    if (!link || link.status !== "resolving") return aggregate;
    const active = link as ActiveMissionLink;
    const agent = this.agents.get(link.agentId);
    const proposal = await agent.getProposal(proposalId);
    if (!proposal) throw new Error("Goal proposal is missing");
    const plan = await this.tickets.getPlan(link.planId);
    const goal = await agent.getGoal(link.agentGoalId);
    if (!goal) throw new Error("Goal is missing");
    const work = await this.tickets.getWorkItem(link.ticketId);
    if (!work) throw new Error("Ticket work item is missing");
    const schemaRef = goal.spec.outputContract?.schemaRef;
    const validation = validateMissionTicketOutcome(schemaRef, proposal.status, proposal.domainOutcome, proposal.humanInputRequest);
    const assignmentError = validation.valid
      ? await validateTeamAssignments(proposal.domainOutcome as MissionTicketOutcome, schemaRef, this.team, this.tickets)
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
    if (validation.valid && proposal.status === "completed" && work.definition.permissions?.settleMission) {
      const member = this.team.members.find((item) => item.principalId === link.agentPrincipalId);
      const required = this.team.deliveryPolicy?.requiredTerminalCapabilities ?? [];
      if (!member || !required.every((capability) => member.capabilities.includes(capability))) {
        missionContractError = `当前 Agent 没有 Mission 结算能力：${required.join("、")}`;
      } else if (!aggregate.record.baseline) missionContractError = "Mission 尚未建立权威 baseline，不能结算";
      else {
        const resolution = (proposal.domainOutcome as MissionTicketOutcome | undefined)?.missionResolution;
        const settlementValidation = validateMissionSettlement(aggregate.record.baseline, resolution);
        if (!settlementValidation.valid) missionContractError = settlementValidation.reason;
      }
    }
    const correctionReason = validation.valid ? (assignmentError ?? missionContractError) : validation.reason;
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
    const planCommand = schemaRef === "plan-change-set-v3"
      ? proposalToPlanChangeCommand(proposal as never, active, plan.version, this.now().toISOString())
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
    if (result.accepted && result.ticketStatus === "completed") {
      if (work.definition.contextPolicy?.establishesMissionBaseline) {
        const baseline = createMissionBaseline(
          proposal.domainOutcome as MissionTicketOutcome,
          link.ticketId,
          (currentAggregate.record.baseline?.version ?? 0) + 1,
          this.now().toISOString(),
        );
        currentAggregate = await this.store.transact(currentAggregate.version, (current) => ({
          ...current,
          version: current.version + 1,
          record: { ...current.record, baseline },
        }));
      }
      if (work.definition.permissions?.settleMission) {
        const baseline = currentAggregate.record.baseline!;
        const resolution = (proposal.domainOutcome as MissionTicketOutcome).missionResolution as {
          baselineVersion: number;
          summary: string;
          criterionResults: Array<{ criterionId: string; status: "satisfied"; evidence: Array<{ kind: string; ref: string; note?: string }> }>;
          residualRisks: string[];
        };
        const linkedAt = "linkedAt" in currentAggregate.record ? currentAggregate.record.linkedAt : this.now().toISOString();
        currentAggregate = await this.store.transact(currentAggregate.version, (current) => ({
          ...current,
          version: current.version + 1,
          record: {
            ...current.record,
            status: "completed",
            linkedAt,
            baseline,
            settlement: {
              ...structuredClone(resolution),
              acceptedByTicketId: link.ticketId,
              acceptedByPrincipalId: link.agentPrincipalId,
              settledAt: this.now().toISOString(),
            },
          },
        }));
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
    return this.updateLink(currentAggregate, dispatchId, nextLink);
  }

  private async listCorrectionTargets(planId: PlanId, ticketId: TicketId): Promise<Array<{ ticketId: TicketId; title: string }>> {
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
    const targets: Array<{ ticketId: TicketId; title: string }> = [];
    for (const ancestorId of ancestorIds) {
      const work = await this.tickets.getWorkItem(ancestorId);
      if (work?.ticket.status === "completed") targets.push({ ticketId: ancestorId, title: work.definition.title });
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
    const previous = aggregate.cursors.find((item) => item.partition === partition);
    const appliedVersions = { ...(previous?.appliedVersions ?? {}) };
    for (const [id, version] of versions) appliedVersions[id] = Math.max(appliedVersions[id] ?? 0, version);
    const next: MissionCursorRecord = { partition, cursor, appliedVersions };
    return this.store.transact(aggregate.version, (current) => ({
      ...current,
      version: current.version + 1,
      cursors: [...current.cursors.filter((item) => item.partition !== partition), next],
    }));
  }

  private async requireAggregate(): Promise<MissionAggregate> {
    const aggregate = await this.store.read();
    if (!aggregate) throw new Error("Mission does not exist");
    return aggregate;
  }
}

function selectMember(team: TeamBinding, principalId: string | undefined, capabilities: string[]) {
  const candidates = principalId
    ? team.members.filter((member) => member.principalId === principalId)
    : team.members;
  return candidates.find((item) => capabilities.every((capability) => item.capabilities.includes(capability)));
}

export async function validateTeamAssignments(
  outcome: MissionTicketOutcome | undefined,
  schemaRef: string | undefined,
  team: TeamBinding,
  tickets?: Pick<TicketPort, "getWorkItem">,
): Promise<string | undefined> {
  if (schemaRef !== "plan-change-set-v3" || !outcome?.change || typeof outcome.change !== "object" || Array.isArray(outcome.change)) return undefined;
  const change = outcome.change as unknown as {
    additions: Array<{ clientRef: string; assignment: { principalId?: string; requiredCapabilities?: string[] }; permissions?: { settleMission?: boolean } }>;
    requiredTerminalRefs: Array<{ clientRef?: string; ticketId?: TicketId }>;
  };
  for (const node of change.additions) {
    if (!membersForAssignment(team, node.assignment).length) {
      const required = node.assignment.requiredCapabilities ?? [];
      const available = [...new Set(team.members.flatMap((member) => member.capabilities))].join("、");
      return `新增 Ticket ${node.clientRef} 无可分配 Agent；要求能力：${required.join("、") || "未指定"}；团队可用能力：${available}`;
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
    let assignment: { principalId?: string; requiredCapabilities?: string[] } | undefined;
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
  return undefined;
}

function membersForAssignment(team: TeamBinding, assignment: { principalId?: string; requiredCapabilities?: string[] }) {
  const candidates = assignment.principalId
    ? team.members.filter((member) => member.principalId === assignment.principalId)
    : team.members;
  const required = assignment.requiredCapabilities ?? [];
  return candidates.filter((member) => required.every((capability) => member.capabilities.includes(capability)));
}

function isActiveLink(link: MissionLink): link is ActiveMissionLink {
  return new Set(["running", "blocked", "resolving", "paused", "recovering"]).has(link.status);
}

function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash("sha256").update(JSON.stringify(parts)).digest("base64url")}`;
}
