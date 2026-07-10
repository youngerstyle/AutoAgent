import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type {
  PlannedTicketGraph,
  PlannedWorkflowCompletionPolicy,
  TicketNodeKey,
  TicketCommandEnvelope,
  TicketCommandPayload,
  WorkflowCommandEnvelope,
  WorkflowId,
  WorkflowPolicyRef,
} from "../../src/shared/contracts/ticket-engine.js";
import {
  TicketEngine,
  TicketEngineOperationError,
} from "../../src/server/tickets/ticket-engine.js";
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

  it("exposes the immutable work definition required to start an Agent Goal", async () => {
    const fixture = await createFixture();
    await fixture.engine.createWorkflow(createCommand(fixture.workflowId, fixture.policyRef));
    const ticketId = (await fixture.store.read(fixture.workflowId))!.tickets[0]!.ticketId;

    await expect(fixture.engine.getWorkItem(ticketId)).resolves.toMatchObject({
      ticket: { ticketId, status: "ready" },
      definition: {
        key: "dev",
        title: "dev",
        objective: "complete dev",
        successCriteria: ["dev done"],
        outputContract: { schemaRef: "schema:dev" },
      },
    });
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

  it("claims a ready ticket once and recovers the receipt by request id", async () => {
    const fixture = await createStartedFixture();
    const ticket = (await fixture.store.read(fixture.workflowId))!.tickets[0]!;
    const request = {
      requestId: "claim-request",
      workflowId: fixture.workflowId,
      ticketId: ticket.ticketId,
      expectedTicketVersion: ticket.version,
      principalId: "planner-1",
      leaseDurationMs: 60_000,
    };

    const claimed = await fixture.engine.claimReady(request);
    const replay = await fixture.engine.claimReady(structuredClone(request));

    expect(claimed).toMatchObject({ ticketVersion: 2, fencingToken: 1 });
    expect(replay).toEqual(claimed);
    expect(await fixture.engine.getClaimByRequestId("claim-request")).toEqual(claimed);
    expect((await fixture.store.read(fixture.workflowId))?.tickets[0]).toMatchObject({
      status: "running",
      activeAuthority: { kind: "claim", claimId: claimed?.claimId },
    });
    await expect(fixture.engine.claimReady({ ...request, leaseDurationMs: 30_000 })).rejects.toMatchObject({
      code: "idempotency_conflict",
    });
  });

  it("denies unauthorized claims and never creates two active claims for one ticket", async () => {
    const fixture = await createStartedFixture();
    const ticket = (await fixture.store.read(fixture.workflowId))!.tickets[0]!;
    await expect(fixture.engine.claimReady({
      requestId: "unauthorized-claim",
      workflowId: fixture.workflowId,
      ticketId: ticket.ticketId,
      expectedTicketVersion: ticket.version,
      principalId: "unknown-principal",
      leaseDurationMs: 60_000,
    })).rejects.toMatchObject({ code: "policy_violation" });
    const claim = await fixture.engine.claimReady({
      requestId: "first-active-claim",
      workflowId: fixture.workflowId,
      ticketId: ticket.ticketId,
      expectedTicketVersion: ticket.version,
      principalId: "planner-1",
      leaseDurationMs: 60_000,
    });
    await expect(fixture.engine.claimReady({
      requestId: "second-active-claim",
      workflowId: fixture.workflowId,
      ticketId: ticket.ticketId,
      expectedTicketVersion: ticket.version,
      principalId: "planner-1",
      leaseDurationMs: 60_000,
    })).resolves.toBeUndefined();
    expect((await fixture.store.read(fixture.workflowId))?.claims).toHaveLength(1);
  });

  it("renews and releases a claim while rejecting the stale fencing token", async () => {
    const fixture = await createStartedFixture();
    const ticket = (await fixture.store.read(fixture.workflowId))!.tickets[0]!;
    const claim = await fixture.engine.claimReady({
      requestId: "claim-for-release",
      workflowId: fixture.workflowId,
      ticketId: ticket.ticketId,
      expectedTicketVersion: ticket.version,
      principalId: "planner-1",
      leaseDurationMs: 10_000,
    });
    const renewed = await fixture.engine.renewClaim({
      requestId: "renew-request",
      claimId: claim!.claimId,
      fencingToken: claim!.fencingToken,
      extendByMs: 5_000,
    });
    const released = await fixture.engine.releaseClaim({
      requestId: "release-request",
      claimId: claim!.claimId,
      fencingToken: claim!.fencingToken,
      reason: "operator_release",
    });

    expect(renewed.ticketVersion).toBe(3);
    expect(released).toMatchObject({ status: "ready", version: 4, activeAuthority: undefined });
    await expect(fixture.engine.renewClaim({
      requestId: "late-renew",
      claimId: claim!.claimId,
      fencingToken: claim!.fencingToken,
      extendByMs: 5_000,
    })).rejects.toBeInstanceOf(TicketEngineOperationError);
    await expect(fixture.engine.releaseClaim({
      requestId: "release-request",
      claimId: claim!.claimId,
      fencingToken: claim!.fencingToken,
      reason: "operator_release",
    })).resolves.toEqual(released);
  });

  it("expires leases idempotently and makes the ticket ready again", async () => {
    let now = new Date("2026-07-10T00:00:00.000Z");
    const fixture = await createStartedFixture(() => now);
    const ticket = (await fixture.store.read(fixture.workflowId))!.tickets[0]!;
    const claim = await fixture.engine.claimReady({
      requestId: "expiring-claim",
      workflowId: fixture.workflowId,
      ticketId: ticket.ticketId,
      expectedTicketVersion: ticket.version,
      principalId: "planner-1",
      leaseDurationMs: 1_000,
    });
    now = new Date("2026-07-10T00:00:02.000Z");

    await expect(fixture.engine.applyTicket({
      ...ticketCommand(
        fixture.workflowId,
        "expired-complete",
        "proposal-expired",
        claim!,
        { type: "complete", result: {}, evidence: [] },
      ),
      issuedAt: "2026-07-10T00:00:00.500Z",
    })).resolves.toMatchObject({ accepted: false, code: "stale_authority" });

    const first = await fixture.engine.scanExpiredClaims();
    const second = await fixture.engine.scanExpiredClaims();

    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ status: "ready", version: 3 });
    expect(second).toEqual([]);
    const events = await fixture.store.readEvents({ workflowId: fixture.workflowId, limit: 50 });
    expect(events.events.some((event) => event.payload.type === "ClaimExpired")).toBe(true);
  });

  it("transfers blocked ownership with a monotonically increasing fencing token", async () => {
    const fixture = await createStartedFixture();
    const aggregate = (await fixture.store.read(fixture.workflowId))!;
    const ticket = aggregate.tickets[0]!;
    const ownership = {
      ownershipId: "ownership-1",
      workflowId: fixture.workflowId,
      ticketId: ticket.ticketId,
      ticketVersion: 2,
      principalId: "planner-1",
      fencingToken: 1,
    };
    await fixture.store.transact(
      fixture.workflowId,
      { aggregateVersion: aggregate.aggregateVersion, workflowVersion: aggregate.workflow.version },
      (current) => ({
        ...current,
        workflow: { ...current.workflow, version: current.workflow.version + 1, status: "blocked" },
        tickets: current.tickets.map((item) => item.ticketId === ticket.ticketId ? {
          ...item,
          version: 2,
          status: "blocked" as const,
          activeAuthority: { kind: "blocked_owner" as const, ownershipId: ownership.ownershipId, fencingToken: 1 },
        } : item),
        blockedOwnerships: [...current.blockedOwnerships, ownership],
      }),
    );

    const transferred = await fixture.engine.transferBlockedOwnership({
      requestId: "transfer-request",
      ownershipId: ownership.ownershipId,
      fencingToken: ownership.fencingToken,
      toPrincipalId: "developer-1",
    });

    expect(transferred).toMatchObject({ principalId: "developer-1", fencingToken: 2, ticketVersion: 3 });
    await expect(fixture.engine.transferBlockedOwnership({
      requestId: "late-transfer",
      ownershipId: ownership.ownershipId,
      fencingToken: ownership.fencingToken,
      toPrincipalId: "developer-2",
    })).rejects.toMatchObject({ code: "stale_authority" });
  });

  it("completes a ticket and unlocks its dependency in the same durable write", async () => {
    const fixture = await createStartedFixture();
    const claim = await claimFirstReady(fixture, "claim-dev");
    const result = await fixture.engine.applyTicket(ticketCommand(
      fixture.workflowId,
      "complete-dev",
      "proposal-dev",
      claim,
      { type: "complete", result: { summary: "done" }, evidence: [] },
    ));

    expect(result).toMatchObject({ accepted: true, ticketStatus: "completed", ticketVersion: 3 });
    const aggregate = await fixture.store.read(fixture.workflowId);
    expect(aggregate?.tickets.map((ticket) => ticket.status)).toEqual(["completed", "ready"]);
    expect(aggregate?.outbox.slice(-3).map((entry) => entry.event.payload.type)).toEqual([
      "AuthorityRevoked",
      "TicketTerminal",
      "TicketReady",
    ]);
    const restarted = new TicketEngine(
      new TicketStore(fixture.root, "task-1", "run-1"),
      fixture.policyStore,
    );
    await expect(restarted.applyTicket(ticketCommand(
      fixture.workflowId,
      "complete-dev",
      "proposal-dev",
      claim,
      { type: "complete", result: { summary: "done" }, evidence: [] },
    ))).resolves.toEqual(result);
  });

  it("converts a running claim into blocked ownership and rejects the old claim", async () => {
    const fixture = await createStartedFixture();
    const claim = await claimFirstReady(fixture, "claim-blocked");
    const blocked = await fixture.engine.applyTicket(ticketCommand(
      fixture.workflowId,
      "block-dev",
      "proposal-block",
      claim,
      { type: "block", reason: "needs input", requiredInput: "decision" },
    ));
    expect(blocked).toMatchObject({
      accepted: true,
      ticketStatus: "blocked",
      nextAuthority: { kind: "blocked_owner", fencingToken: 2 },
    });
    await expect(fixture.engine.applyTicket(ticketCommand(
      fixture.workflowId,
      "late-complete",
      "proposal-late",
      { ...claim, ticketVersion: 3 },
      { type: "complete", result: {}, evidence: [] },
    ))).resolves.toMatchObject({ accepted: false, code: "stale_authority" });
    const owner = (blocked as Extract<typeof blocked, { accepted: true }>).nextAuthority!;
    const completed = await fixture.engine.applyTicket({
      commandId: "owner-complete",
      proposalId: "proposal-owner",
      workflowId: fixture.workflowId,
      ticketId: claim.ticketId,
      expectedTicketVersion: 3,
      actorPrincipalId: "planner-1",
      executionRef: "goal-owner",
      authority: owner,
      issuedAt: "2026-07-10T00:00:01.000Z",
      payload: { type: "complete", result: {}, evidence: [] },
    });
    expect(completed).toMatchObject({ accepted: true, ticketStatus: "completed" });
  });

  it("applies require-resolution failure policy without inventing a route", async () => {
    const fixture = await createStartedFixture();
    const claim = await claimFirstReady(fixture, "claim-fail");
    const result = await fixture.engine.applyTicket(ticketCommand(
      fixture.workflowId,
      "fail-dev",
      "proposal-fail",
      claim,
      { type: "fail", reason: "cannot build", evidence: [] },
    ));
    expect(result).toMatchObject({
      accepted: true,
      ticketStatus: "failed",
      workflowStatus: "blocked",
    });
    expect((await fixture.store.read(fixture.workflowId))?.workflow.status).toBe("blocked");
  });

  it("applies fail-fast policy as a workflow fact", async () => {
    const fixture = await createFixture();
    const command = createCommand(fixture.workflowId, fixture.policyRef);
    if (command.payload.type !== "create_graph") throw new Error("invalid test command");
    command.payload.definition.completionPolicy.failurePolicy = "fail_fast";
    await fixture.engine.createWorkflow(command);
    const claim = await claimFirstReady(fixture, "claim-fail-fast");
    const result = await fixture.engine.applyTicket(ticketCommand(
      fixture.workflowId,
      "fail-fast-dev",
      "proposal-fail-fast",
      claim,
      { type: "fail", reason: "fatal", evidence: [] },
    ));
    expect(result).toMatchObject({ accepted: true, workflowStatus: "failed" });
  });

  it("completes a planning ticket with a graph update atomically", async () => {
    const fixture = await createStartedFixture();
    const claim = await claimFirstReady(fixture, "claim-plan");
    const graph: PlannedTicketGraph = {
      schemaVersion: 2,
      nodes: [node("docs")],
      dependencyEdges: [],
    };
    const result = await fixture.engine.applyTicket(ticketCommand(
      fixture.workflowId,
      "complete-with-graph",
      "proposal-graph",
      claim,
      {
        type: "complete_with_graph",
        result: { plan: "expanded" },
        evidence: [],
        expectedWorkflowVersion: 2,
        graph,
        completionPolicy: {
          requiredTerminalKeys: ["docs" as TicketNodeKey],
          failurePolicy: "require_resolution",
          blockedPolicy: "wait",
        },
        cancelTicketIds: [],
      },
    ));
    expect(result).toMatchObject({ accepted: true, ticketStatus: "completed", workflowVersion: 3 });
    const aggregate = await fixture.store.read(fixture.workflowId);
    expect(aggregate?.tickets).toHaveLength(3);
    expect(aggregate?.tickets.filter((ticket) => ticket.status === "ready")).toHaveLength(2);
    expect(aggregate?.planning?.plannedGraph.nodes.map((item) => item.key)).toEqual(["dev", "docs", "qa"]);
    expect(aggregate?.planning?.plannedGraph.dependencyEdges).toContainEqual({
      fromKey: "dev",
      toKey: "docs",
    });
  });

  it("deduplicates proposal ids across different ticket command ids", async () => {
    const fixture = await createStartedFixture();
    const claim = await claimFirstReady(fixture, "claim-proposal");
    await fixture.engine.applyTicket(ticketCommand(
      fixture.workflowId,
      "first-proposal-command",
      "single-proposal",
      claim,
      { type: "complete", result: {}, evidence: [] },
    ));
    const conflict = await fixture.engine.applyTicket(ticketCommand(
      fixture.workflowId,
      "second-proposal-command",
      "single-proposal",
      { ...claim, ticketVersion: 3 },
      { type: "complete", result: {}, evidence: [] },
    ));
    expect(conflict).toMatchObject({ accepted: false, code: "idempotency_conflict" });
  });

  it("returns a child to a new parent revision without running the old downstream branch", async () => {
    const fixture = await createFixture();
    const command = createCommand(fixture.workflowId, fixture.policyRef);
    if (command.payload.type !== "create_graph") throw new Error("invalid test command");
    command.payload.definition.initialGraph = {
      schemaVersion: 2,
      nodes: [
        node("pm"),
        { ...node("dev"), parentKey: "pm" as TicketNodeKey },
        node("qa"),
      ],
      dependencyEdges: [
        { fromKey: "pm" as TicketNodeKey, toKey: "dev" as TicketNodeKey },
        { fromKey: "dev" as TicketNodeKey, toKey: "qa" as TicketNodeKey },
      ],
    };
    command.payload.definition.completionPolicy = {
      requiredTerminalKeys: ["qa" as TicketNodeKey],
      failurePolicy: "require_resolution",
      blockedPolicy: "wait",
    };
    await fixture.engine.createWorkflow(command);
    const pmClaim = await claimFirstReady(fixture, "claim-pm");
    await fixture.engine.applyTicket(ticketCommand(
      fixture.workflowId,
      "complete-pm",
      "proposal-pm",
      pmClaim,
      { type: "complete", result: {}, evidence: [] },
    ));
    const devClaim = await claimFirstReady(fixture, "claim-dev-return");
    const aggregateBefore = (await fixture.store.read(fixture.workflowId))!;
    const parentTicketId = aggregateBefore.tickets.find((ticket) => ticket.ticketId === devClaim.ticketId)!.parentTicketId!;
    const result = await fixture.engine.applyTicket(ticketCommand(
      fixture.workflowId,
      "return-dev",
      "proposal-return",
      devClaim,
      {
        type: "return_to_parent",
        parentTicketId,
        expectedWorkflowVersion: aggregateBefore.workflow.version,
        reason: "requirements incomplete",
        evidence: [],
      },
    ));

    expect(result).toMatchObject({ accepted: true, ticketStatus: "returned" });
    const aggregate = await fixture.store.read(fixture.workflowId);
    expect(aggregate?.tickets.find((ticket) => ticket.ticketId === devClaim.ticketId)?.status).toBe("returned");
    expect(aggregate?.tickets.find((ticket) => ticket.ticketId === parentTicketId)?.status).toBe("completed");
    expect(aggregate?.tickets.some((ticket) => ticket.status === "ready")).toBe(true);
    expect(aggregate?.planning?.plannedGraph.nodes.some((item) => item.key === "qa")).toBe(false);
    expect(aggregate?.planning?.plannedGraph.nodes.some((item) => item.revisionOfKey === "pm")).toBe(true);
  });
});

async function createFixture(now?: () => Date) {
  const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-ticket-engine-"));
  const workflowId = "workflow-1" as WorkflowId;
  const store = new TicketStore(root, "task-1", "run-1");
  const policyStore = new WorkflowPolicyStore(root);
  const policy = createWorkflowPolicy({
    policyId: "test-policy",
    policyVersion: 1,
    grants: [{
      principalId: "planner-1",
      capabilities: [
        "blocked_ownership:transfer",
        "ticket:claim",
        "ticket_graph:create",
        "ticket_graph:amend",
        "workflow:control",
      ],
    }],
  });
  const policyRef = (await policyStore.seedPolicy(policy)).ref;
  return {
    root,
    workflowId,
    policyRef,
    store,
    policyStore,
    engine: new TicketEngine(store, policyStore, { now }),
  };
}

async function claimFirstReady(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  requestId: string,
) {
  const ticket = (await fixture.store.read(fixture.workflowId))!.tickets.find((item) => item.status === "ready")!;
  const claim = await fixture.engine.claimReady({
    requestId,
    workflowId: fixture.workflowId,
    ticketId: ticket.ticketId,
    expectedTicketVersion: ticket.version,
    principalId: "planner-1",
    leaseDurationMs: 60_000,
  });
  if (!claim) throw new Error("ticket was not claimed");
  return claim;
}

function ticketCommand(
  workflowId: WorkflowId,
  commandId: string,
  proposalId: string,
  claim: Awaited<ReturnType<typeof claimFirstReady>>,
  payload: TicketCommandPayload,
): TicketCommandEnvelope {
  return {
    commandId,
    proposalId,
    workflowId,
    ticketId: claim.ticketId,
    expectedTicketVersion: claim.ticketVersion,
    actorPrincipalId: claim.principalId,
    executionRef: `goal-${proposalId}`,
    authority: { kind: "claim", claimId: claim.claimId, fencingToken: claim.fencingToken },
    issuedAt: "2026-07-10T00:00:01.000Z",
    payload,
  };
}

async function createStartedFixture(now?: () => Date) {
  const fixture = await createFixture(now);
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
