import { createHash } from "node:crypto";
import type {
  AgentEventCursor,
  AgentPort,
  GoalResolutionStatus,
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
  type MissionTicketOutcome,
} from "./ticket-agent-adapter.js";

export interface MissionAgentDirectory {
  get(agentId: string): AgentPort<MissionTicketOutcome>;
}

export class MissionProcessManager {
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
    const dispatchId = stableId("dispatch", aggregate.missionId, ticketId, String(ticketVersion));
    const existing = aggregate.links.find((item) => item.dispatchId === dispatchId);
    if (existing) return this.continueDispatch(aggregate, dispatchId);
    const work = await this.tickets.getWorkItem(ticketId);
    if (!work) throw new Error(`Ticket work item ${ticketId} is missing`);
    const member = selectMember(this.team, work.definition.assignment.principalId, work.definition.assignment.requiredCapabilities ?? []);
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
        leaseDurationMs: 5 * 60_000,
      });
      if (!claim) return aggregate;
      aggregate = await this.updateLink(aggregate, dispatchId, {
        ...link,
        status: "starting",
        ticketVersion: claim.ticketVersion,
        authority: { kind: "claim", claimId: claim.claimId, fencingToken: claim.fencingToken },
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
      const prior = await agent.getGoalByStartKey(link.goalStartKey);
      const goal = prior ?? await agent.startGoal({
        agentId: link.agentId,
        threadId,
        idempotencyKey: link.goalStartKey,
        spec: {
          id: stableId("goal", dispatchId),
          threadId,
          objective: work.definition.objective,
          successCriteria: work.definition.successCriteria,
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
    const command = proposalToTicketCommand(proposal as never, active, workflow.version, this.now().toISOString());
    const result = await this.tickets.getTicketCommandResult(command.commandId) ?? await this.tickets.applyTicket(command);
    const decisionId = stableId("goal_decision", proposalId, command.commandId);
    const decision = ticketResultToGoalDecision(proposal, result);
    const settled = await agent.settleProposal({
      decisionId,
      proposalId,
      expectedGoalVersion: (await agent.getGoal(link.agentGoalId))!.version,
      decision,
    });
    if (!settled.applied && settled.code === "version_conflict") return aggregate;
    let nextLink: MissionLink;
    if (result.accepted && result.ticketStatus === "blocked") {
      nextLink = { ...active, status: "blocked", authority: result.nextAuthority ?? active.authority, lastCommandId: command.commandId, lastDecisionId: decisionId };
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

function selectMember(team: TeamBinding, principalId: string | undefined, capabilities: string[]) {
  const candidates = principalId
    ? team.members.filter((member) => member.principalId === principalId)
    : team.members;
  const member = candidates.find((item) => capabilities.every((capability) => item.capabilities.includes(capability)));
  if (!member) throw new Error(`No Agent satisfies capabilities: ${capabilities.join(", ")}`);
  return member;
}

function isActiveLink(link: MissionLink): link is ActiveMissionLink {
  return new Set(["running", "blocked", "resolving", "paused", "recovering"]).has(link.status);
}

function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash("sha256").update(JSON.stringify(parts)).digest("base64url")}`;
}
