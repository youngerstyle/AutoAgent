import { createHash } from "node:crypto";
import type {
  BlockedOwnershipReceipt,
  ClaimReceipt,
  ClaimRequest,
  PlannedTicketNode,
  ReleaseClaimRequest,
  RenewClaimRequest,
  TicketEvent,
  TicketEventPage,
  TicketEventQuery,
  TicketCommandEnvelope,
  TicketCommandPayload,
  TicketCommandResult,
  TicketId,
  TicketSnapshot,
  TicketWorkItem,
  TransferBlockedOwnershipRequest,
  WorkflowAuthorizationPolicy,
  WorkflowCommandEnvelope,
  WorkflowCommandResult,
  WorkflowId,
  WorkflowPolicyPort,
  WorkflowStatus,
} from "../../shared/contracts/ticket-engine.js";
import {
  TicketStore,
  TicketStoreConflictError,
  type TicketAggregate,
  type TicketOperationRecord,
  type TicketPlanningState,
} from "./ticket-store.js";
import {
  evaluateWorkflowOutcome,
  materializeWorkflowGraph,
  type MaterializedWorkflowGraph,
  WorkflowGraphError,
} from "./workflow-graph.js";

const TERMINAL_WORKFLOW_STATUSES = new Set<WorkflowStatus>(["completed", "failed", "cancelled"]);
const TERMINAL_TICKET_STATUSES = new Set(["completed", "returned", "failed", "cancelled"]);

class WorkflowCommandValidationError extends Error {}

export interface TicketEngineOptions {
  teamBindingIds?: string[];
  now?: () => Date;
}

export class TicketEngineOperationError extends Error {
  constructor(
    public readonly code: "invalid_request" | "idempotency_conflict" | "stale_authority" | "policy_violation",
    message: string,
  ) {
    super(message);
    this.name = "TicketEngineOperationError";
  }
}

export class TicketEngine {
  private readonly teamBindingIds: string[];
  private readonly now: () => Date;

  constructor(
    private readonly store: TicketStore,
    private readonly policyPort: WorkflowPolicyPort,
    options: TicketEngineOptions = {},
  ) {
    this.teamBindingIds = [...new Set(options.teamBindingIds ?? [])].sort();
    this.now = options.now ?? (() => new Date());
  }

  async getClaim(claimId: string): Promise<ClaimReceipt | undefined> {
    return this.store.findClaim(claimId);
  }

  async getWorkflow(workflowId: WorkflowId) {
    const aggregate = await this.store.read(workflowId);
    if (!aggregate) throw new Error(`Workflow ${workflowId} does not exist`);
    return structuredClone(aggregate.workflow);
  }

  async getTicket(ticketId: TicketId): Promise<TicketSnapshot | undefined> {
    for (const workflowId of await this.store.listWorkflowIds()) {
      const ticket = (await this.store.read(workflowId))?.tickets.find((item) => item.ticketId === ticketId);
      if (ticket) return structuredClone(ticket);
    }
    return undefined;
  }

  async getWorkItem(ticketId: TicketId): Promise<TicketWorkItem | undefined> {
    for (const workflowId of await this.store.listWorkflowIds()) {
      const aggregate = await this.store.read(workflowId);
      const ticket = aggregate?.tickets.find((item) => item.ticketId === ticketId);
      if (!aggregate || !ticket || !aggregate.planning) continue;
      const node = aggregate.workflow.graph.nodes.find((item) => item.ticketId === ticketId);
      const definition = node ? aggregate.planning.definitionsByKey[String(node.nodeKey)] : undefined;
      if (definition) return { ticket: structuredClone(ticket), definition: structuredClone(definition) };
    }
    return undefined;
  }

  async getWorkflowCommandResult(commandId: string): Promise<WorkflowCommandResult | undefined> {
    for (const workflowId of await this.store.listWorkflowIds()) {
      const result = await this.store.getCommandResult(workflowId, commandId);
      if (result && !('proposalId' in result) && !('receipt' in result)) return result as WorkflowCommandResult;
    }
    return undefined;
  }

  async getTicketCommandResult(commandId: string): Promise<TicketCommandResult | undefined> {
    for (const workflowId of await this.store.listWorkflowIds()) {
      const result = await this.store.getCommandResult(workflowId, commandId);
      if (result && 'proposalId' in result) return result as TicketCommandResult;
    }
    return undefined;
  }

  readEvents<TWorkflowId extends WorkflowId>(
    input: TicketEventQuery<TWorkflowId>,
  ): Promise<TicketEventPage<TWorkflowId>> {
    return this.store.readEvents(input);
  }

  async getClaimByRequestId(requestId: string): Promise<ClaimReceipt | undefined> {
    const record = await this.store.findOperationRecord(requestId);
    return record?.kind === "claim" || record?.kind === "renew_claim"
      ? record.claim
      : undefined;
  }

  async claimReady(input: ClaimRequest): Promise<ClaimReceipt | undefined> {
    validateDuration(input.leaseDurationMs, "leaseDurationMs");
    const fingerprint = requestFingerprint("claim", input);
    const replay = await this.replayOperation(input.requestId, "claim", fingerprint);
    if (replay) return replay.claim;
    const aggregate = await this.store.read(input.workflowId);
    if (!aggregate || aggregate.workflow.status !== "active") return undefined;
    if (!await this.authorized(
      aggregate.workflow.policyRef,
      input.principalId,
      "ticket:claim",
    )) {
      throw new TicketEngineOperationError("policy_violation", "Principal cannot claim tickets");
    }
    const ticket = aggregate.tickets.find((item) => item.ticketId === input.ticketId);
    if (!ticket || ticket.status !== "ready" || ticket.version !== input.expectedTicketVersion) return undefined;

    const nextVersion = ticket.version + 1;
    const receipt: ClaimReceipt = {
      requestId: input.requestId,
      claimId: stableId("claim", input.workflowId, input.ticketId, input.requestId),
      workflowId: input.workflowId,
      ticketId: input.ticketId,
      ticketVersion: nextVersion,
      principalId: input.principalId,
      fencingToken: nextFencingToken(aggregate, input.ticketId),
      leaseUntil: new Date(this.now().getTime() + input.leaseDurationMs).toISOString(),
    };
    try {
      await this.store.transact(
        input.workflowId,
        { aggregateVersion: aggregate.aggregateVersion, workflowVersion: aggregate.workflow.version },
        (current) => {
          const currentTicket = current.tickets.find((item) => item.ticketId === input.ticketId);
          if (!currentTicket || currentTicket.status !== "ready" || currentTicket.version !== input.expectedTicketVersion) {
            throw new WorkflowCommandValidationError("Ticket is no longer ready");
          }
          return {
            ...current,
            workflow: { ...current.workflow, version: current.workflow.version + 1 },
            tickets: current.tickets.map((item) => item.ticketId === input.ticketId ? {
              ...item,
              version: nextVersion,
              status: "running" as const,
              activeAuthority: {
                kind: "claim" as const,
                claimId: receipt.claimId,
                fencingToken: receipt.fencingToken,
              },
            } : item),
            claims: [...current.claims, receipt],
            operationRecords: [...current.operationRecords, {
              kind: "claim" as const,
              requestId: input.requestId,
              fingerprint,
              claim: receipt,
            }],
            pendingEvents: [ticketEventFromValues(
              input.workflowId,
              input.ticketId,
              nextVersion,
              input.requestId,
              this.now().toISOString(),
              { type: "TicketClaimed", claimId: receipt.claimId },
            )],
          };
        },
      );
      return receipt;
    } catch (error) {
      if (error instanceof TicketStoreConflictError || error instanceof WorkflowCommandValidationError) {
        const raced = await this.replayOperation(input.requestId, "claim", fingerprint);
        return raced?.claim;
      }
      throw error;
    }
  }

  async renewClaim(input: RenewClaimRequest): Promise<ClaimReceipt> {
    validateDuration(input.extendByMs, "extendByMs");
    const fingerprint = requestFingerprint("renew_claim", input);
    const replay = await this.replayOperation(input.requestId, "renew_claim", fingerprint);
    if (replay) return replay.claim;
    const claim = await this.requireClaim(input.claimId, input.fencingToken);
    const aggregate = await this.requireWorkflow(claim.workflowId);
    const ticket = requireActiveClaimTicket(aggregate, claim);
    const nextVersion = ticket.version + 1;
    const leaseBase = Math.max(Date.parse(claim.leaseUntil), this.now().getTime());
    const renewed: ClaimReceipt = {
      ...claim,
      requestId: input.requestId,
      ticketVersion: nextVersion,
      leaseUntil: new Date(leaseBase + input.extendByMs).toISOString(),
    };
    await this.store.transact(
      claim.workflowId,
      { aggregateVersion: aggregate.aggregateVersion, workflowVersion: aggregate.workflow.version },
      (current) => ({
        ...current,
        workflow: { ...current.workflow, version: current.workflow.version + 1 },
        tickets: current.tickets.map((item) => item.ticketId === ticket.ticketId
          ? { ...item, version: nextVersion }
          : item),
        claims: current.claims.map((item) => item.claimId === claim.claimId ? renewed : item),
        operationRecords: [...current.operationRecords, {
          kind: "renew_claim" as const,
          requestId: input.requestId,
          fingerprint,
          claim: renewed,
        }],
      }),
    );
    return renewed;
  }

  async releaseClaim(input: ReleaseClaimRequest): Promise<TicketSnapshot> {
    const fingerprint = requestFingerprint("release_claim", input);
    const replay = await this.replayOperation(input.requestId, "release_claim", fingerprint);
    if (replay) return replay.ticket;
    const claim = await this.requireClaim(input.claimId, input.fencingToken);
    return this.releaseActiveClaim(claim, input.requestId, fingerprint, "released");
  }

  async transferBlockedOwnership(
    input: TransferBlockedOwnershipRequest,
  ): Promise<BlockedOwnershipReceipt> {
    const fingerprint = requestFingerprint("transfer_blocked_ownership", input);
    const replay = await this.replayOperation(
      input.requestId,
      "transfer_blocked_ownership",
      fingerprint,
    );
    if (replay) return replay.ownership;
    const ownership = await this.store.findBlockedOwnership(input.ownershipId);
    if (!ownership || ownership.fencingToken !== input.fencingToken) {
      throw new TicketEngineOperationError("stale_authority", "Blocked ownership is stale");
    }
    const aggregate = await this.requireWorkflow(ownership.workflowId);
    if (!await this.authorized(
      aggregate.workflow.policyRef,
      ownership.principalId,
      "blocked_ownership:transfer",
    )) {
      throw new TicketEngineOperationError("policy_violation", "Owner cannot transfer blocked ownership");
    }
    const ticket = aggregate.tickets.find((item) => item.ticketId === ownership.ticketId);
    if (
      !ticket
      || ticket.status !== "blocked"
      || ticket.activeAuthority?.kind !== "blocked_owner"
      || ticket.activeAuthority.ownershipId !== ownership.ownershipId
      || ticket.activeAuthority.fencingToken !== ownership.fencingToken
    ) {
      throw new TicketEngineOperationError("stale_authority", "Blocked ownership is no longer active");
    }
    const nextVersion = ticket.version + 1;
    const transferred: BlockedOwnershipReceipt = {
      ownershipId: stableId("ownership", ownership.workflowId, ownership.ticketId, input.requestId),
      workflowId: ownership.workflowId,
      ticketId: ownership.ticketId,
      ticketVersion: nextVersion,
      principalId: input.toPrincipalId,
      fencingToken: nextFencingToken(aggregate, ownership.ticketId),
    };
    await this.store.transact(
      ownership.workflowId,
      { aggregateVersion: aggregate.aggregateVersion, workflowVersion: aggregate.workflow.version },
      (current) => ({
        ...current,
        workflow: { ...current.workflow, version: current.workflow.version + 1 },
        tickets: current.tickets.map((item) => item.ticketId === ownership.ticketId ? {
          ...item,
          version: nextVersion,
          activeAuthority: {
            kind: "blocked_owner" as const,
            ownershipId: transferred.ownershipId,
            fencingToken: transferred.fencingToken,
          },
        } : item),
        blockedOwnerships: [...current.blockedOwnerships, transferred],
        operationRecords: [...current.operationRecords, {
          kind: "transfer_blocked_ownership" as const,
          requestId: input.requestId,
          fingerprint,
          ownership: transferred,
        }],
        pendingEvents: [ticketEventFromValues(
          ownership.workflowId,
          ownership.ticketId,
          nextVersion,
          input.requestId,
          this.now().toISOString(),
          { type: "AuthorityRevoked", fencingToken: ownership.fencingToken },
        )],
      }),
    );
    return transferred;
  }

  async scanExpiredClaims(now = this.now()): Promise<TicketSnapshot[]> {
    const released: TicketSnapshot[] = [];
    for (const workflowId of await this.store.listWorkflowIds()) {
      const aggregate = await this.store.read(workflowId);
      if (!aggregate) continue;
      for (const claim of aggregate.claims) {
        const ticket = aggregate.tickets.find((item) => item.ticketId === claim.ticketId);
        if (
          ticket?.activeAuthority?.kind !== "claim"
          || ticket.activeAuthority.claimId !== claim.claimId
          || Date.parse(claim.leaseUntil) > now.getTime()
        ) continue;
        const requestId = `expire:${claim.claimId}:${claim.leaseUntil}`;
        const fingerprint = requestFingerprint("release_claim", { requestId, claimId: claim.claimId });
        const replay = await this.replayOperation(requestId, "release_claim", fingerprint);
        released.push(replay?.ticket ?? await this.releaseActiveClaim(
          claim,
          requestId,
          fingerprint,
          "expired",
          now,
        ));
      }
    }
    return released;
  }

  async createWorkflow(command: WorkflowCommandEnvelope): Promise<WorkflowCommandResult> {
    const fingerprint = commandFingerprint(command);
    const existing = await this.store.read(command.workflowId);
    if (existing) return this.replayOrConflict(existing, command, fingerprint);
    if (command.payload.type !== "create_graph") {
      return rejected(command, "invalid_command", "Workflow creation requires create_graph");
    }
    if (!await this.authorized(
      command.payload.definition.policyRef,
      command.actorPrincipalId,
      "ticket_graph:create",
    )) {
      return rejected(command, "policy_violation", "Principal cannot create workflow graphs");
    }

    let materialized: MaterializedWorkflowGraph;
    try {
      materialized = materializeWorkflowGraph({
        workflowId: command.workflowId,
        graph: command.payload.definition.initialGraph,
        completionPolicy: command.payload.definition.completionPolicy,
      });
    } catch (error) {
      return rejected(command, "invalid_definition", errorMessage(error));
    }

    const tickets = initialTickets(materialized, command.workflowId);
    const result: WorkflowCommandResult = {
      accepted: true,
      commandId: command.commandId,
      workflowStatus: "active",
      workflowVersion: 1,
    };
    const pendingEvents = [
      ...tickets
        .filter((ticket) => ticket.status === "ready")
        .map((ticket) => ticketEvent(command, ticket, {
          type: "TicketReady" as const,
          ticketVersion: ticket.version,
        })),
      workflowEvent(command, "active", 1),
    ];
    try {
      await this.store.create({
        schemaVersion: 2,
        workflow: {
          workflowId: command.workflowId,
          version: 1,
          status: "active",
          graph: materialized.graph,
          completionPolicy: materialized.completionPolicy,
          policyRef: command.payload.definition.policyRef,
        },
        planning: planningState(materialized),
        tickets,
        claims: [],
        blockedOwnerships: [],
        commandInputs: [{ commandId: command.commandId, fingerprint }],
        commandResults: [result],
        pendingEvents,
      });
      return result;
    } catch (error) {
      if (!(error instanceof TicketStoreConflictError)) throw error;
      const raced = await this.store.read(command.workflowId);
      return raced
        ? this.replayOrConflict(raced, command, fingerprint)
        : rejected(command, "version_conflict", error.message);
    }
  }

  async applyWorkflow(command: WorkflowCommandEnvelope): Promise<WorkflowCommandResult> {
    if (command.payload.type === "create_graph") return this.createWorkflow(command);
    const fingerprint = commandFingerprint(command);
    const current = await this.store.read(command.workflowId);
    if (!current) return rejected(command, "invalid_command", "Workflow does not exist");
    const replay = this.existingCommand(current, command, fingerprint);
    if (replay) return replay;

    if (TERMINAL_WORKFLOW_STATUSES.has(current.workflow.status)) {
      return this.persistRejected(current, fingerprint, rejected(
        command,
        "workflow_terminal",
        `Workflow is ${current.workflow.status}`,
        current.workflow.version,
      ));
    }
    if (command.payload.expectedWorkflowVersion !== current.workflow.version) {
      return this.persistRejected(current, fingerprint, rejected(
        command,
        "version_conflict",
        "Workflow version is stale",
        current.workflow.version,
      ));
    }
    const capability = command.payload.type === "amend" ? "ticket_graph:amend" : "workflow:control";
    if (!await this.authorized(
      current.workflow.policyRef,
      command.actorPrincipalId,
      capability,
    )) {
      return this.persistRejected(current, fingerprint, rejected(
        command,
        "policy_violation",
        `Principal lacks ${capability}`,
        current.workflow.version,
      ));
    }

    try {
      const updated = await this.store.transact(
        command.workflowId,
        {
          aggregateVersion: current.aggregateVersion,
          workflowVersion: current.workflow.version,
        },
        (aggregate) => this.applyAcceptedCommand(aggregate, command, fingerprint),
      );
      return updated.commandResults.find((result) => result.commandId === command.commandId) as WorkflowCommandResult;
    } catch (error) {
      if (error instanceof WorkflowGraphError || error instanceof WorkflowCommandValidationError) {
        return this.persistRejected(current, fingerprint, rejected(
          command,
          error instanceof WorkflowGraphError ? "invalid_definition" : "invalid_command",
          errorMessage(error),
          current.workflow.version,
        ));
      }
      if (!(error instanceof TicketStoreConflictError)) throw error;
      const latest = await this.store.read(command.workflowId);
      if (latest) {
        const racedReplay = this.existingCommand(latest, command, fingerprint);
        if (racedReplay) return racedReplay;
        return this.persistRejected(latest, fingerprint, rejected(
          command,
          "version_conflict",
          error.message,
          latest.workflow.version,
        ));
      }
      return rejected(command, "version_conflict", error.message);
    }
  }

  async applyTicket(
    command: TicketCommandEnvelope<TicketCommandPayload>,
  ): Promise<TicketCommandResult> {
    const fingerprint = commandFingerprint(command);
    const aggregate = await this.store.read(command.workflowId);
    if (!aggregate) return ticketRejected(command, "invalid_command", "Workflow does not exist");
    const replay = this.existingTicketCommand(aggregate, command, fingerprint);
    if (replay) return replay;
    const proposalConflict = aggregate.commandResults.find((result) => (
      "proposalId" in result && result.proposalId === command.proposalId
    ));
    if (proposalConflict) {
      return this.persistTicketRejected(aggregate, fingerprint, ticketRejected(
        command,
        "idempotency_conflict",
        `Proposal ${command.proposalId} already has a command`,
        aggregate,
      ));
    }
    if (TERMINAL_WORKFLOW_STATUSES.has(aggregate.workflow.status)) {
      return this.persistTicketRejected(aggregate, fingerprint, ticketRejected(
        command,
        "workflow_terminal",
        `Workflow is ${aggregate.workflow.status}`,
        aggregate,
      ));
    }
    const ticket = aggregate.tickets.find((item) => item.ticketId === command.ticketId);
    if (!ticket) {
      return this.persistTicketRejected(aggregate, fingerprint, ticketRejected(
        command,
        "invalid_command",
        "Ticket does not exist",
        aggregate,
      ));
    }
    if (ticket.version !== command.expectedTicketVersion) {
      return this.persistTicketRejected(aggregate, fingerprint, ticketRejected(
        command,
        "version_conflict",
        "Ticket version is stale",
        aggregate,
      ));
    }
    if (
      (command.payload.type === "complete_with_graph" || command.payload.type === "return_to_parent")
      && command.payload.expectedWorkflowVersion !== aggregate.workflow.version
    ) {
      return this.persistTicketRejected(aggregate, fingerprint, ticketRejected(
        command,
        "version_conflict",
        "Workflow version is stale",
        aggregate,
      ));
    }
    try {
      requireCommandAuthority(aggregate, ticket, command, this.now());
      const updated = await this.store.transact(
        command.workflowId,
        { aggregateVersion: aggregate.aggregateVersion, workflowVersion: aggregate.workflow.version },
        (current) => this.applyAcceptedTicketCommand(current, command, fingerprint),
      );
      return updated.commandResults.find((result) => result.commandId === command.commandId) as TicketCommandResult;
    } catch (error) {
      if (error instanceof TicketEngineOperationError) {
        return this.persistTicketRejected(aggregate, fingerprint, ticketRejected(
          command,
          error.code === "stale_authority" ? "stale_authority" : "invalid_command",
          error.message,
          aggregate,
        ));
      }
      if (error instanceof WorkflowGraphError || error instanceof WorkflowCommandValidationError) {
        return this.persistTicketRejected(aggregate, fingerprint, ticketRejected(
          command,
          "invalid_command",
          error.message,
          aggregate,
        ));
      }
      if (error instanceof TicketStoreConflictError) {
        const latest = await this.requireWorkflow(command.workflowId);
        const raced = this.existingTicketCommand(latest, command, fingerprint);
        if (raced) return raced;
        return this.persistTicketRejected(latest, fingerprint, ticketRejected(
          command,
          "version_conflict",
          error.message,
          latest,
        ));
      }
      throw error;
    }
  }

  private applyAcceptedCommand(
    aggregate: TicketAggregate,
    command: WorkflowCommandEnvelope,
    fingerprint: string,
  ) {
    switch (command.payload.type) {
      case "pause":
        if (aggregate.workflow.status === "paused") {
          throw new WorkflowCommandValidationError("Workflow is already paused");
        }
        return withWorkflowResult(aggregate, command, fingerprint, {
          workflow: {
            ...aggregate.workflow,
            version: aggregate.workflow.version + 1,
            status: "paused",
            deferredOutcome: deferredOutcome(aggregate.workflow.status),
          },
          pendingEvents: [workflowEvent(command, "paused", aggregate.workflow.version + 1)],
        });
      case "resume": {
        if (aggregate.workflow.status !== "paused") {
          throw new WorkflowCommandValidationError("Only paused workflows can resume");
        }
        const status = aggregate.workflow.deferredOutcome ?? "active";
        return withWorkflowResult(aggregate, command, fingerprint, {
          workflow: {
            ...aggregate.workflow,
            version: aggregate.workflow.version + 1,
            status,
            deferredOutcome: undefined,
          },
          pendingEvents: [workflowEvent(command, status, aggregate.workflow.version + 1)],
        });
      }
      case "cancel":
        return this.cancelWorkflow(aggregate, command, command.payload, fingerprint);
      case "amend":
        return this.amendWorkflow(aggregate, command, command.payload, fingerprint);
      default:
        throw new Error("Unsupported workflow command");
    }
  }

  private applyAcceptedTicketCommand(
    aggregate: TicketAggregate,
    command: TicketCommandEnvelope<TicketCommandPayload>,
    fingerprint: string,
  ) {
    const ticket = aggregate.tickets.find((item) => item.ticketId === command.ticketId);
    if (!ticket || ticket.version !== command.expectedTicketVersion) {
      throw new WorkflowCommandValidationError("Ticket changed before command commit");
    }
    requireCommandAuthority(aggregate, ticket, command, this.now());
    switch (command.payload.type) {
      case "complete":
        return this.finishTicket(aggregate, command, fingerprint, "completed");
      case "fail":
        return this.finishTicket(aggregate, command, fingerprint, "failed");
      case "block":
        return this.blockTicket(aggregate, command, command.payload, fingerprint);
      case "complete_with_graph":
        return this.completeTicketWithGraph(aggregate, command, command.payload, fingerprint);
      case "return_to_parent":
        return this.returnTicketToParent(aggregate, command, command.payload, fingerprint);
    }
  }

  private finishTicket(
    aggregate: TicketAggregate,
    command: TicketCommandEnvelope,
    fingerprint: string,
    status: "completed" | "failed",
  ) {
    const current = aggregate.tickets.find((item) => item.ticketId === command.ticketId)!;
    const version = current.version + 1;
    const finished: TicketSnapshot = {
      ...current,
      version,
      status,
      activeAuthority: undefined,
    };
    const pendingEvents = authorityRevocationEvents(command, current, version);
    pendingEvents.push(ticketEvent(command, finished, { type: "TicketTerminal", status }));
    let tickets = aggregate.tickets.map((item) => item.ticketId === finished.ticketId ? finished : item);
    tickets = unlockReadyTickets(aggregate.workflow.graph, tickets, command, pendingEvents);
    return ticketMutationResult(aggregate, command, fingerprint, {
      tickets,
      pendingEvents,
      ticket: finished,
    });
  }

  private blockTicket(
    aggregate: TicketAggregate,
    command: TicketCommandEnvelope,
    payload: Extract<TicketCommandPayload, { type: "block" }>,
    fingerprint: string,
  ) {
    const current = aggregate.tickets.find((item) => item.ticketId === command.ticketId)!;
    if (current.status !== "running" || current.activeAuthority?.kind !== "claim") {
      throw new WorkflowCommandValidationError("Only a running claim can block a ticket");
    }
    const activeClaim = aggregate.claims.find((item) => (
      current.activeAuthority?.kind === "claim" && item.claimId === current.activeAuthority.claimId
    ));
    if (!activeClaim) throw new TicketEngineOperationError("stale_authority", "Claim is missing");
    const version = current.version + 1;
    const ownership: BlockedOwnershipReceipt = {
      ownershipId: stableId("ownership", command.workflowId, command.ticketId, command.commandId),
      workflowId: command.workflowId,
      ticketId: command.ticketId,
      ticketVersion: version,
      principalId: activeClaim.principalId,
      fencingToken: nextFencingToken(aggregate, command.ticketId),
    };
    const blocked: TicketSnapshot = {
      ...current,
      version,
      status: "blocked",
      activeAuthority: {
        kind: "blocked_owner",
        ownershipId: ownership.ownershipId,
        fencingToken: ownership.fencingToken,
      },
    };
    const pendingEvents = authorityRevocationEvents(command, current, version);
    pendingEvents.push(ticketEvent(command, blocked, {
      type: "TicketBlocked",
      requiredInput: payload.requiredInput,
    }));
    return ticketMutationResult(aggregate, command, fingerprint, {
      tickets: aggregate.tickets.map((item) => item.ticketId === blocked.ticketId ? blocked : item),
      blockedOwnerships: [...aggregate.blockedOwnerships, ownership],
      pendingEvents,
      ticket: blocked,
      nextAuthority: blocked.activeAuthority,
    });
  }

  private completeTicketWithGraph(
    aggregate: TicketAggregate,
    command: TicketCommandEnvelope,
    payload: Extract<TicketCommandPayload, { type: "complete_with_graph" }>,
    fingerprint: string,
  ) {
    if (!aggregate.planning) throw new WorkflowCommandValidationError("Workflow planning state is missing");
    const statuses = new Map(aggregate.tickets.map((ticket) => [ticket.ticketId, ticket.status] as const));
    const next = materializeWorkflowGraph({
      workflowId: command.workflowId,
      graph: payload.graph,
      completionPolicy: payload.completionPolicy,
      previous: materializedFromAggregate(aggregate),
      cancelTicketIds: payload.cancelTicketIds,
      ticketStatuses: statuses,
    });
    const merged = mergeTicketsForGraph(aggregate, next, command);
    const current = merged.tickets.find((item) => item.ticketId === command.ticketId);
    if (!current || !next.graph.nodes.some((node) => node.ticketId === command.ticketId && node.active)) {
      throw new WorkflowCommandValidationError("Completing planner ticket must remain in the submitted graph");
    }
    const completed: TicketSnapshot = {
      ...current,
      version: current.version + 1,
      status: "completed",
      activeAuthority: undefined,
    };
    const pendingEvents = [...merged.pendingEvents, ...authorityRevocationEvents(
      command,
      current,
      completed.version,
    )];
    pendingEvents.push(ticketEvent(command, completed, { type: "TicketTerminal", status: "completed" }));
    let tickets = merged.tickets.map((item) => item.ticketId === completed.ticketId ? completed : item);
    tickets = unlockReadyTickets(next.graph, tickets, command, pendingEvents);
    return ticketMutationResult(aggregate, command, fingerprint, {
      planning: planningState(next),
      workflow: {
        ...aggregate.workflow,
        graph: next.graph,
        completionPolicy: next.completionPolicy,
      },
      tickets,
      pendingEvents,
      ticket: completed,
    });
  }

  private returnTicketToParent(
    aggregate: TicketAggregate,
    command: TicketCommandEnvelope,
    payload: Extract<TicketCommandPayload, { type: "return_to_parent" }>,
    fingerprint: string,
  ) {
    if (!aggregate.planning) throw new WorkflowCommandValidationError("Workflow planning state is missing");
    const current = aggregate.tickets.find((item) => item.ticketId === command.ticketId)!;
    if (current.parentTicketId !== payload.parentTicketId) {
      throw new WorkflowCommandValidationError("Return target is not the ticket parent");
    }
    const parentNode = aggregate.workflow.graph.nodes.find((node) => node.ticketId === payload.parentTicketId);
    if (!parentNode) throw new WorkflowCommandValidationError("Parent ticket is missing from graph");
    const parentDefinition = aggregate.planning.definitionsByKey[String(parentNode.nodeKey)];
    if (!parentDefinition) throw new WorkflowCommandValidationError("Parent ticket definition is missing");
    const currentNode = aggregate.workflow.graph.nodes.find((node) => node.ticketId === command.ticketId)!;
    const affectedKeys = descendantKeys(
      aggregate.planning.plannedGraph,
      String(currentNode.nodeKey),
    );
    const revisionKey = `revision_${createHash("sha256").update(command.commandId).digest("hex").slice(0, 20)}`;
    const retainedNodes = aggregate.planning.plannedGraph.nodes.filter((node) => (
      node.key !== parentNode.nodeKey && !affectedKeys.has(String(node.key))
    ));
    const revisionNode: PlannedTicketNode = {
      ...structuredClone(parentDefinition),
      key: revisionKey as never,
      revisionOfKey: parentNode.nodeKey,
    };
    const retainedKeys = new Set(retainedNodes.map((node) => String(node.key)));
    retainedKeys.add(revisionKey);
    const dependencyEdges = aggregate.planning.plannedGraph.dependencyEdges.flatMap((edge) => {
      const from = edge.fromKey === parentNode.nodeKey ? revisionKey : String(edge.fromKey);
      const to = edge.toKey === parentNode.nodeKey ? revisionKey : String(edge.toKey);
      if (
        affectedKeys.has(String(edge.fromKey))
        || affectedKeys.has(String(edge.toKey))
        || !retainedKeys.has(from)
        || !retainedKeys.has(to)
      ) return [];
      return [{ fromKey: from as never, toKey: to as never }];
    });
    const graph = {
      schemaVersion: 2 as const,
      nodes: [...retainedNodes, revisionNode],
      dependencyEdges,
    };
    const unrelatedTerminals = aggregate.workflow.completionPolicy.requiredTerminalTicketIds
      .filter((ticketId) => ticketId !== command.ticketId && ticketId !== payload.parentTicketId)
      .map((ticketId) => aggregate.workflow.graph.nodes.find((node) => node.ticketId === ticketId))
      .filter((node): node is NonNullable<typeof node> => (
        Boolean(node?.active) && !affectedKeys.has(String(node!.nodeKey))
      ))
      .map((node) => node.nodeKey);
    const completionPolicy = {
      requiredTerminalKeys: [...unrelatedTerminals, revisionKey as never],
      failurePolicy: aggregate.workflow.completionPolicy.failurePolicy,
      blockedPolicy: "wait" as const,
    };
    const statuses = new Map(aggregate.tickets.map((ticket) => [ticket.ticketId, ticket.status] as const));
    const cancelTicketIds = aggregate.workflow.graph.nodes
      .filter((node) => affectedKeys.has(String(node.nodeKey)))
      .map((node) => node.ticketId)
      .filter((ticketId) => !TERMINAL_TICKET_STATUSES.has(statuses.get(ticketId) ?? "pending"));
    const next = materializeWorkflowGraph({
      workflowId: command.workflowId,
      graph,
      completionPolicy,
      previous: materializedFromAggregate(aggregate),
      cancelTicketIds,
      ticketStatuses: statuses,
    });
    const merged = mergeTicketsForGraph(aggregate, next, command, new Set([command.ticketId]));
    const returned: TicketSnapshot = {
      ...current,
      version: current.version + 1,
      status: "returned",
      activeAuthority: undefined,
    };
    let tickets = merged.tickets.map((item) => item.ticketId === returned.ticketId ? returned : item);
    const pendingEvents = [...merged.pendingEvents, ...authorityRevocationEvents(
      command,
      current,
      returned.version,
    )];
    pendingEvents.push(ticketEvent(command, returned, { type: "TicketTerminal", status: "returned" }));
    tickets = unlockReadyTickets(next.graph, tickets, command, pendingEvents);
    const revisionTicketId = next.ticketIdByKey[revisionKey];
    const revisionTicket = tickets.find((ticket) => ticket.ticketId === revisionTicketId)!;
    return ticketMutationResult(aggregate, command, fingerprint, {
      planning: planningState(next),
      workflow: {
        ...aggregate.workflow,
        graph: next.graph,
        completionPolicy: next.completionPolicy,
      },
      tickets,
      pendingEvents,
      ticket: returned,
      nextAuthority: revisionTicket.activeAuthority,
    });
  }

  private cancelWorkflow(
    aggregate: TicketAggregate,
    command: WorkflowCommandEnvelope,
    _payload: Extract<WorkflowCommandEnvelope["payload"], { type: "cancel" }>,
    fingerprint: string,
  ) {
    const pendingEvents: TicketEvent[] = [];
    const tickets = aggregate.tickets.map((ticket) => {
      if (TERMINAL_TICKET_STATUSES.has(ticket.status)) return ticket;
      const version = ticket.version + 1;
      if (ticket.activeAuthority) {
        pendingEvents.push(ticketEvent(command, { ...ticket, version }, {
          type: "AuthorityRevoked",
          fencingToken: ticket.activeAuthority.fencingToken,
        }));
      }
      pendingEvents.push(ticketEvent(command, { ...ticket, version }, {
        type: "TicketTerminal",
        status: "cancelled",
      }));
      return { ...ticket, version, status: "cancelled" as const, activeAuthority: undefined };
    });
    const version = aggregate.workflow.version + 1;
    pendingEvents.push(workflowEvent(command, "cancelled", version));
    return withWorkflowResult(aggregate, command, fingerprint, {
      workflow: { ...aggregate.workflow, version, status: "cancelled", deferredOutcome: undefined },
      tickets,
      pendingEvents,
    });
  }

  private amendWorkflow(
    aggregate: TicketAggregate,
    command: WorkflowCommandEnvelope,
    payload: Extract<WorkflowCommandEnvelope["payload"], { type: "amend" }>,
    fingerprint: string,
  ) {
    if (!aggregate.planning) throw new WorkflowCommandValidationError("Workflow planning state is missing");
    const previous = materializedFromAggregate(aggregate);
    const statuses = new Map(aggregate.tickets.map((ticket) => [ticket.ticketId, ticket.status] as const));
    const next = materializeWorkflowGraph({
      workflowId: command.workflowId,
      graph: payload.graph,
      completionPolicy: payload.completionPolicy,
      previous,
      cancelTicketIds: payload.cancelTicketIds,
      ticketStatuses: statuses,
    });
    const currentById = new Map(aggregate.tickets.map((ticket) => [ticket.ticketId, ticket] as const));
    const activeIds = new Set(next.graph.nodes.filter((node) => node.active).map((node) => node.ticketId));
    const pendingEvents: TicketEvent[] = [];
    let tickets = next.graph.nodes.map((node) => {
      const current = currentById.get(node.ticketId);
      if (!current) {
        return ticketFromNode(next, node.ticketId, command.workflowId);
      }
      if (!activeIds.has(current.ticketId) && !TERMINAL_TICKET_STATUSES.has(current.status)) {
        const cancelled = { ...current, version: current.version + 1, status: "cancelled" as const };
        pendingEvents.push(ticketEvent(command, cancelled, { type: "TicketTerminal", status: "cancelled" }));
        return cancelled;
      }
      return current;
    });
    const ticketById = new Map(tickets.map((ticket) => [ticket.ticketId, ticket] as const));
    const predecessors = new Map<TicketId, TicketId[]>();
    for (const edge of next.graph.dependencyEdges) {
      predecessors.set(edge.toTicketId, [...(predecessors.get(edge.toTicketId) ?? []), edge.fromTicketId]);
    }
    tickets = tickets.map((ticket) => {
      if (!activeIds.has(ticket.ticketId) || ticket.status !== "pending") return ticket;
      const dependencies = predecessors.get(ticket.ticketId) ?? [];
      if (!dependencies.every((ticketId) => ticketById.get(ticketId)?.status === "completed")) return ticket;
      const ready = { ...ticket, version: currentById.has(ticket.ticketId) ? ticket.version + 1 : ticket.version, status: "ready" as const };
      pendingEvents.push(ticketEvent(command, ready, { type: "TicketReady", ticketVersion: ready.version }));
      return ready;
    });
    const statusMap = new Map(tickets.map((ticket) => [ticket.ticketId, ticket.status] as const));
    const outcome = evaluateWorkflowOutcome({ materialized: next, ticketStatuses: statusMap });
    const version = aggregate.workflow.version + 1;
    const status = aggregate.workflow.status === "paused" ? "paused" : outcome;
    if (status !== aggregate.workflow.status) pendingEvents.push(workflowEvent(command, status, version));
    return withWorkflowResult(aggregate, command, fingerprint, {
      planning: planningState(next),
      workflow: {
        ...aggregate.workflow,
        version,
        status,
        graph: next.graph,
        completionPolicy: next.completionPolicy,
        deferredOutcome: status === "paused" ? outcome : undefined,
      },
      tickets,
      pendingEvents,
    });
  }

  private async replayOperation<TKind extends TicketOperationRecord["kind"]>(
    requestId: string,
    kind: TKind,
    fingerprint: string,
  ): Promise<Extract<TicketOperationRecord, { kind: TKind }> | undefined> {
    const record = await this.store.findOperationRecord(requestId);
    if (!record) return undefined;
    if (record.kind !== kind || record.fingerprint !== fingerprint) {
      throw new TicketEngineOperationError(
        "idempotency_conflict",
        `Request ID ${requestId} was used with different content`,
      );
    }
    return record as Extract<TicketOperationRecord, { kind: TKind }>;
  }

  private async requireClaim(claimId: string, fencingToken: number): Promise<ClaimReceipt> {
    const claim = await this.store.findClaim(claimId);
    if (!claim || claim.fencingToken !== fencingToken) {
      throw new TicketEngineOperationError("stale_authority", "Claim is stale");
    }
    return claim;
  }

  private async requireWorkflow(workflowId: WorkflowId): Promise<TicketAggregate> {
    const aggregate = await this.store.read(workflowId);
    if (!aggregate) throw new TicketEngineOperationError("invalid_request", "Workflow does not exist");
    return aggregate;
  }

  private async releaseActiveClaim(
    claim: ClaimReceipt,
    requestId: string,
    fingerprint: string,
    mode: "released" | "expired",
    occurredAt = this.now(),
  ): Promise<TicketSnapshot> {
    const aggregate = await this.requireWorkflow(claim.workflowId);
    const ticket = requireActiveClaimTicket(aggregate, claim);
    const next: TicketSnapshot = {
      ...ticket,
      version: ticket.version + 1,
      status: "ready",
      activeAuthority: undefined,
    };
    const pendingEvents: TicketEvent[] = [ticketEventFromValues(
      claim.workflowId,
      claim.ticketId,
      next.version,
      requestId,
      occurredAt.toISOString(),
      { type: "AuthorityRevoked", fencingToken: claim.fencingToken },
    )];
    if (mode === "expired") {
      pendingEvents.push(ticketEventFromValues(
        claim.workflowId,
        claim.ticketId,
        next.version,
        requestId,
        occurredAt.toISOString(),
        { type: "ClaimExpired", claimId: claim.claimId },
      ));
    }
    pendingEvents.push(ticketEventFromValues(
      claim.workflowId,
      claim.ticketId,
      next.version,
      requestId,
      occurredAt.toISOString(),
      { type: "TicketReady", ticketVersion: next.version },
    ));
    try {
      await this.store.transact(
        claim.workflowId,
        { aggregateVersion: aggregate.aggregateVersion, workflowVersion: aggregate.workflow.version },
        (current) => {
          requireActiveClaimTicket(current, claim);
          return {
            ...current,
            workflow: { ...current.workflow, version: current.workflow.version + 1 },
            tickets: current.tickets.map((item) => item.ticketId === claim.ticketId ? next : item),
            operationRecords: [...current.operationRecords, {
              kind: "release_claim" as const,
              requestId,
              fingerprint,
              ticket: next,
            }],
            pendingEvents,
          };
        },
      );
      return next;
    } catch (error) {
      if (error instanceof TicketStoreConflictError || error instanceof TicketEngineOperationError) {
        const replay = await this.replayOperation(requestId, "release_claim", fingerprint);
        if (replay) return replay.ticket;
      }
      throw error;
    }
  }

  private async authorized(
    ref: TicketAggregate["workflow"]["policyRef"],
    principalId: string,
    capability: string,
  ): Promise<boolean> {
    const policy = await this.policyPort.getPolicy(ref);
    return policy ? hasCapability(policy, principalId, this.teamBindingIds, capability) : false;
  }

  private existingCommand(
    aggregate: TicketAggregate,
    command: WorkflowCommandEnvelope,
    fingerprint: string,
  ): WorkflowCommandResult | undefined {
    const input = aggregate.commandInputs.find((item) => item.commandId === command.commandId);
    const result = aggregate.commandResults.find((item) => item.commandId === command.commandId);
    if (!input && !result) return undefined;
    if (!input || !result || input.fingerprint !== fingerprint) {
      return rejected(command, "idempotency_conflict", "Command ID was used with different content", aggregate.workflow.version);
    }
    return result as WorkflowCommandResult;
  }

  private existingTicketCommand(
    aggregate: TicketAggregate,
    command: TicketCommandEnvelope,
    fingerprint: string,
  ): TicketCommandResult | undefined {
    const input = aggregate.commandInputs.find((item) => item.commandId === command.commandId);
    const result = aggregate.commandResults.find((item) => item.commandId === command.commandId);
    if (!input && !result) return undefined;
    if (
      !input
      || !result
      || input.fingerprint !== fingerprint
      || !("proposalId" in result)
    ) {
      return ticketRejected(
        command,
        "idempotency_conflict",
        "Command ID was used with different content",
        aggregate,
      );
    }
    return result as TicketCommandResult;
  }

  private async persistTicketRejected(
    aggregate: TicketAggregate,
    fingerprint: string,
    result: TicketCommandResult,
  ): Promise<TicketCommandResult> {
    await this.store.recordCommandResult(
      aggregate.workflow.workflowId,
      { commandId: result.commandId, fingerprint },
      result,
    );
    return result;
  }

  private replayOrConflict(
    aggregate: TicketAggregate,
    command: WorkflowCommandEnvelope,
    fingerprint: string,
  ): WorkflowCommandResult {
    return this.existingCommand(aggregate, command, fingerprint)
      ?? rejected(command, "invalid_command", "Workflow already exists", aggregate.workflow.version);
  }

  private async persistRejected(
    aggregate: TicketAggregate,
    fingerprint: string,
    result: WorkflowCommandResult,
  ): Promise<WorkflowCommandResult> {
    await this.store.recordCommandResult(
      aggregate.workflow.workflowId,
      { commandId: result.commandId, fingerprint },
      result,
    );
    return result;
  }
}

function initialTickets(materialized: MaterializedWorkflowGraph, workflowId: WorkflowId): TicketSnapshot[] {
  const incoming = new Set(materialized.graph.dependencyEdges.map((edge) => edge.toTicketId));
  return materialized.graph.nodes.map((node) => ({
    ticketId: node.ticketId,
    workflowId,
    version: 1,
    status: incoming.has(node.ticketId) ? "pending" : "ready",
    parentTicketId: parentTicketId(materialized, node.nodeKey),
  }));
}

function requireCommandAuthority(
  aggregate: TicketAggregate,
  ticket: TicketSnapshot,
  command: TicketCommandEnvelope,
  now: Date,
): void {
  if (!command.executionRef.trim()) {
    throw new TicketEngineOperationError("invalid_request", "executionRef is required");
  }
  const active = ticket.activeAuthority;
  if (!active || active.kind !== command.authority.kind || active.fencingToken !== command.authority.fencingToken) {
    throw new TicketEngineOperationError("stale_authority", "Ticket authority is stale");
  }
  if (active.kind === "claim" && command.authority.kind === "claim") {
    if (active.claimId !== command.authority.claimId || ticket.status !== "running") {
      throw new TicketEngineOperationError("stale_authority", "Claim is stale");
    }
    const claim = aggregate.claims.find((item) => item.claimId === active.claimId);
    if (
      !claim
      || claim.ticketId !== ticket.ticketId
      || claim.ticketVersion !== ticket.version
      || claim.principalId !== command.actorPrincipalId
      || Date.parse(claim.leaseUntil) <= now.getTime()
    ) {
      throw new TicketEngineOperationError("stale_authority", "Claim is invalid or expired");
    }
    return;
  }
  if (active.kind === "blocked_owner" && command.authority.kind === "blocked_owner") {
    if (active.ownershipId !== command.authority.ownershipId || ticket.status !== "blocked") {
      throw new TicketEngineOperationError("stale_authority", "Blocked ownership is stale");
    }
    const ownership = aggregate.blockedOwnerships.find((item) => item.ownershipId === active.ownershipId);
    if (
      !ownership
      || ownership.ticketId !== ticket.ticketId
      || ownership.ticketVersion !== ticket.version
      || ownership.principalId !== command.actorPrincipalId
    ) {
      throw new TicketEngineOperationError("stale_authority", "Blocked ownership is invalid");
    }
    return;
  }
  throw new TicketEngineOperationError("stale_authority", "Ticket authority kind is invalid");
}

function authorityRevocationEvents(
  command: EventCommand,
  ticket: TicketSnapshot,
  nextVersion: number,
): TicketEvent[] {
  return ticket.activeAuthority ? [ticketEvent(command, {
    ...ticket,
    version: nextVersion,
  }, {
    type: "AuthorityRevoked",
    fencingToken: ticket.activeAuthority.fencingToken,
  })] : [];
}

function unlockReadyTickets(
  graph: TicketAggregate["workflow"]["graph"],
  tickets: TicketSnapshot[],
  command: EventCommand,
  pendingEvents: TicketEvent[],
  newTicketIds: ReadonlySet<TicketId> = new Set(),
): TicketSnapshot[] {
  const active = new Set(graph.nodes.filter((node) => node.active).map((node) => node.ticketId));
  const predecessors = new Map<TicketId, TicketId[]>();
  for (const edge of graph.dependencyEdges) {
    predecessors.set(edge.toTicketId, [...(predecessors.get(edge.toTicketId) ?? []), edge.fromTicketId]);
  }
  const byId = new Map(tickets.map((ticket) => [ticket.ticketId, ticket] as const));
  return tickets.map((ticket) => {
    if (!active.has(ticket.ticketId) || ticket.status !== "pending") return ticket;
    const dependencies = predecessors.get(ticket.ticketId) ?? [];
    if (!dependencies.every((ticketId) => byId.get(ticketId)?.status === "completed")) return ticket;
    const ready = {
      ...ticket,
      version: newTicketIds.has(ticket.ticketId) ? ticket.version : ticket.version + 1,
      status: "ready" as const,
    };
    pendingEvents.push(ticketEvent(command, ready, { type: "TicketReady", ticketVersion: ready.version }));
    return ready;
  });
}

function mergeTicketsForGraph(
  aggregate: TicketAggregate,
  materialized: MaterializedWorkflowGraph,
  command: EventCommand,
  preserveInactiveTicketIds: ReadonlySet<TicketId> = new Set(),
): { tickets: TicketSnapshot[]; pendingEvents: TicketEvent[] } {
  const currentById = new Map(aggregate.tickets.map((ticket) => [ticket.ticketId, ticket] as const));
  const newTicketIds = new Set<TicketId>();
  const activeIds = new Set(materialized.graph.nodes.filter((node) => node.active).map((node) => node.ticketId));
  const pendingEvents: TicketEvent[] = [];
  let tickets = materialized.graph.nodes.map((node) => {
    const current = currentById.get(node.ticketId);
    if (!current) {
      newTicketIds.add(node.ticketId);
      return ticketFromNode(materialized, node.ticketId, aggregate.workflow.workflowId);
    }
    if (
      !activeIds.has(current.ticketId)
      && !preserveInactiveTicketIds.has(current.ticketId)
      && !TERMINAL_TICKET_STATUSES.has(current.status)
    ) {
      const cancelled = { ...current, version: current.version + 1, status: "cancelled" as const, activeAuthority: undefined };
      pendingEvents.push(...authorityRevocationEvents(command, current, cancelled.version));
      pendingEvents.push(ticketEvent(command, cancelled, { type: "TicketTerminal", status: "cancelled" }));
      return cancelled;
    }
    return current;
  });
  tickets = unlockReadyTickets(materialized.graph, tickets, command, pendingEvents, newTicketIds);
  return { tickets, pendingEvents };
}

function descendantKeys(
  graph: TicketPlanningState["plannedGraph"],
  rootKey: string,
): Set<string> {
  const outgoing = new Map<string, string[]>();
  for (const edge of graph.dependencyEdges) {
    const from = String(edge.fromKey);
    outgoing.set(from, [...(outgoing.get(from) ?? []), String(edge.toKey)]);
  }
  const result = new Set<string>();
  const queue = [rootKey];
  for (let index = 0; index < queue.length; index += 1) {
    const key = queue[index]!;
    if (result.has(key)) continue;
    result.add(key);
    queue.push(...(outgoing.get(key) ?? []));
  }
  return result;
}

function ticketMutationResult(
  aggregate: TicketAggregate,
  command: TicketCommandEnvelope,
  fingerprint: string,
  patch: {
    ticket: TicketSnapshot;
    tickets: TicketSnapshot[];
    pendingEvents: TicketEvent[];
    planning?: TicketPlanningState;
    workflow?: TicketAggregate["workflow"];
    blockedOwnerships?: BlockedOwnershipReceipt[];
    nextAuthority?: TicketSnapshot["activeAuthority"];
  },
) {
  const baseWorkflow = patch.workflow ?? aggregate.workflow;
  const materialized: MaterializedWorkflowGraph = {
    workflowId: baseWorkflow.workflowId,
    plannedGraph: (patch.planning ?? aggregate.planning)!.plannedGraph,
    graph: baseWorkflow.graph,
    completionPolicy: baseWorkflow.completionPolicy,
    ticketIdByKey: (patch.planning ?? aggregate.planning)!.ticketIdByKey,
    definitionsByKey: (patch.planning ?? aggregate.planning)!.definitionsByKey,
  };
  const outcome = evaluateWorkflowOutcome({
    materialized,
    ticketStatuses: new Map(patch.tickets.map((ticket) => [ticket.ticketId, ticket.status] as const)),
  });
  const workflowVersion = aggregate.workflow.version + 1;
  const workflowStatus: WorkflowStatus = aggregate.workflow.status === "paused" ? "paused" : outcome;
  const workflow = {
    ...baseWorkflow,
    version: workflowVersion,
    status: workflowStatus,
    deferredOutcome: workflowStatus === "paused" ? outcome : undefined,
  };
  const pendingEvents = [...patch.pendingEvents];
  if (workflowStatus !== aggregate.workflow.status) {
    pendingEvents.push(workflowEvent(command, workflowStatus, workflowVersion));
  }
  const result: TicketCommandResult = {
    accepted: true,
    commandId: command.commandId,
    proposalId: command.proposalId,
    ticketStatus: patch.ticket.status as "blocked" | "completed" | "returned" | "failed",
    ticketVersion: patch.ticket.version,
    workflowStatus,
    workflowVersion,
    ...(patch.nextAuthority ? { nextAuthority: patch.nextAuthority } : {}),
  };
  return {
    ...aggregate,
    ...patch,
    workflow,
    blockedOwnerships: patch.blockedOwnerships ?? aggregate.blockedOwnerships,
    commandInputs: [...aggregate.commandInputs, { commandId: command.commandId, fingerprint }],
    commandResults: [...aggregate.commandResults, result],
    pendingEvents,
  };
}

function ticketRejected(
  command: TicketCommandEnvelope,
  code: Extract<TicketCommandResult, { accepted: false }>["code"],
  reason: string,
  aggregate?: TicketAggregate,
): TicketCommandResult {
  return {
    accepted: false,
    commandId: command.commandId,
    proposalId: command.proposalId,
    code,
    reason,
    ...(aggregate ? {
      currentTicketVersion: aggregate.tickets.find((ticket) => ticket.ticketId === command.ticketId)?.version,
      currentWorkflowVersion: aggregate.workflow.version,
    } : {}),
  };
}

function ticketFromNode(
  materialized: MaterializedWorkflowGraph,
  ticketId: TicketId,
  workflowId: WorkflowId,
): TicketSnapshot {
  const node = materialized.graph.nodes.find((item) => item.ticketId === ticketId)!;
  return {
    ticketId,
    workflowId,
    version: 1,
    status: "pending",
    parentTicketId: parentTicketId(materialized, node.nodeKey),
  };
}

function parentTicketId(materialized: MaterializedWorkflowGraph, nodeKey: string): TicketId | undefined {
  const parentKey = materialized.definitionsByKey[nodeKey]?.parentKey;
  return parentKey ? materialized.ticketIdByKey[String(parentKey)] : undefined;
}

function planningState(materialized: MaterializedWorkflowGraph): TicketPlanningState {
  return {
    plannedGraph: materialized.plannedGraph,
    ticketIdByKey: materialized.ticketIdByKey,
    definitionsByKey: materialized.definitionsByKey,
  };
}

function materializedFromAggregate(aggregate: TicketAggregate): MaterializedWorkflowGraph {
  if (!aggregate.planning) throw new Error("Workflow planning state is missing");
  return {
    workflowId: aggregate.workflow.workflowId,
    plannedGraph: aggregate.planning.plannedGraph,
    graph: aggregate.workflow.graph,
    completionPolicy: aggregate.workflow.completionPolicy,
    ticketIdByKey: aggregate.planning.ticketIdByKey,
    definitionsByKey: aggregate.planning.definitionsByKey,
  };
}

function withWorkflowResult(
  aggregate: TicketAggregate,
  command: WorkflowCommandEnvelope,
  fingerprint: string,
  patch: Partial<TicketAggregate> & Pick<TicketAggregate, "workflow"> & { pendingEvents: TicketEvent[] },
) {
  const result: WorkflowCommandResult = {
    accepted: true,
    commandId: command.commandId,
    workflowStatus: patch.workflow.status,
    workflowVersion: patch.workflow.version,
  };
  return {
    ...aggregate,
    ...patch,
    commandInputs: [...aggregate.commandInputs, { commandId: command.commandId, fingerprint }],
    commandResults: [...aggregate.commandResults, result],
  };
}

function rejected(
  command: WorkflowCommandEnvelope,
  code: Extract<WorkflowCommandResult, { accepted: false }>["code"],
  reason: string,
  currentWorkflowVersion?: number,
): WorkflowCommandResult {
  return {
    accepted: false,
    commandId: command.commandId,
    code,
    reason,
    ...(currentWorkflowVersion === undefined ? {} : { currentWorkflowVersion }),
  };
}

function hasCapability(
  policy: WorkflowAuthorizationPolicy,
  principalId: string,
  teamBindingIds: string[],
  capability: string,
): boolean {
  const teams = new Set(teamBindingIds);
  return policy.grants.some((grant) => (
    grant.capabilities.includes(capability)
    && (grant.principalId === principalId || (grant.teamBindingId !== undefined && teams.has(grant.teamBindingId)))
  ));
}

function deferredOutcome(status: WorkflowStatus): "active" | "blocked" | "completed" | "failed" {
  return status === "blocked" || status === "completed" || status === "failed" ? status : "active";
}

interface EventCommand {
  commandId: string;
  workflowId: WorkflowId;
  issuedAt: string;
}

function ticketEvent(
  command: EventCommand,
  ticket: Pick<TicketSnapshot, "ticketId" | "workflowId" | "version">,
  payload: Extract<TicketEvent, { aggregateType: "ticket" }>["payload"],
): TicketEvent {
  return {
    eventId: eventId(command.commandId, payload.type, ticket.ticketId, ticket.version),
    workflowId: ticket.workflowId,
    aggregateType: "ticket",
    aggregateId: ticket.ticketId,
    aggregateVersion: ticket.version,
    occurredAt: command.issuedAt,
    payload,
  };
}

function workflowEvent(
  command: EventCommand,
  status: WorkflowStatus,
  version: number,
): TicketEvent {
  return {
    eventId: eventId(command.commandId, "WorkflowStatusChanged", command.workflowId, version),
    workflowId: command.workflowId,
    aggregateType: "workflow",
    aggregateId: command.workflowId,
    aggregateVersion: version,
    occurredAt: command.issuedAt,
    payload: { type: "WorkflowStatusChanged", status },
  };
}

function eventId(commandId: string, type: string, aggregateId: string, version: number): string {
  return `te_${createHash("sha256").update(JSON.stringify([commandId, type, aggregateId, version])).digest("base64url")}`;
}

function ticketEventFromValues(
  workflowId: WorkflowId,
  ticketId: TicketId,
  ticketVersion: number,
  requestId: string,
  occurredAt: string,
  payload: Extract<TicketEvent, { aggregateType: "ticket" }>["payload"],
): TicketEvent {
  return {
    eventId: eventId(requestId, payload.type, ticketId, ticketVersion),
    workflowId,
    aggregateType: "ticket",
    aggregateId: ticketId,
    aggregateVersion: ticketVersion,
    occurredAt,
    payload,
  };
}

function requireActiveClaimTicket(aggregate: TicketAggregate, claim: ClaimReceipt): TicketSnapshot {
  const ticket = aggregate.tickets.find((item) => item.ticketId === claim.ticketId);
  if (
    !ticket
    || ticket.status !== "running"
    || ticket.activeAuthority?.kind !== "claim"
    || ticket.activeAuthority.claimId !== claim.claimId
    || ticket.activeAuthority.fencingToken !== claim.fencingToken
    || ticket.version !== claim.ticketVersion
  ) {
    throw new TicketEngineOperationError("stale_authority", "Claim is no longer active");
  }
  return ticket;
}

function nextFencingToken(aggregate: TicketAggregate, ticketId: TicketId): number {
  return Math.max(
    0,
    ...aggregate.claims.filter((claim) => claim.ticketId === ticketId).map((claim) => claim.fencingToken),
    ...aggregate.blockedOwnerships
      .filter((ownership) => ownership.ticketId === ticketId)
      .map((ownership) => ownership.fencingToken),
  ) + 1;
}

function stableId(kind: string, workflowId: WorkflowId, ticketId: TicketId, requestId: string): string {
  return `${kind}_${createHash("sha256")
    .update(JSON.stringify([kind, workflowId, ticketId, requestId]))
    .digest("base64url")}`;
}

function requestFingerprint(kind: string, input: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson({ kind, input })).digest("hex")}`;
}

function validateDuration(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1 || value > 86_400_000) {
    throw new TicketEngineOperationError(
      "invalid_request",
      `${label} must be an integer between 1 and 86400000`,
    );
  }
}

function commandFingerprint(command: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(command)).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
