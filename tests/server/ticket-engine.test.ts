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

    await fixture.engine.applyTicket(ticketCommand(fixture.planId, planning, claim!, "complete-plan", {
      type: "complete",
      handoff: {
        schemaVersion: 1,
        summary: "目标已经确认",
        output: { brief: "accepted" },
        evidence: [{ evidenceId: "ev-brief" }],
        criterionResults: [{ criterionIndex: 0, status: "satisfied", evidence: [{ evidenceId: "ev-brief" }] }],
        residualRisks: [],
      },
    }));
    const afterPlanning = await fixture.engine.getPlan(fixture.planId);
    expect(afterPlanning.status).toBe("active");
    expect(await fixture.engine.getTicket(planning)).toMatchObject({
      status: "completed",
      completion: {
        handoff: {
          schemaVersion: 1,
          summary: "目标已经确认",
          output: { brief: "accepted" },
          evidence: [{ evidenceId: "ev-brief" }],
          criterionResults: [{ criterionIndex: 0, status: "satisfied", evidence: [{ evidenceId: "ev-brief" }] }],
          residualRisks: [],
        },
        actorPrincipalId: "planner",
      },
    });
    expect((await fixture.engine.getTicket(dev))?.status).toBe("ready");
  });

  it("never reactivates a completed Ticket when another same-title Ticket is appended", async () => {
    const fixture = await createFixture();
    const first = fixture.plan.graph.ticketIds[0]!;
    const claim = await fixture.engine.claimReady({ requestId: "claim-first", planId: fixture.planId, ticketId: first, expectedTicketVersion: 1, principalId: "planner", leaseDurationMs: 60_000 });
    await fixture.engine.applyPlan({ commandId: "append-same", planId: fixture.planId, actorPrincipalId: "planner", issuedAt: now, payload: { type: "apply_change", expectedPlanVersion: 2, sourceTicketId: first, sourceAuthority: { kind: "claim", claimId: claim!.claimId, fencingToken: claim!.fencingToken }, change: { additions: [draft("next", "计划拆解")], dependencyAdditions: [{ from: { ticketId: first }, to: { clientRef: "next" } }], cancelTicketIds: [], requiredTerminalRefs: [{ clientRef: "next" }] } } });
    await fixture.engine.applyTicket(ticketCommand(fixture.planId, first, claim!, "complete-first", completePayload()));
    const plan = await fixture.engine.getPlan(fixture.planId);
    expect(plan.graph.ticketIds).toHaveLength(2);
    expect(new Set(plan.graph.ticketIds).size).toBe(2);
    expect((await fixture.engine.getTicket(first))?.status).toBe("completed");
  });

  it("preserves completed history and queues a planner amendment for correction work", async () => {
    const fixture = await createExecutionFixture();
    const qaClaim = await fixture.engine.claimReady({ requestId: "claim-qa", planId: fixture.planId, ticketId: fixture.qa, expectedTicketVersion: 2, principalId: "qa", leaseDurationMs: 60_000 });
    const result = await fixture.engine.applyTicket(ticketCommand(fixture.planId, fixture.qa, qaClaim!, "correction-1", {
      type: "request_correction",
      targetTicketId: fixture.dev,
      reason: "射击碰撞没有生效",
      evidence: [{ evidenceId: "ev-qa-failure-1" }],
    }));

    expect(result).toMatchObject({ accepted: true, ticketStatus: "pending", planStatus: "blocked" });
    const plan = await fixture.engine.getPlan(fixture.planId);
    expect(plan.graph.ticketIds).toHaveLength(5);
    const amendmentId = plan.graph.ticketIds.find((ticketId) => !fixture.plan.graph.ticketIds.includes(ticketId))!;
    expect(plan.graph.dependencyEdges).toContainEqual({ fromTicketId: amendmentId, toTicketId: fixture.qa });
    expect(await fixture.engine.getTicket(fixture.dev)).toMatchObject({ status: "completed", attempts: [{ status: "completed", attemptNumber: 1 }] });
    expect(await fixture.engine.getTicket(fixture.qa)).toMatchObject({ status: "pending", attempts: [{ status: "returned", attemptNumber: 1, reason: "射击碰撞没有生效" }] });
    expect(await fixture.engine.getTicket(fixture.qa)).not.toHaveProperty("activeAuthority");
    expect(await fixture.engine.getTicket(fixture.acceptance)).toMatchObject({ status: "pending" });
    expect(await fixture.engine.getTicket(amendmentId)).toMatchObject({ status: "ready", attempts: [] });
    expect(plan.completionPolicy.requiredTerminalTicketIds).toEqual([fixture.acceptance]);

    const events = await fixture.engine.readEvents({ planId: fixture.planId, limit: 100 });
    expect(events.events.some((event) => event.aggregateType === "plan" && event.payload.type === "TicketCorrectionRequested")).toBe(true);
    expect(events.events.some((event) => event.aggregateType === "plan" && event.payload.type === "PlanAmendmentRequested")).toBe(true);
  });

  it("reopens only the returned path and preserves completed parallel work", async () => {
    const fixture = await createFixture();
    const planning = fixture.plan.graph.ticketIds[0]!;
    const planningClaim = await fixture.engine.claimReady({ requestId: "claim-parallel-plan", planId: fixture.planId, ticketId: planning, expectedTicketVersion: 1, principalId: "planner", leaseDurationMs: 60_000 });
    await fixture.engine.applyPlan({
      commandId: "append-parallel", planId: fixture.planId, actorPrincipalId: "planner", issuedAt: now,
      payload: {
        type: "apply_change", expectedPlanVersion: 2, sourceTicketId: planning, sourceAuthority: { kind: "claim", claimId: planningClaim!.claimId, fencingToken: planningClaim!.fencingToken },
        change: {
          additions: [
            { ...draft("dev-a", "开发 A"), assignment: { principalId: "dev" } },
            { ...draft("qa-a", "检查 A"), assignment: { principalId: "qa" } },
            { ...draft("dev-b", "开发 B"), assignment: { principalId: "dev" } },
            { ...draft("qa-b", "检查 B"), assignment: { principalId: "qa" } },
            { ...draft("acceptance", "验收"), assignment: { principalId: "boss" } },
          ],
          dependencyAdditions: [
            { from: { ticketId: planning }, to: { clientRef: "dev-a" } },
            { from: { clientRef: "dev-a" }, to: { clientRef: "qa-a" } },
            { from: { ticketId: planning }, to: { clientRef: "dev-b" } },
            { from: { clientRef: "dev-b" }, to: { clientRef: "qa-b" } },
            { from: { clientRef: "qa-a" }, to: { clientRef: "acceptance" } },
            { from: { clientRef: "qa-b" }, to: { clientRef: "acceptance" } },
          ],
          cancelTicketIds: [], requiredTerminalRefs: [{ clientRef: "acceptance" }],
        },
      },
    });
    await fixture.engine.applyTicket(ticketCommand(fixture.planId, planning, planningClaim!, "complete-parallel-plan", completePayload()));
    const [, devA, qaA, devB, qaB, acceptance] = (await fixture.engine.getPlan(fixture.planId)).graph.ticketIds;
    for (const [ticketId, principalId, key] of [[devA!, "dev", "dev-a"], [devB!, "dev", "dev-b"]] as const) {
      const ticket = await fixture.engine.getTicket(ticketId);
      const claim = await fixture.engine.claimReady({ requestId: `claim-${key}`, planId: fixture.planId, ticketId, expectedTicketVersion: ticket!.version, principalId, leaseDurationMs: 60_000 });
      await fixture.engine.applyTicket(ticketCommand(fixture.planId, ticketId, claim!, `complete-${key}`, completePayload()));
    }
    const qaBClaim = await fixture.engine.claimReady({ requestId: "claim-qa-b", planId: fixture.planId, ticketId: qaB!, expectedTicketVersion: (await fixture.engine.getTicket(qaB!))!.version, principalId: "qa", leaseDurationMs: 60_000 });
    await fixture.engine.applyTicket(ticketCommand(fixture.planId, qaB!, qaBClaim!, "complete-qa-b", completePayload()));
    const qaBBefore = await fixture.engine.getTicket(qaB!);
    const qaAClaim = await fixture.engine.claimReady({ requestId: "claim-qa-a", planId: fixture.planId, ticketId: qaA!, expectedTicketVersion: (await fixture.engine.getTicket(qaA!))!.version, principalId: "qa", leaseDurationMs: 60_000 });
    await fixture.engine.applyTicket(ticketCommand(fixture.planId, qaA!, qaAClaim!, "return-a", { type: "request_correction", targetTicketId: devA!, reason: "A 分支缺陷", evidence: [] }));

    expect(await fixture.engine.getTicket(devA!)).toMatchObject({ status: "completed" });
    expect(await fixture.engine.getTicket(qaA!)).toMatchObject({ status: "pending" });
    expect(await fixture.engine.getTicket(devB!)).toMatchObject({ status: "completed" });
    expect(await fixture.engine.getTicket(qaB!)).toEqual(qaBBefore);
    expect(await fixture.engine.getTicket(acceptance!)).toMatchObject({ status: "pending" });
    const changedPlan = await fixture.engine.getPlan(fixture.planId);
    const amendmentId = changedPlan.graph.ticketIds.find((ticketId) => ![planning, devA, qaA, devB, qaB, acceptance].includes(ticketId))!;
    expect(await fixture.engine.getTicket(amendmentId)).toMatchObject({ status: "ready" });
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

  it("rejects completion when the handoff does not satisfy the Ticket work contract", async () => {
    const fixture = await createFixture();
    const ticketId = fixture.plan.graph.ticketIds[0]!;
    const claim = await fixture.engine.claimReady({ requestId: "claim-invalid-handoff", planId: fixture.planId, ticketId, expectedTicketVersion: 1, principalId: "planner", leaseDurationMs: 60_000 });
    const result = await fixture.engine.applyTicket(ticketCommand(fixture.planId, ticketId, claim!, "invalid-handoff", {
      type: "complete",
      handoff: { schemaVersion: 1, summary: "口头完成", output: {}, evidence: [], criterionResults: [], residualRisks: [] },
    }));

    expect(result).toMatchObject({ accepted: false, code: "invalid_command", reason: expect.stringContaining("report all 1 success criteria") });
    expect(await fixture.engine.getTicket(ticketId)).toMatchObject({ status: "running", activeAttemptId: claim!.attemptId });
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
      definition: { title: "计划修订", assignment: fixture.plan.plannerAssignment, outputContract: { schemaRef: "change-v1" }, permissions: { amendPlan: true } },
    });
    expect(plan.graph.dependencyEdges).toContainEqual({ fromTicketId: amendmentId, toTicketId: fixture.qa });
    expect(await fixture.engine.getTicket(fixture.acceptance)).toMatchObject({ status: "pending" });
  });

  it("keeps completed development closed when QA waits for a human manual test", async () => {
    const fixture = await createExecutionFixture();
    const qaClaim = await fixture.engine.claimReady({
      requestId: "claim-qa-manual",
      planId: fixture.planId,
      ticketId: fixture.qa,
      expectedTicketVersion: 2,
      principalId: "qa",
      leaseDurationMs: 60_000,
    });

    const result = await fixture.engine.applyTicket(ticketCommand(fixture.planId, fixture.qa, qaClaim!, "qa-manual", {
      type: "block",
      reason: "静态检查完成，缺少浏览器交互环境",
      requiredInput: {
        kind: "manual_test",
        description: "请在浏览器中按步骤完成一局",
        details: { testFile: "index.html", steps: ["打开游戏", "完成一局"] },
      },
    }));

    expect(result).toMatchObject({ accepted: true, ticketStatus: "blocked", planStatus: "blocked" });
    expect(await fixture.engine.getTicket(fixture.dev)).toMatchObject({ status: "completed" });
    expect(await fixture.engine.getTicket(fixture.qa)).toMatchObject({
      status: "blocked",
      attempts: [{ requiredInput: { kind: "manual_test" } }],
    });
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
    const requiredInput = {
      kind: "manual_test" as const,
      description: "需要 human 在浏览器中完成交互测试",
      details: { testFile: "index.html", steps: ["完成一局"] },
    };
    const blocked = await fixture.engine.applyTicket(ticketCommand(fixture.planId, ticketId, claim!, "block", { type: "block", reason: "需要输入", requiredInput }));
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
      attempts: [{ status: "blocked", requiredInput }],
    });
  });

  it("restores a blocked Plan to blocked after an operator pause and resume", async () => {
    const fixture = await createFixture();
    const ticketId = fixture.plan.graph.ticketIds[0]!;
    const claim = await fixture.engine.claimReady({ requestId: "claim-pause", planId: fixture.planId, ticketId, expectedTicketVersion: 1, principalId: "planner", leaseDurationMs: 60_000 });
    await fixture.engine.applyTicket(ticketCommand(fixture.planId, ticketId, claim!, "block-pause", {
      type: "block",
      reason: "等待输入",
      requiredInput: { kind: "external_fact", description: "等待外部事实" },
    }));
    expect(await fixture.engine.applyPlan({ commandId: "pause", planId: fixture.planId, actorPrincipalId: "planner", issuedAt: now, payload: { type: "pause", expectedPlanVersion: 3 } }))
      .toMatchObject({ accepted: true, planStatus: "paused" });
    expect(await fixture.engine.applyPlan({ commandId: "resume", planId: fixture.planId, actorPrincipalId: "planner", issuedAt: now, payload: { type: "resume", expectedPlanVersion: 4 } }))
      .toMatchObject({ accepted: true, planStatus: "blocked" });
  });

  it("settles the active Attempt and revokes execution authority when the Plan is cancelled", async () => {
    const fixture = await createFixture();
    const ticketId = fixture.plan.graph.ticketIds[0]!;
    const claim = await fixture.engine.claimReady({ requestId: "claim-before-cancel", planId: fixture.planId, ticketId, expectedTicketVersion: 1, principalId: "planner", leaseDurationMs: 60_000 });

    expect(await fixture.engine.applyPlan({ commandId: "cancel-running-plan", planId: fixture.planId, actorPrincipalId: "planner", issuedAt: now, payload: { type: "cancel", expectedPlanVersion: 2, reason: "用户取消" } }))
      .toMatchObject({ accepted: true, planStatus: "cancelled" });
    expect(await fixture.engine.getTicket(ticketId)).toMatchObject({
      status: "cancelled",
      attempts: [{ attemptId: claim!.attemptId, attemptNumber: 1, status: "cancelled", endedAt: now, reason: "Plan cancelled" }],
    });
    expect(await fixture.engine.getTicket(ticketId)).not.toHaveProperty("activeAttemptId");
    expect(await fixture.engine.getTicket(ticketId)).not.toHaveProperty("activeAuthority");
  });
});

const now = "2026-07-14T00:00:00.000Z";
function draft(clientRef: string, title: string) { return { clientRef, title, objective: `完成 ${title}`, successCriteria: [`${title} 完成`], assignment: { principalId: "planner" }, outputContract: { schemaRef: "result-v1" } }; }
function completePayload(output: unknown = {}) { return { type: "complete" as const, handoff: { schemaVersion: 1 as const, summary: "工作完成", output, evidence: [], criterionResults: [{ criterionIndex: 0, status: "satisfied" as const, evidence: [] }], residualRisks: [] } }; }
async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-plan-"));
  const policy = createPlanPolicy({ policyId: "test", policyVersion: 1, grants: [
    { principalId: "planner", capabilities: ["plan:create", "plan:control", "ticket:claim", "blocked_ownership:transfer"] },
    { principalId: "dev", capabilities: ["ticket:claim"] },
    { principalId: "qa", capabilities: ["ticket:claim"] },
    { principalId: "boss", capabilities: ["ticket:claim"] },
  ] });
  const policyPort: PlanPolicyPort = { getPolicy: async (ref) => ref.contentHash === policy.ref.contentHash ? policy : undefined };
  const store = new TicketStore(root, "task", "run");
  const engine = new TicketEngine(store, policyPort);
  const planId = "f6f66a47-0c29-4c30-9461-f3de7525ad76" as PlanId;
  const command: PlanCommandEnvelope = { commandId: "create", planId, actorPrincipalId: "planner", issuedAt: now, payload: { type: "create_plan", missionId: "mission", definition: { definitionId: "test", definitionVersion: 1, policyRef: policy.ref, plannerAssignment: { principalId: "planner" }, amendmentTemplate: { title: "计划修订", successCriteria: ["完成修订"], outputContract: { schemaRef: "change-v1" } }, initialChange: { additions: [{ ...draft("planning", "计划拆解"), permissions: { amendPlan: true } }], dependencyAdditions: [], cancelTicketIds: [], requiredTerminalRefs: [{ clientRef: "planning" }] } } } };
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
  await fixture.engine.applyTicket(ticketCommand(fixture.planId, planning, planningClaim!, "complete-planning-chain", completePayload()));
  const plan = await fixture.engine.getPlan(fixture.planId);
  const [, dev, qa, acceptance] = plan.graph.ticketIds;
  const devClaim = await fixture.engine.claimReady({ requestId: "claim-dev-chain", planId: fixture.planId, ticketId: dev!, expectedTicketVersion: 2, principalId: "dev", leaseDurationMs: 60_000 });
  await fixture.engine.applyTicket(ticketCommand(fixture.planId, dev!, devClaim!, "complete-dev-chain", completePayload()));
  return { ...fixture, plan, planning, dev: dev!, qa: qa!, acceptance: acceptance! };
}
function ticketCommand(planId: PlanId, ticketId: TicketId, claim: NonNullable<Awaited<ReturnType<TicketEngine["claimReady"]>>>, commandId: string, payload: TicketCommandEnvelope["payload"]): TicketCommandEnvelope {
  return { commandId, proposalId: `proposal-${commandId}`, planId, ticketId, expectedTicketVersion: claim.ticketVersion, actorPrincipalId: claim.principalId, executionRef: "goal", authority: { kind: "claim", claimId: claim.claimId, fencingToken: claim.fencingToken }, issuedAt: now, payload };
}
