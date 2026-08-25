import { createHash, randomUUID } from "node:crypto";
import { DEFAULT_PLAN_CONVERGENCE_LIMITS } from "../../shared/contracts/ticket-engine.js";
import type {
  BlockedOwnershipReceipt,
  ClaimReceipt,
  ClaimRequest,
  ConvergenceBudgetExhaustion,
  PlanAuthorizationPolicy,
  PlanCommandEnvelope,
  PlanCommandResult,
  PlanConvergenceLimits,
  PlanConvergenceState,
  PlanId,
  PlanPolicyPort,
  PlanStatus,
  ReleaseClaimRequest,
  RenewClaimRequest,
  TicketCommandEnvelope,
  TicketCommandPayload,
  TicketCommandResult,
  TicketDefinition,
  TicketEvent,
  TicketEventPage,
  TicketEventQuery,
  TicketExecutionAuthority,
  TicketHandoff,
  TicketId,
  TicketSnapshot,
  TicketStatus,
  TicketWorkItem,
  TransferBlockedOwnershipRequest,
} from "../../shared/contracts/ticket-engine.js";
import {
  computeRequiredClosure,
  DEFAULT_GRAPH_LIMITS,
  evaluatePlanOutcome,
  findUnresolvedRequiredFailures,
  isTicketDependencySatisfied,
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
import type { TicketAttemptWorkspacePort } from "./workspace-snapshot-store.js";

const TERMINAL_PLAN = new Set<PlanStatus>(["completed", "failed", "cancelled"]);
const TERMINAL_TICKET = new Set<TicketStatus>(["completed", "returned", "failed", "cancelled"]);

export interface TicketEngineOptions {
  teamBindingIds?: string[];
  now?: () => Date;
  workspacePort?: TicketAttemptWorkspacePort;
}
export class TicketEngineOperationError extends Error {
  constructor(public readonly code: "invalid_request" | "idempotency_conflict" | "stale_authority" | "policy_violation", message: string) { super(message); }
}

class SharedWorkspaceWriterBusyError extends Error {}

class ConvergenceBudgetError extends Error {
  constructor(readonly details: ConvergenceBudgetExhaustion) {
    super(`Plan convergence budget exhausted: ${details.dimension}`);
  }
}

export class TicketEngine {
  private readonly teamBindingIds: string[];
  private readonly now: () => Date;
  private readonly workspacePort?: TicketAttemptWorkspacePort;

  constructor(
    private readonly store: TicketStore,
    private readonly policyPort: PlanPolicyPort,
    options: TicketEngineOptions = {},
  ) {
    this.teamBindingIds = options.teamBindingIds ?? [];
    this.now = options.now ?? (() => new Date());
    this.workspacePort = options.workspacePort;
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
      const convergence = createConvergenceState(
        command.payload.definition.convergenceLimits,
        materialized.graph.ticketIds.length,
      );
      const tickets = createTickets(materialized, command.planId);
      initializeReady(tickets, materialized.graph);
      const plan = {
        planId: command.planId,
        missionId: command.payload.missionId,
        version: 1,
        status: "active" as const,
        graph: materialized.graph,
        completionPolicy: materialized.completionPolicy,
        convergence,
        policyRef: command.payload.definition.policyRef,
        plannerAssignment: command.payload.definition.plannerAssignment,
        amendmentTemplate: structuredClone(command.payload.definition.amendmentTemplate),
      };
      const result: PlanCommandResult = { accepted: true, commandId: command.commandId, planStatus: plan.status, planVersion: plan.version };
      const events = [
        planEvent(command.planId, 1, { type: "PlanChanged", addedTicketIds: [...materialized.addedTicketIds] }, command.issuedAt),
        ...tickets.filter((ticket) => ticket.status === "ready").map((ticket) => ticketEvent(ticket, { type: "TicketReady", ticketVersion: ticket.version }, command.issuedAt)),
      ];
      await this.store.create({
        schemaVersion: 5,
        plan,
        definitionsByTicketId: { ...materialized.definitionsByTicketId },
        tickets,
        commandInputs: [{ commandId: command.commandId, fingerprint }],
        commandResults: [result],
        pendingEvents: events,
      });
      return result;
    } catch (error) {
      if (error instanceof ConvergenceBudgetError) {
        return { accepted: false, commandId: command.commandId, code: "budget_exhausted", reason: error.message, budget: error.details };
      }
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
          tickets = tickets.map((ticket) => TERMINAL_TICKET.has(ticket.status) ? ticket : cancelTicket(ticket, command.issuedAt, "Plan cancelled"));
          current.claims = [];
          current.blockedOwnerships = [];
          pendingEvents.push(planEvent(command.planId, plan.version, { type: "PlanStatusChanged", status: plan.status }, command.issuedAt));
        } else {
          const materialized = materializePlanGraph({
            planId: command.planId,
            previous: asMaterialized(current),
            change: payload.change,
            ticketStatuses: statusMap(current.tickets),
          });
          const convergence = convergenceStateFor(current.plan);
          assertConvergenceAvailable(
            convergence,
            current.plan.graph.ticketIds.length,
            materialized.graph.ticketIds.length,
            convergence.acceptedAmendments + 1,
          );
          if (materialized.addedTicketIds.some((ticketId) => !isStrictAncestor(materialized.graph, payload.sourceTicketId, ticketId))) {
            throw new PlanGraphError("Every appended Ticket must have the source Ticket as an ancestor");
          }
          const unresolvedHistoricalTickets = findUnresolvedRequiredFailures({
            graph: materialized.graph,
            completionPolicy: materialized.completionPolicy,
            ticketStatuses: statusMap(current.tickets),
          });
          if (unresolvedHistoricalTickets.length > 0) {
            throw new PlanGraphError(
              `Required delivery closure contains terminal unsuccessful Tickets: ${unresolvedHistoricalTickets.join(", ")}. `
              + "Do not cancel, reopen, depend on, or reuse those historical Tickets. "
              + "Start the replacement work from the current planning Ticket, add a new assurance Ticket after that work, "
              + "and declare each historical failure in change.failureResolutions as "
              + '{"failedTicketId":"<historical Ticket UUID>","resolvedBy":{"clientRef":"<new assurance clientRef>"}}.',
            );
          }
          const added = createTickets(materialized, command.planId).filter((ticket) => materialized.addedTicketIds.includes(ticket.ticketId));
          const requiredClosure = new Set([...computeRequiredClosure(
            materialized.graph,
            materialized.completionPolicy.requiredTerminalTicketIds,
          )].map(String));
          const cancellationIds = new Set([
            ...payload.change.cancelTicketIds.map(String),
            ...current.tickets
              .filter((ticket) => (ticket.status === "pending" || ticket.status === "ready")
                && !requiredClosure.has(String(ticket.ticketId)))
              .map((ticket) => String(ticket.ticketId)),
          ]);
          const cancelled = tickets
            .filter((ticket) => cancellationIds.has(String(ticket.ticketId)))
            .map((ticket) => cancelTicket(ticket, command.issuedAt, "Cancelled by Plan change"));
          const cancelledById = new Map(cancelled.map((ticket) => [String(ticket.ticketId), ticket]));
          tickets = [...tickets.map((ticket) => cancelledById.get(String(ticket.ticketId)) ?? ticket), ...added];
          initializeReady(tickets, materialized.graph);
          plan = {
            ...plan,
            status: "active",
            graph: materialized.graph,
            completionPolicy: materialized.completionPolicy,
            convergence: { ...convergence, acceptedAmendments: convergence.acceptedAmendments + 1 },
          };
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
      if (error instanceof ConvergenceBudgetError) {
        return this.persistPlanRejection(aggregate, command, fingerprint, "budget_exhausted", error.message, error.details);
      }
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
    const claimablePlan = aggregate.plan.status === "active" || aggregate.plan.status === "blocked";
    if (!ticket || ticket.status !== "ready" || ticket.version !== input.expectedTicketVersion || !claimablePlan) return undefined;
    const policy = await this.policyPort.getPolicy(aggregate.plan.policyRef);
    if (!policy || !hasCapability(policy, input.principalId, this.teamBindingIds, "ticket:claim")) throw new TicketEngineOperationError("policy_violation", "Principal cannot claim Ticket");
    const attemptId = randomUUID();
    const definition = aggregate.definitionsByTicketId[String(input.ticketId)];
    const requiresIsolation = definitionRequiresGitIsolation(definition);
    const workspaceBaseline = await this.workspacePort?.captureBaseline(attemptId, {
      isolate: requiresIsolation,
    });
    const receipt: ClaimReceipt = {
      requestId: input.requestId,
      claimId: randomUUID(),
      planId: input.planId,
      ticketId: input.ticketId,
      ticketVersion: ticket.version + 1,
      attemptId,
      principalId: input.principalId,
      fencingToken: 1,
      leaseUntil: new Date(this.now().getTime() + input.leaseDurationMs).toISOString(),
    };
    try {
      await this.store.transact(input.planId, versions(aggregate), (current) => {
        if (requiresIsolation && !workspaceBaseline?.isolation && current.tickets.some((candidate) => {
          if (candidate.ticketId === input.ticketId || candidate.status !== "running") return false;
          return definitionRequiresGitIsolation(current.definitionsByTicketId[String(candidate.ticketId)]);
        })) {
          throw new SharedWorkspaceWriterBusyError("A writable Ticket already owns the shared workspace");
        }
        const tickets = current.tickets.map((item) => item.ticketId === input.ticketId ? {
          ...item,
          status: "running" as const,
          version: receipt.ticketVersion,
          activeAuthority: { kind: "claim" as const, claimId: receipt.claimId, fencingToken: 1 },
          activeAttemptId: attemptId,
          attempts: [...item.attempts, {
            attemptId,
            attemptNumber: item.attempts.length + 1,
            status: "running" as const,
             principalId: input.principalId,
             startedAt: this.now().toISOString(),
             ...(workspaceBaseline ? { workspaceBaseline } : {}),
           }],
        } : item);
        const plan = { ...current.plan, version: current.plan.version + 1 };
        const claimed = tickets.find((item) => item.ticketId === input.ticketId)!;
        return { ...current, plan, tickets, claims: [...current.claims, receipt], operationRecords: [...current.operationRecords, { kind: "claim", requestId: input.requestId, fingerprint: fingerprintOf(input), claim: receipt }], pendingEvents: [ticketEvent(claimed, { type: "TicketClaimed", claimId: receipt.claimId, attemptId, attemptNumber: claimed.attempts.length }, this.now().toISOString())] };
      });
      return receipt;
    } catch (error) {
      if (error instanceof SharedWorkspaceWriterBusyError) {
        if (workspaceBaseline) await this.workspacePort?.discardAttempt?.(attemptId, workspaceBaseline).catch(() => undefined);
        return undefined;
      }
      if (!(error instanceof TicketStoreConflictError)) throw error;
      const raced = await this.store.findOperationRecord(input.requestId);
      if (raced?.kind === "claim" && raced.fingerprint === fingerprintOf(input)) return raced.claim;
      if (workspaceBaseline) await this.workspacePort?.discardAttempt?.(attemptId, workspaceBaseline).catch(() => undefined);
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
      for (const attempt of replay.ticket.attempts.filter((candidate) => candidate.status === "released" && candidate.reason !== "agent_unavailable" && candidate.workspaceBaseline?.isolation)) {
        await this.workspacePort?.discardAttempt?.(attempt.attemptId, attempt.workspaceBaseline!).catch(() => undefined);
      }
      return structuredClone(replay.ticket);
    }
    const claim = await this.requireClaim(input.claimId, input.fencingToken);
    const aggregate = await this.requirePlan(claim.planId);
    const ticket = aggregate.tickets.find((candidate) => candidate.ticketId === claim.ticketId);
    const activeAttempt = ticket?.attempts.find((attempt) => attempt.attemptId === claim.attemptId);
    const salvageChangeSet = input.reason === "agent_unavailable" && activeAttempt?.workspaceBaseline
      ? await this.workspacePort?.captureChangeSet(activeAttempt.attemptId, activeAttempt.workspaceBaseline, { checkpoint: true })
      : undefined;
    const next = await this.store.transact(claim.planId, versions(aggregate), (current) => {
      const endedAt = this.now().toISOString();
      const tickets = current.tickets.map((ticket) => ticket.ticketId === claim.ticketId && ticket.status === "running" ? {
        ...ticket,
        status: "ready" as const,
        version: ticket.version + 1,
        activeAuthority: undefined,
        activeAttemptId: undefined,
        attempts: settleAttempt(ticket, claim.attemptId, {
          status: "released",
          endedAt,
          reason: input.reason,
          ...(salvageChangeSet ? { changeSet: salvageChangeSet } : {}),
        }),
      } : ticket);
      const released = tickets.find((ticket) => ticket.ticketId === claim.ticketId)!;
      return { ...current, plan: { ...current.plan, version: current.plan.version + 1 }, tickets, claims: current.claims.filter((item) => item.claimId !== claim.claimId), operationRecords: [...current.operationRecords, { kind: "release_claim", requestId: input.requestId, fingerprint: fingerprintOf(input), ticket: released }], pendingEvents: [ticketEvent(released, { type: "TicketReady", ticketVersion: released.version }, this.now().toISOString())] };
    });
    const released = next.tickets.find((ticket) => ticket.ticketId === claim.ticketId)!;
    const releasedAttempt = released.attempts.find((attempt) => attempt.attemptId === claim.attemptId);
    if (releasedAttempt?.workspaceBaseline && input.reason !== "agent_unavailable") {
      await this.workspacePort?.discardAttempt?.(releasedAttempt.attemptId, releasedAttempt.workspaceBaseline).catch(() => undefined);
    }
    return released;
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
    if (aggregate.plan.status === "paused") return this.persistTicketRejection(aggregate, command, fingerprint, "plan_paused", "Plan is paused");
    const ticket = aggregate.tickets.find((item) => item.ticketId === command.ticketId);
    if (!ticket || ticket.version !== command.expectedTicketVersion) return this.persistTicketRejection(aggregate, command, fingerprint, "version_conflict", "Ticket version conflict");
    if (!authorityMatches(ticket.activeAuthority, command.authority)) return this.persistTicketRejection(aggregate, command, fingerprint, "stale_authority", "Ticket authority is stale");
    if (ticket.status !== "running" && ticket.status !== "blocked") return this.persistTicketRejection(aggregate, command, fingerprint, "invalid_command", "Ticket is not executing");
    const definition = aggregate.definitionsByTicketId[String(command.ticketId)];
    if (command.payload.type === "resume_after_input") {
      if (ticket.status !== "blocked" || command.authority.kind !== "blocked_owner") {
        return this.persistTicketRejection(aggregate, command, fingerprint, "invalid_command", "Only the current blocked owner can resume a blocked Ticket after input");
      }
      if (!command.payload.inputMessageId.trim()) {
        return this.persistTicketRejection(aggregate, command, fingerprint, "invalid_command", "Input message ID is required to resume a blocked Ticket");
      }
    }
    if (command.payload.type === "complete") {
      const handoffError = validateCompletionHandoff(command.payload.handoff);
      if (handoffError) return this.persistTicketRejection(aggregate, command, fingerprint, "invalid_command", handoffError);
    }
    if (command.payload.type === "request_correction") {
      const handoffError = validateCompletionHandoff(command.payload.handoff);
      if (handoffError) return this.persistTicketRejection(aggregate, command, fingerprint, "invalid_command", handoffError);
      const targetTicketId = command.payload.targetTicketId;
      const target = aggregate.tickets.find((item) => item.ticketId === targetTicketId);
      if (!target || target.status !== "completed" || !isStrictAncestor(aggregate.plan.graph, target.ticketId, ticket.ticketId)) {
        return this.persistTicketRejection(aggregate, command, fingerprint, "invalid_command", "Correction target must be a completed strict ancestor in the same Plan");
      }
    }
    const activeAttempt = ticket.attempts.find((attempt) => attempt.attemptId === ticket.activeAttemptId);
    const changeSet = command.payload.type !== "block" && command.payload.type !== "resume_after_input" && activeAttempt?.workspaceBaseline
      ? await this.workspacePort?.captureChangeSet(activeAttempt.attemptId, activeAttempt.workspaceBaseline, {
          integrate: command.payload.type === "complete" && definitionIntegratesWorkspaceChanges(definition),
        })
      : undefined;
    if (changeSet?.integration?.status === "conflict") {
      const paths = changeSet.integration.conflictingPaths?.length
        ? ` Conflicting paths: ${changeSet.integration.conflictingPaths.join(", ")}.`
        : "";
      return this.persistTicketRejection(
        aggregate,
        command,
        fingerprint,
        "workspace_conflict",
        `${changeSet.integration.reason ?? "Ticket delivery could not be integrated into the canonical workspace."}${paths} Resolve the retained Attempt worktree and submit the Goal again.`,
      );
    }
    if (
      command.payload.type === "complete"
      && activeAttempt?.workspaceBaseline?.isolation
      && !definitionIntegratesWorkspaceChanges(definition)
      && changeSet
    ) {
      const changedPaths = [...changeSet.added, ...changeSet.modified, ...changeSet.deleted]
        .map((change) => change.path);
      if (changedPaths.length > 0) {
        const displayedPaths = changedPaths.slice(0, 12);
        const remaining = changedPaths.length - displayedPaths.length;
        return this.persistTicketRejection(
          aggregate,
          command,
          fingerprint,
          "workspace_changes_not_allowed",
          `This isolated Attempt is not authorized to integrate workspace changes, but verification left ${changedPaths.length} changed path(s): ${displayedPaths.join(", ")}${remaining > 0 ? `, and ${remaining} more` : ""}. Restore side effects created by diagnostics and submit the Goal again. If the project's documented verification command changes a clean checkout, report or request correction instead of hiding that product defect.`,
        );
      }
    }
    const correctionTargetId = command.payload.type === "request_correction" ? command.payload.targetTicketId : undefined;
    try {
      const next = await this.store.transact(command.planId, versions(aggregate), (current) => {
      const currentTicket = current.tickets.find((item) => item.ticketId === command.ticketId)!;
      const appendsResolutionTicket = command.payload.type === "request_correction"
        || command.payload.type === "request_plan_change"
        || (command.payload.type === "fail" && current.plan.completionPolicy.failurePolicy === "require_resolution");
      const convergence = convergenceStateFor(current.plan);
      if (appendsResolutionTicket) {
        assertConvergenceAvailable(
          convergence,
          current.plan.graph.ticketIds.length,
          current.plan.graph.ticketIds.length + 1,
          convergence.acceptedAmendments,
        );
      }
      let status: TicketStatus;
      if (command.payload.type === "complete") status = "completed";
      else if (command.payload.type === "block") status = "blocked";
      else if (command.payload.type === "resume_after_input") status = "running";
      else if (command.payload.type === "fail") status = "failed";
      else if (command.payload.type === "request_correction") status = "pending";
      else status = "returned";
      const ownership: BlockedOwnershipReceipt | undefined = status === "blocked" ? {
        ownershipId: randomUUID(), planId: command.planId, ticketId: command.ticketId,
        ticketVersion: currentTicket.version + 1, principalId: command.actorPrincipalId,
        fencingToken: command.authority.fencingToken + 1,
      } : undefined;
      const attemptUpdate = command.payload.type === "complete"
        ? { status: "completed" as const, endedAt: command.issuedAt, executionRef: command.executionRef, handoff: structuredClone(command.payload.handoff), ...(changeSet ? { changeSet } : {}) }
        : command.payload.type === "block"
          ? { status: "blocked" as const, reason: command.payload.reason, requiredInput: structuredClone(command.payload.requiredInput) }
          : command.payload.type === "resume_after_input"
            ? { status: "running" as const, endedAt: undefined, reason: undefined, requiredInput: undefined }
          : command.payload.type === "fail"
            ? { status: "failed" as const, endedAt: command.issuedAt, reason: command.payload.reason, evidence: structuredClone(command.payload.evidence), ...(changeSet ? { changeSet } : {}) }
            : {
                status: "returned" as const,
                endedAt: command.issuedAt,
                reason: command.payload.reason,
                evidence: structuredClone(command.payload.evidence),
                ...(command.payload.type === "request_correction"
                  ? { handoff: structuredClone(command.payload.handoff) }
                  : {}),
                ...(changeSet ? { changeSet } : {}),
              };
      const resumesBlockedAttempt = command.payload.type === "resume_after_input";
      let tickets = current.tickets.map((item) => item.ticketId === command.ticketId ? {
        ...item, status, version: item.version + 1,
        activeAuthority: ownership
          ? { kind: "blocked_owner" as const, ownershipId: ownership.ownershipId, fencingToken: ownership.fencingToken }
          : resumesBlockedAttempt ? item.activeAuthority : undefined,
        activeAttemptId: ownership || resumesBlockedAttempt ? item.activeAttemptId : undefined,
        attempts: settleAttempt(item, item.activeAttemptId, attemptUpdate),
        ...(command.payload.type === "complete" ? {
          completion: {
            handoff: structuredClone(command.payload.handoff),
            completedAt: command.issuedAt,
            actorPrincipalId: command.actorPrincipalId,
            executionRef: command.executionRef,
          },
        } : command.payload.type === "request_correction" || command.payload.type === "request_plan_change" || command.payload.type === "fail"
          ? { completion: undefined }
          : {}),
      } : item);
      let graph = current.plan.graph;
      let completionPolicy = current.plan.completionPolicy;
      let definitionsByTicketId = current.definitionsByTicketId;
      let appendedTicket: TicketSnapshot | undefined;
      const requiresPlanResolution = command.payload.type === "fail"
        && current.plan.completionPolicy.failurePolicy === "require_resolution";
      const failureReason = command.payload.type === "fail" ? command.payload.reason : undefined;
      if (command.payload.type === "request_correction") {
        if (graph.ticketIds.length + 1 > DEFAULT_GRAPH_LIMITS.maxTickets || graph.dependencyEdges.length + 2 > DEFAULT_GRAPH_LIMITS.maxEdges) {
          throw new PlanGraphError("Plan cannot append another correction Ticket within graph limits");
        }
        const targetDefinition = current.definitionsByTicketId[String(correctionTargetId)];
        if (!targetDefinition) throw new PlanGraphError(`Correction target ${correctionTargetId} has no definition`);
        const correctionId = randomUUID() as TicketId;
        appendedTicket = {
          ticketId: correctionId,
          planId: command.planId,
          version: 1,
          status: "pending",
          parentTicketId: command.ticketId,
          attempts: [],
        };
        tickets = [...tickets, appendedTicket];
        graph = {
          ...graph,
          ticketIds: [...graph.ticketIds, correctionId],
          dependencyEdges: [
            ...graph.dependencyEdges,
            { fromTicketId: correctionTargetId!, toTicketId: correctionId },
            { fromTicketId: correctionId, toTicketId: command.ticketId },
          ],
        };
        definitionsByTicketId = {
          ...definitionsByTicketId,
          [String(correctionId)]: {
            ...structuredClone(targetDefinition),
            parentTicketId: command.ticketId,
            correction: {
              targetTicketId: correctionTargetId!,
              sourceTicketId: command.ticketId,
            },
            permissions: undefined,
          },
        };
      } else if (command.payload.type === "request_plan_change" || requiresPlanResolution) {
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
          attempts: [],
        };
        tickets = [...tickets, appendedTicket];
        graph = {
          ...graph,
          ticketIds: [...graph.ticketIds, amendmentId],
          dependencyEdges: [...graph.dependencyEdges],
        };
        definitionsByTicketId = {
          ...definitionsByTicketId,
          [String(amendmentId)]: {
            parentTicketId: command.ticketId,
            title: current.plan.amendmentTemplate.title,
            objective: command.payload.type === "request_plan_change"
                ? `处理工单 ${command.ticketId} 提出的计划结构问题：${command.payload.reason}`
                : `处理工单 ${command.ticketId} 的失败事实并修订 Plan：${failureReason}`,
            successCriteria: [...current.plan.amendmentTemplate.successCriteria],
            assignment: structuredClone(current.plan.plannerAssignment),
            outputContract: structuredClone(current.plan.amendmentTemplate.outputContract),
            permissions: { amendPlan: true },
          },
        };
      }
      const changed = unlockReady(tickets, graph);
      tickets = changed.tickets;
      const statuses = statusMap(tickets);
      let planStatus = evaluatePlanOutcome({ graph, completionPolicy, ticketStatuses: statuses });
      if (status === "blocked" || command.payload.type === "request_plan_change" || requiresPlanResolution) {
        planStatus = "blocked";
      }
      const plan = {
        ...current.plan,
        version: current.plan.version + 1,
        status: planStatus,
        graph,
        completionPolicy,
        ...(appendsResolutionTicket ? { convergence } : {}),
      };
      const settled = tickets.find((item) => item.ticketId === command.ticketId)!;
      const result: TicketCommandResult = {
        accepted: true, commandId: command.commandId, proposalId: command.proposalId,
        ticketStatus: status as "pending" | "running" | "blocked" | "completed" | "returned" | "failed",
        ticketVersion: settled.version, planStatus: plan.status, planVersion: plan.version,
        ...(ownership || resumesBlockedAttempt ? { nextAuthority: settled.activeAuthority } : {}),
      };
      const pendingEvents: TicketEvent[] = [ticketEvent(
        settled,
        command.payload.type === "block"
          ? { type: "TicketBlocked", requiredInput: structuredClone(command.payload.requiredInput) }
          : command.payload.type === "resume_after_input"
            ? { type: "TicketResumedAfterInput", inputMessageId: command.payload.inputMessageId }
          : command.payload.type === "request_correction"
            ? { type: "TicketAttemptReturned", correctionTicketId: appendedTicket!.ticketId }
            : { type: "TicketTerminal", status: status as "completed" | "returned" | "failed" },
        command.issuedAt,
      )];
      for (const ready of changed.ready) pendingEvents.push(ticketEvent(ready, { type: "TicketReady", ticketVersion: ready.version }, command.issuedAt));
      if (command.payload.type === "request_correction") {
        pendingEvents.push(planEvent(command.planId, plan.version, {
          type: "TicketCorrectionRequested",
          sourceTicketId: command.ticketId,
          targetTicketId: correctionTargetId!,
          correctionTicketId: appendedTicket!.ticketId,
          reason: command.payload.reason,
          handoff: structuredClone(command.payload.handoff),
        }, command.issuedAt));
        pendingEvents.push(planEvent(command.planId, plan.version, { type: "PlanChanged", addedTicketIds: [appendedTicket!.ticketId] }, command.issuedAt));
      } else if (command.payload.type === "request_plan_change") {
        pendingEvents.push(planEvent(command.planId, plan.version, { type: "PlanAmendmentRequested", sourceTicketId: command.ticketId, amendmentTicketId: appendedTicket!.ticketId, reason: command.payload.reason }, command.issuedAt));
        pendingEvents.push(planEvent(command.planId, plan.version, { type: "PlanChanged", addedTicketIds: [appendedTicket!.ticketId] }, command.issuedAt));
      } else if (requiresPlanResolution) {
        pendingEvents.push(planEvent(command.planId, plan.version, { type: "PlanAmendmentRequested", sourceTicketId: command.ticketId, amendmentTicketId: appendedTicket!.ticketId, reason: failureReason! }, command.issuedAt));
        pendingEvents.push(planEvent(command.planId, plan.version, { type: "PlanChanged", addedTicketIds: [appendedTicket!.ticketId] }, command.issuedAt));
      }
      if (plan.status !== current.plan.status) pendingEvents.push(planEvent(command.planId, plan.version, { type: "PlanStatusChanged", status: plan.status }, command.issuedAt));
      const otherBlockedOwnerships = current.blockedOwnerships.filter((owner) => owner.ticketId !== command.ticketId);
      const blockedOwnerships = ownership
        ? [...otherBlockedOwnerships, ownership]
        : resumesBlockedAttempt ? current.blockedOwnerships : otherBlockedOwnerships;
      return appendCommand(current, { plan, tickets, definitionsByTicketId, claims: current.claims.filter((claim) => claim.ticketId !== command.ticketId), blockedOwnerships, pendingEvents }, command.commandId, fingerprint, result);
      });
      const result = next.commandResults.find((item) => item.commandId === command.commandId)! as TicketCommandResult;
      if (result.accepted && command.payload.type === "complete" && activeAttempt?.workspaceBaseline) {
        if (definitionIntegratesWorkspaceChanges(definition)) {
          await this.workspacePort?.cleanupAttempt?.(activeAttempt.attemptId, activeAttempt.workspaceBaseline).catch(() => undefined);
        } else {
          await this.workspacePort?.discardAttempt?.(activeAttempt.attemptId, activeAttempt.workspaceBaseline).catch(() => undefined);
        }
      }
      return result;
    } catch (error) {
      if (error instanceof ConvergenceBudgetError) {
        return this.persistTicketRejection(aggregate, command, fingerprint, "budget_exhausted", error.message, error.details);
      }
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
  private async persistPlanRejection(aggregate: TicketAggregate, command: PlanCommandEnvelope, fingerprint: string, code: Extract<PlanCommandResult, { accepted: false }>["code"], reason: string, budget?: ConvergenceBudgetExhaustion): Promise<PlanCommandResult> {
    const result: PlanCommandResult = { accepted: false, commandId: command.commandId, code, reason, currentPlanVersion: aggregate.plan.version, ...(budget ? { budget } : {}) };
    await this.store.recordCommandResult(command.planId, { commandId: command.commandId, fingerprint }, result);
    return result;
  }
  private async persistTicketRejection(aggregate: TicketAggregate, command: TicketCommandEnvelope, fingerprint: string, code: Extract<TicketCommandResult, { accepted: false }>["code"], reason: string, budget?: ConvergenceBudgetExhaustion): Promise<TicketCommandResult> {
    const ticket = aggregate.tickets.find((item) => item.ticketId === command.ticketId);
    const result: TicketCommandResult = { accepted: false, commandId: command.commandId, proposalId: command.proposalId, code, reason, currentPlanVersion: aggregate.plan.version, ...(ticket ? { currentTicketVersion: ticket.version } : {}), ...(budget ? { budget } : {}) };
    await this.store.recordCommandResult(command.planId, { commandId: command.commandId, fingerprint }, result);
    return result;
  }
}

function asMaterialized(aggregate: TicketAggregate): MaterializedPlanGraph {
  return { planId: aggregate.plan.planId, graph: aggregate.plan.graph, completionPolicy: aggregate.plan.completionPolicy, definitionsByTicketId: aggregate.definitionsByTicketId, addedTicketIds: [] };
}

function createConvergenceState(
  configured: PlanConvergenceLimits | undefined,
  initialTicketCount: number,
): PlanConvergenceState {
  const limits = configured ?? DEFAULT_PLAN_CONVERGENCE_LIMITS;
  validateConvergenceLimits(limits);
  const state: PlanConvergenceState = {
    maxTickets: limits.maxTickets,
    maxAcceptedAmendments: limits.maxAcceptedAmendments,
    acceptedAmendments: 0,
  };
  assertConvergenceAvailable(state, 0, initialTicketCount, 0);
  return state;
}

function convergenceStateFor(plan: TicketAggregate["plan"]): PlanConvergenceState {
  if (plan.convergence) {
    validateConvergenceLimits(plan.convergence);
    if (!Number.isSafeInteger(plan.convergence.acceptedAmendments) || plan.convergence.acceptedAmendments < 0) {
      throw new PlanGraphError("Plan convergence acceptedAmendments must be a non-negative safe integer");
    }
    return structuredClone(plan.convergence);
  }

  // Legacy snapshots have no convergence state. Preserve their existing graph and
  // start amendment accounting from the first post-migration accepted change.
  return {
    maxTickets: Math.max(DEFAULT_PLAN_CONVERGENCE_LIMITS.maxTickets, plan.graph.ticketIds.length),
    maxAcceptedAmendments: DEFAULT_PLAN_CONVERGENCE_LIMITS.maxAcceptedAmendments,
    acceptedAmendments: 0,
  };
}

function validateConvergenceLimits(limits: PlanConvergenceLimits): void {
  if (!Number.isSafeInteger(limits.maxTickets) || limits.maxTickets <= 0 || limits.maxTickets > DEFAULT_GRAPH_LIMITS.maxTickets) {
    throw new PlanGraphError(`Plan convergence maxTickets must be an integer from 1 to ${DEFAULT_GRAPH_LIMITS.maxTickets}`);
  }
  if (!Number.isSafeInteger(limits.maxAcceptedAmendments) || limits.maxAcceptedAmendments < 0 || limits.maxAcceptedAmendments > 1_000) {
    throw new PlanGraphError("Plan convergence maxAcceptedAmendments must be an integer from 0 to 1000");
  }
}

function assertConvergenceAvailable(
  state: PlanConvergenceState,
  currentTicketCount: number,
  nextTicketCount: number,
  nextAcceptedAmendments: number,
): void {
  const ticketsExceeded = nextTicketCount > state.maxTickets;
  const amendmentsExceeded = nextAcceptedAmendments > state.maxAcceptedAmendments;
  if (!ticketsExceeded && !amendmentsExceeded) return;

  const dimension = ticketsExceeded && amendmentsExceeded
    ? "multiple"
    : ticketsExceeded ? "tickets" : "accepted_amendments";
  const used = ticketsExceeded ? currentTicketCount : state.acceptedAmendments;
  const limit = ticketsExceeded ? state.maxTickets : state.maxAcceptedAmendments;
  throw new ConvergenceBudgetError({
    dimension,
    used,
    limit,
    remaining: Math.max(0, limit - used),
    owner: "planner",
    requiredInput: {
      kind: "agent_recovery",
      description: `Plan convergence ${dimension} budget is exhausted`,
      details: {
        action: "Reduce scope, close the current Plan, or explicitly create a replacement Plan with a new convergence budget.",
      },
    },
    automaticRetry: false,
  });
}

function createTickets(graph: MaterializedPlanGraph, planId: PlanId): TicketSnapshot[] {
  return graph.graph.ticketIds.map((ticketId) => ({ ticketId, planId, version: 1, status: "pending", attempts: [], ...(graph.definitionsByTicketId[String(ticketId)]?.parentTicketId ? { parentTicketId: graph.definitionsByTicketId[String(ticketId)].parentTicketId } : {}) }));
}

function settleAttempt(
  ticket: TicketSnapshot,
  attemptId: string | undefined,
  update: Partial<TicketSnapshot["attempts"][number]> & Pick<TicketSnapshot["attempts"][number], "status">,
): TicketSnapshot["attempts"] {
  if (!attemptId) throw new TicketEngineOperationError("invalid_request", `Ticket ${ticket.ticketId} has no active Attempt`);
  let found = false;
  const attempts = ticket.attempts.map((attempt) => {
    if (attempt.attemptId !== attemptId) return attempt;
    found = true;
    return { ...attempt, ...structuredClone(update) };
  });
  if (!found) throw new TicketEngineOperationError("invalid_request", `Attempt ${attemptId} does not exist`);
  return attempts;
}

function cancelTicket(ticket: TicketSnapshot, endedAt: string, reason: string): TicketSnapshot {
  return {
    ...ticket,
    status: "cancelled",
    version: ticket.version + 1,
    activeAuthority: undefined,
    activeAttemptId: undefined,
    attempts: ticket.activeAttemptId
      ? settleAttempt(ticket, ticket.activeAttemptId, { status: "cancelled", endedAt, reason })
      : ticket.attempts,
  };
}

function validateCompletionHandoff(handoff: TicketHandoff): string | undefined {
  if (handoff.schemaVersion !== 1 || !handoff.summary.trim()) return "Completion handoff must have schemaVersion 1 and a summary";
  if (!Array.isArray(handoff.evidence) || handoff.evidence.some((ref) => !ref?.evidenceId?.trim())) {
    return "Completion handoff evidence is invalid";
  }
  if (!Array.isArray(handoff.residualRisks) || handoff.residualRisks.some((risk) => typeof risk !== "string")) {
    return "Completion handoff residualRisks must be strings";
  }
  if (!Array.isArray(handoff.criterionResults)) return "Completion handoff criterionResults must be an array";
  const indexes = new Set<number>();
  for (const result of handoff.criterionResults) {
    if (!Number.isSafeInteger(result.criterionIndex) || result.criterionIndex < 0 || indexes.has(result.criterionIndex)) {
      return "Completion handoff criterion indexes must be unique non-negative integers";
    }
    indexes.add(result.criterionIndex);
    if (!["satisfied", "not_satisfied", "not_verified"].includes(result.status)) {
      return "Completion handoff criterion status is invalid";
    }
    if (!Array.isArray(result.evidence) || result.evidence.some((ref) => !ref?.evidenceId?.trim())) {
      return "Completion handoff criterion evidence is invalid";
    }
  }
  return undefined;
}

function initializeReady(tickets: TicketSnapshot[], graph: MaterializedPlanGraph["graph"]): void {
  const incoming = new Set(graph.dependencyEdges.map((edge) => String(edge.toTicketId)));
  for (const ticket of tickets) if (ticket.status === "pending" && !incoming.has(String(ticket.ticketId))) ticket.status = "ready";
}
function unlockReady(tickets: TicketSnapshot[], graph: MaterializedPlanGraph["graph"]): { tickets: TicketSnapshot[]; ready: TicketSnapshot[] } {
  const byId = new Map(tickets.map((ticket) => [String(ticket.ticketId), ticket]));
  const statuses = statusMap(tickets);
  const incoming = new Map<string, TicketId[]>();
  for (const edge of graph.dependencyEdges) incoming.set(String(edge.toTicketId), [...(incoming.get(String(edge.toTicketId)) ?? []), edge.fromTicketId]);
  const ready: TicketSnapshot[] = [];
  const next = tickets.map((ticket) => {
    if (ticket.status !== "pending") return ticket;
    if ((incoming.get(String(ticket.ticketId)) ?? []).every((id) => (
      byId.has(String(id)) && isTicketDependencySatisfied(graph, statuses, id)
    ))) {
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
  if (!ticket || !definition?.permissions?.amendPlan) return false;
  if (ticket.status !== "running" && ticket.status !== "blocked") return false;
  if (!authorityMatches(ticket.activeAuthority, authority)) return false;
  if (authority.kind === "claim") return aggregate.claims.some((claim) => claim.claimId === authority.claimId && claim.principalId === principalId);
  return aggregate.blockedOwnerships.some((owner) => owner.ownershipId === authority.ownershipId && owner.principalId === principalId);
}
function requirePositiveDuration(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TicketEngineOperationError("invalid_request", `${label} must be a positive integer`);
}
function definitionRequiresGitIsolation(definition: TicketDefinition | undefined): boolean {
  if (!definition) return false;
  const tools = new Set(definition.assignment.requiredTools ?? []);
  return tools.has("writeFile") || tools.has("editFile") || tools.has("shell") || tools.has("startService");
}
function definitionIntegratesWorkspaceChanges(definition: TicketDefinition | undefined): boolean {
  if (!definition) return false;
  const tools = new Set(definition.assignment.requiredTools ?? []);
  return tools.has("writeFile") || tools.has("editFile");
}
function fingerprintOf(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function ticketEvent(ticket: TicketSnapshot, payload: TicketEvent<"ticket">["payload"], occurredAt: string): TicketEvent<"ticket"> {
  return { eventId: randomUUID(), planId: ticket.planId, aggregateType: "ticket", aggregateId: ticket.ticketId, aggregateVersion: ticket.version, occurredAt, payload };
}
function planEvent(planId: PlanId, version: number, payload: TicketEvent<"plan">["payload"], occurredAt: string): TicketEvent<"plan"> {
  return { eventId: randomUUID(), planId, aggregateType: "plan", aggregateId: planId, aggregateVersion: version, occurredAt, payload };
}
