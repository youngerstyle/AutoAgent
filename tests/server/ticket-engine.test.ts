import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PlanCommandEnvelope, PlanId, PlanPolicyPort, TicketCommandEnvelope, TicketId } from "../../src/shared/contracts/ticket-engine.js";
import { createPlanPolicy } from "../../src/server/tickets/plan-policy-store.js";
import { TicketEngine } from "../../src/server/tickets/ticket-engine.js";
import { TicketStore } from "../../src/server/tickets/ticket-store.js";

describe("TicketEngine single Plan flow", () => {
  it("keeps Plan active after planning and schedules only newly appended UUID Tickets", async () => {
    const fixture = await createFixture();
    const planning = fixture.plan.graph.ticketIds[0]!;
    const claim = await fixture.engine.claimReady({ requestId: "claim-plan", planId: fixture.planId, ticketId: planning, expectedTicketVersion: 1, principalId: "planner", leaseDurationMs: 60_000 });
    expect(claim).toBeDefined();

    const changed = await fixture.engine.applyPlan({
      commandId: "change-1", planId: fixture.planId, actorPrincipalId: "planner", issuedAt: now,
      payload: {
        type: "apply_change", expectedPlanVersion: 2, sourceTicketId: planning, sourceAuthority: { kind: "claim", claimId: claim!.claimId, fencingToken: claim!.fencingToken },
        change: {
          additions: [draft("dev", "同名实现")],
          dependencyAdditions: [{ from: { ticketId: planning }, to: { clientRef: "dev" } }],
          cancelTicketIds: [], requiredTerminalRefs: [{ clientRef: "dev" }],
        },
      },
    });
    expect(changed).toMatchObject({ accepted: true, planStatus: "active" });
    const afterChange = await fixture.engine.getPlan(fixture.planId);
    const dev = afterChange.graph.ticketIds[1]!;
    expect(dev).not.toBe(planning);

    await fixture.engine.applyTicket(ticketCommand(fixture.planId, planning, claim!, "complete-plan", { type: "complete", result: {}, evidence: [] }));
    const afterPlanning = await fixture.engine.getPlan(fixture.planId);
    expect(afterPlanning.status).toBe("active");
    expect((await fixture.engine.getTicket(planning))?.status).toBe("completed");
    expect((await fixture.engine.getTicket(dev))?.status).toBe("ready");
  });

  it("never reactivates a completed Ticket when another same-title Ticket is appended", async () => {
    const fixture = await createFixture();
    const first = fixture.plan.graph.ticketIds[0]!;
    const claim = await fixture.engine.claimReady({ requestId: "claim-first", planId: fixture.planId, ticketId: first, expectedTicketVersion: 1, principalId: "planner", leaseDurationMs: 60_000 });
    await fixture.engine.applyPlan({ commandId: "append-same", planId: fixture.planId, actorPrincipalId: "planner", issuedAt: now, payload: { type: "apply_change", expectedPlanVersion: 2, sourceTicketId: first, sourceAuthority: { kind: "claim", claimId: claim!.claimId, fencingToken: claim!.fencingToken }, change: { additions: [draft("next", "计划拆解")], dependencyAdditions: [{ from: { ticketId: first }, to: { clientRef: "next" } }], cancelTicketIds: [], requiredTerminalRefs: [{ clientRef: "next" }] } } });
    await fixture.engine.applyTicket(ticketCommand(fixture.planId, first, claim!, "complete-first", { type: "complete", result: {}, evidence: [] }));
    const plan = await fixture.engine.getPlan(fixture.planId);
    expect(plan.graph.ticketIds).toHaveLength(2);
    expect(new Set(plan.graph.ticketIds).size).toBe(2);
    expect((await fixture.engine.getTicket(first))?.status).toBe("completed");
  });

  it("appends one planner amendment Ticket after return without cloning or replacing upstream Tickets", async () => {
    const fixture = await createFixture();
    const ticketId = fixture.plan.graph.ticketIds[0]!;
    const claim = await fixture.engine.claimReady({ requestId: "claim-return", planId: fixture.planId, ticketId, expectedTicketVersion: 1, principalId: "planner", leaseDurationMs: 60_000 });
    const result = await fixture.engine.applyTicket(ticketCommand(fixture.planId, ticketId, claim!, "return-1", { type: "return", targetTicketId: ticketId, reason: "前置事实错误", evidence: [] }));
    expect(result).toMatchObject({ accepted: true, ticketStatus: "returned", planStatus: "blocked" });
    const blockedPlan = await fixture.engine.getPlan(fixture.planId);
    expect(blockedPlan.graph.ticketIds).toHaveLength(2);
    expect(blockedPlan.graph.ticketIds[0]).toBe(ticketId);
    const amendmentId = blockedPlan.graph.ticketIds[1]!;
    expect(amendmentId).not.toBe(ticketId);
    expect(await fixture.engine.getWorkItem(amendmentId)).toMatchObject({
      ticket: { status: "ready" },
      definition: {
        title: "计划修订",
        assignment: fixture.plan.plannerAssignment,
        outputContract: { schemaRef: "plan-change-set-v3" },
      },
    });
    const amendmentClaim = await fixture.engine.claimReady({
      requestId: "claim-amendment",
      planId: fixture.planId,
      ticketId: amendmentId,
      expectedTicketVersion: 1,
      principalId: "planner",
      leaseDurationMs: 60_000,
    });
    expect(amendmentClaim).toBeDefined();
    const events = await fixture.engine.readEvents({ planId: fixture.planId, limit: 100 });
    expect(events.events.some((event) => event.aggregateType === "plan" && event.payload.type === "PlanAmendmentRequested")).toBe(true);
  });

  it("returns one durable claim when the same request races concurrently", async () => {
    const fixture = await createFixture();
    const ticketId = fixture.plan.graph.ticketIds[0]!;
    const request = { requestId: "same-claim", planId: fixture.planId, ticketId, expectedTicketVersion: 1, principalId: "planner", leaseDurationMs: 60_000 };
    const [first, second] = await Promise.all([
      fixture.engine.claimReady(request),
      fixture.engine.claimReady(request),
    ]);
    expect(first).toBeDefined();
    expect(second).toEqual(first);
  });

  it("moves blocked ownership and the Ticket authority together", async () => {
    const fixture = await createFixture();
    const ticketId = fixture.plan.graph.ticketIds[0]!;
    const claim = await fixture.engine.claimReady({ requestId: "claim-block", planId: fixture.planId, ticketId, expectedTicketVersion: 1, principalId: "planner", leaseDurationMs: 60_000 });
    const blocked = await fixture.engine.applyTicket(ticketCommand(fixture.planId, ticketId, claim!, "block", { type: "block", reason: "需要输入" }));
    if (!blocked.accepted || blocked.nextAuthority?.kind !== "blocked_owner") throw new Error("Expected blocked ownership");
    const moved = await fixture.engine.transferBlockedOwnership({
      requestId: "move-owner",
      ownershipId: blocked.nextAuthority.ownershipId,
      fencingToken: blocked.nextAuthority.fencingToken,
      toPrincipalId: "planner-2",
    });
    expect(moved.principalId).toBe("planner-2");
    expect(await fixture.engine.getTicket(ticketId)).toMatchObject({
      version: moved.ticketVersion,
      activeAuthority: { kind: "blocked_owner", ownershipId: moved.ownershipId, fencingToken: moved.fencingToken },
    });
  });

  it("restores a blocked Plan to blocked after an operator pause and resume", async () => {
    const fixture = await createFixture();
    const ticketId = fixture.plan.graph.ticketIds[0]!;
    const claim = await fixture.engine.claimReady({ requestId: "claim-pause", planId: fixture.planId, ticketId, expectedTicketVersion: 1, principalId: "planner", leaseDurationMs: 60_000 });
    await fixture.engine.applyTicket(ticketCommand(fixture.planId, ticketId, claim!, "block-pause", { type: "block", reason: "等待输入" }));
    expect(await fixture.engine.applyPlan({ commandId: "pause", planId: fixture.planId, actorPrincipalId: "planner", issuedAt: now, payload: { type: "pause", expectedPlanVersion: 3 } }))
      .toMatchObject({ accepted: true, planStatus: "paused" });
    expect(await fixture.engine.applyPlan({ commandId: "resume", planId: fixture.planId, actorPrincipalId: "planner", issuedAt: now, payload: { type: "resume", expectedPlanVersion: 4 } }))
      .toMatchObject({ accepted: true, planStatus: "blocked" });
  });
});

const now = "2026-07-14T00:00:00.000Z";
function draft(clientRef: string, title: string) { return { clientRef, title, objective: `完成 ${title}`, successCriteria: [`${title} 完成`], assignment: { principalId: "planner" }, outputContract: { schemaRef: "result-v1" } }; }
async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-plan-"));
  const policy = createPlanPolicy({ policyId: "test", policyVersion: 1, grants: [{ principalId: "planner", capabilities: ["plan:create", "plan:amend", "plan:control", "ticket:claim", "blocked_ownership:transfer"] }] });
  const policyPort: PlanPolicyPort = { getPolicy: async (ref) => ref.contentHash === policy.ref.contentHash ? policy : undefined };
  const store = new TicketStore(root, "task", "run");
  const engine = new TicketEngine(store, policyPort);
  const planId = "f6f66a47-0c29-4c30-9461-f3de7525ad76" as PlanId;
  const command: PlanCommandEnvelope = { commandId: "create", planId, actorPrincipalId: "planner", issuedAt: now, payload: { type: "create_plan", missionId: "mission", definition: { definitionId: "test", definitionVersion: 1, policyRef: policy.ref, plannerAssignment: { principalId: "planner" }, initialChange: { additions: [draft("planning", "计划拆解")], dependencyAdditions: [], cancelTicketIds: [], requiredTerminalRefs: [{ clientRef: "planning" }] } } } };
  expect(await engine.createPlan(command)).toMatchObject({ accepted: true });
  return { root, store, engine, planId, plan: await engine.getPlan(planId) };
}
function ticketCommand(planId: PlanId, ticketId: TicketId, claim: NonNullable<Awaited<ReturnType<TicketEngine["claimReady"]>>>, commandId: string, payload: TicketCommandEnvelope["payload"]): TicketCommandEnvelope {
  return { commandId, proposalId: `proposal-${commandId}`, planId, ticketId, expectedTicketVersion: claim.ticketVersion, actorPrincipalId: claim.principalId, executionRef: "goal", authority: { kind: "claim", claimId: claim.claimId, fencingToken: claim.fencingToken }, issuedAt: now, payload };
}
