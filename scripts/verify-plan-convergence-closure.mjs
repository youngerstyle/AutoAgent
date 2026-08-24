import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createPlanPolicy, PlanPolicyStore } from "../dist/server/server/tickets/plan-policy-store.js";
import { TicketEngine } from "../dist/server/server/tickets/ticket-engine.js";
import { TicketStore } from "../dist/server/server/tickets/ticket-store.js";

const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-convergence-closure-"));
const now = "2026-08-24T08:00:00.000Z";

try {
  const policyStore = new PlanPolicyStore(root);
  const policy = createPlanPolicy({
    policyId: "convergence-verification",
    policyVersion: 1,
    grants: [{
      principalId: "planner",
      capabilities: ["plan:create", "plan:amend", "plan:control", "ticket:claim"],
    }],
  });
  await policyStore.seedPolicy(policy);

  const amendment = await verifyAmendmentBudget(root, policyStore, policy.ref);
  const ticket = await verifyTicketBudget(root, policyStore, policy.ref);
  process.stdout.write(`${JSON.stringify({ ok: true, amendment, ticket }, null, 2)}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}

async function verifyAmendmentBudget(workspaceRoot, policies, policyRef) {
  const planId = "18cbfb38-2048-4bf3-9864-000000000001";
  const store = new TicketStore(workspaceRoot, "task-amendment", "run-amendment");
  const engine = new TicketEngine(store, policies);
  const created = await engine.createPlan(createCommand(planId, policyRef, {
    maxTickets: 3,
    maxAcceptedAmendments: 1,
  }));
  assert(created.accepted, `Plan creation failed: ${JSON.stringify(created)}`);
  const sourceTicketId = (await engine.getPlan(planId)).graph.ticketIds[0];
  const claim = await engine.claimReady({
    requestId: "claim-amendment-source",
    planId,
    ticketId: sourceTicketId,
    expectedTicketVersion: 1,
    principalId: "planner",
    leaseDurationMs: 60_000,
  });
  assert(claim, "Planning Ticket was not claimable");
  const authority = { kind: "claim", claimId: claim.claimId, fencingToken: claim.fencingToken };
  const first = await engine.applyPlan(changeCommand("accepted-change", planId, sourceTicketId, authority, 2, "work-1"));
  assert(first.accepted, `First amendment failed: ${JSON.stringify(first)}`);
  const before = await engine.getPlan(planId);
  const rejectedCommand = changeCommand("rejected-change", planId, sourceTicketId, authority, before.version, "work-2");
  const rejected = await engine.applyPlan(rejectedCommand);
  assert(!rejected.accepted && rejected.code === "budget_exhausted", "Second amendment did not exhaust its budget");
  assert(rejected.budget?.dimension === "accepted_amendments", "Wrong exhausted amendment dimension");
  assert(JSON.stringify(await engine.getPlan(planId)) === JSON.stringify(before), "Rejected amendment mutated the Plan");

  const restarted = new TicketEngine(new TicketStore(workspaceRoot, "task-amendment", "run-amendment"), policies);
  assert(JSON.stringify(await restarted.applyPlan(rejectedCommand)) === JSON.stringify(rejected), "Restart did not replay the same rejection");
  assert(JSON.stringify(await restarted.getPlan(planId)) === JSON.stringify(before), "Restart changed the exhausted Plan");
  return {
    planId,
    acceptedAmendments: before.convergence.acceptedAmendments,
    rejection: rejected.budget,
    restartStable: true,
  };
}

async function verifyTicketBudget(workspaceRoot, policies, policyRef) {
  const planId = "18cbfb38-2048-4bf3-9864-000000000002";
  const store = new TicketStore(workspaceRoot, "task-ticket", "run-ticket");
  const engine = new TicketEngine(store, policies);
  const created = await engine.createPlan(createCommand(planId, policyRef, {
    maxTickets: 1,
    maxAcceptedAmendments: 1,
  }));
  assert(created.accepted, `Ticket-budget Plan creation failed: ${JSON.stringify(created)}`);
  const sourceTicketId = (await engine.getPlan(planId)).graph.ticketIds[0];
  const claim = await engine.claimReady({
    requestId: "claim-ticket-source",
    planId,
    ticketId: sourceTicketId,
    expectedTicketVersion: 1,
    principalId: "planner",
    leaseDurationMs: 60_000,
  });
  assert(claim, "Ticket-budget source was not claimable");
  const beforePlan = await engine.getPlan(planId);
  const beforeTicket = await engine.getTicket(sourceTicketId);
  const command = {
    commandId: "rejected-plan-change-request",
    proposalId: "proposal-rejected-plan-change-request",
    planId,
    ticketId: sourceTicketId,
    expectedTicketVersion: claim.ticketVersion,
    actorPrincipalId: "planner",
    executionRef: "goal-ticket-budget",
    authority: { kind: "claim", claimId: claim.claimId, fencingToken: claim.fencingToken },
    issuedAt: now,
    payload: { type: "request_plan_change", reason: "capacity proof", evidence: [] },
  };
  const rejected = await engine.applyTicket(command);
  assert(!rejected.accepted && rejected.code === "budget_exhausted", "Resolution Ticket did not exhaust Ticket capacity");
  assert(rejected.budget?.dimension === "tickets", "Wrong exhausted Ticket dimension");
  assert(JSON.stringify(await engine.getPlan(planId)) === JSON.stringify(beforePlan), "Rejected request mutated the Plan");
  assert(JSON.stringify(await engine.getTicket(sourceTicketId)) === JSON.stringify(beforeTicket), "Rejected request settled the running Ticket");

  const restarted = new TicketEngine(new TicketStore(workspaceRoot, "task-ticket", "run-ticket"), policies);
  assert(JSON.stringify(await restarted.applyTicket(command)) === JSON.stringify(rejected), "Restart did not replay the Ticket rejection");
  return {
    planId,
    sourceTicketStatus: beforeTicket.status,
    rejection: rejected.budget,
    restartStable: true,
  };
}

function createCommand(planId, policyRef, convergenceLimits) {
  return {
    commandId: `create-${planId}`,
    planId,
    actorPrincipalId: "planner",
    issuedAt: now,
    payload: {
      type: "create_plan",
      missionId: `mission-${planId}`,
      definition: {
        definitionId: "convergence-verification",
        definitionVersion: 1,
        policyRef,
        plannerAssignment: { principalId: "planner" },
        amendmentTemplate: {
          title: "Plan amendment",
          successCriteria: ["Plan converges"],
          outputContract: { schemaRef: "change-v1" },
        },
        convergenceLimits,
        initialChange: {
          additions: [{ ...draft("planning"), permissions: { amendPlan: true } }],
          dependencyAdditions: [],
          cancelTicketIds: [],
          requiredTerminalRefs: [{ clientRef: "planning" }],
        },
      },
    },
  };
}

function changeCommand(commandId, planId, sourceTicketId, sourceAuthority, expectedPlanVersion, clientRef) {
  return {
    commandId,
    planId,
    actorPrincipalId: "planner",
    issuedAt: now,
    payload: {
      type: "apply_change",
      expectedPlanVersion,
      sourceTicketId,
      sourceAuthority,
      change: {
        additions: [draft(clientRef)],
        dependencyAdditions: [{ from: { ticketId: sourceTicketId }, to: { clientRef } }],
        cancelTicketIds: [],
        requiredTerminalRefs: [{ clientRef }],
      },
    },
  };
}

function draft(clientRef) {
  return {
    clientRef,
    title: clientRef,
    objective: `Complete ${clientRef}`,
    successCriteria: [`${clientRef} is complete`],
    assignment: { principalId: "planner" },
    outputContract: { schemaRef: "result-v1" },
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
