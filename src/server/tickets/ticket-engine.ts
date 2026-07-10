import { createHash } from "node:crypto";
import type {
  PlannedTicketNode,
  TicketEvent,
  TicketId,
  TicketSnapshot,
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
}

export class TicketEngine {
  private readonly teamBindingIds: string[];

  constructor(
    private readonly store: TicketStore,
    private readonly policyPort: WorkflowPolicyPort,
    options: TicketEngineOptions = {},
  ) {
    this.teamBindingIds = [...new Set(options.teamBindingIds ?? [])].sort();
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

function ticketEvent(
  command: WorkflowCommandEnvelope,
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
  command: WorkflowCommandEnvelope,
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

function commandFingerprint(command: WorkflowCommandEnvelope): string {
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
