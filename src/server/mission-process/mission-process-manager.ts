import { createHash } from "node:crypto";
import type {
  AgentEventCursor,
  AgentPort,
  GoalResolutionDecision,
  GoalResolutionStatus,
  SettleProposalResult,
} from "../../shared/contracts/agent-engine.js";
import type {
  ActiveMissionLink,
  MissionLink,
  MissionStartRequest,
  TeamBinding,
  TicketPort,
} from "../../shared/contracts/mission-control.js";
import type {
  TicketEventCursor,
  TicketId,
  WorkflowId,
} from "../../shared/contracts/ticket-engine.js";
import type { MissionAggregate, MissionCursorRecord } from "./mission-store.js";
import { MissionStore } from "./mission-store.js";
import {
  proposalToTicketCommand,
  ticketResultToGoalDecision,
  validateMissionTicketOutcome,
  type MissionTicketOutcome,
  missionOutcomeInstruction,
} from "./ticket-agent-adapter.js";

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
    const workflowId = stableId("workflow", input.missionId) as WorkflowId;
    const commandId = stableId("workflow_create", input.missionId);
    let aggregate = await this.store.read();
    if (!aggregate) {
      aggregate = await this.store.create({
        missionId: input.missionId,
        workflowId,
        workflowCreateCommandId: commandId,
        status: "starting",
      });
    }
    const replay = await this.tickets.getWorkflowCommandResult(commandId);
    const result = replay ?? await this.tickets.createWorkflow({
      commandId,
      workflowId,
      actorPrincipalId: this.plannerPrincipalId,
      issuedAt: this.now().toISOString(),
      payload: { type: "create_graph", definition: input.resolvedStart.workflowDefinition },
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
    const workflowId = aggregate.record.workflowId;
    const partition = `ticket:${workflowId}`;
    const saved = aggregate.cursors.find((item) => item.partition === partition);
    const page = await this.tickets.readEvents({
      workflowId,
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
    const [workflow, ticket] = await Promise.all([
      this.tickets.getWorkflow(aggregate.record.workflowId),
      this.tickets.getTicket(ticketId),
    ]);
    if (new Set(["completed", "failed", "cancelled"]).has(workflow.status) || ticket?.status !== "ready") {
      return aggregate;
    }
    const dispatchId = stableId("dispatch", aggregate.missionId, ticketId, String(ticketVersion));
    const existing = aggregate.links.find((item) => item.dispatchId === dispatchId);
    if (existing) return this.continueDispatch(aggregate, dispatchId);
    const work = await this.tickets.getWorkItem(ticketId);
    if (!work) throw new Error(`Ticket work item ${ticketId} is missing`);
    const member = selectMemberOrPlanner(this.team, work.definition.assignment.principalId, work.definition.assignment.requiredCapabilities ?? []);
    const link: MissionLink = {
      dispatchId,
      missionId: aggregate.missionId,
      workflowId: aggregate.record.workflowId,
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

  private async continueDispatch(aggregate: MissionAggregate, dispatchId: string): Promise<MissionAggregate> {
    let link = aggregate.links.find((item) => item.dispatchId === dispatchId);
    if (!link) throw new Error("Mission link is missing");
    const agent = this.agents.get(link.agentId);
    if (link.status === "dispatching") {
      const claim = await this.tickets.getClaimByRequestId(link.claimRequestId) ?? await this.tickets.claimReady({
        requestId: link.claimRequestId,
        workflowId: link.workflowId,
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
            ? `${assignmentIssue}。记录分配阻塞事实，等待具备授权的 workflow 维护者修订 Ticket DAG。`
            : work.definition.objective,
          successCriteria: assignmentIssue
            ? ["明确记录无法分配的能力", "提交 blocked，不伪装完成原工作"]
            : work.definition.successCriteria,
          contextRefs: [
            { kind: "mission", ref: aggregate.missionId },
            { kind: "workflow", ref: link.workflowId },
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
          ? `${assignmentIssue}。这是工单分配异常，不执行原工作；请提交 blocked，并在 summary 中记录缺失能力。`
          : missionOutcomeInstruction(
              work.definition.outputContract.schemaRef,
              [...new Set(this.team.members.flatMap((item) => item.capabilities))],
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
    const workflow = await this.tickets.getWorkflow(link.workflowId);
    const goal = await agent.getGoal(link.agentGoalId);
    if (!goal) throw new Error("Goal is missing");
    const schemaRef = goal.spec.outputContract?.schemaRef;
    const validation = validateMissionTicketOutcome(schemaRef, proposal.status, proposal.domainOutcome);
    const assignmentError = validation.valid
      ? validateTeamAssignments(proposal.domainOutcome as MissionTicketOutcome, schemaRef, this.team)
      : undefined;
    const correctionReason = validation.valid ? assignmentError : validation.reason;
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
    const command = proposalToTicketCommand(proposal as never, active, schemaRef, workflow.version, this.now().toISOString());
    const result = await this.tickets.getTicketCommandResult(command.commandId) ?? await this.tickets.applyTicket(command);
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
    return this.updateLink(aggregate, dispatchId, nextLink);
  }

  private async reconcileResolvingLinks(aggregate: MissionAggregate): Promise<MissionAggregate> {
    let current = aggregate;
    for (const link of current.links) {
      if (link.status !== "resolving" || !link.lastProposalId) continue;
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
    return this.store.transact(aggregate.version, (current) => ({
      ...current,
      version: current.version + 1,
      links: current.links.map((item) => item.dispatchId === dispatchId ? { ...next, updatedAt: this.now().toISOString() } : item),
    }));
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

function selectMemberOrPlanner(team: TeamBinding, principalId: string | undefined, capabilities: string[]) {
  const candidates = principalId
    ? team.members.filter((member) => member.principalId === principalId)
    : team.members;
  const member = candidates.find((item) => capabilities.every((capability) => item.capabilities.includes(capability)));
  if (member) return member;
  const planner = team.members.find((item) => item.capabilities.includes("workflow:plan"));
  if (planner) return planner;
  throw new Error(`No Agent satisfies capabilities: ${capabilities.join(", ")}`);
}

function validateTeamAssignments(outcome: MissionTicketOutcome, schemaRef: string | undefined, team: TeamBinding): string | undefined {
  if (schemaRef !== "ticket-graph-v2" || !outcome.graph || typeof outcome.graph !== "object" || Array.isArray(outcome.graph)) return undefined;
  const graph = outcome.graph as unknown as { nodes: Array<{ key: string; assignment: { principalId?: string; requiredCapabilities?: string[] } }> };
  for (const node of graph.nodes) {
    const candidates = node.assignment.principalId
      ? team.members.filter((member) => member.principalId === node.assignment.principalId)
      : team.members;
    const required = node.assignment.requiredCapabilities ?? [];
    if (!candidates.some((member) => required.every((capability) => member.capabilities.includes(capability)))) {
      const available = [...new Set(team.members.flatMap((member) => member.capabilities))].join("、");
      return `节点 ${node.key} 无可分配 Agent；要求能力：${required.join("、") || "未指定"}；团队可用能力：${available}`;
    }
  }
  return undefined;
}

function isActiveLink(link: MissionLink): link is ActiveMissionLink {
  return new Set(["running", "blocked", "resolving", "paused", "recovering"]).has(link.status);
}

function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash("sha256").update(JSON.stringify(parts)).digest("base64url")}`;
}
