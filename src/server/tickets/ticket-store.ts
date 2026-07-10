import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  BlockedOwnershipReceipt,
  ClaimCommandResult,
  ClaimReceipt,
  TicketCommandResult,
  TicketEvent,
  TicketEventPage,
  TicketEventQuery,
  TicketSnapshot,
  WorkflowCommandResult,
  WorkflowId,
  WorkflowSnapshot,
} from "../../shared/contracts/ticket-engine.js";
import { ticketEngineFile, ticketEngineLockFile } from "../storage/paths.js";
import {
  computeRequiredClosure,
  evaluateWorkflowOutcome,
  type MaterializedWorkflowGraph,
} from "./workflow-graph.js";

export type TicketStoredCommandResult =
  | TicketCommandResult
  | WorkflowCommandResult
  | ClaimCommandResult;

export interface TicketOutboxEntry {
  position: number;
  event: TicketEvent;
}

export interface TicketStorageIdentity {
  taskId: string;
  taskRunId: string;
  workflowId: WorkflowId;
}

export interface TicketAggregate {
  schemaVersion: 2;
  storageIdentity: TicketStorageIdentity;
  aggregateVersion: number;
  workflow: WorkflowSnapshot;
  tickets: TicketSnapshot[];
  claims: ClaimReceipt[];
  blockedOwnerships: BlockedOwnershipReceipt[];
  commandResults: TicketStoredCommandResult[];
  outbox: TicketOutboxEntry[];
}

export interface TicketAggregateSeed {
  schemaVersion: 2;
  workflow: WorkflowSnapshot;
  tickets: TicketSnapshot[];
  claims: ClaimReceipt[];
  blockedOwnerships: BlockedOwnershipReceipt[];
  commandResults: TicketStoredCommandResult[];
  pendingEvents?: TicketEvent[];
}

export interface TicketAggregateExpectedVersion {
  aggregateVersion: number;
  workflowVersion: number;
}

export type TicketAggregateMutation = TicketAggregate & {
  pendingEvents?: TicketEvent[];
};

export interface TicketStoreOptions {
  lockWaitTimeoutMs?: number;
  lockRetryMs?: number;
  lockStaleMs?: number;
}

interface ResolvedTicketStoreOptions {
  lockWaitTimeoutMs: number;
  lockRetryMs: number;
  lockStaleMs: number;
}

interface WorkflowLockMetadata {
  token: string;
  pid: number;
  hostname: string;
  createdAt: string;
}

export class TicketStoreConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TicketStoreConflictError";
  }
}

export class TicketStoreCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TicketStoreCursorError";
  }
}

export class TicketStoreCorruptionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TicketStoreCorruptionError";
  }
}

const workflowWriteQueues = new Map<string, Promise<unknown>>();
const DEFAULT_OPTIONS: ResolvedTicketStoreOptions = {
  lockWaitTimeoutMs: 60_000,
  lockRetryMs: 10,
  lockStaleMs: 30_000,
};
const RENAME_MAX_ATTEMPTS = 6;

export class TicketStore {
  private readonly options: ResolvedTicketStoreOptions;

  constructor(
    private readonly workspaceRoot: string,
    private readonly taskId: string,
    private readonly taskRunId: string,
    options: TicketStoreOptions = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    for (const [name, value] of Object.entries(this.options)) {
      if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be non-negative`);
    }
  }

  async create(seed: TicketAggregateSeed): Promise<TicketAggregate> {
    return this.enqueue(seed.workflow.workflowId, async () => {
      const existing = await this.readFromDisk(seed.workflow.workflowId);
      if (existing) {
        throw new TicketStoreConflictError(`Workflow ${seed.workflow.workflowId} already exists`);
      }

      const { pendingEvents = [], ...persistedSeed } = structuredClone(seed);
      const aggregate: TicketAggregate = {
        ...persistedSeed,
        schemaVersion: 2,
        storageIdentity: this.storageIdentity(seed.workflow.workflowId),
        aggregateVersion: 1,
        outbox: pendingEvents.map((event, index) => ({ position: index + 1, event })),
      };
      this.validateAggregate(aggregate, seed.workflow.workflowId);
      await writeDurableJson(this.file(seed.workflow.workflowId), aggregate);
      return structuredClone(aggregate);
    });
  }

  async read(workflowId: WorkflowId): Promise<TicketAggregate | undefined> {
    const aggregate = await this.readFromDisk(workflowId);
    return aggregate ? structuredClone(aggregate) : undefined;
  }

  async transact(
    workflowId: WorkflowId,
    expected: TicketAggregateExpectedVersion,
    mutate: (current: TicketAggregate) => TicketAggregateMutation | Promise<TicketAggregateMutation>,
  ): Promise<TicketAggregate> {
    return this.enqueue(workflowId, async () => {
      const current = await this.requireAggregate(workflowId);
      if (
        current.aggregateVersion !== expected.aggregateVersion
        || current.workflow.version !== expected.workflowVersion
      ) {
        throw new TicketStoreConflictError(
          `Workflow ${workflowId} version conflict: expected aggregate ${expected.aggregateVersion}`
          + `/workflow ${expected.workflowVersion}, current aggregate ${current.aggregateVersion}`
          + `/workflow ${current.workflow.version}`,
        );
      }

      const proposed = await mutate(structuredClone(current));
      const pendingEvents = proposed.pendingEvents ?? [];
      if (proposed.workflow.version !== current.workflow.version + 1) {
        throw new TicketStoreConflictError(
          `Workflow ${workflowId} must increment workflow version by exactly one`,
        );
      }

      const nextOutbox = [...current.outbox];
      let position = nextOutbox.at(-1)?.position ?? 0;
      for (const event of pendingEvents) {
        position += 1;
        nextOutbox.push({ position, event: structuredClone(event) });
      }

      const next: TicketAggregate = {
        schemaVersion: 2,
        storageIdentity: this.storageIdentity(workflowId),
        aggregateVersion: current.aggregateVersion + 1,
        workflow: structuredClone(proposed.workflow),
        tickets: structuredClone(proposed.tickets),
        claims: structuredClone(proposed.claims),
        blockedOwnerships: structuredClone(proposed.blockedOwnerships),
        commandResults: structuredClone(proposed.commandResults),
        outbox: nextOutbox,
      };
      this.validateAggregate(next, workflowId);
      await writeDurableJson(this.file(workflowId), next);
      return structuredClone(next);
    });
  }

  async getCommandResult(
    workflowId: WorkflowId,
    commandId: string,
  ): Promise<TicketStoredCommandResult | undefined> {
    const aggregate = await this.readFromDisk(workflowId);
    return structuredClone(aggregate?.commandResults.find((result) => result.commandId === commandId));
  }

  async readEvents<TWorkflowId extends WorkflowId>(
    query: TicketEventQuery<TWorkflowId>,
  ): Promise<TicketEventPage<TWorkflowId>> {
    if (!Number.isInteger(query.limit) || query.limit < 1) {
      throw new TicketStoreCursorError("Event page limit must be a positive integer");
    }

    const aggregate = await this.readFromDisk(query.workflowId);
    const lastDurablePosition = aggregate?.outbox.at(-1)?.position ?? 0;
    const afterPosition = query.after
      ? this.decodeCursor(query.workflowId, query.after, lastDurablePosition)
      : 0;
    const entries = (aggregate?.outbox ?? [])
      .filter((entry) => entry.position > afterPosition)
      .slice(0, query.limit);
    const lastPosition = entries.at(-1)?.position ?? afterPosition;

    return {
      events: structuredClone(entries.map((entry) => entry.event)) as TicketEventPage<TWorkflowId>["events"],
      nextCursor: {
        source: "ticket",
        partitionId: query.workflowId,
        position: this.encodeCursor(query.workflowId, lastPosition),
      },
    };
  }

  private async requireAggregate(workflowId: WorkflowId): Promise<TicketAggregate> {
    const aggregate = await this.readFromDisk(workflowId);
    if (!aggregate) throw new Error(`Workflow ${workflowId} does not exist`);
    return aggregate;
  }

  private async readFromDisk(workflowId: WorkflowId): Promise<TicketAggregate | undefined> {
    let content: string;
    try {
      content = await readFile(this.file(workflowId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }

    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch (error) {
      throw new TicketStoreCorruptionError(`Workflow ${workflowId} contains invalid JSON`, {
        cause: error,
      });
    }
    this.validateAggregate(value, workflowId);
    return value as TicketAggregate;
  }

  private validateAggregate(value: unknown, workflowId: WorkflowId): asserts value is TicketAggregate {
    const aggregate = requireRecord(value, "aggregate");
    assertOnlyKeys(aggregate, [
      "schemaVersion",
      "storageIdentity",
      "aggregateVersion",
      "workflow",
      "tickets",
      "claims",
      "blockedOwnerships",
      "commandResults",
      "outbox",
    ], "aggregate");
    if (aggregate.schemaVersion !== 2) this.corrupt("unsupported schemaVersion");
    requirePositiveVersion(aggregate.aggregateVersion, "aggregateVersion");

    const identity = requireRecord(aggregate.storageIdentity, "storageIdentity");
    assertOnlyKeys(identity, ["taskId", "taskRunId", "workflowId"], "storageIdentity");
    if (
      identity.taskId !== this.taskId
      || identity.taskRunId !== this.taskRunId
      || identity.workflowId !== workflowId
    ) {
      this.corrupt("storage identity does not match the requested aggregate");
    }

    const workflow = requireRecord(aggregate.workflow, "workflow");
    assertOnlyKeys(workflow, [
      "workflowId",
      "version",
      "status",
      "deferredOutcome",
      "graph",
      "completionPolicy",
      "policyRef",
    ], "workflow");
    if (workflow.workflowId !== workflowId) this.corrupt("workflowId does not match its aggregate");
    requirePositiveVersion(workflow.version, "workflow.version");
    if (typeof workflow.status !== "string" || !WORKFLOW_STATUSES.has(workflow.status)) {
      this.corrupt("workflow.status is invalid");
    }
    if (
      workflow.deferredOutcome !== undefined
      && (typeof workflow.deferredOutcome !== "string" || !DEFERRED_OUTCOMES.has(workflow.deferredOutcome))
    ) {
      this.corrupt("workflow.deferredOutcome is invalid");
    }

    const graph = requireRecord(workflow.graph, "workflow.graph");
    assertOnlyKeys(graph, ["schemaVersion", "nodes", "dependencyEdges"], "workflow.graph");
    if (graph.schemaVersion !== 2) this.corrupt("workflow.graph schemaVersion is invalid");
    const graphNodes = requireArray(graph.nodes, "workflow.graph.nodes");
    const graphTicketIds = new Set<string>();
    const graphNodeKeys = new Set<string>();
    const graphNodeRecords: Record<string, unknown>[] = [];
    for (const [index, rawNode] of graphNodes.entries()) {
      const node = requireRecord(rawNode, `workflow.graph.nodes[${index}]`);
      assertOnlyKeys(node, [
        "nodeKey",
        "ticketId",
        "active",
        "revisionOfTicketId",
        "supersededByTicketId",
      ], `workflow.graph.nodes[${index}]`);
      graphNodeRecords.push(node);
      const ticketId = requireNonEmptyString(node.ticketId, `workflow.graph.nodes[${index}].ticketId`);
      if (graphTicketIds.has(ticketId)) this.corrupt(`duplicate graph ticketId ${ticketId}`);
      graphTicketIds.add(ticketId);
      const nodeKey = requireNonEmptyString(node.nodeKey, `workflow.graph.nodes[${index}].nodeKey`);
      if (graphNodeKeys.has(nodeKey)) this.corrupt(`duplicate graph nodeKey ${nodeKey}`);
      graphNodeKeys.add(nodeKey);
      if (typeof node.active !== "boolean") this.corrupt(`workflow.graph.nodes[${index}].active is invalid`);
      requireOptionalNonEmptyString(node.revisionOfTicketId, `workflow.graph.nodes[${index}].revisionOfTicketId`);
      requireOptionalNonEmptyString(node.supersededByTicketId, `workflow.graph.nodes[${index}].supersededByTicketId`);
    }
    for (const [index, node] of graphNodeRecords.entries()) {
      for (const field of ["revisionOfTicketId", "supersededByTicketId"] as const) {
        if (node[field] !== undefined && !graphTicketIds.has(String(node[field]))) {
          this.corrupt(`workflow.graph.nodes[${index}].${field} references an unknown ticket`);
        }
      }
    }
    validateRevisionRelationships(graphNodeRecords);
    const dependencyPairs: Array<[string, string]> = [];
    const dependencyKeys = new Set<string>();
    for (const [index, rawEdge] of requireArray(graph.dependencyEdges, "workflow.graph.dependencyEdges").entries()) {
      const edge = requireRecord(rawEdge, `workflow.graph.dependencyEdges[${index}]`);
      assertOnlyKeys(edge, ["fromTicketId", "toTicketId"], `workflow.graph.dependencyEdges[${index}]`);
      const fromTicketId = requireNonEmptyString(
        edge.fromTicketId,
        `workflow.graph.dependencyEdges[${index}].fromTicketId`,
      );
      const toTicketId = requireNonEmptyString(
        edge.toTicketId,
        `workflow.graph.dependencyEdges[${index}].toTicketId`,
      );
      if (!graphTicketIds.has(fromTicketId) || !graphTicketIds.has(toTicketId)) {
        this.corrupt(`workflow.graph.dependencyEdges[${index}] references an unknown ticket`);
      }
      if (fromTicketId === toTicketId) this.corrupt("workflow dependency cannot reference itself");
      const dependencyKey = `${fromTicketId}\u0000${toTicketId}`;
      if (dependencyKeys.has(dependencyKey)) this.corrupt(`duplicate workflow dependency ${fromTicketId} -> ${toTicketId}`);
      dependencyKeys.add(dependencyKey);
      dependencyPairs.push([fromTicketId, toTicketId]);
    }
    assertAcyclic(graphTicketIds, dependencyPairs, "workflow.graph.dependencyEdges");

    const completionPolicy = requireRecord(workflow.completionPolicy, "workflow.completionPolicy");
    assertOnlyKeys(completionPolicy, [
      "requiredTerminalTicketIds",
      "failurePolicy",
      "blockedPolicy",
    ], "workflow.completionPolicy");
    const requiredTerminalIds = new Set<string>();
    for (const ticketId of requireArray(
      completionPolicy.requiredTerminalTicketIds,
      "workflow.completionPolicy.requiredTerminalTicketIds",
    )) {
      if (typeof ticketId !== "string" || !graphTicketIds.has(ticketId)) {
        this.corrupt("completion policy references an unknown ticket");
      }
      if (requiredTerminalIds.has(ticketId)) this.corrupt(`duplicate required terminal ticket ${ticketId}`);
      requiredTerminalIds.add(ticketId);
    }
    if (
      typeof completionPolicy.failurePolicy !== "string"
      || !FAILURE_POLICIES.has(completionPolicy.failurePolicy)
    ) {
      this.corrupt("workflow.completionPolicy.failurePolicy is invalid");
    }
    if (completionPolicy.blockedPolicy !== "wait") {
      this.corrupt("workflow.completionPolicy.blockedPolicy is invalid");
    }
    computeRequiredClosure(
      graph as never,
      completionPolicy as never,
    );
    const policyRef = requireRecord(workflow.policyRef, "workflow.policyRef");
    assertOnlyKeys(policyRef, ["policyId", "policyVersion", "contentHash"], "workflow.policyRef");
    requireNonEmptyString(policyRef.policyId, "workflow.policyRef.policyId");
    requirePositiveVersion(policyRef.policyVersion, "workflow.policyRef.policyVersion");
    requireNonEmptyString(policyRef.contentHash, "workflow.policyRef.contentHash");

    const tickets = requireArray(aggregate.tickets, "tickets");
    const ticketIds = new Set<string>();
    const ticketRecords: Record<string, unknown>[] = [];
    for (const [index, rawTicket] of tickets.entries()) {
      const ticket = requireRecord(rawTicket, `tickets[${index}]`);
      assertOnlyKeys(ticket, [
        "ticketId",
        "workflowId",
        "version",
        "status",
        "parentTicketId",
        "activeAuthority",
      ], `tickets[${index}]`);
      ticketRecords.push(ticket);
      const ticketId = requireNonEmptyString(ticket.ticketId, `tickets[${index}].ticketId`);
      if (ticketIds.has(ticketId)) this.corrupt(`duplicate ticketId ${ticketId}`);
      ticketIds.add(ticketId);
      if (ticket.workflowId !== workflowId) this.corrupt(`ticket ${ticketId} belongs to another workflow`);
      requirePositiveVersion(ticket.version, `tickets[${index}].version`);
      if (typeof ticket.status !== "string" || !TICKET_STATUSES.has(ticket.status)) {
        this.corrupt(`ticket ${ticketId} has an invalid status`);
      }
      requireOptionalNonEmptyString(ticket.parentTicketId, `tickets[${index}].parentTicketId`);
      if (ticket.activeAuthority !== undefined) {
        validateAuthority(ticket.activeAuthority, `tickets[${index}].activeAuthority`);
      }
    }
    if (ticketIds.size !== graphTicketIds.size || [...graphTicketIds].some((id) => !ticketIds.has(id))) {
      this.corrupt("workflow graph and ticket snapshots are inconsistent");
    }
    const parentPairs: Array<[string, string]> = [];
    for (const [index, ticket] of ticketRecords.entries()) {
      if (ticket.parentTicketId !== undefined && !ticketIds.has(String(ticket.parentTicketId))) {
        this.corrupt(`tickets[${index}].parentTicketId references an unknown ticket`);
      }
      if (ticket.parentTicketId !== undefined) {
        parentPairs.push([String(ticket.parentTicketId), String(ticket.ticketId)]);
      }
    }
    assertAcyclic(ticketIds, parentPairs, "ticket parent relationships");

    const claims = requireArray(aggregate.claims, "claims");
    const claimIds = new Set<string>();
    const claimRequestIds = new Set<string>();
    const claimsById = new Map<string, Record<string, unknown>>();
    for (const [index, rawClaim] of claims.entries()) {
      const claim = requireRecord(rawClaim, `claims[${index}]`);
      assertOnlyKeys(claim, [
        "requestId",
        "claimId",
        "workflowId",
        "ticketId",
        "ticketVersion",
        "principalId",
        "fencingToken",
        "leaseUntil",
      ], `claims[${index}]`);
      const requestId = requireNonEmptyString(claim.requestId, `claims[${index}].requestId`);
      if (claimRequestIds.has(requestId)) this.corrupt(`duplicate claim requestId ${requestId}`);
      claimRequestIds.add(requestId);
      const claimId = requireNonEmptyString(claim.claimId, `claims[${index}].claimId`);
      if (claimIds.has(claimId)) this.corrupt(`duplicate claimId ${claimId}`);
      claimIds.add(claimId);
      claimsById.set(claimId, claim);
      this.validateOwnedTicket(claim, workflowId, ticketIds, `claims[${index}]`);
      requireNonEmptyString(claim.principalId, `claims[${index}].principalId`);
      requireNonNegativeInteger(claim.fencingToken, `claims[${index}].fencingToken`);
      requireIsoTimestamp(claim.leaseUntil, `claims[${index}].leaseUntil`);
    }

    const ownershipIds = new Set<string>();
    const ownershipsById = new Map<string, Record<string, unknown>>();
    for (const [index, rawOwnership] of requireArray(
      aggregate.blockedOwnerships,
      "blockedOwnerships",
    ).entries()) {
      const ownership = requireRecord(rawOwnership, `blockedOwnerships[${index}]`);
      assertOnlyKeys(ownership, [
        "ownershipId",
        "workflowId",
        "ticketId",
        "ticketVersion",
        "principalId",
        "fencingToken",
      ], `blockedOwnerships[${index}]`);
      const ownershipId = requireNonEmptyString(
        ownership.ownershipId,
        `blockedOwnerships[${index}].ownershipId`,
      );
      if (ownershipIds.has(ownershipId)) this.corrupt(`duplicate ownershipId ${ownershipId}`);
      ownershipIds.add(ownershipId);
      ownershipsById.set(ownershipId, ownership);
      this.validateOwnedTicket(ownership, workflowId, ticketIds, `blockedOwnerships[${index}]`);
      requireNonEmptyString(ownership.principalId, `blockedOwnerships[${index}].principalId`);
      requireNonNegativeInteger(ownership.fencingToken, `blockedOwnerships[${index}].fencingToken`);
    }

    for (const [index, ticket] of ticketRecords.entries()) {
      validateTicketAuthorityRelationship(
        ticket,
        claimsById,
        ownershipsById,
        `tickets[${index}]`,
      );
    }

    validateWorkflowOutcomeRelationship(
      workflow,
      graph,
      completionPolicy,
      ticketRecords,
    );

    const commandIds = new Set<string>();
    for (const [index, rawResult] of requireArray(aggregate.commandResults, "commandResults").entries()) {
      const result = requireRecord(rawResult, `commandResults[${index}]`);
      const commandId = requireNonEmptyString(result.commandId, `commandResults[${index}].commandId`);
      if (commandIds.has(commandId)) this.corrupt(`duplicate commandId ${commandId}`);
      commandIds.add(commandId);
      validateCommandResult(result, workflowId, ticketIds, `commandResults[${index}]`);
    }

    const eventIds = new Set<string>();
    const ticketRecordsById = new Map(
      ticketRecords.map((ticket) => [String(ticket.ticketId), ticket] as const),
    );
    const lastEventVersionByAggregate = new Map<string, number>();
    for (const [index, rawEntry] of requireArray(aggregate.outbox, "outbox").entries()) {
      const entry = requireRecord(rawEntry, `outbox[${index}]`);
      assertOnlyKeys(entry, ["position", "event"], `outbox[${index}]`);
      if (entry.position !== index + 1) this.corrupt("outbox positions must be contiguous from one");
      const event = requireRecord(entry.event, `outbox[${index}].event`);
      assertOnlyKeys(event, [
        "eventId",
        "workflowId",
        "aggregateType",
        "aggregateId",
        "aggregateVersion",
        "occurredAt",
        "payload",
      ], `outbox[${index}].event`);
      const eventId = requireNonEmptyString(event.eventId, `outbox[${index}].event.eventId`);
      if (eventIds.has(eventId)) this.corrupt(`duplicate eventId ${eventId}`);
      eventIds.add(eventId);
      if (event.workflowId !== workflowId) this.corrupt(`event ${eventId} belongs to another workflow`);
      requirePositiveVersion(event.aggregateVersion, `outbox[${index}].event.aggregateVersion`);
      requireIsoTimestamp(event.occurredAt, `outbox[${index}].event.occurredAt`);
      const payload = requireRecord(event.payload, `outbox[${index}].event.payload`);
      if (event.aggregateType === "ticket") {
        if (typeof event.aggregateId !== "string" || !ticketIds.has(event.aggregateId)) {
          this.corrupt(`event ${eventId} references an unknown ticket`);
        }
        const currentTicketVersion = Number(ticketRecordsById.get(String(event.aggregateId))!.version);
        if (Number(event.aggregateVersion) > currentTicketVersion) {
          this.corrupt(`event ${eventId} references a future ticket version`);
        }
        validateTicketEventPayload(payload, `outbox[${index}].event.payload`);
        if (payload.type === "TicketReady" && payload.ticketVersion !== event.aggregateVersion) {
          this.corrupt(`event ${eventId} has inconsistent TicketReady versions`);
        }
      } else if (event.aggregateType === "workflow") {
        if (event.aggregateId !== workflowId) this.corrupt(`event ${eventId} references another workflow`);
        if (Number(event.aggregateVersion) > Number(workflow.version)) {
          this.corrupt(`event ${eventId} references a future workflow version`);
        }
        validateWorkflowEventPayload(payload, `outbox[${index}].event.payload`);
      } else {
        this.corrupt(`event ${eventId} has an invalid aggregateType`);
      }
      const aggregateKey = `${String(event.aggregateType)}\u0000${String(event.aggregateId)}`;
      const previousVersion = lastEventVersionByAggregate.get(aggregateKey) ?? 0;
      if (Number(event.aggregateVersion) < previousVersion) {
        this.corrupt(`event ${eventId} moves aggregate history backwards`);
      }
      lastEventVersionByAggregate.set(aggregateKey, Number(event.aggregateVersion));
    }
  }

  private validateOwnedTicket(
    value: Record<string, unknown>,
    workflowId: WorkflowId,
    ticketIds: Set<string>,
    label: string,
  ): void {
    if (value.workflowId !== workflowId) this.corrupt(`${label} belongs to another workflow`);
    if (typeof value.ticketId !== "string" || !ticketIds.has(value.ticketId)) {
      this.corrupt(`${label} references an unknown ticket`);
    }
    requirePositiveVersion(value.ticketVersion, `${label}.ticketVersion`);
  }

  private corrupt(message: string): never {
    throw new TicketStoreCorruptionError(message);
  }

  private encodeCursor(workflowId: WorkflowId, position: number): string {
    return `ticket:${encodeURIComponent(workflowId)}:${position}`;
  }

  private decodeCursor(
    workflowId: WorkflowId,
    cursor: { source: "ticket"; partitionId: WorkflowId; position: string },
    lastDurablePosition: number,
  ): number {
    if (cursor.source !== "ticket") {
      throw new TicketStoreCursorError(`Cursor source ${String(cursor.source)} is not ticket`);
    }
    if (cursor.partitionId !== workflowId) {
      throw new TicketStoreCursorError(
        `Cursor belongs to workflow ${cursor.partitionId}, not ${workflowId}`,
      );
    }
    const prefix = `ticket:${encodeURIComponent(workflowId)}:`;
    if (!cursor.position.startsWith(prefix)) {
      throw new TicketStoreCursorError(`Cursor namespace does not match workflow ${workflowId}`);
    }
    const position = Number(cursor.position.slice(prefix.length));
    if (!Number.isSafeInteger(position) || position < 0) {
      throw new TicketStoreCursorError("Cursor position is invalid");
    }
    if (position > lastDurablePosition) {
      throw new TicketStoreCursorError(
        `Cursor position ${position} is beyond durable outbox position ${lastDurablePosition}`,
      );
    }
    return position;
  }

  private storageIdentity(workflowId: WorkflowId): TicketStorageIdentity {
    return { taskId: this.taskId, taskRunId: this.taskRunId, workflowId };
  }

  private file(workflowId: WorkflowId): string {
    return ticketEngineFile(this.workspaceRoot, this.taskId, this.taskRunId, workflowId);
  }

  private lockFile(workflowId: WorkflowId): string {
    return ticketEngineLockFile(this.workspaceRoot, this.taskId, this.taskRunId, workflowId);
  }

  private enqueue<T>(workflowId: WorkflowId, operation: () => Promise<T>): Promise<T> {
    const key = this.file(workflowId).toLowerCase();
    const previous = workflowWriteQueues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.withWorkflowLock(workflowId, operation));
    workflowWriteQueues.set(key, next);
    return next.finally(() => {
      if (workflowWriteQueues.get(key) === next) workflowWriteQueues.delete(key);
    });
  }

  private async withWorkflowLock<T>(workflowId: WorkflowId, operation: () => Promise<T>): Promise<T> {
    const lock = await this.acquireWorkflowLock(workflowId);
    try {
      return await operation();
    } finally {
      await this.releaseWorkflowLock(lock.file, lock.token);
    }
  }

  private async acquireWorkflowLock(workflowId: WorkflowId): Promise<{ file: string; token: string }> {
    const file = this.lockFile(workflowId);
    await mkdir(path.dirname(file), { recursive: true });
    const deadline = Date.now() + this.options.lockWaitTimeoutMs;

    while (true) {
      const token = randomUUID();
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(file, "wx", 0o600);
        const metadata: WorkflowLockMetadata = {
          token,
          pid: process.pid,
          hostname: os.hostname(),
          createdAt: new Date().toISOString(),
        };
        await handle.writeFile(`${JSON.stringify(metadata)}\n`, "utf8");
        await handle.sync();
        await handle.close();
        return { file, token };
      } catch (error) {
        await handle?.close().catch(() => undefined);
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          if (handle) await rm(file, { force: true }).catch(() => undefined);
          throw error;
        }
      }

      if (await this.recoverStaleLock(file)) continue;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for Ticket workflow lock ${workflowId}`);
      }
      await delay(this.options.lockRetryMs);
    }
  }

  private async recoverStaleLock(file: string): Promise<boolean> {
    let firstContent: string;
    let firstStat: Awaited<ReturnType<typeof stat>>;
    try {
      [firstContent, firstStat] = await Promise.all([readFile(file, "utf8"), stat(file)]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      return false;
    }
    if (Date.now() - firstStat.mtimeMs <= this.options.lockStaleMs) return false;

    const metadata = parseLockMetadata(firstContent);
    if (metadata?.hostname === os.hostname() && isProcessAlive(metadata.pid)) return false;

    try {
      const [latestContent, latestStat] = await Promise.all([readFile(file, "utf8"), stat(file)]);
      if (latestContent !== firstContent || latestStat.mtimeMs !== firstStat.mtimeMs) return false;
      await rm(file);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
  }

  private async releaseWorkflowLock(file: string, token: string): Promise<void> {
    try {
      const metadata = parseLockMetadata(await readFile(file, "utf8"));
      if (metadata?.token === token) await rm(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

const WORKFLOW_STATUSES = new Set(["active", "paused", "blocked", "completed", "failed", "cancelled"]);
const DEFERRED_OUTCOMES = new Set(["active", "blocked", "completed", "failed"]);
const FAILURE_POLICIES = new Set(["fail_fast", "require_resolution"]);
const TICKET_STATUSES = new Set([
  "pending",
  "ready",
  "running",
  "blocked",
  "completed",
  "returned",
  "failed",
  "cancelled",
]);
const TICKET_RESULT_STATUSES = new Set(["blocked", "completed", "returned", "failed"]);
const TICKET_REJECTION_CODES = new Set([
  "invalid_command",
  "policy_violation",
  "version_conflict",
  "stale_authority",
  "workflow_terminal",
  "idempotency_conflict",
]);
const WORKFLOW_REJECTION_CODES = new Set([
  "invalid_definition",
  "policy_violation",
  "version_conflict",
  "workflow_terminal",
  "idempotency_conflict",
]);
const CLAIM_REJECTION_CODES = new Set([
  "not_ready",
  "policy_violation",
  "version_conflict",
  "workflow_paused",
  "workflow_terminal",
  "idempotency_conflict",
]);
const TICKET_TERMINAL_EVENT_STATUSES = new Set(["completed", "returned", "failed", "cancelled"]);

function validateRevisionRelationships(nodes: Record<string, unknown>[]): void {
  const byId = new Map(nodes.map((node) => [String(node.ticketId), node] as const));
  const successorsByPredecessor = new Map<string, number>();
  const revisionEdges: Array<[string, string]> = [];

  for (const node of nodes) {
    const ticketId = String(node.ticketId);
    const revisionOf = node.revisionOfTicketId === undefined
      ? undefined
      : String(node.revisionOfTicketId);
    const supersededBy = node.supersededByTicketId === undefined
      ? undefined
      : String(node.supersededByTicketId);
    if (revisionOf === ticketId || supersededBy === ticketId) {
      throw new TicketStoreCorruptionError(`revision chain for ${ticketId} references itself`);
    }
    if (revisionOf) {
      const predecessor = byId.get(revisionOf)!;
      successorsByPredecessor.set(revisionOf, (successorsByPredecessor.get(revisionOf) ?? 0) + 1);
      if (predecessor.supersededByTicketId !== ticketId) {
        throw new TicketStoreCorruptionError(`revision ${revisionOf} -> ${ticketId} is not bidirectional`);
      }
      if (predecessor.active !== false) {
        throw new TicketStoreCorruptionError(`revision predecessor ${revisionOf} must be inactive`);
      }
      revisionEdges.push([revisionOf, ticketId]);
    }
    if (supersededBy) {
      const successor = byId.get(supersededBy)!;
      if (successor.revisionOfTicketId !== ticketId) {
        throw new TicketStoreCorruptionError(`supersession ${ticketId} -> ${supersededBy} is not bidirectional`);
      }
      if (node.active !== false) {
        throw new TicketStoreCorruptionError(`superseded ticket ${ticketId} must be inactive`);
      }
    } else if (revisionOf && node.active !== true) {
      throw new TicketStoreCorruptionError(`latest revision ${ticketId} must be active`);
    }
  }
  for (const [predecessor, count] of successorsByPredecessor) {
    if (count > 1) {
      throw new TicketStoreCorruptionError(`revision predecessor ${predecessor} has multiple successors`);
    }
  }
  assertAcyclic(new Set(byId.keys()), revisionEdges, "ticket revision relationships");
}

function validateTicketAuthorityRelationship(
  ticket: Record<string, unknown>,
  claimsById: Map<string, Record<string, unknown>>,
  ownershipsById: Map<string, Record<string, unknown>>,
  label: string,
): void {
  const authority = ticket.activeAuthority as Record<string, unknown> | undefined;
  if (ticket.status === "running" && authority?.kind !== "claim") {
    throw new TicketStoreCorruptionError(`${label} running status requires claim authority`);
  }
  if (ticket.status === "blocked" && authority?.kind !== "blocked_owner") {
    throw new TicketStoreCorruptionError(`${label} blocked status requires blocked-owner authority`);
  }
  if (ticket.status !== "running" && ticket.status !== "blocked" && authority !== undefined) {
    throw new TicketStoreCorruptionError(`${label} status cannot carry active authority`);
  }
  if (!authority) return;

  const receipt = authority.kind === "claim"
    ? claimsById.get(String(authority.claimId))
    : ownershipsById.get(String(authority.ownershipId));
  if (!receipt) throw new TicketStoreCorruptionError(`${label}.activeAuthority cannot be resolved`);
  if (
    receipt.workflowId !== ticket.workflowId
    || receipt.ticketId !== ticket.ticketId
    || receipt.ticketVersion !== ticket.version
    || receipt.fencingToken !== authority.fencingToken
  ) {
    throw new TicketStoreCorruptionError(`${label}.activeAuthority does not match its receipt`);
  }
}

function validateWorkflowOutcomeRelationship(
  workflow: Record<string, unknown>,
  graph: Record<string, unknown>,
  completionPolicy: Record<string, unknown>,
  tickets: Record<string, unknown>[],
): void {
  const outcome = evaluateWorkflowOutcome({
    materialized: {
      graph,
      completionPolicy,
    } as unknown as MaterializedWorkflowGraph,
    ticketStatuses: new Map(tickets.map((ticket) => [
      String(ticket.ticketId),
      ticket.status,
    ])) as never,
  });
  if (workflow.status === "paused") {
    if (workflow.deferredOutcome !== outcome) {
      throw new TicketStoreCorruptionError("paused workflow deferredOutcome is inconsistent");
    }
    return;
  }
  if (workflow.deferredOutcome !== undefined) {
    throw new TicketStoreCorruptionError("only paused workflows may persist deferredOutcome");
  }
  if (workflow.status !== "cancelled" && workflow.status !== outcome) {
    throw new TicketStoreCorruptionError(
      `workflow status ${String(workflow.status)} does not match policy outcome ${outcome}`,
    );
  }
}

function validateAuthority(value: unknown, label: string): void {
  const authority = requireRecord(value, label);
  requireNonNegativeInteger(authority.fencingToken, `${label}.fencingToken`);
  if (authority.kind === "claim") {
    assertOnlyKeys(authority, ["kind", "claimId", "fencingToken"], label);
    requireNonEmptyString(authority.claimId, `${label}.claimId`);
    return;
  }
  if (authority.kind === "blocked_owner") {
    assertOnlyKeys(authority, ["kind", "ownershipId", "fencingToken"], label);
    requireNonEmptyString(authority.ownershipId, `${label}.ownershipId`);
    return;
  }
  throw new TicketStoreCorruptionError(`${label}.kind is invalid`);
}

function validateCommandResult(
  result: Record<string, unknown>,
  workflowId: WorkflowId,
  ticketIds: Set<string>,
  label: string,
): void {
  if (typeof result.accepted !== "boolean") {
    throw new TicketStoreCorruptionError(`${label}.accepted must be boolean`);
  }

  if (result.accepted) {
    if (result.receipt !== undefined) {
      assertOnlyKeys(result, ["accepted", "commandId", "receipt"], label);
      validateClaimReceipt(result.receipt, workflowId, ticketIds, `${label}.receipt`);
      return;
    }
    if (result.proposalId !== undefined || result.ticketStatus !== undefined) {
      assertOnlyKeys(result, [
        "accepted",
        "commandId",
        "proposalId",
        "ticketStatus",
        "ticketVersion",
        "workflowStatus",
        "workflowVersion",
        "nextAuthority",
      ], label);
      requireNonEmptyString(result.proposalId, `${label}.proposalId`);
      if (typeof result.ticketStatus !== "string" || !TICKET_RESULT_STATUSES.has(result.ticketStatus)) {
        throw new TicketStoreCorruptionError(`${label}.ticketStatus is invalid`);
      }
      requirePositiveVersion(result.ticketVersion, `${label}.ticketVersion`);
      requireWorkflowStatus(result.workflowStatus, `${label}.workflowStatus`);
      requirePositiveVersion(result.workflowVersion, `${label}.workflowVersion`);
      if (result.nextAuthority !== undefined) validateAuthority(result.nextAuthority, `${label}.nextAuthority`);
      return;
    }
    assertOnlyKeys(result, ["accepted", "commandId", "workflowStatus", "workflowVersion"], label);
    requireWorkflowStatus(result.workflowStatus, `${label}.workflowStatus`);
    requirePositiveVersion(result.workflowVersion, `${label}.workflowVersion`);
    return;
  }

  requireNonEmptyString(result.reason, `${label}.reason`);
  if (result.proposalId !== undefined) {
    assertOnlyKeys(result, [
      "accepted",
      "commandId",
      "proposalId",
      "code",
      "reason",
      "currentTicketVersion",
      "currentWorkflowVersion",
    ], label);
    requireNonEmptyString(result.proposalId, `${label}.proposalId`);
    requireCode(result.code, TICKET_REJECTION_CODES, `${label}.code`);
  } else {
    const code = requireNonEmptyString(result.code, `${label}.code`);
    if (!WORKFLOW_REJECTION_CODES.has(code) && !CLAIM_REJECTION_CODES.has(code)) {
      throw new TicketStoreCorruptionError(`${label}.code is invalid`);
    }
    if (result.currentTicketVersion !== undefined && result.currentWorkflowVersion !== undefined) {
      throw new TicketStoreCorruptionError(`${label} mixes claim and workflow result versions`);
    }
    if (result.currentTicketVersion !== undefined || !WORKFLOW_REJECTION_CODES.has(code)) {
      assertOnlyKeys(result, [
        "accepted",
        "commandId",
        "code",
        "reason",
        "currentTicketVersion",
      ], label);
    } else if (result.currentWorkflowVersion !== undefined || !CLAIM_REJECTION_CODES.has(code)) {
      assertOnlyKeys(result, [
        "accepted",
        "commandId",
        "code",
        "reason",
        "currentWorkflowVersion",
      ], label);
    } else {
      assertOnlyKeys(result, ["accepted", "commandId", "code", "reason"], label);
    }
  }
  requireOptionalPositiveVersion(result.currentTicketVersion, `${label}.currentTicketVersion`);
  requireOptionalPositiveVersion(result.currentWorkflowVersion, `${label}.currentWorkflowVersion`);
}

function validateClaimReceipt(
  value: unknown,
  workflowId: WorkflowId,
  ticketIds: Set<string>,
  label: string,
): void {
  const receipt = requireRecord(value, label);
  assertOnlyKeys(receipt, [
    "requestId",
    "claimId",
    "workflowId",
    "ticketId",
    "ticketVersion",
    "principalId",
    "fencingToken",
    "leaseUntil",
  ], label);
  requireNonEmptyString(receipt.requestId, `${label}.requestId`);
  requireNonEmptyString(receipt.claimId, `${label}.claimId`);
  if (receipt.workflowId !== workflowId) {
    throw new TicketStoreCorruptionError(`${label}.workflowId is invalid`);
  }
  if (typeof receipt.ticketId !== "string" || !ticketIds.has(receipt.ticketId)) {
    throw new TicketStoreCorruptionError(`${label}.ticketId is invalid`);
  }
  requirePositiveVersion(receipt.ticketVersion, `${label}.ticketVersion`);
  requireNonEmptyString(receipt.principalId, `${label}.principalId`);
  requireNonNegativeInteger(receipt.fencingToken, `${label}.fencingToken`);
  requireIsoTimestamp(receipt.leaseUntil, `${label}.leaseUntil`);
}

function validateTicketEventPayload(payload: Record<string, unknown>, label: string): void {
  switch (payload.type) {
    case "TicketReady":
      assertOnlyKeys(payload, ["type", "ticketVersion"], label);
      requirePositiveVersion(payload.ticketVersion, `${label}.ticketVersion`);
      return;
    case "TicketClaimed":
    case "ClaimExpired":
      assertOnlyKeys(payload, ["type", "claimId"], label);
      requireNonEmptyString(payload.claimId, `${label}.claimId`);
      return;
    case "TicketBlocked":
      assertOnlyKeys(payload, ["type", "requiredInput"], label);
      requireOptionalString(payload.requiredInput, `${label}.requiredInput`);
      return;
    case "TicketTerminal":
      assertOnlyKeys(payload, ["type", "status"], label);
      requireCode(payload.status, TICKET_TERMINAL_EVENT_STATUSES, `${label}.status`);
      return;
    case "AuthorityRevoked":
      assertOnlyKeys(payload, ["type", "fencingToken"], label);
      requireNonNegativeInteger(payload.fencingToken, `${label}.fencingToken`);
      return;
    default:
      throw new TicketStoreCorruptionError(`${label}.type is invalid for a ticket event`);
  }
}

function validateWorkflowEventPayload(payload: Record<string, unknown>, label: string): void {
  if (payload.type !== "WorkflowStatusChanged") {
    throw new TicketStoreCorruptionError(`${label}.type is invalid for a workflow event`);
  }
  assertOnlyKeys(payload, ["type", "status"], label);
  requireWorkflowStatus(payload.status, `${label}.status`);
}

function requireWorkflowStatus(value: unknown, label: string): string {
  return requireCode(value, WORKFLOW_STATUSES, label);
}

function requireCode(value: unknown, allowed: Set<string>, label: string): string {
  const code = requireNonEmptyString(value, label);
  if (!allowed.has(code)) throw new TicketStoreCorruptionError(`${label} is invalid`);
  return code;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TicketStoreCorruptionError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertOnlyKeys(value: Record<string, unknown>, keys: string[], label: string): void {
  const allowed = new Set(keys);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new TicketStoreCorruptionError(`${label}.${unknown} is not allowed`);
}

function assertAcyclic(nodes: Set<string>, edges: Array<[string, string]>, label: string): void {
  const outgoing = new Map<string, string[]>();
  for (const node of nodes) outgoing.set(node, []);
  for (const [from, to] of edges) outgoing.get(from)?.push(to);

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (node: string): void => {
    if (visiting.has(node)) throw new TicketStoreCorruptionError(`${label} contains a cycle`);
    if (visited.has(node)) return;
    visiting.add(node);
    for (const child of outgoing.get(node) ?? []) visit(child);
    visiting.delete(node);
    visited.add(node);
  };
  for (const node of nodes) visit(node);
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new TicketStoreCorruptionError(`${label} must be an array`);
  return value;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TicketStoreCorruptionError(`${label} must be a non-empty string`);
  }
  return value;
}

function requireOptionalNonEmptyString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : requireNonEmptyString(value, label);
}

function requireOptionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new TicketStoreCorruptionError(`${label} must be a string`);
  return value;
}

function requireIsoTimestamp(value: unknown, label: string): string {
  const timestamp = requireNonEmptyString(value, label);
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== timestamp) {
    throw new TicketStoreCorruptionError(`${label} must be a valid timestamp`);
  }
  return timestamp;
}

function requirePositiveVersion(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new TicketStoreCorruptionError(`${label} must be a positive integer`);
  }
  return Number(value);
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TicketStoreCorruptionError(`${label} must be a non-negative integer`);
  }
  return Number(value);
}

function requireOptionalPositiveVersion(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : requirePositiveVersion(value, label);
}

function parseLockMetadata(content: string): WorkflowLockMetadata | undefined {
  try {
    const value = JSON.parse(content) as Partial<WorkflowLockMetadata>;
    if (
      typeof value.token !== "string"
      || typeof value.pid !== "number"
      || typeof value.hostname !== "string"
      || typeof value.createdAt !== "string"
    ) return undefined;
    return value as WorkflowLockMetadata;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function writeDurableJson(file: string, value: unknown): Promise<void> {
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await renameWithRetry(temporary, file);
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function renameWithRetry(source: string, target: string): Promise<void> {
  for (let attempt = 0; attempt < RENAME_MAX_ATTEMPTS; attempt += 1) {
    try {
      await rename(source, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!new Set(["EPERM", "EBUSY", "ENOTEMPTY"]).has(String(code)) || attempt === RENAME_MAX_ATTEMPTS - 1) {
        throw error;
      }
      await delay(25 * (attempt + 1));
    }
  }
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") {
    // Node cannot fsync a directory on Windows. Flushing the temporary file before rename gives
    // process-crash atomic replacement, but this does not claim power-loss durability for the
    // renamed directory entry. POSIX persists that entry with the directory fsync below.
    return;
  }
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
