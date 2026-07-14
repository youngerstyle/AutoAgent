import { createHash, randomUUID } from "node:crypto";
import type {
  BlockedOwnershipReceipt,
  ClaimReceipt,
  ClaimRequest,
  PlanAuthorizationPolicy,
  PlanCommandEnvelope,
  PlanCommandResult,
  PlanId,
  PlanPolicyPort,
  PlanStatus,
  ReleaseClaimRequest,
  RenewClaimRequest,
  TicketCommandEnvelope,
  TicketCommandPayload,
  TicketCommandResult,
  TicketEvent,
  TicketEventPage,
  TicketEventQuery,
  TicketExecutionAuthority,
  TicketId,
  TicketSnapshot,
  TicketStatus,
  TicketWorkItem,
  TransferBlockedOwnershipRequest,
} from "../../shared/contracts/ticket-engine.js";
import {
  DEFAULT_GRAPH_LIMITS,
  evaluatePlanOutcome,
  materializePlanGraph,
  PlanGraphError,
  type MaterializedPlanGraph,
} from "./plan-graph.js";
import {
  TicketStore,
  TicketStoreConflictError,
  type TicketAggregate,
  type TicketOperationRecord,
} from "./ticket-store.js";

const TERMINAL_PLAN = new Set<PlanStatus>(["completed", "failed", "cancelled"]);
const TERMINAL_TICKET = new Set<TicketStatus>(["completed", "returned", "failed", "cancelled"]);

export interface TicketEngineOptions { teamBindingIds?: string[]; now?: () => Date }
export class TicketEngineOperationError extends Error {
  constructor(public readonly code: "invalid_request" | "idempotency_conflict" | "stale_authority" | "policy_violation", message: string) { super(message); }
}

export class TicketEngine {
  private readonly teamBindingIds: string[];
  private readonly now: () => Date;

  constructor(
    private readonly store: TicketStore,
    private readonly policyPort: PlanPolicyPort,
    options: TicketEngineOptions = {},
  ) {
    this.teamBindingIds = options.teamBindingIds ?? [];
    this.now = options.now ?? (() => new Date());
  }

  async getPlan(planId: PlanId) {
    const aggregate = await this.store.read(planId);
    if (!aggregate) throw new TicketEngineOperationError("invalid_request", "Plan does not exist");
    return structuredClone(aggregate.plan);
  }

  async getTicket(ticketId: TicketId): Promise<TicketSnapshot | undefined> {
    for (const planId of await this.store.listPlanIds()) {
      const ticket = (await this.store.read(planId))?.tickets.find((item) => item.ticketId === ticketId);
      if (ticket) return structuredClone(ticket);
    }
    return undefined;
  }

  async getWorkItem(ticketId: TicketId): Promise<TicketWorkItem | undefined> {
    for (const planId of await this.store.listPlanIds()) {
      const aggregate = await this.store.read(planId);
      const ticket = aggregate?.tickets.find((item) => item.ticketId === ticketId);
      const definition = aggregate?.definitionsByTicketId[String(ticketId)];
      if (ticket && definition) return { ticket: structuredClone(ticket), definition: structuredClone(definition) };
    }
    return undefined;
  }

  async getClaim(claimId: string): Promise<ClaimReceipt | undefined> { return this.store.findClaim(claimId); }
  async getClaimByRequestId(requestId: string): Promise<ClaimReceipt | undefined> {
    const record = await this.store.findOperationRecord(requestId);
    return record?.kind === "claim" || record?.kind === "renew_claim" ? record.claim : undefined;
  }

  async getPlanCommandResult(planId: PlanId, commandId: string): Promise<PlanCommandResult | undefined> {
    const value = await this.store.getCommandResult(planId, commandId);
    return value && "planVersion" in value && !("proposalId" in value) ? value as PlanCommandResult : undefined;
  }

  async getTicketCommandResult(planId: PlanId, commandId: string): Promise<TicketCommandResult | undefined> {
    const value = await this.store.getCommandResult(planId, commandId);
    return value && "proposalId" in value ? value as TicketCommandResult : undefined;
  }

  async createPlan(command: PlanCommandEnvelope): Promise<PlanCommandResult> {
    if (command.payload.type !== "create_plan") return this.rejectPlan(command, "invalid_command", "Plan creation requires create_plan");
    const fingerprint = fingerprintOf(command);
    const existing = await this.store.read(command.planId);
    if (existing) return this.replayPlan(existing, command.commandId, fingerprint);
    const policy = await this.policyPort.getPolicy(command.payload.definition.policyRef);
    if (!policy || !hasCapability(policy, command.actorPrincipalId, this.teamBindingIds, "plan:create")) {
      return { accepted: false, commandId: command.commandId, code: "policy_violation", reason: "Principal cannot create Plan" };
    }
    try {
      const materialized = materializePlanGraph({ planId: command.planId, change: command.payload.definition.initialChange });
      const tickets = createTickets(materialized, command.planId);
      initializeReady(tickets, materialized.graph.dependencyEdges);
      const plan = {
        planId: command.planId,
        missionId: command.payload.missionId,
        version: 1,
        status: "active" as const,
        graph: materialized.graph,
        completionPolicy: materialized.completionPolicy,
        policyRef: command.payload.definition.policyRef,
        plannerAssignment: command.payload.definition.plannerAssignment,
      };
      const result: PlanCommandResult = { accepted: true, commandId: command.commandId, planStatus: plan.status, planVersion: plan.version };
      const events = [
        planEvent(command.planId, 1, { type: "PlanChanged", addedTicketIds: [...materialized.addedTicketIds] }, command.issuedAt),
        ...tickets.filter((ticket) => ticket.status === "ready").map((ticket) => ticketEvent(ticket, { type: "TicketReady", ticketVersion: ticket.version }, command.issuedAt)),
      ];
      await this.store.create({
        schemaVersion: 3,
        plan,
        definitionsByTicketId: { ...materialized.definitionsByTicketId },
        tickets,
        commandInputs: [{ commandId: command.commandId, fingerprint }],
        commandResults: [result],
        pendingEvents: events,
      });
      return result;
    } catch (error) {
      if (error instanceof PlanGraphError) return { accepted: false, commandId: command.commandId, code: "invalid_definition", reason: error.message };
      if (error instanceof TicketStoreConflictError) {
        const raced = await this.store.read(command.planId);
        return raced
          ? this.replayPlan(raced, command.commandId, fingerprint)
          : { accepted: false, commandId: command.commandId, code: "version_conflict", reason: error.message };
      }
      throw error;
    }
  }

  async applyPlan(command: PlanCommandEnvelope): Promise<PlanCommandResult> {
    if (command.payload.type === "create_plan") return this.createPlan(command);
    const payload = command.payload;
    const aggregate = await this.requirePlan(command.planId);
    const fingerprint = fingerprintOf(command);
    const replay = replayCommand<PlanCommandResult>(aggregate, command.commandId, fingerprint);
    if (replay) return replay;
    if (TERMINAL_PLAN.has(aggregate.plan.status)) return this.persistPlanRejection(aggregate, command, fingerprint, "plan_terminal", "Plan is terminal");
    if (payload.type === "pause" && aggregate.plan.status === "paused") return this.persistPlanRejection(aggregate, command, fingerprint, "invalid_command", "Plan is already paused");
    if (payload.type === "resume" && aggregate.plan.status !== "paused") return this.persistPlanRejection(aggregate, command, fingerprint, "invalid_command", "Plan is not paused");
    const expected = payload.expectedPlanVersion;
    if (expected !== aggregate.plan.version) return this.persistPlanRejection(aggregate, command, fingerprint, "version_conflict", "Plan version conflict");
    const capability = payload.type === "apply_change" ? "plan:amend" : "plan:control";
    const policy = await this.policyPort.getPolicy(aggregate.plan.policyRef);
    const delegatedChange = payload.type === "apply_change"
      && canApplyChangeFromTicket(aggregate, payload.sourceTicketId, payload.sourceAuthority, command.actorPrincipalId);
    if (!delegatedChange && (!policy || !hasCapability(policy, command.actorPrincipalId, this.teamBindingIds, capability))) {
      return this.persistPlanRejection(aggregate, command, fingerprint, "policy_violation", `Principal lacks ${capability}`);
    }
    try {
      const next = await this.store.transact(command.planId, versions(aggregate), (current) => {
        let plan = { ...current.plan, version: current.plan.version + 1 };
        let tickets = structuredClone(current.tickets);
        let definitions = structuredClone(current.definitionsByTicketId);
        const pendingEvents: TicketEvent[] = [];
        if (payload.type === "pause" || payload.type === "resume") {
          if (payload.type === "pause") {
            plan = { ...plan, status: "paused", deferredOutcome: current.plan.status === "blocked" ? "blocked" : "active" };
          } else {
            const resumed = evaluatePlanOutcome({
              graph: current.plan.graph,
              completionPolicy: current.plan.completionPolicy,
              ticketStatuses: statusMap(current.tickets),
              deferredOutcome: current.plan.deferredOutcome ?? "active",
            });
            plan = { ...plan, status: resumed, deferredOutcome: undefined };
          }
          pendingEvents.push(planEvent(command.planId, plan.version, { type: "PlanStatusChanged", status: plan.status }, command.issuedAt));
        } else if (payload.type === "cancel") {
          plan.status = "cancelled";
          tickets = tickets.map((ticket) => TERMINAL_TICKET.has(ticket.status) ? ticket : { ...ticket, status: "cancelled", version: ticket.version + 1, activeAuthority: undefined });
          pendingEvents.push(planEvent(command.planId, plan.version, { type: "PlanStatusChanged", status: plan.status }, command.issuedAt));
        } else {
          const materialized = materializePlanGraph({
            planId: command.planId,
            previous: asMaterialized(current),
            change: payload.change,
            ticketStatuses: statusMap(current.tickets),
          });
          const added = createTickets(materialized, command.planId).filter((ticket) => materialized.addedTicketIds.includes(ticket.ticketId));
          const cancellationIds = new Set(payload.change.cancelTicketIds.map(String));
          const cancelled = tickets
            .filter((ticket) => cancellationIds.has(String(ticket.ticketId)))
            .map((ticket) => ({ ...ticket, status: "cancelled" as const, version: ticket.version + 1, activeAuthority: undefined }));
          const cancelledById = new Map(cancelled.map((ticket) => [String(ticket.ticketId), ticket]));
          tickets = [...tickets.map((ticket) => cancelledById.get(String(ticket.ticketId)) ?? ticket), ...added];
          initializeReady(tickets, materialized.graph.dependencyEdges);
          plan = { ...plan, status: "active", graph: materialized.graph, completionPolicy: materialized.completionPolicy };
          definitions = { ...materialized.definitionsByTicketId };
          pendingEvents.push(planEvent(command.planId, plan.version, { type: "PlanChanged", addedTicketIds: [...materialized.addedTicketIds] }, command.issuedAt));
          for (const ticket of cancelled) pendingEvents.push(ticketEvent(ticket, { type: "TicketTerminal", status: "cancelled" }, command.issuedAt));
          for (const ticket of added.filter((item) => item.status === "ready")) pendingEvents.push(ticketEvent(ticket, { type: "TicketReady", ticketVersion: ticket.version }, command.issuedAt));
          current.claims = current.claims.filter((claim) => !cancellationIds.has(String(claim.ticketId)));
          current.blockedOwnerships = current.blockedOwnerships.filter((owner) => !cancellationIds.has(String(owner.ticketId)));
        }
        const result: PlanCommandResult = { accepted: true, commandId: command.commandId, planStatus: plan.status, planVersion: plan.version };
        return appendCommand(current, { plan, tickets, definitionsByTicketId: definitions, pendingEvents }, command.commandId, fingerprint, result);
      });
      return next.commandResults.find((item) => item.commandId === command.commandId)! as PlanCommandResult;
    } catch (error) {
      if (error instanceof PlanGraphError) return this.persistPlanRejection(aggregate, command, fingerprint, "invalid_command", error.message);
      if (error instanceof TicketStoreConflictError) return this.persistPlanRejection(await this.requirePlan(command.planId), command, fingerprint, "version_conflict", error.message);
      throw error;
    }
  }

  async claimReady(input: ClaimRequest): Promise<ClaimReceipt | undefined> {
    requirePositiveDuration(input.leaseDurationMs, "leaseDurationMs");
    const replay = await this.store.findOperationRecord(input.requestId);
    if (replay) {
      if (replay.kind !== "claim" || replay.fingerprint !== fingerprintOf(input)) throw new TicketEngineOperationError("idempotency_conflict", "Claim request was reused");
      return structuredClone(replay.claim);
    }
    const aggregate = await this.requirePlan(input.planId);
    const ticket = aggregate.tickets.find((item) => item.ticketId === input.ticketId);
    const definition = aggregate.definitionsByTicketId[String(input.ticketId)];
    const claimablePlan = aggregate.plan.status === "active"
      || (aggregate.plan.status === "blocked" && definition?.outputContract.schemaRef === "plan-change-set-v3");
    if (!ticket || ticket.status !== "ready" || ticket.version !== input.expectedTicketVersion || !claimablePlan) return undefined;
    const policy = await this.policyPort.getPolicy(aggregate.plan.policyRef);
    if (!policy || !hasCapability(policy, input.principalId, this.teamBindingIds, "ticket:claim")) throw new TicketEngineOperationError("policy_violation", "Principal cannot claim Ticket");
    const receipt: ClaimReceipt = {
      requestId: input.requestId,
      claimId: randomUUID(),
      planId: input.planId,
      ticketId: input.ticketId,
      ticketVersion: ticket.version + 1,
      principalId: input.principalId,
      fencingToken: 1,
      leaseUntil: new Date(this.now().getTime() + input.leaseDurationMs).toISOString(),
    };
    try {
      await this.store.transact(input.planId, versions(aggregate), (current) => {
        const tickets = current.tickets.map((item) => item.ticketId === input.ticketId ? { ...item, status: "running" as const, version: receipt.ticketVersion, activeAuthority: { kind: "claim" as const, claimId: receipt.claimId, fencingToken: 1 } } : item);
        const plan = { ...current.plan, version: current.plan.version + 1 };
        return { ...current, plan, tickets, claims: [...current.claims, receipt], operationRecords: [...current.operationRecords, { kind: "claim", requestId: input.requestId, fingerprint: fingerprintOf(input), claim: receipt }], pendingEvents: [ticketEvent(tickets.find((item) => item.ticketId === input.ticketId)!, { type: "TicketClaimed", claimId: receipt.claimId }, this.now().toISOString())] };
      });
      return receipt;
    } catch (error) {
      if (!(error instanceof TicketStoreConflictError)) throw error;
      const raced = await this.store.findOperationRecord(input.requestId);
      if (raced?.kind === "claim" && raced.fingerprint === fingerprintOf(input)) return raced.claim;
      return undefined;
    }
  }

  async renewClaim(input: RenewClaimRequest): Promise<ClaimReceipt> {
    requirePositiveDuration(input.extendByMs, "extendByMs");
    const replay = await this.store.findOperationRecord(input.requestId);
    if (replay) {
      if (replay.kind !== "renew_claim" || replay.fingerprint !== fingerprintOf(input)) throw new TicketEngineOperationError("idempotency_conflict", "Renew request was reused");
      return structuredClone(replay.claim);
    }
    const claim = await this.requireClaim(input.claimId, input.fencingToken);
    const aggregate = await this.requirePlan(claim.planId);
    const renewed = { ...claim, requestId: input.requestId, leaseUntil: new Date(Math.max(this.now().getTime(), Date.parse(claim.leaseUntil)) + input.extendByMs).toISOString() };
    await this.store.transact(claim.planId, versions(aggregate), (current) => ({ ...current, plan: { ...current.plan, version: current.plan.version + 1 }, claims: current.claims.map((item) => item.claimId === claim.claimId ? renewed : item), operationRecords: [...current.operationRecords, { kind: "renew_claim", requestId: input.requestId, fingerprint: fingerprintOf(input), claim: renewed }] }));
    return renewed;
  }

  async releaseClaim(input: ReleaseClaimRequest): Promise<TicketSnapshot> {
    const replay = await this.store.findOperationRecord(input.requestId);
    if (replay) {
      if (replay.kind !== "release_claim" || replay.fingerprint !== fingerprintOf(input)) throw new TicketEngineOperationError("idempotency_conflict", "Release request was reused");
      return structuredClone(replay.ticket);
    }
    const claim = await this.requireClaim(input.claimId, input.fencingToken);
    const aggregate = await this.requirePlan(claim.planId);
    const next = await this.store.transact(claim.planId, versions(aggregate), (current) => {
      const tickets = current.tickets.map((ticket) => ticket.ticketId === claim.ticketId && ticket.status === "running" ? { ...ticket, status: "ready" as const, version: ticket.version + 1, activeAuthority: undefined } : ticket);
      const released = tickets.find((ticket) => ticket.ticketId === claim.ticketId)!;
      return { ...current, plan: { ...current.plan, version: current.plan.version + 1 }, tickets, claims: current.claims.filter((item) => item.claimId !== claim.claimId), operationRecords: [...current.operationRecords, { kind: "release_claim", requestId: input.requestId, fingerprint: fingerprintOf(input), ticket: released }], pendingEvents: [ticketEvent(released, { type: "TicketReady", ticketVersion: released.version }, this.now().toISOString())] };
    });
    return next.tickets.find((ticket) => ticket.ticketId === claim.ticketId)!;
  }

  async transferBlockedOwnership(input: TransferBlockedOwnershipRequest): Promise<BlockedOwnershipReceipt> {
    const replay = await this.store.findOperationRecord(input.requestId);
    if (replay) {
      if (replay.kind !== "transfer_blocked_ownership" || replay.fingerprint !== fingerprintOf(input)) throw new TicketEngineOperationError("idempotency_conflict", "Transfer request was reused");
      return structuredClone(replay.ownership);
    }
    const ownership = await this.store.findBlockedOwnership(input.ownershipId);
    if (!ownership || ownership.fencingToken !== input.fencingToken) throw new TicketEngineOperationError("stale_authority", "Blocked ownership is stale");
    const aggregate = await this.requirePlan(ownership.planId);
    const policy = await this.policyPort.getPolicy(aggregate.plan.policyRef);
    if (!policy || !hasCapability(policy, ownership.principalId, this.teamBindingIds, "blocked_ownership:transfer")) {
      throw new TicketEngineOperationError("policy_violation", "Owner cannot transfer blocked ownership");
    }
    const ticket = aggregate.tickets.find((item) => item.ticketId === ownership.ticketId);
    if (!ticket || ticket.status !== "blocked" || !authorityMatches(ticket.activeAuthority, { kind: "blocked_owner", ownershipId: ownership.ownershipId, fencingToken: ownership.fencingToken })) {
      throw new TicketEngineOperationError("stale_authority", "Blocked ownership is no longer active");
    }
    const nextOwnership = { ...ownership, ownershipId: randomUUID(), ticketVersion: ticket.version + 1, principalId: input.toPrincipalId, fencingToken: ownership.fencingToken + 1 };
    await this.store.transact(ownership.planId, versions(aggregate), (current) => {
      const tickets = current.tickets.map((item) => item.ticketId === ownership.ticketId ? {
        ...item,
        version: nextOwnership.ticketVersion,
        activeAuthority: { kind: "blocked_owner" as const, ownershipId: nextOwnership.ownershipId, fencingToken: nextOwnership.fencingToken },
      } : item);
      return {
        ...current,
        plan: { ...current.plan, version: current.plan.version + 1 },
        tickets,
        blockedOwnerships: [...current.blockedOwnerships.filter((item) => item.ownershipId !== ownership.ownershipId), nextOwnership],
        operationRecords: [...current.operationRecords, { kind: "transfer_blocked_ownership", requestId: input.requestId, fingerprint: fingerprintOf(input), ownership: nextOwnership }],
        pendingEvents: [ticketEvent(tickets.find((item) => item.ticketId === ownership.ticketId)!, { type: "AuthorityRevoked", fencingToken: ownership.fencingToken }, this.now().toISOString())],
      };
    });
    return nextOwnership;
  }

  async applyTicket(command: TicketCommandEnvelope<TicketCommandPayload>): Promise<TicketCommandResult> {
    const aggregate = await this.requirePlan(command.planId);
    const fingerprint = fingerprintOf(command);
    const replay = replayCommand<TicketCommandResult>(aggregate, command.commandId, fingerprint);
    if (replay) return replay;
    if (TERMINAL_PLAN.has(aggregate.plan.status)) return this.persistTicketRejection(aggregate, command, fingerprint, "plan_terminal", "Plan is terminal");
    const ticket = aggregate.tickets.find((item) => item.ticketId === command.ticketId);
    if (!ticket || ticket.version !== command.expectedTicketVersion) return this.persistTicketRejection(aggregate, command, fingerprint, "version_conflict", "Ticket version conflict");
    if (!authorityMatches(ticket.activeAuthority, command.authority)) return this.persistTicketRejection(aggregate, command, fingerprint, "stale_authority", "Ticket authority is stale");
    if (ticket.status !== "running" && ticket.status !== "blocked") return this.persistTicketRejection(aggregate, command, fingerprint, "invalid_command", "Ticket is not executing");
    if (command.payload.type === "request_correction") {
      const targetTicketId = command.payload.targetTicketId;
      const target = aggregate.tickets.find((item) => item.ticketId === targetTicketId);
      if (!target || target.status !== "completed" || !isStrictAncestor(aggregate.plan.graph, target.ticketId, ticket.ticketId)) {
        return this.persistTicketRejection(aggregate, command, fingerprint, "invalid_command", "Correction target must be a completed strict ancestor in the same Plan");
      }
    }
    try {
      const next = await this.store.transact(command.planId, versions(aggregate), (current) => {
      const currentTicket = current.tickets.find((item) => item.ticketId === command.ticketId)!;
      let status: TicketStatus;
      if (command.payload.type === "complete") status = "completed";
      else if (command.payload.type === "block") status = "blocked";
      else if (command.payload.type === "fail") status = "failed";
      else status = "pending";
      const ownership: BlockedOwnershipReceipt | undefined = status === "blocked" ? {
        ownershipId: randomUUID(), planId: command.planId, ticketId: command.ticketId,
        ticketVersion: currentTicket.version + 1, principalId: command.actorPrincipalId,
        fencingToken: command.authority.fencingToken + 1,
      } : undefined;
      let tickets = current.tickets.map((item) => item.ticketId === command.ticketId ? {
        ...item, status, version: item.version + 1,
        activeAuthority: ownership ? { kind: "blocked_owner" as const, ownershipId: ownership.ownershipId, fencingToken: ownership.fencingToken } : undefined,
      } : item);
      let graph = current.plan.graph;
      let completionPolicy = current.plan.completionPolicy;
      let definitionsByTicketId = current.definitionsByTicketId;
      let appendedTicket: TicketSnapshot | undefined;
      if (command.payload.type === "request_correction") {
        if (graph.ticketIds.length + 1 > DEFAULT_GRAPH_LIMITS.maxTickets || graph.dependencyEdges.length + 2 > DEFAULT_GRAPH_LIMITS.maxEdges) {
          throw new PlanGraphError("Plan cannot append another correction Ticket within graph limits");
        }
        const targetDefinition = current.definitionsByTicketId[String(command.payload.targetTicketId)]!;
        const correctionId = randomUUID() as TicketId;
        appendedTicket = {
          ticketId: correctionId,
          planId: command.planId,
          version: 1,
          status: "pending",
          parentTicketId: command.payload.targetTicketId,
        };
        tickets = [...tickets, appendedTicket];
        graph = {
          ...graph,
          ticketIds: [...graph.ticketIds, correctionId],
          dependencyEdges: [
            ...graph.dependencyEdges,
            { fromTicketId: command.payload.targetTicketId, toTicketId: correctionId },
            { fromTicketId: correctionId, toTicketId: command.ticketId },
          ],
        };
        definitionsByTicketId = {
          ...definitionsByTicketId,
          [String(correctionId)]: {
            parentTicketId: command.payload.targetTicketId,
            title: `纠错：${targetDefinition.title}`,
            objective: `修正工单 ${command.payload.targetTicketId} 的交付问题：${command.payload.reason}`,
            successCriteria: [
              `解决报告问题：${command.payload.reason}`,
              ...targetDefinition.successCriteria,
            ],
            assignment: structuredClone(targetDefinition.assignment),
            outputContract: structuredClone(targetDefinition.outputContract),
          },
        };
      } else if (command.payload.type === "request_plan_change") {
        if (graph.ticketIds.length + 1 > DEFAULT_GRAPH_LIMITS.maxTickets || graph.dependencyEdges.length + 1 > DEFAULT_GRAPH_LIMITS.maxEdges) {
          throw new PlanGraphError("Plan cannot append another amendment Ticket within graph limits");
        }
        const amendmentId = randomUUID() as TicketId;
        appendedTicket = {
          ticketId: amendmentId,
          planId: command.planId,
          version: 1,
          status: "pending",
          parentTicketId: command.ticketId,
        };
        tickets = [...tickets, appendedTicket];
        graph = {
          ...graph,
          ticketIds: [...graph.ticketIds, amendmentId],
          dependencyEdges: [...graph.dependencyEdges, { fromTicketId: amendmentId, toTicketId: command.ticketId }],
        };
        definitionsByTicketId = {
          ...definitionsByTicketId,
          [String(amendmentId)]: {
            parentTicketId: command.ticketId,
            title: "计划修订",
            objective: `处理工单 ${command.ticketId} 提出的计划结构问题：${command.payload.reason}`,
            successCriteria: ["核对结构变更原因和证据", "追加完成 Mission 所需的新工单和依赖", "保持 Plan 无环且具有可验证终点"],
            assignment: structuredClone(current.plan.plannerAssignment),
            outputContract: { schemaRef: "plan-change-set-v3" },
          },
        };
      }
      const changed = unlockReady(tickets, graph.dependencyEdges);
      tickets = changed.tickets;
      const statuses = statusMap(tickets);
      let planStatus = evaluatePlanOutcome({ graph, completionPolicy, ticketStatuses: statuses });
      if (status === "blocked" || command.payload.type === "request_plan_change") planStatus = "blocked";
      const plan = { ...current.plan, version: current.plan.version + 1, status: planStatus, graph, completionPolicy };
      const settled = tickets.find((item) => item.ticketId === command.ticketId)!;
      const result: TicketCommandResult = {
        accepted: true, commandId: command.commandId, proposalId: command.proposalId,
        ticketStatus: status as "pending" | "blocked" | "completed" | "failed",
        ticketVersion: settled.version, planStatus: plan.status, planVersion: plan.version,
        ...(ownership ? { nextAuthority: settled.activeAuthority } : {}),
      };
      const pendingEvents: TicketEvent[] = [ticketEvent(
        settled,
        status === "blocked"
          ? { type: "TicketBlocked", requiredInput: command.payload.type === "block" ? command.payload.requiredInput : undefined }
          : status === "pending"
            ? { type: "TicketRetryQueued", prerequisiteTicketId: appendedTicket!.ticketId }
            : { type: "TicketTerminal", status: status as "completed" | "failed" },
        command.issuedAt,
      )];
      for (const ready of changed.ready) pendingEvents.push(ticketEvent(ready, { type: "TicketReady", ticketVersion: ready.version }, command.issuedAt));
      if (command.payload.type === "request_correction") {
        pendingEvents.push(planEvent(command.planId, plan.version, { type: "TicketCorrectionRequested", sourceTicketId: command.ticketId, targetTicketId: command.payload.targetTicketId, correctionTicketId: appendedTicket!.ticketId, reason: command.payload.reason }, command.issuedAt));
        pendingEvents.push(planEvent(command.planId, plan.version, { type: "PlanChanged", addedTicketIds: [appendedTicket!.ticketId] }, command.issuedAt));
      } else if (command.payload.type === "request_plan_change") {
        pendingEvents.push(planEvent(command.planId, plan.version, { type: "PlanAmendmentRequested", sourceTicketId: command.ticketId, amendmentTicketId: appendedTicket!.ticketId, reason: command.payload.reason }, command.issuedAt));
        pendingEvents.push(planEvent(command.planId, plan.version, { type: "PlanChanged", addedTicketIds: [appendedTicket!.ticketId] }, command.issuedAt));
      }
      if (plan.status !== current.plan.status) pendingEvents.push(planEvent(command.planId, plan.version, { type: "PlanStatusChanged", status: plan.status }, command.issuedAt));
      const otherBlockedOwnerships = current.blockedOwnerships.filter((owner) => owner.ticketId !== command.ticketId);
      return appendCommand(current, { plan, tickets, definitionsByTicketId, claims: current.claims.filter((claim) => claim.ticketId !== command.ticketId), blockedOwnerships: ownership ? [...otherBlockedOwnerships, ownership] : otherBlockedOwnerships, pendingEvents }, command.commandId, fingerprint, result);
      });
      return next.commandResults.find((item) => item.commandId === command.commandId)! as TicketCommandResult;
    } catch (error) {
      if (error instanceof PlanGraphError) return this.persistTicketRejection(aggregate, command, fingerprint, "invalid_command", error.message);
      if (!(error instanceof TicketStoreConflictError)) throw error;
      const latest = await this.requirePlan(command.planId);
      const replayAfterRace = replayCommand<TicketCommandResult>(latest, command.commandId, fingerprint);
      if (replayAfterRace) return replayAfterRace;
      return this.persistTicketRejection(latest, command, fingerprint, "version_conflict", error.message);
    }
  }

  async scanExpiredClaims(now = this.now()): Promise<TicketSnapshot[]> {
    const released: TicketSnapshot[] = [];
    for (const planId of await this.store.listPlanIds()) {
      const aggregate = await this.store.read(planId);
      if (!aggregate) continue;
      for (const claim of aggregate.claims.filter((item) => Date.parse(item.leaseUntil) <= now.getTime())) {
        released.push(await this.releaseClaim({ requestId: `expired:${claim.claimId}`, claimId: claim.claimId, fencingToken: claim.fencingToken, reason: "agent_unavailable" }));
      }
    }
    return released;
  }

  async readEvents<TPlanId extends PlanId>(input: TicketEventQuery<TPlanId>): Promise<TicketEventPage<TPlanId, TicketEvent<"ticket" | "plan", TPlanId>>> {
    return this.store.readEvents(input) as Promise<TicketEventPage<TPlanId, TicketEvent<"ticket" | "plan", TPlanId>>>;
  }

  private async requirePlan(planId: PlanId): Promise<TicketAggregate> {
    const aggregate = await this.store.read(planId);
    if (!aggregate) throw new TicketEngineOperationError("invalid_request", "Plan does not exist");
    return aggregate;
  }
  private async requireClaim(claimId: string, fencingToken: number): Promise<ClaimReceipt> {
    const claim = await this.store.findClaim(claimId);
    if (!claim || claim.fencingToken !== fencingToken) throw new TicketEngineOperationError("stale_authority", "Claim is stale");
    return claim;
  }
  private replayPlan(aggregate: TicketAggregate, commandId: string, fingerprint: string): PlanCommandResult {
    const replay = replayCommand<PlanCommandResult>(aggregate, commandId, fingerprint);
    if (!replay) return { accepted: false, commandId, code: "idempotency_conflict", reason: "Plan already exists" };
    return replay;
  }
  private rejectPlan(command: PlanCommandEnvelope, code: "invalid_command", reason: string): PlanCommandResult { return { accepted: false, commandId: command.commandId, code, reason }; }
  private async persistPlanRejection(aggregate: TicketAggregate, command: PlanCommandEnvelope, fingerprint: string, code: Extract<PlanCommandResult, { accepted: false }>["code"], reason: string): Promise<PlanCommandResult> {
    const result: PlanCommandResult = { accepted: false, commandId: command.commandId, code, reason, currentPlanVersion: aggregate.plan.version };
    await this.store.recordCommandResult(command.planId, { commandId: command.commandId, fingerprint }, result);
    return result;
  }
  private async persistTicketRejection(aggregate: TicketAggregate, command: TicketCommandEnvelope, fingerprint: string, code: Extract<TicketCommandResult, { accepted: false }>["code"], reason: string): Promise<TicketCommandResult> {
    const ticket = aggregate.tickets.find((item) => item.ticketId === command.ticketId);
    const result: TicketCommandResult = { accepted: false, commandId: command.commandId, proposalId: command.proposalId, code, reason, currentPlanVersion: aggregate.plan.version, ...(ticket ? { currentTicketVersion: ticket.version } : {}) };
    await this.store.recordCommandResult(command.planId, { commandId: command.commandId, fingerprint }, result);
    return result;
  }
}

function asMaterialized(aggregate: TicketAggregate): MaterializedPlanGraph {
  return { planId: aggregate.plan.planId, graph: aggregate.plan.graph, completionPolicy: aggregate.plan.completionPolicy, definitionsByTicketId: aggregate.definitionsByTicketId, addedTicketIds: [] };
}
function createTickets(graph: MaterializedPlanGraph, planId: PlanId): TicketSnapshot[] {
  return graph.graph.ticketIds.map((ticketId) => ({ ticketId, planId, version: 1, status: "pending", ...(graph.definitionsByTicketId[String(ticketId)]?.parentTicketId ? { parentTicketId: graph.definitionsByTicketId[String(ticketId)].parentTicketId } : {}) }));
}
function initializeReady(tickets: TicketSnapshot[], edges: MaterializedPlanGraph["graph"]["dependencyEdges"]): void {
  const incoming = new Set(edges.map((edge) => String(edge.toTicketId)));
  for (const ticket of tickets) if (ticket.status === "pending" && !incoming.has(String(ticket.ticketId))) ticket.status = "ready";
}
function unlockReady(tickets: TicketSnapshot[], edges: MaterializedPlanGraph["graph"]["dependencyEdges"]): { tickets: TicketSnapshot[]; ready: TicketSnapshot[] } {
  const byId = new Map(tickets.map((ticket) => [String(ticket.ticketId), ticket]));
  const incoming = new Map<string, TicketId[]>();
  for (const edge of edges) incoming.set(String(edge.toTicketId), [...(incoming.get(String(edge.toTicketId)) ?? []), edge.fromTicketId]);
  const ready: TicketSnapshot[] = [];
  const next = tickets.map((ticket) => {
    if (ticket.status !== "pending") return ticket;
    if ((incoming.get(String(ticket.ticketId)) ?? []).every((id) => byId.get(String(id))?.status === "completed")) {
      const value = { ...ticket, status: "ready" as const, version: ticket.version + 1 };
      ready.push(value);
      return value;
    }
    return ticket;
  });
  return { tickets: next, ready };
}
function statusMap(tickets: TicketSnapshot[]): Map<TicketId, TicketStatus> { return new Map(tickets.map((ticket) => [ticket.ticketId, ticket.status])); }
function isStrictAncestor(graph: MaterializedPlanGraph["graph"], ancestor: TicketId, descendant: TicketId): boolean {
  if (ancestor === descendant) return false;
  const incoming = new Map<string, TicketId[]>();
  for (const edge of graph.dependencyEdges) {
    incoming.set(String(edge.toTicketId), [...(incoming.get(String(edge.toTicketId)) ?? []), edge.fromTicketId]);
  }
  const seen = new Set<string>();
  const queue = [...(incoming.get(String(descendant)) ?? [])];
  while (queue.length > 0) {
    const current = queue.pop()!;
    if (current === ancestor) return true;
    if (seen.has(String(current))) continue;
    seen.add(String(current));
    queue.push(...(incoming.get(String(current)) ?? []));
  }
  return false;
}
function versions(aggregate: TicketAggregate) { return { aggregateVersion: aggregate.aggregateVersion, planVersion: aggregate.plan.version }; }
function appendCommand(aggregate: TicketAggregate, patch: Partial<TicketAggregate> & Pick<TicketAggregate, "plan" | "tickets"> & { pendingEvents?: TicketEvent[] }, commandId: string, fingerprint: string, result: PlanCommandResult | TicketCommandResult) {
  return { ...aggregate, ...patch, commandInputs: [...aggregate.commandInputs, { commandId, fingerprint }], commandResults: [...aggregate.commandResults, result] };
}
function replayCommand<T>(aggregate: TicketAggregate, commandId: string, fingerprint: string): T | undefined {
  const input = aggregate.commandInputs.find((item) => item.commandId === commandId);
  const result = aggregate.commandResults.find((item) => item.commandId === commandId);
  if (!input && !result) return undefined;
  if (!input || !result || input.fingerprint !== fingerprint) throw new TicketEngineOperationError("idempotency_conflict", `Command ${commandId} was reused`);
  return structuredClone(result) as T;
}
function authorityMatches(left: TicketExecutionAuthority | undefined, right: TicketExecutionAuthority): boolean {
  if (!left || left.kind !== right.kind || left.fencingToken !== right.fencingToken) return false;
  return left.kind === "claim" ? left.claimId === (right as typeof left).claimId : left.ownershipId === (right as typeof left).ownershipId;
}
function hasCapability(policy: PlanAuthorizationPolicy, principalId: string, teamBindingIds: string[], capability: string): boolean {
  const teams = new Set(teamBindingIds);
  return policy.grants.some((grant) => (grant.principalId === principalId || (grant.teamBindingId && teams.has(grant.teamBindingId))) && grant.capabilities.includes(capability));
}
function canApplyChangeFromTicket(aggregate: TicketAggregate, ticketId: TicketId, authority: TicketExecutionAuthority, principalId: string): boolean {
  const ticket = aggregate.tickets.find((item) => item.ticketId === ticketId);
  const definition = aggregate.definitionsByTicketId[String(ticketId)];
  if (!ticket || !definition || definition.outputContract.schemaRef !== "plan-change-set-v3") return false;
  if (ticket.status !== "running" && ticket.status !== "blocked") return false;
  if (!authorityMatches(ticket.activeAuthority, authority)) return false;
  if (authority.kind === "claim") return aggregate.claims.some((claim) => claim.claimId === authority.claimId && claim.principalId === principalId);
  return aggregate.blockedOwnerships.some((owner) => owner.ownershipId === authority.ownershipId && owner.principalId === principalId);
}
function requirePositiveDuration(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TicketEngineOperationError("invalid_request", `${label} must be a positive integer`);
}
function fingerprintOf(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function ticketEvent(ticket: TicketSnapshot, payload: TicketEvent<"ticket">["payload"], occurredAt: string): TicketEvent<"ticket"> {
  return { eventId: randomUUID(), planId: ticket.planId, aggregateType: "ticket", aggregateId: ticket.ticketId, aggregateVersion: ticket.version, occurredAt, payload };
}
function planEvent(planId: PlanId, version: number, payload: TicketEvent<"plan">["payload"], occurredAt: string): TicketEvent<"plan"> {
  return { eventId: randomUUID(), planId, aggregateType: "plan", aggregateId: planId, aggregateVersion: version, occurredAt, payload };
}
