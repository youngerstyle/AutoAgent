import { createHash } from "node:crypto";
import type {
  PlannedTicketGraph,
  PlannedTicketNode,
  PlannedWorkflowCompletionPolicy,
  TicketGraphSnapshot,
  TicketId,
  TicketNodeKey,
  TicketStatus,
  WorkflowCompletionPolicy,
  WorkflowId,
} from "../../shared/contracts/ticket-engine.js";

export class WorkflowGraphError extends Error {
  constructor(
    public readonly code:
      | "duplicate_key"
      | "missing_reference"
      | "cycle"
      | "immutable_key"
      | "invalid_revision"
      | "implicit_removal"
      | "invalid_cancellation"
      | "invalid_identifier"
      | "invalid_completion_policy"
      | "graph_limit"
      | "missing_status",
    message: string,
  ) {
    super(message);
    this.name = "WorkflowGraphError";
  }
}

export interface MaterializedWorkflowGraph {
  readonly workflowId: WorkflowId;
  readonly plannedGraph: PlannedTicketGraph;
  readonly graph: TicketGraphSnapshot;
  readonly completionPolicy: WorkflowCompletionPolicy;
  readonly ticketIdByKey: Readonly<Record<string, TicketId>>;
  readonly definitionsByKey: Readonly<Record<string, PlannedTicketNode>>;
}

export interface MaterializeWorkflowGraphInput {
  workflowId: WorkflowId;
  graph: PlannedTicketGraph;
  completionPolicy: PlannedWorkflowCompletionPolicy;
  previous?: MaterializedWorkflowGraph;
  cancelTicketIds?: readonly TicketId[];
  ticketStatuses?: TicketStatusLookup;
  limits?: Partial<GraphLimits>;
}

export interface GraphLimits {
  maxNodes: number;
  maxEdges: number;
  maxSerializedBytes?: number;
}

export const DEFAULT_GRAPH_LIMITS: Readonly<GraphLimits> = Object.freeze({
  maxNodes: 500,
  maxEdges: 5_000,
});

export type TicketStatusLookup =
  | ReadonlyMap<TicketId, TicketStatus>
  | ((ticketId: TicketId) => TicketStatus | undefined);

export interface RequiredFailureInput {
  previous: MaterializedWorkflowGraph;
  next: MaterializedWorkflowGraph;
  ticketStatuses: ReadonlyMap<TicketId, TicketStatus>;
}

export interface WorkflowOutcomeInput {
  materialized: MaterializedWorkflowGraph;
  ticketStatuses: ReadonlyMap<TicketId, TicketStatus>;
  unresolvedRequiredFailureTicketIds?: readonly TicketId[];
}

export type EvaluatedWorkflowOutcome = "active" | "blocked" | "completed" | "failed";

export function materializeWorkflowGraph(
  input: MaterializeWorkflowGraphInput,
): MaterializedWorkflowGraph {
  const limits = resolveGraphLimits(input.limits);
  enforceGraphLimits(input.graph, input.completionPolicy, limits);
  validateRuntimeIdentifier("workflow", String(input.workflowId));
  if (input.previous && input.previous.workflowId !== input.workflowId) {
    throw new WorkflowGraphError(
      "missing_reference",
      "Previous graph belongs to a different workflow",
    );
  }

  const plannedGraph = clonePlannedGraph(input.graph);
  const previousDefinitions = input.previous?.definitionsByKey ?? {};
  const currentNodes = indexAndValidateNodes(plannedGraph.nodes, previousDefinitions);
  validateDependencyGraph(plannedGraph, currentNodes);
  validateCompletionPolicy(input.completionPolicy, currentNodes);

  const previousNodes = input.previous?.graph.nodes ?? [];
  for (const previousNode of previousNodes) {
    validateRuntimeIdentifier("ticket key", String(previousNode.nodeKey));
  }
  const previousSnapshotByKey = new Map(
    previousNodes.map((item) => [String(item.nodeKey), item] as const),
  );
  for (const nodeKey of currentNodes.keys()) {
    const previousNode = previousSnapshotByKey.get(nodeKey);
    if (previousNode && !previousNode.active) {
      throw new WorkflowGraphError(
        "immutable_key",
        `Inactive ticket key ${nodeKey} cannot be reused`,
      );
    }
  }
  const previousKeyByTicketId = new Map(
    previousNodes.map((item) => [String(item.ticketId), String(item.nodeKey)] as const),
  );
  const cancellations = new Set((input.cancelTicketIds ?? []).map(String));
  validateCancellations(
    cancellations,
    previousKeyByTicketId,
    previousSnapshotByKey,
    input.ticketStatuses,
  );
  for (const cancelledTicketId of cancellations) {
    const retainedKey = previousKeyByTicketId.get(cancelledTicketId)!;
    if (currentNodes.has(retainedKey)) {
      throw new WorkflowGraphError(
        "invalid_cancellation",
        `Cannot cancel retained active node ${retainedKey}`,
      );
    }
  }

  const revisionByPredecessor = new Map<string, string>();
  for (const [nodeKey, plannedNode] of currentNodes) {
    if (!plannedNode.revisionOfKey) continue;
    const predecessorKey = String(plannedNode.revisionOfKey);
    const predecessor = previousSnapshotByKey.get(predecessorKey);
    if (!predecessor) {
      throw new WorkflowGraphError(
        "missing_reference",
        `Missing revision reference ${predecessorKey} for ${nodeKey}`,
      );
    }
    if (currentNodes.has(predecessorKey)) {
      throw new WorkflowGraphError(
        "invalid_revision",
        `Revision predecessor ${predecessorKey} cannot remain active with successor ${nodeKey}`,
      );
    }
    const previousSuccessor = previousSnapshotByKey.get(nodeKey);
    const retainsExistingRevision = Boolean(
      predecessor.supersededByTicketId
      && previousSuccessor?.ticketId === predecessor.supersededByTicketId
      && previousSuccessor.revisionOfTicketId === predecessor.ticketId,
    );
    if (
      (predecessor.supersededByTicketId && !retainsExistingRevision)
      || revisionByPredecessor.has(predecessorKey)
    ) {
      throw new WorkflowGraphError(
        "invalid_revision",
        `Ticket ${predecessorKey} already has an active successor`,
      );
    }
    revisionByPredecessor.set(predecessorKey, nodeKey);
  }

  for (const previousNode of previousNodes) {
    const nodeKey = String(previousNode.nodeKey);
    if (
      previousNode.active &&
      !currentNodes.has(nodeKey) &&
      !cancellations.has(String(previousNode.ticketId)) &&
      !revisionByPredecessor.has(nodeKey)
    ) {
      throw new WorkflowGraphError(
        "implicit_removal",
        `cancelTicketIds must explicitly include omitted active node ${nodeKey}`,
      );
    }
  }

  const ticketIdByKey = nullRecord<TicketId>(input.previous?.ticketIdByKey);
  for (const nodeKey of currentNodes.keys()) {
    ticketIdByKey[nodeKey] ??= deterministicTicketId(input.workflowId, nodeKey);
  }

  const snapshotByKey = new Map(
    previousNodes.map((item) => [
      String(item.nodeKey),
      {
        ...item,
        active: currentNodes.has(String(item.nodeKey)),
      },
    ] as const),
  );

  for (const nodeKey of currentNodes.keys()) {
    const existing = snapshotByKey.get(nodeKey);
    snapshotByKey.set(nodeKey, existing ?? {
      nodeKey: nodeKey as TicketNodeKey,
      ticketId: ticketIdByKey[nodeKey],
      active: true,
    });
  }

  for (const [predecessorKey, successorKey] of revisionByPredecessor) {
    const predecessor = snapshotByKey.get(predecessorKey)!;
    const successor = snapshotByKey.get(successorKey)!;
    snapshotByKey.set(predecessorKey, {
      ...predecessor,
      active: false,
      supersededByTicketId: successor.ticketId,
    });
    snapshotByKey.set(successorKey, {
      ...successor,
      active: true,
      revisionOfTicketId: predecessor.ticketId,
    });
  }

  for (const cancelledTicketId of cancellations) {
    const cancelledKey = previousKeyByTicketId.get(cancelledTicketId)!;
    const cancelled = snapshotByKey.get(cancelledKey)!;
    snapshotByKey.set(cancelledKey, { ...cancelled, active: false });
  }

  const topologicalKeys = topologicalOrder(plannedGraph, currentNodes);
  const position = new Map(topologicalKeys.map((nodeKey, index) => [nodeKey, index]));
  const dependencyEdges = plannedGraph.dependencyEdges
    .map((edge) => ({
      fromTicketId: ticketIdByKey[String(edge.fromKey)],
      toTicketId: ticketIdByKey[String(edge.toKey)],
      fromKey: String(edge.fromKey),
      toKey: String(edge.toKey),
    }))
    .sort((left, right) =>
      (position.get(left.fromKey)! - position.get(right.fromKey)!) ||
      (position.get(left.toKey)! - position.get(right.toKey)!) ||
      compareStrings(left.fromKey, right.fromKey) ||
      compareStrings(left.toKey, right.toKey),
    )
    .map(({ fromTicketId, toTicketId }) => ({ fromTicketId, toTicketId }));

  const definitionsByKey = cloneDefinitions(previousDefinitions);
  for (const [nodeKey, plannedNode] of currentNodes) {
    definitionsByKey[nodeKey] = clonePlannedNode(plannedNode);
  }

  return {
    workflowId: input.workflowId,
    plannedGraph: canonicalPlannedGraph(plannedGraph, topologicalKeys),
    graph: {
      schemaVersion: 2,
      nodes: [...snapshotByKey.values()].sort((left, right) =>
        compareStrings(String(left.nodeKey), String(right.nodeKey)),
      ),
      dependencyEdges,
    },
    completionPolicy: {
      requiredTerminalTicketIds: [...input.completionPolicy.requiredTerminalKeys]
        .sort((left, right) =>
          (position.get(String(left))! - position.get(String(right))!) ||
          compareStrings(String(left), String(right)),
        )
        .map((nodeKey) => ticketIdByKey[String(nodeKey)]),
      failurePolicy: input.completionPolicy.failurePolicy,
      blockedPolicy: input.completionPolicy.blockedPolicy,
    },
    ticketIdByKey,
    definitionsByKey,
  };
}

export function computeRequiredClosure(
  graph: TicketGraphSnapshot,
  completionPolicy: WorkflowCompletionPolicy,
): ReadonlySet<TicketId> {
  if (completionPolicy.requiredTerminalTicketIds.length === 0) {
    throw new WorkflowGraphError(
      "invalid_completion_policy",
      "Required terminal ticket IDs cannot be empty",
    );
  }
  const activeIds = new Set(
    graph.nodes.filter((item) => item.active).map((item) => String(item.ticketId)),
  );
  const predecessors = new Map<string, string[]>();
  for (const edge of graph.dependencyEdges) {
    if (!activeIds.has(String(edge.fromTicketId)) || !activeIds.has(String(edge.toTicketId))) {
      continue;
    }
    const list = predecessors.get(String(edge.toTicketId)) ?? [];
    list.push(String(edge.fromTicketId));
    predecessors.set(String(edge.toTicketId), list);
  }

  const closure = new Set<TicketId>();
  const queue = [...completionPolicy.requiredTerminalTicketIds];
  let queueIndex = 0;
  while (queueIndex < queue.length) {
    const ticketId = queue[queueIndex++];
    if (closure.has(ticketId)) continue;
    if (!activeIds.has(String(ticketId))) {
      throw new WorkflowGraphError(
        "missing_reference",
        `Required terminal ${ticketId} is not active in the graph`,
      );
    }
    closure.add(ticketId);
    for (const predecessor of predecessors.get(String(ticketId)) ?? []) {
      queue.push(predecessor as TicketId);
    }
  }
  return closure;
}

export function findUnresolvedRequiredFailures(input: RequiredFailureInput): TicketId[] {
  const previousClosure = computeRequiredClosure(
    input.previous.graph,
    input.previous.completionPolicy,
  );
  const nextClosure = computeRequiredClosure(input.next.graph, input.next.completionPolicy);
  const nextNodesById = new Map(
    input.next.graph.nodes.map((item) => [String(item.ticketId), item] as const),
  );

  const previousKeysById = new Map(
    input.previous.graph.nodes.map((item) => [String(item.ticketId), String(item.nodeKey)] as const),
  );
  return [...previousClosure].filter((failedTicketId) => {
    const status = input.ticketStatuses.get(failedTicketId);
    if (!status) {
      throw new WorkflowGraphError(
        "missing_status",
        `Missing status for required historical ticket ${previousKeysById.get(String(failedTicketId)) ?? failedTicketId}`,
      );
    }
    if (status !== "failed") return false;
    if (nextClosure.has(failedTicketId)) return true;

    const visited = new Set<string>();
    let current = nextNodesById.get(String(failedTicketId));
    while (current?.supersededByTicketId) {
      if (visited.has(String(current.ticketId))) return true;
      visited.add(String(current.ticketId));
      current = nextNodesById.get(String(current.supersededByTicketId));
    }
    return !current?.active || !nextClosure.has(current.ticketId);
  });
}

export function evaluateWorkflowOutcome(input: WorkflowOutcomeInput): EvaluatedWorkflowOutcome {
  const requiredClosure = computeRequiredClosure(
    input.materialized.graph,
    input.materialized.completionPolicy,
  );
  const unresolvedFailures = new Set(
    (input.unresolvedRequiredFailureTicketIds ?? []).map(String),
  );
  for (const ticketId of requiredClosure) {
    if (readStatus(input.ticketStatuses, ticketId) === "failed") {
      unresolvedFailures.add(String(ticketId));
    }
  }

  if (unresolvedFailures.size > 0) {
    return input.materialized.completionPolicy.failurePolicy === "fail_fast"
      ? "failed"
      : "blocked";
  }

  const activeNodes = input.materialized.graph.nodes.filter((item) => item.active);
  const activeStatuses = activeNodes.map((item) => readStatus(input.ticketStatuses, item.ticketId));
  if (activeStatuses.includes("blocked")) return "blocked";

  const allTerminalsComplete = input.materialized.completionPolicy.requiredTerminalTicketIds.every(
    (ticketId) => readStatus(input.ticketStatuses, ticketId) === "completed",
  );
  const hasOutstandingWork = activeStatuses.some((status) =>
    status === "pending" || status === "ready" || status === "running" || status === "blocked",
  );
  return allTerminalsComplete && !hasOutstandingWork ? "completed" : "active";
}

function indexAndValidateNodes(
  nodes: readonly PlannedTicketNode[],
  previousDefinitions: Readonly<Record<string, PlannedTicketNode>>,
): Map<string, PlannedTicketNode> {
  const result = new Map<string, PlannedTicketNode>();
  for (const plannedNode of nodes) {
    const nodeKey = String(plannedNode.key);
    validateRuntimeIdentifier("ticket key", nodeKey);
    if (result.has(nodeKey)) {
      throw new WorkflowGraphError("duplicate_key", `Duplicate ticket key ${nodeKey}`);
    }
    const previous = Object.hasOwn(previousDefinitions, nodeKey)
      ? previousDefinitions[nodeKey]
      : undefined;
    if (previous && stableNodeDefinition(previous) !== stableNodeDefinition(plannedNode)) {
      throw new WorkflowGraphError(
        "immutable_key",
        `Immutable ticket key ${nodeKey} cannot be reused with a different definition`,
      );
    }
    result.set(nodeKey, plannedNode);
  }

  const knownKeys = new Set([...Object.keys(previousDefinitions), ...result.keys()]);
  for (const [nodeKey, plannedNode] of result) {
    if (plannedNode.parentKey) {
      validateRuntimeIdentifier("ticket key", String(plannedNode.parentKey));
    }
    if (plannedNode.parentKey && !knownKeys.has(String(plannedNode.parentKey))) {
      throw new WorkflowGraphError(
        "missing_reference",
        `Missing parent reference ${plannedNode.parentKey} for ${nodeKey}`,
      );
    }
    if (plannedNode.revisionOfKey) {
      validateRuntimeIdentifier("ticket key", String(plannedNode.revisionOfKey));
    }
    if (plannedNode.revisionOfKey && !knownKeys.has(String(plannedNode.revisionOfKey))) {
      throw new WorkflowGraphError(
        "missing_reference",
        `Missing revision reference ${plannedNode.revisionOfKey} for ${nodeKey}`,
      );
    }
  }
  validateParentGraph(result, previousDefinitions);
  return result;
}

function validateDependencyGraph(
  graph: PlannedTicketGraph,
  nodes: ReadonlyMap<string, PlannedTicketNode>,
): void {
  const seenEdges = new Set<string>();
  for (const edge of graph.dependencyEdges) {
    const fromKey = String(edge.fromKey);
    const toKey = String(edge.toKey);
    validateRuntimeIdentifier("ticket key", fromKey);
    validateRuntimeIdentifier("ticket key", toKey);
    if (!nodes.has(fromKey) || !nodes.has(toKey)) {
      throw new WorkflowGraphError(
        "missing_reference",
        `Missing dependency reference ${fromKey} -> ${toKey}`,
      );
    }
    const edgeKey = `${fromKey}\u0000${toKey}`;
    if (seenEdges.has(edgeKey)) {
      throw new WorkflowGraphError("duplicate_key", `Duplicate dependency ${fromKey} -> ${toKey}`);
    }
    seenEdges.add(edgeKey);
  }
  topologicalOrder(graph, nodes);
}

function resolveGraphLimits(overrides: Partial<GraphLimits> | undefined): GraphLimits {
  const limits: GraphLimits = {
    maxNodes: overrides?.maxNodes ?? DEFAULT_GRAPH_LIMITS.maxNodes,
    maxEdges: overrides?.maxEdges ?? DEFAULT_GRAPH_LIMITS.maxEdges,
    ...(overrides?.maxSerializedBytes === undefined
      ? {}
      : { maxSerializedBytes: overrides.maxSerializedBytes }),
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new WorkflowGraphError(
        "graph_limit",
        `Graph limit ${name} must be a positive safe integer`,
      );
    }
  }
  return limits;
}

function enforceGraphLimits(
  graph: PlannedTicketGraph,
  completionPolicy: PlannedWorkflowCompletionPolicy,
  limits: GraphLimits,
): void {
  if (graph.nodes.length > limits.maxNodes) {
    throw new WorkflowGraphError(
      "graph_limit",
      `Graph maxNodes limit ${limits.maxNodes} exceeded by ${graph.nodes.length}`,
    );
  }
  if (graph.dependencyEdges.length > limits.maxEdges) {
    throw new WorkflowGraphError(
      "graph_limit",
      `Graph maxEdges limit ${limits.maxEdges} exceeded by ${graph.dependencyEdges.length}`,
    );
  }
  if (limits.maxSerializedBytes !== undefined) {
    let serialized: string;
    try {
      serialized = JSON.stringify({ graph, completionPolicy });
    } catch (error) {
      throw new WorkflowGraphError(
        "graph_limit",
        `Graph serialized size cannot be measured: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const bytes = Buffer.byteLength(serialized, "utf8");
    if (bytes > limits.maxSerializedBytes) {
      throw new WorkflowGraphError(
        "graph_limit",
        `Graph maxSerializedBytes limit ${limits.maxSerializedBytes} exceeded by ${bytes}`,
      );
    }
  }
}

function validateParentGraph(
  currentNodes: ReadonlyMap<string, PlannedTicketNode>,
  previousDefinitions: Readonly<Record<string, PlannedTicketNode>>,
): void {
  const allNodes = new Map<string, PlannedTicketNode>();
  for (const [nodeKey, plannedNode] of Object.entries(previousDefinitions)) {
    validateRuntimeIdentifier("ticket key", nodeKey);
    if (String(plannedNode.key) !== nodeKey) {
      throw new WorkflowGraphError(
        "immutable_key",
        `Stored ticket key ${nodeKey} does not match its definition`,
      );
    }
    allNodes.set(nodeKey, plannedNode);
  }
  for (const [nodeKey, plannedNode] of currentNodes) allNodes.set(nodeKey, plannedNode);

  for (const [nodeKey, plannedNode] of allNodes) {
    if (plannedNode.parentKey && !allNodes.has(String(plannedNode.parentKey))) {
      throw new WorkflowGraphError(
        "missing_reference",
        `Missing parent reference ${plannedNode.parentKey} for ${nodeKey}`,
      );
    }
  }

  const completed = new Set<string>();
  for (const startKey of allNodes.keys()) {
    if (completed.has(startKey)) continue;
    const path: string[] = [];
    const pathPositions = new Map<string, number>();
    let currentKey: string | undefined = startKey;
    while (currentKey && !completed.has(currentKey)) {
      if (pathPositions.has(currentKey)) {
        const cycleStart = pathPositions.get(currentKey)!;
        const cycle = [...path.slice(cycleStart), currentKey].join(" -> ");
        throw new WorkflowGraphError("cycle", `Parent graph contains a cycle: ${cycle}`);
      }
      pathPositions.set(currentKey, path.length);
      path.push(currentKey);
      const parentKey: string | undefined = allNodes.get(currentKey)?.parentKey
        ? String(allNodes.get(currentKey)!.parentKey)
        : undefined;
      currentKey = parentKey;
    }
    for (const nodeKey of path) completed.add(nodeKey);
  }
}

function validateCompletionPolicy(
  policy: PlannedWorkflowCompletionPolicy,
  nodes: ReadonlyMap<string, PlannedTicketNode>,
): void {
  if (policy.requiredTerminalKeys.length === 0) {
    throw new WorkflowGraphError(
      "invalid_completion_policy",
      "Required terminal keys cannot be empty",
    );
  }
  const seen = new Set<string>();
  for (const terminalKey of policy.requiredTerminalKeys) {
    const value = String(terminalKey);
    validateRuntimeIdentifier("ticket key", value);
    if (!nodes.has(value)) {
      throw new WorkflowGraphError(
        "missing_reference",
        `Missing required terminal reference ${value}`,
      );
    }
    if (seen.has(value)) {
      throw new WorkflowGraphError("duplicate_key", `Duplicate required terminal ${value}`);
    }
    seen.add(value);
  }
}

function validateCancellations(
  cancellations: ReadonlySet<string>,
  previousKeyByTicketId: ReadonlyMap<string, string>,
  previousSnapshotByKey: ReadonlyMap<string, TicketGraphSnapshot["nodes"][number]>,
  ticketStatuses: TicketStatusLookup | undefined,
): void {
  for (const ticketId of cancellations) {
    const nodeKey = previousKeyByTicketId.get(ticketId);
    if (!nodeKey) {
      throw new WorkflowGraphError(
        "invalid_cancellation",
        `cancelTicketIds contains unknown ticket ${ticketId}`,
      );
    }
    if (!previousSnapshotByKey.get(nodeKey)?.active) {
      throw new WorkflowGraphError(
        "invalid_cancellation",
        `cancelTicketIds contains inactive ticket ${ticketId}`,
      );
    }
    const brandedTicketId = ticketId as TicketId;
    const status = lookupTicketStatus(ticketStatuses, brandedTicketId);
    if (!status) {
      throw new WorkflowGraphError(
        "missing_status",
        `Status is required to cancel ticket ${nodeKey}`,
      );
    }
    if (isTerminalStatus(status)) {
      throw new WorkflowGraphError(
        "invalid_cancellation",
        `Terminal ticket ${nodeKey} with status ${status} cannot be cancelled`,
      );
    }
  }
}

function topologicalOrder(
  graph: PlannedTicketGraph,
  nodes: ReadonlyMap<string, PlannedTicketNode>,
): string[] {
  const incoming = new Map([...nodes.keys()].map((nodeKey) => [nodeKey, 0]));
  const outgoing = new Map<string, string[]>();
  for (const edge of graph.dependencyEdges) {
    const fromKey = String(edge.fromKey);
    const toKey = String(edge.toKey);
    incoming.set(toKey, (incoming.get(toKey) ?? 0) + 1);
    const targets = outgoing.get(fromKey) ?? [];
    targets.push(toKey);
    outgoing.set(fromKey, targets);
  }

  const ready = new MinStringHeap();
  for (const [nodeKey, count] of incoming) {
    if (count === 0) ready.push(nodeKey);
  }
  const ordered: string[] = [];
  while (ready.size > 0) {
    const nodeKey = ready.pop()!;
    ordered.push(nodeKey);
    for (const target of outgoing.get(nodeKey) ?? []) {
      const remaining = incoming.get(target)! - 1;
      incoming.set(target, remaining);
      if (remaining === 0) {
        ready.push(target);
      }
    }
  }
  if (ordered.length !== nodes.size) {
    throw new WorkflowGraphError("cycle", "Dependency graph contains a cycle");
  }
  return ordered;
}

function deterministicTicketId(workflowId: WorkflowId, nodeKey: string): TicketId {
  const digest = createHash("sha256")
    .update(JSON.stringify(["autoagent-ticket-v2", String(workflowId), nodeKey]))
    .digest("hex")
    .slice(0, 24);
  return `tk_${digest}` as TicketId;
}

function canonicalPlannedGraph(
  graph: PlannedTicketGraph,
  topologicalKeys: readonly string[],
): PlannedTicketGraph {
  const nodesByKey = new Map(graph.nodes.map((item) => [String(item.key), item] as const));
  const position = new Map(topologicalKeys.map((nodeKey, index) => [nodeKey, index]));
  return {
    schemaVersion: 2,
    nodes: topologicalKeys.map((nodeKey) => clonePlannedNode(nodesByKey.get(nodeKey)!)),
    dependencyEdges: graph.dependencyEdges
      .map((edge) => ({ ...edge }))
      .sort((left, right) =>
        (position.get(String(left.fromKey))! - position.get(String(right.fromKey))!) ||
        (position.get(String(left.toKey))! - position.get(String(right.toKey))!) ||
        compareStrings(String(left.fromKey), String(right.fromKey)) ||
        compareStrings(String(left.toKey), String(right.toKey)),
      ),
  };
}

function stableNodeDefinition(node: PlannedTicketNode): string {
  return JSON.stringify({
    key: node.key,
    parentKey: node.parentKey ?? null,
    revisionOfKey: node.revisionOfKey ?? null,
    title: node.title,
    objective: node.objective,
    successCriteria: [...node.successCriteria],
    assignment: {
      principalId: node.assignment.principalId ?? null,
      requiredCapabilities: [...(node.assignment.requiredCapabilities ?? [])].sort(),
    },
    outputContract: { schemaRef: node.outputContract.schemaRef },
  });
}

function clonePlannedGraph(graph: PlannedTicketGraph): PlannedTicketGraph {
  return {
    schemaVersion: 2,
    nodes: graph.nodes.map(clonePlannedNode),
    dependencyEdges: graph.dependencyEdges.map((edge) => ({ ...edge })),
  };
}

function clonePlannedNode(node: PlannedTicketNode): PlannedTicketNode {
  return {
    key: node.key,
    ...(node.parentKey ? { parentKey: node.parentKey } : {}),
    ...(node.revisionOfKey ? { revisionOfKey: node.revisionOfKey } : {}),
    title: node.title,
    objective: node.objective,
    successCriteria: [...node.successCriteria],
    assignment: {
      ...(node.assignment.principalId ? { principalId: node.assignment.principalId } : {}),
      ...(node.assignment.requiredCapabilities
        ? { requiredCapabilities: [...node.assignment.requiredCapabilities] }
        : {}),
    },
    outputContract: { schemaRef: node.outputContract.schemaRef },
  };
}

function cloneDefinitions(
  definitions: Readonly<Record<string, PlannedTicketNode>>,
): Record<string, PlannedTicketNode> {
  const result = Object.create(null) as Record<string, PlannedTicketNode>;
  for (const [nodeKey, node] of Object.entries(definitions)) {
    validateRuntimeIdentifier("ticket key", nodeKey);
    result[nodeKey] = clonePlannedNode(node);
  }
  return result;
}

function readStatus(
  statuses: ReadonlyMap<TicketId, TicketStatus>,
  ticketId: TicketId,
): TicketStatus {
  const status = statuses.get(ticketId);
  if (!status) {
    throw new WorkflowGraphError("missing_status", `Missing status for active ticket ${ticketId}`);
  }
  return status;
}

function validateRuntimeIdentifier(kind: "workflow" | "ticket key", value: string): void {
  const reserved = new Set(["__proto__", "prototype", "constructor"]);
  if (
    value.length === 0
    || value.length > 128
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
    || reserved.has(value.toLowerCase())
  ) {
    throw new WorkflowGraphError(
      "invalid_identifier",
      `Invalid ${kind} identifier`,
    );
  }
}

function lookupTicketStatus(
  lookup: TicketStatusLookup | undefined,
  ticketId: TicketId,
): TicketStatus | undefined {
  if (!lookup) return undefined;
  return typeof lookup === "function" ? lookup(ticketId) : lookup.get(ticketId);
}

function isTerminalStatus(status: TicketStatus): boolean {
  return status === "completed"
    || status === "returned"
    || status === "failed"
    || status === "cancelled";
}

function nullRecord<T>(source?: Readonly<Record<string, T>>): Record<string, T> {
  const result = Object.create(null) as Record<string, T>;
  for (const [key, value] of Object.entries(source ?? {})) {
    validateRuntimeIdentifier("ticket key", key);
    result[key] = value;
  }
  return result;
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

class MinStringHeap {
  private readonly values: string[] = [];

  get size(): number {
    return this.values.length;
  }

  push(value: string): void {
    this.values.push(value);
    let index = this.values.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (compareStrings(this.values[parent], this.values[index]) <= 0) break;
      [this.values[parent], this.values[index]] = [this.values[index], this.values[parent]];
      index = parent;
    }
  }

  pop(): string | undefined {
    if (this.values.length === 0) return undefined;
    const first = this.values[0];
    const last = this.values.pop()!;
    if (this.values.length === 0) return first;
    this.values[0] = last;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (
        left < this.values.length
        && compareStrings(this.values[left], this.values[smallest]) < 0
      ) smallest = left;
      if (
        right < this.values.length
        && compareStrings(this.values[right], this.values[smallest]) < 0
      ) smallest = right;
      if (smallest === index) break;
      [this.values[index], this.values[smallest]] = [this.values[smallest], this.values[index]];
      index = smallest;
    }
    return first;
  }
}
