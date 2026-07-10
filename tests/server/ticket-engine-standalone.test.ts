import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type {
  TicketCommandEnvelope,
  TicketNodeKey,
  WorkflowCommandEnvelope,
  WorkflowId,
} from "../../src/shared/contracts/ticket-engine.js";
import { TicketEngine } from "../../src/server/tickets/ticket-engine.js";
import { TicketStore } from "../../src/server/tickets/ticket-store.js";
import { createWorkflowPolicy, WorkflowPolicyStore } from "../../src/server/tickets/workflow-policy-store.js";

describe("standalone Ticket Engine", () => {
  it("recovers between every persisted step without AgentRuntime or MissionControl", async () => {
    const fixture = await fixtureRoot();
    const created = await fixture.engine().createWorkflow(createWorkflowCommand(fixture));
    expect(created).toMatchObject({ accepted: true, workflowVersion: 1 });

    const dev = (await fixture.store().read(fixture.workflowId))!.tickets.find((ticket) => ticket.status === "ready")!;
    const devClaim = await fixture.engine().claimReady({
      requestId: "claim-dev",
      workflowId: fixture.workflowId,
      ticketId: dev.ticketId,
      expectedTicketVersion: dev.version,
      principalId: "worker-1",
      leaseDurationMs: 60_000,
    });
    const devComplete = completeCommand(fixture.workflowId, "complete-dev", "proposal-dev", devClaim!);
    const completedDev = await fixture.engine().applyTicket(devComplete);
    expect(completedDev).toMatchObject({ accepted: true, ticketStatus: "completed" });
    await expect(fixture.engine().applyTicket(devComplete)).resolves.toEqual(completedDev);

    const qa = (await fixture.store().read(fixture.workflowId))!.tickets.find((ticket) => ticket.status === "ready")!;
    const qaClaim = await fixture.engine().claimReady({
      requestId: "claim-qa",
      workflowId: fixture.workflowId,
      ticketId: qa.ticketId,
      expectedTicketVersion: qa.version,
      principalId: "worker-1",
      leaseDurationMs: 60_000,
    });
    const blocked = await fixture.engine().applyTicket({
      ...completeCommand(fixture.workflowId, "block-qa", "proposal-block", qaClaim!),
      payload: { type: "block", reason: "manual evidence required", requiredInput: "test result" },
    });
    expect(blocked).toMatchObject({ accepted: true, ticketStatus: "blocked" });

    const authority = (blocked as Extract<typeof blocked, { accepted: true }>).nextAuthority!;
    const final = await fixture.engine().applyTicket({
      commandId: "complete-qa",
      proposalId: "proposal-qa",
      workflowId: fixture.workflowId,
      ticketId: qa.ticketId,
      expectedTicketVersion: 4,
      actorPrincipalId: "worker-1",
      executionRef: "goal-qa-resumed",
      authority,
      issuedAt: "2026-07-10T00:00:04.000Z",
      payload: { type: "complete", result: { passed: true }, evidence: [] },
    });

    expect(final).toMatchObject({ accepted: true, workflowStatus: "completed" });
    const restored = await fixture.store().read(fixture.workflowId);
    expect(restored?.workflow.status).toBe("completed");
    expect(restored?.tickets.every((ticket) => ticket.status === "completed")).toBe(true);
    const events = await fixture.store().readEvents({ workflowId: fixture.workflowId, limit: 100 });
    expect(events.events.map((event) => event.payload.type)).toContain("TicketBlocked");
    expect(events.events.at(-1)?.payload).toEqual({ type: "WorkflowStatusChanged", status: "completed" });
  });

  it("cancels a restored workflow and never reopens its tickets", async () => {
    const fixture = await fixtureRoot("workflow-cancel");
    await fixture.engine().createWorkflow(createWorkflowCommand(fixture));
    const result = await fixture.engine().applyWorkflow({
      commandId: "cancel-workflow",
      workflowId: fixture.workflowId,
      actorPrincipalId: "planner-1",
      issuedAt: "2026-07-10T00:00:01.000Z",
      payload: { type: "cancel", expectedWorkflowVersion: 1, reason: "operator cancelled" },
    });
    expect(result).toMatchObject({ accepted: true, workflowStatus: "cancelled" });
    expect((await fixture.store().read(fixture.workflowId))?.tickets.every(
      (ticket) => ticket.status === "cancelled",
    )).toBe(true);
  });
});

async function fixtureRoot(workflow = "workflow-standalone") {
  const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-ticket-standalone-"));
  const workflowId = workflow as WorkflowId;
  const policyStore = new WorkflowPolicyStore(root);
  const policy = await policyStore.seedPolicy(createWorkflowPolicy({
    policyId: "standalone",
    policyVersion: 1,
    grants: [
      { principalId: "planner-1", capabilities: ["ticket_graph:create", "workflow:control"] },
      { principalId: "worker-1", capabilities: ["ticket:claim"] },
    ],
  }));
  return {
    root,
    workflowId,
    policyRef: policy.ref,
    store: () => new TicketStore(root, "task-1", "run-1"),
    engine: () => new TicketEngine(
      new TicketStore(root, "task-1", "run-1"),
      new WorkflowPolicyStore(root),
      { now: () => new Date("2026-07-10T00:00:10.000Z") },
    ),
  };
}

function createWorkflowCommand(
  fixture: Awaited<ReturnType<typeof fixtureRoot>>,
): WorkflowCommandEnvelope {
  return {
    commandId: "create-workflow",
    workflowId: fixture.workflowId,
    actorPrincipalId: "planner-1",
    issuedAt: "2026-07-10T00:00:00.000Z",
    payload: {
      type: "create_graph",
      definition: {
        definitionId: "standalone-definition",
        definitionVersion: 1,
        policyRef: fixture.policyRef,
        initialGraph: {
          schemaVersion: 2,
          nodes: [node("dev"), node("qa")],
          dependencyEdges: [{ fromKey: "dev" as TicketNodeKey, toKey: "qa" as TicketNodeKey }],
        },
        completionPolicy: {
          requiredTerminalKeys: ["qa" as TicketNodeKey],
          failurePolicy: "require_resolution",
          blockedPolicy: "wait",
        },
      },
    },
  };
}

function completeCommand(
  workflowId: WorkflowId,
  commandId: string,
  proposalId: string,
  claim: NonNullable<Awaited<ReturnType<TicketEngine["claimReady"]>>>,
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
    issuedAt: "2026-07-10T00:00:02.000Z",
    payload: { type: "complete", result: {}, evidence: [] },
  };
}

function node(key: string) {
  return {
    key: key as TicketNodeKey,
    title: key,
    objective: key,
    successCriteria: [`${key} done`],
    assignment: { requiredCapabilities: [`work:${key}`] },
    outputContract: { schemaRef: `schema:${key}` },
  };
}
