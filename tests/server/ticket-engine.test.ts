import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type {
  PlannedTicketGraph,
  PlannedWorkflowCompletionPolicy,
  TicketNodeKey,
  WorkflowCommandEnvelope,
  WorkflowId,
  WorkflowPolicyRef,
} from "../../src/shared/contracts/ticket-engine.js";
import { TicketEngine } from "../../src/server/tickets/ticket-engine.js";
import { TicketStore } from "../../src/server/tickets/ticket-store.js";
import {
  createWorkflowPolicy,
  WorkflowPolicyStore,
} from "../../src/server/tickets/workflow-policy-store.js";

describe("TicketEngine workflow commands", () => {
  it("creates a materialized workflow and emits ready facts atomically", async () => {
    const fixture = await createFixture();
    const result = await fixture.engine.createWorkflow(createCommand(fixture.workflowId, fixture.policyRef));

    expect(result).toMatchObject({ accepted: true, workflowStatus: "active", workflowVersion: 1 });
    const aggregate = await fixture.store.read(fixture.workflowId);
    expect(aggregate?.planning?.plannedGraph.nodes.map((node) => node.key)).toEqual(["dev", "qa"]);
    expect(aggregate?.tickets.map((ticket) => ticket.status)).toEqual(["ready", "pending"]);
    expect(aggregate?.outbox.map((entry) => entry.event.payload.type)).toEqual([
      "TicketReady",
      "WorkflowStatusChanged",
    ]);
    expect(aggregate?.commandInputs).toHaveLength(1);
  });

  it("rejects invalid definitions without creating a partial workflow", async () => {
    const fixture = await createFixture();
    const command = createCommand(fixture.workflowId, fixture.policyRef);
    if (command.payload.type !== "create_graph") throw new Error("invalid test command");
    command.payload.definition.completionPolicy.requiredTerminalKeys = [];

    await expect(fixture.engine.createWorkflow(command)).resolves.toMatchObject({
      accepted: false,
      code: "invalid_definition",
    });
    await expect(fixture.store.read(fixture.workflowId)).resolves.toBeUndefined();
  });

  it("enforces capability policy without role-name branches", async () => {
    const fixture = await createFixture();
    const command = createCommand(fixture.workflowId, fixture.policyRef, "untrusted-principal");

    await expect(fixture.engine.createWorkflow(command)).resolves.toMatchObject({
      accepted: false,
      code: "policy_violation",
    });
  });

  it("pauses and resumes with workflow CAS while preserving the deferred outcome", async () => {
    const fixture = await createStartedFixture();
    const paused = await fixture.engine.applyWorkflow(workflowCommand(
      fixture.workflowId,
      "pause-command",
      { type: "pause", expectedWorkflowVersion: 1 },
    ));
    const resumed = await fixture.engine.applyWorkflow(workflowCommand(
      fixture.workflowId,
      "resume-command",
      { type: "resume", expectedWorkflowVersion: 2 },
    ));

    expect(paused).toMatchObject({ accepted: true, workflowStatus: "paused", workflowVersion: 2 });
    expect(resumed).toMatchObject({ accepted: true, workflowStatus: "active", workflowVersion: 3 });
    expect((await fixture.store.read(fixture.workflowId))?.workflow.deferredOutcome).toBeUndefined();
  });

  it("persists stale-version rejection without changing workflow version", async () => {
    const fixture = await createStartedFixture();
    const result = await fixture.engine.applyWorkflow(workflowCommand(
      fixture.workflowId,
      "stale-command",
      { type: "pause", expectedWorkflowVersion: 99 },
    ));

    expect(result).toMatchObject({ accepted: false, code: "version_conflict", currentWorkflowVersion: 1 });
    const aggregate = await fixture.store.read(fixture.workflowId);
    expect(aggregate?.workflow.version).toBe(1);
    expect(aggregate?.aggregateVersion).toBe(2);
    expect(await fixture.store.getCommandResult(fixture.workflowId, "stale-command")).toEqual(result);
  });

  it("returns the first result for identical replay and rejects different content with the same commandId", async () => {
    const fixture = await createStartedFixture();
    const pause = workflowCommand(
      fixture.workflowId,
      "stable-command",
      { type: "pause", expectedWorkflowVersion: 1 },
    );
    const first = await fixture.engine.applyWorkflow(pause);
    const replay = await fixture.engine.applyWorkflow(structuredClone(pause));
    const conflict = await fixture.engine.applyWorkflow(workflowCommand(
      fixture.workflowId,
      "stable-command",
      { type: "resume", expectedWorkflowVersion: 2 },
    ));

    expect(replay).toEqual(first);
    expect(conflict).toMatchObject({ accepted: false, code: "idempotency_conflict" });
    expect((await fixture.store.read(fixture.workflowId))?.workflow.version).toBe(2);
  });

  it("cancels every nonterminal ticket and emits terminal and authority facts", async () => {
    const fixture = await createStartedFixture();
    const result = await fixture.engine.applyWorkflow(workflowCommand(
      fixture.workflowId,
      "cancel-command",
      { type: "cancel", expectedWorkflowVersion: 1, reason: "operator cancelled" },
    ));

    expect(result).toMatchObject({ accepted: true, workflowStatus: "cancelled", workflowVersion: 2 });
    const aggregate = await fixture.store.read(fixture.workflowId);
    expect(aggregate?.tickets.every((ticket) => ticket.status === "cancelled")).toBe(true);
    expect(aggregate?.outbox.filter((entry) => entry.event.payload.type === "TicketTerminal")).toHaveLength(2);
    expect(aggregate?.outbox.at(-1)?.event.payload).toEqual({
      type: "WorkflowStatusChanged",
      status: "cancelled",
    });
  });

  it("amends an active graph, materializes new IDs, and emits ready facts for new roots", async () => {
    const fixture = await createStartedFixture();
    const graph = plannedGraph();
    graph.nodes.push(node("docs"));
    const completionPolicy: PlannedWorkflowCompletionPolicy = {
      requiredTerminalKeys: ["qa" as TicketNodeKey, "docs" as TicketNodeKey],
      failurePolicy: "require_resolution",
      blockedPolicy: "wait",
    };
    const result = await fixture.engine.applyWorkflow(workflowCommand(
      fixture.workflowId,
      "amend-command",
      {
        type: "amend",
        expectedWorkflowVersion: 1,
        graph,
        completionPolicy,
        cancelTicketIds: [],
      },
    ));

    expect(result).toMatchObject({ accepted: true, workflowVersion: 2 });
    const aggregate = await fixture.store.read(fixture.workflowId);
    expect(aggregate?.tickets).toHaveLength(3);
    expect(aggregate?.tickets.find((ticket) => (
      aggregate.planning?.ticketIdByKey.docs === ticket.ticketId
    ))?.status).toBe("ready");
    expect(aggregate?.outbox.filter((entry) => entry.event.payload.type === "TicketReady")).toHaveLength(2);
  });
});

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-ticket-engine-"));
  const workflowId = "workflow-1" as WorkflowId;
  const store = new TicketStore(root, "task-1", "run-1");
  const policyStore = new WorkflowPolicyStore(root);
  const policy = createWorkflowPolicy({
    policyId: "test-policy",
    policyVersion: 1,
    grants: [{
      principalId: "planner-1",
      capabilities: ["ticket_graph:create", "ticket_graph:amend", "workflow:control"],
    }],
  });
  const policyRef = (await policyStore.seedPolicy(policy)).ref;
  return {
    workflowId,
    policyRef,
    store,
    engine: new TicketEngine(store, policyStore),
  };
}

async function createStartedFixture() {
  const fixture = await createFixture();
  const result = await fixture.engine.createWorkflow(createCommand(fixture.workflowId, fixture.policyRef));
  if (!result.accepted) throw new Error(result.reason);
  return fixture;
}

function createCommand(
  workflowId: WorkflowId,
  policyRef: WorkflowPolicyRef,
  actorPrincipalId = "planner-1",
): WorkflowCommandEnvelope {
  return {
    commandId: "create-command",
    workflowId,
    actorPrincipalId,
    issuedAt: "2026-07-10T00:00:00.000Z",
    payload: {
      type: "create_graph",
      definition: {
        definitionId: "definition-1",
        definitionVersion: 1,
        initialGraph: plannedGraph(),
        completionPolicy: completionPolicy(),
        policyRef,
      },
    },
  };
}

function workflowCommand(
  workflowId: WorkflowId,
  commandId: string,
  payload: WorkflowCommandEnvelope["payload"],
): WorkflowCommandEnvelope {
  return {
    commandId,
    workflowId,
    actorPrincipalId: "planner-1",
    issuedAt: "2026-07-10T00:00:00.000Z",
    payload,
  };
}

function plannedGraph(): PlannedTicketGraph {
  return {
    schemaVersion: 2,
    nodes: [node("dev"), node("qa")],
    dependencyEdges: [{ fromKey: "dev" as TicketNodeKey, toKey: "qa" as TicketNodeKey }],
  };
}

function node(key: string) {
  return {
    key: key as TicketNodeKey,
    title: key,
    objective: `complete ${key}`,
    successCriteria: [`${key} done`],
    assignment: { requiredCapabilities: [`work:${key}`] },
    outputContract: { schemaRef: `schema:${key}` },
  };
}

function completionPolicy(): PlannedWorkflowCompletionPolicy {
  return {
    requiredTerminalKeys: ["qa" as TicketNodeKey],
    failurePolicy: "require_resolution",
    blockedPolicy: "wait",
  };
}
