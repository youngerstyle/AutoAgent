import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PlanCommandEnvelope, PlanId, PlanPolicyPort, TicketCommandEnvelope, TicketId } from "../../src/shared/contracts/ticket-engine.js";
import { createPlanPolicy } from "../../src/server/tickets/plan-policy-store.js";
import { TicketEngine } from "../../src/server/tickets/ticket-engine.js";
import { TicketStore } from "../../src/server/tickets/ticket-store.js";

describe("TicketEngine single Plan flow", () => {
  it("rejects appended work that can run before its source planning Ticket completes", async () => {
    const fixture = await createFixture();
    const planning = fixture.plan.graph.ticketIds[0]!;
    const claim = await fixture.engine.claimReady({ requestId: "claim-unordered-plan", planId: fixture.planId, ticketId: planning, expectedTicketVersion: 1, principalId: "planner", leaseDurationMs: 60_000 });

    const changed = await fixture.engine.applyPlan({
      commandId: "unordered-change", planId: fixture.planId, actorPrincipalId: "planner", issuedAt: now,
      payload: {
        type: "apply_change", expectedPlanVersion: 2, sourceTicketId: planning, sourceAuthority: { kind: "claim", claimId: claim!.claimId, fencingToken: claim!.fencingToken },
        change: {
          additions: [draft("dev", "开发执行")],
          dependencyAdditions: [],
          cancelTicketIds: [], requiredTerminalRefs: [{ clientRef: "dev" }],
        },
      },
    });

    expect(changed).toMatchObject({
      accepted: false,
      code: "invalid_command",
      reason: expect.stringContaining("source Ticket"),
    });
  });

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

  it("appends a correction Ticket and retries the same verifier without involving the planner", async () => {
    const fixture = await createExecutionFixture();
    const qaClaim = await fixture.engine.claimReady({ requestId: "claim-qa", planId: fixture.planId, ticketId: fixture.qa, expectedTicketVersion: 2, principalId: "qa", leaseDurationMs: 60_000 });
    const result = await fixture.engine.applyTicket(ticketCommand(fixture.planId, fixture.qa, qaClaim!, "correction-1", {
      type: "request_correction",
      targetTicketId: fixture.dev,
      reason: "射击碰撞没有生效",
      evidence: [{ kind: "test", ref: "qa://failure/1" }],
    }));

    expect(result).toMatchObject({ accepted: true, ticketStatus: "pending", planStatus: "active" });
    const plan = await fixture.engine.getPlan(fixture.planId);
    const correctionId = plan.graph.ticketIds.at(-1)!;
    expect(correctionId).not.toBe(fixture.dev);
    expect(correctionId).not.toBe(fixture.qa);
    expect(await fixture.engine.getTicket(fixture.dev)).toMatchObject({ status: "completed" });
    expect(await fixture.engine.getTicket(fixture.qa)).toMatchObject({ status: "pending" });
    expect(await fixture.engine.getTicket(fixture.qa)).not.toHaveProperty("activeAuthority");
    expect(await fixture.engine.getTicket(fixture.acceptance)).toMatchObject({ status: "pending" });
    expect(await fixture.engine.getWorkItem(correctionId)).toMatchObject({
      ticket: { status: "ready", parentTicketId: fixture.dev },
      definition: {
        assignment: { principalId: "dev" },
        outputContract: { schemaRef: "result-v1" },
      },
    });
    expect(plan.graph.dependencyEdges).toEqual(expect.arrayContaining([
      { fromTicketId: fixture.dev, toTicketId: correctionId },
      { fromTicketId: correctionId, toTicketId: fixture.qa },
    ]));
    expect(plan.completionPolicy.requiredTerminalTicketIds).toEqual([fixture.acceptance]);

    const correctionClaim = await fixture.engine.claimReady({ requestId: "claim-correction", planId: fixture.planId, ticketId: correctionId, expectedTicketVersion: 2, principalId: "dev", leaseDurationMs: 60_000 });
    await fixture.engine.applyTicket(ticketCommand(fixture.planId, correctionId, correctionClaim!, "complete-correction", { type: "complete", result: {}, evidence: [] }));
    expect(await fixture.engine.getTicket(fixture.qa)).toMatchObject({ status: "ready" });
    expect(await fixture.engine.getTicket(fixture.acceptance)).toMatchObject({ status: "pending" });

    const events = await fixture.engine.readEvents({ planId: fixture.planId, limit: 100 });
    expect(events.events.some((event) => event.aggregateType === "plan" && event.payload.type === "TicketCorrectionRequested")).toBe(true);
    expect(events.events.some((event) => event.aggregateType === "plan" && event.payload.type === "PlanAmendmentRequested")).toBe(false);
  });

  it("rejects a correction target that is not a completed strict ancestor", async () => {
    const fixture = await createExecutionFixture();
    const qaClaim = await fixture.engine.claimReady({ requestId: "claim-qa-invalid", planId: fixture.planId, ticketId: fixture.qa, expectedTicketVersion: 2, principalId: "qa", leaseDurationMs: 60_000 });
    const result = await fixture.engine.applyTicket(ticketCommand(fixture.planId, fixture.qa, qaClaim!, "invalid-correction", {
      type: "request_correction",
      targetTicketId: fixture.qa,
      reason: "不能纠正自己",
      evidence: [],
    }));
    expect(result).toMatchObject({ accepted: false, code: "invalid_command" });
    expect((await fixture.engine.getPlan(fixture.planId)).graph.ticketIds).toHaveLength(4);
  });

  it("creates a planner amendment only for an explicit Plan change request", async () => {
    const fixture = await createExecutionFixture();
    const qaClaim = await fixture.engine.claimReady({ requestId: "claim-qa-replan", planId: fixture.planId, ticketId: fixture.qa, expectedTicketVersion: 2, principalId: "qa", leaseDurationMs: 60_000 });
    const result = await fixture.engine.applyTicket(ticketCommand(fixture.planId, fixture.qa, qaClaim!, "replan-1", {
      type: "request_plan_change",
      reason: "验收标准与 Mission 范围冲突",
      evidence: [],
    }));
    expect(result).toMatchObject({ accepted: true, ticketStatus: "pending", planStatus: "blocked" });
    const plan = await fixture.engine.getPlan(fixture.planId);
    const amendmentId = plan.graph.ticketIds.at(-1)!;
    expect(await fixture.engine.getWorkItem(amendmentId)).toMatchObject({
      ticket: { status: "ready" },
      definition: { title: "计划修订", assignment: fixture.plan.plannerAssignment, outputContract: { schemaRef: "plan-change-set-v3" } },
    });
    expect(plan.graph.dependencyEdges).toContainEqual({ fromTicketId: amendmentId, toTicketId: fixture.qa });
    expect(await fixture.engine.getTicket(fixture.acceptance)).toMatchObject({ status: "pending" });
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
  const policy = createPlanPolicy({ policyId: "test", policyVersion: 1, grants: [
    { principalId: "planner", capabilities: ["plan:create", "plan:amend", "plan:control", "ticket:claim", "blocked_ownership:transfer"] },
    { principalId: "dev", capabilities: ["ticket:claim"] },
    { principalId: "qa", capabilities: ["ticket:claim"] },
    { principalId: "boss", capabilities: ["ticket:claim"] },
  ] });
  const policyPort: PlanPolicyPort = { getPolicy: async (ref) => ref.contentHash === policy.ref.contentHash ? policy : undefined };
  const store = new TicketStore(root, "task", "run");
  const engine = new TicketEngine(store, policyPort);
  const planId = "f6f66a47-0c29-4c30-9461-f3de7525ad76" as PlanId;
  const command: PlanCommandEnvelope = { commandId: "create", planId, actorPrincipalId: "planner", issuedAt: now, payload: { type: "create_plan", missionId: "mission", definition: { definitionId: "test", definitionVersion: 1, policyRef: policy.ref, plannerAssignment: { principalId: "planner" }, initialChange: { additions: [draft("planning", "计划拆解")], dependencyAdditions: [], cancelTicketIds: [], requiredTerminalRefs: [{ clientRef: "planning" }] } } } };
  expect(await engine.createPlan(command)).toMatchObject({ accepted: true });
  return { root, store, engine, planId, plan: await engine.getPlan(planId) };
}
async function createExecutionFixture() {
  const fixture = await createFixture();
  const planning = fixture.plan.graph.ticketIds[0]!;
  const planningClaim = await fixture.engine.claimReady({ requestId: "claim-planning-chain", planId: fixture.planId, ticketId: planning, expectedTicketVersion: 1, principalId: "planner", leaseDurationMs: 60_000 });
  await fixture.engine.applyPlan({
    commandId: "append-execution-chain", planId: fixture.planId, actorPrincipalId: "planner", issuedAt: now,
    payload: {
      type: "apply_change", expectedPlanVersion: 2, sourceTicketId: planning, sourceAuthority: { kind: "claim", claimId: planningClaim!.claimId, fencingToken: planningClaim!.fencingToken },
      change: {
        additions: [
          { ...draft("dev", "开发"), assignment: { principalId: "dev" } },
          { ...draft("qa", "质量检查"), assignment: { principalId: "qa" } },
          { ...draft("acceptance", "验收"), assignment: { principalId: "boss" } },
        ],
        dependencyAdditions: [
          { from: { ticketId: planning }, to: { clientRef: "dev" } },
          { from: { clientRef: "dev" }, to: { clientRef: "qa" } },
          { from: { clientRef: "qa" }, to: { clientRef: "acceptance" } },
        ],
        cancelTicketIds: [], requiredTerminalRefs: [{ clientRef: "acceptance" }],
      },
    },
  });
  await fixture.engine.applyTicket(ticketCommand(fixture.planId, planning, planningClaim!, "complete-planning-chain", { type: "complete", result: {}, evidence: [] }));
  const plan = await fixture.engine.getPlan(fixture.planId);
  const [, dev, qa, acceptance] = plan.graph.ticketIds;
  const devClaim = await fixture.engine.claimReady({ requestId: "claim-dev-chain", planId: fixture.planId, ticketId: dev!, expectedTicketVersion: 2, principalId: "dev", leaseDurationMs: 60_000 });
  await fixture.engine.applyTicket(ticketCommand(fixture.planId, dev!, devClaim!, "complete-dev-chain", { type: "complete", result: {}, evidence: [] }));
  return { ...fixture, plan, planning, dev: dev!, qa: qa!, acceptance: acceptance! };
}
function ticketCommand(planId: PlanId, ticketId: TicketId, claim: NonNullable<Awaited<ReturnType<TicketEngine["claimReady"]>>>, commandId: string, payload: TicketCommandEnvelope["payload"]): TicketCommandEnvelope {
  return { commandId, proposalId: `proposal-${commandId}`, planId, ticketId, expectedTicketVersion: claim.ticketVersion, actorPrincipalId: claim.principalId, executionRef: "goal", authority: { kind: "claim", claimId: claim.claimId, fencingToken: claim.fencingToken }, issuedAt: now, payload };
}
