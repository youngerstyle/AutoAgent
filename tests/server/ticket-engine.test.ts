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

  it("rejects every Plan mutation after the required terminal Ticket completes", async () => {
    const fixture = await createFixture();
    const planning = fixture.plan.graph.ticketIds[0]!;
    const claim = await fixture.engine.claimReady({
      requestId: "claim-terminal-plan",
      planId: fixture.planId,
      ticketId: planning,
      expectedTicketVersion: 1,
      principalId: "planner",
      leaseDurationMs: 60_000,
    });
    await fixture.engine.applyTicket(ticketCommand(
      fixture.planId,
      planning,
      claim!,
      "complete-terminal-plan",
      completePayload(),
    ));

    const terminal = await fixture.engine.getPlan(fixture.planId);
    expect(terminal.status).toBe("completed");
    expect(terminal.version).toBeGreaterThan(1);

    const rejected = await fixture.engine.applyPlan({
      commandId: "append-after-terminal",
      planId: fixture.planId,
      actorPrincipalId: "planner",
      issuedAt: now,
      payload: {
        type: "apply_change",
        expectedPlanVersion: terminal.version,
        sourceTicketId: planning,
        sourceAuthority: {
          kind: "claim",
          claimId: claim!.claimId,
          fencingToken: claim!.fencingToken,
        },
        change: {
          additions: [draft("late", "终态后的追加")],
          dependencyAdditions: [{ from: { ticketId: planning }, to: { clientRef: "late" } }],
          cancelTicketIds: [],
          requiredTerminalRefs: [{ clientRef: "late" }],
        },
      },
    });

    expect(rejected).toMatchObject({ accepted: false, code: "plan_terminal" });
    const after = await fixture.engine.getPlan(fixture.planId);
    expect(after).toMatchObject({ status: "completed", version: terminal.version });
    expect(after.graph.ticketIds).toEqual(terminal.graph.ticketIds);
  });

  it("keeps completed work immutable across three sequential Plan revisions", async () => {
    const fixture = await createFixture();
    const planning = fixture.plan.graph.ticketIds[0]!;
    const planningClaim = await fixture.engine.claimReady({
      requestId: "claim-multi-revision-planning",
      planId: fixture.planId,
      ticketId: planning,
      expectedTicketVersion: 1,
      principalId: "planner",
      leaseDurationMs: 60_000,
    });
    const firstChange = await fixture.engine.applyPlan({
      commandId: "multi-revision-change-1",
      planId: fixture.planId,
      actorPrincipalId: "planner",
      issuedAt: now,
      payload: {
        type: "apply_change",
        expectedPlanVersion: 2,
        sourceTicketId: planning,
        sourceAuthority: { kind: "claim", claimId: planningClaim!.claimId, fencingToken: planningClaim!.fencingToken },
        change: {
          additions: [
            draft("work-1", "第一轮执行"),
            { ...draft("amend-1", "第一轮修订"), permissions: { amendPlan: true } },
          ],
          dependencyAdditions: [
            { from: { ticketId: planning }, to: { clientRef: "work-1" } },
            { from: { clientRef: "work-1" }, to: { clientRef: "amend-1" } },
          ],
          cancelTicketIds: [],
          requiredTerminalRefs: [{ clientRef: "amend-1" }],
        },
      },
    });
    expect(firstChange).toMatchObject({ accepted: true, planVersion: 3, planStatus: "active" });

    await fixture.engine.applyTicket(ticketCommand(fixture.planId, planning, planningClaim!, "multi-revision-complete-planning", completePayload()));
    const work1 = await findTicketByTitle(fixture.engine, fixture.planId, "第一轮执行");
    const amend1 = await findTicketByTitle(fixture.engine, fixture.planId, "第一轮修订");
    const work1Claim = await fixture.engine.claimReady({ requestId: "claim-multi-revision-work-1", planId: fixture.planId, ticketId: work1, expectedTicketVersion: 2, principalId: "planner", leaseDurationMs: 60_000 });
    await fixture.engine.applyTicket(ticketCommand(fixture.planId, work1, work1Claim!, "multi-revision-complete-work-1", completePayload({ revision: 1 })));

    const amend1Claim = await fixture.engine.claimReady({ requestId: "claim-multi-revision-amend-1", planId: fixture.planId, ticketId: amend1, expectedTicketVersion: 2, principalId: "planner", leaseDurationMs: 60_000 });
    const beforeSecond = await fixture.engine.getPlan(fixture.planId);
    const secondChange = await fixture.engine.applyPlan({
      commandId: "multi-revision-change-2",
      planId: fixture.planId,
      actorPrincipalId: "planner",
      issuedAt: now,
      payload: {
        type: "apply_change",
        expectedPlanVersion: beforeSecond.version,
        sourceTicketId: amend1,
        sourceAuthority: { kind: "claim", claimId: amend1Claim!.claimId, fencingToken: amend1Claim!.fencingToken },
        change: {
          additions: [
            draft("work-2", "第二轮执行"),
            { ...draft("amend-2", "第二轮修订"), permissions: { amendPlan: true } },
          ],
          dependencyAdditions: [
            { from: { ticketId: amend1 }, to: { clientRef: "work-2" } },
            { from: { clientRef: "work-2" }, to: { clientRef: "amend-2" } },
          ],
          cancelTicketIds: [],
          requiredTerminalRefs: [{ clientRef: "amend-2" }],
        },
      },
    });
    expect(secondChange).toMatchObject({ accepted: true, planVersion: beforeSecond.version + 1, planStatus: "active" });
    await fixture.engine.applyTicket(ticketCommand(fixture.planId, amend1, amend1Claim!, "multi-revision-complete-amend-1", completePayload({ revision: 2 })));

    const work2 = await findTicketByTitle(fixture.engine, fixture.planId, "第二轮执行");
    const amend2 = await findTicketByTitle(fixture.engine, fixture.planId, "第二轮修订");
    const work2Claim = await fixture.engine.claimReady({ requestId: "claim-multi-revision-work-2", planId: fixture.planId, ticketId: work2, expectedTicketVersion: 2, principalId: "planner", leaseDurationMs: 60_000 });
    await fixture.engine.applyTicket(ticketCommand(fixture.planId, work2, work2Claim!, "multi-revision-complete-work-2", completePayload({ revision: 2 })));

    const amend2Claim = await fixture.engine.claimReady({ requestId: "claim-multi-revision-amend-2", planId: fixture.planId, ticketId: amend2, expectedTicketVersion: 2, principalId: "planner", leaseDurationMs: 60_000 });
    const beforeThird = await fixture.engine.getPlan(fixture.planId);
    const thirdChange = await fixture.engine.applyPlan({
      commandId: "multi-revision-change-3",
      planId: fixture.planId,
      actorPrincipalId: "planner",
      issuedAt: now,
      payload: {
        type: "apply_change",
        expectedPlanVersion: beforeThird.version,
        sourceTicketId: amend2,
        sourceAuthority: { kind: "claim", claimId: amend2Claim!.claimId, fencingToken: amend2Claim!.fencingToken },
        change: {
          additions: [draft("work-3", "第三轮执行")],
          dependencyAdditions: [{ from: { ticketId: amend2 }, to: { clientRef: "work-3" } }],
          cancelTicketIds: [],
          requiredTerminalRefs: [{ clientRef: "work-3" }],
        },
      },
    });
    expect(thirdChange).toMatchObject({ accepted: true, planVersion: beforeThird.version + 1, planStatus: "active" });
    await fixture.engine.applyTicket(ticketCommand(fixture.planId, amend2, amend2Claim!, "multi-revision-complete-amend-2", completePayload({ revision: 3 })));

    const work3 = await findTicketByTitle(fixture.engine, fixture.planId, "第三轮执行");
    const work3Claim = await fixture.engine.claimReady({ requestId: "claim-multi-revision-work-3", planId: fixture.planId, ticketId: work3, expectedTicketVersion: 2, principalId: "planner", leaseDurationMs: 60_000 });
    await fixture.engine.applyTicket(ticketCommand(fixture.planId, work3, work3Claim!, "multi-revision-complete-work-3", completePayload({ revision: 3 })));

    const finalPlan = await fixture.engine.getPlan(fixture.planId);
    expect(finalPlan.status).toBe("completed");
    expect(finalPlan.version).toBeGreaterThan(beforeThird.version);
    expect(await fixture.engine.getTicket(planning)).toMatchObject({ status: "completed" });
    expect(await fixture.engine.getTicket(work1)).toMatchObject({ status: "completed" });
    expect(await fixture.engine.getTicket(work2)).toMatchObject({ status: "completed" });
    expect(await fixture.engine.getTicket(work3)).toMatchObject({ status: "completed" });
    expect(new Set(finalPlan.graph.ticketIds).size).toBe(finalPlan.graph.ticketIds.length);
    expect(finalPlan.graph.ticketIds).toHaveLength(6);
  });

  it("appends correction work and retries the same reporting Ticket without planner involvement", async () => {
    const fixture = await createExecutionFixture();
    const qaClaim = await fixture.engine.claimReady({ requestId: "claim-qa", planId: fixture.planId, ticketId: fixture.qa, expectedTicketVersion: 2, principalId: "qa", leaseDurationMs: 60_000 });
    const result = await fixture.engine.applyTicket(ticketCommand(fixture.planId, fixture.qa, qaClaim!, "correction-1", {
      type: "request_correction",
      targetTicketId: fixture.dev,
      reason: "射击碰撞没有生效",
      evidence: [{ evidenceId: "ev-qa-failure-1" }],
      handoff: completePayload({ findings: ["射击碰撞没有生效"] }).handoff,
    }));

    expect(result).toMatchObject({ accepted: true, ticketStatus: "pending", planStatus: "active" });
    expect((await fixture.engine.getTicket(fixture.qa))?.attempts.at(-1)?.handoff).toMatchObject({
      output: { findings: ["射击碰撞没有生效"] },
    });
    const plan = await fixture.engine.getPlan(fixture.planId);
    expect(plan.graph.ticketIds).toHaveLength(5);
    const correctionId = plan.graph.ticketIds.find((ticketId) => !fixture.plan.graph.ticketIds.includes(ticketId))!;
    expect(plan.graph.dependencyEdges).toContainEqual({ fromTicketId: fixture.dev, toTicketId: correctionId });
    expect(plan.graph.dependencyEdges).toContainEqual({ fromTicketId: correctionId, toTicketId: fixture.qa });
    expect(await fixture.engine.getTicket(fixture.dev)).toMatchObject({ status: "completed", attempts: [{ status: "completed", attemptNumber: 1 }] });
    expect(await fixture.engine.getTicket(fixture.qa)).toMatchObject({ status: "pending", attempts: [{ status: "returned", attemptNumber: 1, reason: "射击碰撞没有生效" }] });
    expect(await fixture.engine.getTicket(fixture.qa)).not.toHaveProperty("activeAuthority");
    expect(await fixture.engine.getTicket(fixture.acceptance)).toMatchObject({ status: "pending" });
    expect(await fixture.engine.getTicket(correctionId)).toMatchObject({ status: "ready", attempts: [] });
    expect(await fixture.engine.getWorkItem(correctionId)).toMatchObject({
      definition: {
        title: "开发",
        assignment: { principalId: "dev" },
        correction: { targetTicketId: fixture.dev, sourceTicketId: fixture.qa },
      },
    });
    expect(plan.completionPolicy.requiredTerminalTicketIds).toEqual([fixture.acceptance]);

    const correctionClaim = await fixture.engine.claimReady({
      requestId: "claim-correction",
      planId: fixture.planId,
      ticketId: correctionId,
      expectedTicketVersion: (await fixture.engine.getTicket(correctionId))!.version,
      principalId: "dev",
      leaseDurationMs: 60_000,
    });
    await fixture.engine.applyTicket(ticketCommand(
      fixture.planId,
      correctionId,
      correctionClaim!,
      "complete-correction",
      completePayload(),
    ));
    expect(await fixture.engine.getTicket(fixture.qa)).toMatchObject({ status: "ready" });
    expect(await fixture.engine.getTicket(fixture.acceptance)).toMatchObject({ status: "pending" });

    const retriedQa = await fixture.engine.getTicket(fixture.qa);
    const retriedQaClaim = await fixture.engine.claimReady({
      requestId: "claim-retried-qa",
      planId: fixture.planId,
      ticketId: fixture.qa,
      expectedTicketVersion: retriedQa!.version,
      principalId: "qa",
      leaseDurationMs: 60_000,
    });
    expect(retriedQaClaim).toMatchObject({ attemptId: expect.any(String) });
    expect(await fixture.engine.getTicket(fixture.qa)).toMatchObject({
      status: "running",
      attempts: [{ attemptNumber: 1, status: "returned" }, { attemptNumber: 2, status: "running" }],
    });
    await fixture.engine.applyTicket(ticketCommand(
      fixture.planId,
      fixture.qa,
      retriedQaClaim!,
      "complete-retried-qa",
      completePayload(),
    ));
    expect(await fixture.engine.getTicket(fixture.qa)).toMatchObject({ status: "completed" });
    expect(await fixture.engine.getTicket(fixture.acceptance)).toMatchObject({ status: "ready" });

    const events = await fixture.engine.readEvents({ planId: fixture.planId, limit: 100 });
    expect(events.events.find((event) => (
      event.aggregateType === "plan" && event.payload.type === "TicketCorrectionRequested"
    ))?.payload).toMatchObject({
      type: "TicketCorrectionRequested",
      correctionTicketId: correctionId,
      handoff: { output: { findings: ["射击碰撞没有生效"] } },
    });
    expect(events.events.some((event) => event.aggregateType === "plan" && event.payload.type === "PlanAmendmentRequested")).toBe(false);
  });

  it("retries only the reporting branch and preserves completed parallel work", async () => {
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
    await fixture.engine.applyTicket(ticketCommand(fixture.planId, qaA!, qaAClaim!, "return-a", {
      type: "request_correction",
      targetTicketId: devA!,
      reason: "A 分支缺陷",
      evidence: [],
      handoff: completePayload({ findings: ["A 分支缺陷"] }).handoff,
    }));

    expect(await fixture.engine.getTicket(devA!)).toMatchObject({ status: "completed" });
    expect(await fixture.engine.getTicket(qaA!)).toMatchObject({
      status: "pending",
      attempts: [{ status: "returned", attemptNumber: 1 }],
    });
    expect(await fixture.engine.getTicket(devB!)).toMatchObject({ status: "completed" });
    expect(await fixture.engine.getTicket(qaB!)).toEqual(qaBBefore);
    expect(await fixture.engine.getTicket(acceptance!)).toMatchObject({ status: "pending" });
    const changedPlan = await fixture.engine.getPlan(fixture.planId);
    const correctionId = changedPlan.graph.ticketIds.find((ticketId) => ![planning, devA, qaA, devB, qaB, acceptance].includes(ticketId))!;
    expect(await fixture.engine.getTicket(correctionId)).toMatchObject({ status: "ready" });
    expect(await fixture.engine.getWorkItem(correctionId)).toMatchObject({
      definition: {
        assignment: { principalId: "dev" },
        correction: { targetTicketId: devA, sourceTicketId: qaA },
      },
    });
    expect(changedPlan.completionPolicy.requiredTerminalTicketIds).toEqual([acceptance]);
  });

  it("rejects a correction target that is not a completed strict ancestor", async () => {
    const fixture = await createExecutionFixture();
    const qaClaim = await fixture.engine.claimReady({ requestId: "claim-qa-invalid", planId: fixture.planId, ticketId: fixture.qa, expectedTicketVersion: 2, principalId: "qa", leaseDurationMs: 60_000 });
    const result = await fixture.engine.applyTicket(ticketCommand(fixture.planId, fixture.qa, qaClaim!, "invalid-correction", {
      type: "request_correction",
      targetTicketId: fixture.qa,
      reason: "不能纠正自己",
      evidence: [],
      handoff: completePayload({ findings: ["不能纠正自己"] }).handoff,
    }));
    expect(result).toMatchObject({ accepted: false, code: "invalid_command" });
    expect((await fixture.engine.getPlan(fixture.planId)).graph.ticketIds).toHaveLength(4);
  });

  it("commits a structurally valid handoff without re-interpreting Agent domain criteria", async () => {
    const fixture = await createFixture();
    const ticketId = fixture.plan.graph.ticketIds[0]!;
    const claim = await fixture.engine.claimReady({ requestId: "claim-invalid-handoff", planId: fixture.planId, ticketId, expectedTicketVersion: 1, principalId: "planner", leaseDurationMs: 60_000 });
    const result = await fixture.engine.applyTicket(ticketCommand(fixture.planId, ticketId, claim!, "invalid-handoff", {
      type: "complete",
      handoff: { schemaVersion: 1, summary: "口头完成", output: {}, evidence: [], criterionResults: [], residualRisks: [] },
    }));

    expect(result).toMatchObject({ accepted: true });
    expect(await fixture.engine.getTicket(ticketId)).toMatchObject({ status: "completed" });
  });

  it("does not turn Mission contribution scope into extra Ticket success criteria", async () => {
    const fixture = await createFixture();
    const planning = fixture.plan.graph.ticketIds[0]!;
    const planningClaim = await fixture.engine.claimReady({
      requestId: "claim-contribution-plan",
      planId: fixture.planId,
      ticketId: planning,
      expectedTicketVersion: 1,
      principalId: "planner",
      leaseDurationMs: 60_000,
    });
    await fixture.engine.applyPlan({
      commandId: "append-contribution-work",
      planId: fixture.planId,
      actorPrincipalId: "planner",
      issuedAt: now,
      payload: {
        type: "apply_change",
        expectedPlanVersion: 2,
        sourceTicketId: planning,
        sourceAuthority: {
          kind: "claim",
          claimId: planningClaim!.claimId,
          fencingToken: planningClaim!.fencingToken,
        },
        change: {
          additions: [{
            ...draft("delivery", "开发交付"),
            assignment: { principalId: "dev" },
            missionContribution: { missionCriterionIds: ["mission-a", "mission-b"] },
          }],
          dependencyAdditions: [{ from: { ticketId: planning }, to: { clientRef: "delivery" } }],
          cancelTicketIds: [],
          requiredTerminalRefs: [{ clientRef: "delivery" }],
        },
      },
    });
    await fixture.engine.applyTicket(ticketCommand(
      fixture.planId,
      planning,
      planningClaim!,
      "complete-contribution-plan",
      completePayload(),
    ));
    const delivery = (await fixture.engine.getPlan(fixture.planId)).graph.ticketIds[1]!;
    const deliveryTicket = (await fixture.engine.getTicket(delivery))!;
    const deliveryClaim = await fixture.engine.claimReady({
      requestId: "claim-contribution-work",
      planId: fixture.planId,
      ticketId: delivery,
      expectedTicketVersion: deliveryTicket.version,
      principalId: "dev",
      leaseDurationMs: 60_000,
    });

    expect(await fixture.engine.applyTicket(ticketCommand(
      fixture.planId,
      delivery,
      deliveryClaim!,
      "complete-contribution-work",
      completePayload(),
    ))).toMatchObject({ accepted: true, ticketStatus: "completed" });
  });

  it("creates a planner amendment only for an explicit Plan change request", async () => {
    const fixture = await createExecutionFixture();
    const qaClaim = await fixture.engine.claimReady({ requestId: "claim-qa-replan", planId: fixture.planId, ticketId: fixture.qa, expectedTicketVersion: 2, principalId: "qa", leaseDurationMs: 60_000 });
    const result = await fixture.engine.applyTicket(ticketCommand(fixture.planId, fixture.qa, qaClaim!, "replan-1", {
      type: "request_plan_change",
      reason: "验收标准与 Mission 范围冲突",
      evidence: [],
    }));
    expect(result).toMatchObject({ accepted: true, ticketStatus: "returned", planStatus: "blocked" });
    const plan = await fixture.engine.getPlan(fixture.planId);
    const amendmentId = plan.graph.ticketIds.at(-1)!;
    expect(await fixture.engine.getWorkItem(amendmentId)).toMatchObject({
      ticket: { status: "ready" },
      definition: { title: "计划修订", assignment: fixture.plan.plannerAssignment, outputContract: { schemaRef: "change-v1" }, permissions: { amendPlan: true } },
    });
    expect(plan.graph.dependencyEdges).not.toContainEqual({ fromTicketId: amendmentId, toTicketId: fixture.qa });
    expect(await fixture.engine.getTicket(fixture.acceptance)).toMatchObject({ status: "pending" });
  });

  it("keeps a failed Ticket immutable and opens planner resolution when policy requires it", async () => {
    const fixture = await createExecutionFixture();
    const qaClaim = await fixture.engine.claimReady({
      requestId: "claim-qa-failure",
      planId: fixture.planId,
      ticketId: fixture.qa,
      expectedTicketVersion: 2,
      principalId: "qa",
      leaseDurationMs: 60_000,
    });

    const result = await fixture.engine.applyTicket(ticketCommand(fixture.planId, fixture.qa, qaClaim!, "qa-failure", {
      type: "fail",
      reason: "执行后仍无法满足成功标准",
      evidence: [],
    }));

    expect(result).toMatchObject({ accepted: true, ticketStatus: "failed", planStatus: "blocked" });
    expect(await fixture.engine.getTicket(fixture.qa)).toMatchObject({ status: "failed" });
    const plan = await fixture.engine.getPlan(fixture.planId);
    const amendmentId = plan.graph.ticketIds.at(-1)!;
    expect(await fixture.engine.getWorkItem(amendmentId)).toMatchObject({
      ticket: { status: "ready", parentTicketId: fixture.qa },
      definition: {
        title: "计划修订",
        objective: expect.stringContaining("失败事实"),
        assignment: fixture.plan.plannerAssignment,
        permissions: { amendPlan: true },
      },
    });
    expect(await fixture.engine.getTicket(fixture.acceptance)).toMatchObject({ status: "pending" });
  });

  it("keeps completed development closed when QA waits for a human manual test", async () => {
    const fixture = await createExecutionFixture();
    const before = await fixture.engine.getPlan(fixture.planId);
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
    const after = await fixture.engine.getPlan(fixture.planId);
    expect(after.graph.ticketIds).toEqual(before.graph.ticketIds);
    expect(after.graph.dependencyEdges).toEqual(before.graph.dependencyEdges);
    const events = await fixture.engine.readEvents({ planId: fixture.planId, limit: 100 });
    expect(events.events.some((event) => (
      event.aggregateType === "plan" && event.payload.type === "PlanAmendmentRequested"
    ))).toBe(false);
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

  it("releases blocked ownership and schedules replacement work from a planner amendment", async () => {
    const fixture = await createFixture();
    const planning = fixture.plan.graph.ticketIds[0]!;
    const planningClaim = await fixture.engine.claimReady({
      requestId: "claim-planning-before-replacement",
      planId: fixture.planId,
      ticketId: planning,
      expectedTicketVersion: 1,
      principalId: "planner",
      leaseDurationMs: 60_000,
    });
    await fixture.engine.applyPlan({
      commandId: "append-old-and-amendment",
      planId: fixture.planId,
      actorPrincipalId: "planner",
      issuedAt: now,
      payload: {
        type: "apply_change",
        expectedPlanVersion: 2,
        sourceTicketId: planning,
        sourceAuthority: {
          kind: "claim",
          claimId: planningClaim!.claimId,
          fencingToken: planningClaim!.fencingToken,
        },
        change: {
          additions: [
            draft("old", "旧验收"),
            { ...draft("amendment", "计划修订"), permissions: { amendPlan: true } },
          ],
          dependencyAdditions: [
            { from: { ticketId: planning }, to: { clientRef: "old" } },
            { from: { ticketId: planning }, to: { clientRef: "amendment" } },
          ],
          cancelTicketIds: [],
          requiredTerminalRefs: [{ clientRef: "old" }, { clientRef: "amendment" }],
        },
      },
    });
    await fixture.engine.applyTicket(ticketCommand(
      fixture.planId,
      planning,
      planningClaim!,
      "complete-planning-before-replacement",
      completePayload(),
    ));
    const preparedPlan = await fixture.engine.getPlan(fixture.planId);
    const oldTicketId = preparedPlan.graph.ticketIds[1]!;
    const amendmentTicketId = preparedPlan.graph.ticketIds[2]!;
    const oldClaim = await fixture.engine.claimReady({
      requestId: "claim-old-before-replacement",
      planId: fixture.planId,
      ticketId: oldTicketId,
      expectedTicketVersion: 2,
      principalId: "planner",
      leaseDurationMs: 60_000,
    });
    const blocked = await fixture.engine.applyTicket(ticketCommand(
      fixture.planId,
      oldTicketId,
      oldClaim!,
      "block-before-replacement",
      {
        type: "block",
        reason: "旧方案无法继续",
        requiredInput: { kind: "external_fact", description: "需要修订计划" },
      },
    ));
    if (!blocked.accepted || blocked.nextAuthority?.kind !== "blocked_owner") {
      throw new Error("Expected blocked ownership");
    }
    const amendmentClaim = await fixture.engine.claimReady({
      requestId: "claim-amendment-for-replacement",
      planId: fixture.planId,
      ticketId: amendmentTicketId,
      expectedTicketVersion: 2,
      principalId: "planner",
      leaseDurationMs: 60_000,
    });
    const planBeforeReplacement = await fixture.engine.getPlan(fixture.planId);

    const changed = await fixture.engine.applyPlan({
      commandId: "replace-blocked-ticket",
      planId: fixture.planId,
      actorPrincipalId: "planner",
      issuedAt: now,
      payload: {
        type: "apply_change",
        expectedPlanVersion: planBeforeReplacement.version,
        sourceTicketId: amendmentTicketId,
        sourceAuthority: {
          kind: "claim",
          claimId: amendmentClaim!.claimId,
          fencingToken: amendmentClaim!.fencingToken,
        },
        change: {
          additions: [draft("replacement", "替代计划")],
          dependencyAdditions: [{ from: { ticketId: amendmentTicketId }, to: { clientRef: "replacement" } }],
          cancelTicketIds: [oldTicketId],
          requiredTerminalRefs: [{ clientRef: "replacement" }],
        },
      },
    });

    if (!changed.accepted) throw new Error(`Expected replacement Plan change to be accepted: ${JSON.stringify(changed)}`);
    expect(changed).toMatchObject({ planStatus: "active" });
    const plan = await fixture.engine.getPlan(fixture.planId);
    const replacement = plan.graph.ticketIds.find((id) => !preparedPlan.graph.ticketIds.includes(id));
    expect(replacement).toBeDefined();
    const cancelledTicket = await fixture.engine.getTicket(oldTicketId);
    const replacementTicket = await fixture.engine.getTicket(replacement!);
    expect(cancelledTicket).toMatchObject({ status: "cancelled" });
    expect(cancelledTicket).not.toHaveProperty("activeAuthority");
    expect(replacementTicket).toMatchObject({ status: "pending" });
    expect(replacementTicket).not.toHaveProperty("activeAuthority");

    await fixture.engine.applyTicket(ticketCommand(
      fixture.planId,
      amendmentTicketId,
      amendmentClaim!,
      "complete-amendment-for-replacement",
      completePayload(),
    ));
    expect(await fixture.engine.getTicket(replacement!)).toMatchObject({ status: "ready" });
  });

  it("cancels obsolete ready branches outside the replacement completion closure", async () => {
    const fixture = await createFixture();
    const planning = fixture.plan.graph.ticketIds[0]!;
    const planningClaim = await fixture.engine.claimReady({
      requestId: "claim-planning-before-supersede",
      planId: fixture.planId,
      ticketId: planning,
      expectedTicketVersion: 1,
      principalId: "planner",
      leaseDurationMs: 60_000,
    });
    await fixture.engine.applyPlan({
      commandId: "append-parallel-old-branch",
      planId: fixture.planId,
      actorPrincipalId: "planner",
      issuedAt: now,
      payload: {
        type: "apply_change",
        expectedPlanVersion: 2,
        sourceTicketId: planning,
        sourceAuthority: {
          kind: "claim",
          claimId: planningClaim!.claimId,
          fencingToken: planningClaim!.fencingToken,
        },
        change: {
          additions: [
            draft("obsolete", "旧待执行分支"),
            { ...draft("amendment", "计划修订"), permissions: { amendPlan: true } },
          ],
          dependencyAdditions: [
            { from: { ticketId: planning }, to: { clientRef: "obsolete" } },
            { from: { ticketId: planning }, to: { clientRef: "amendment" } },
          ],
          cancelTicketIds: [],
          requiredTerminalRefs: [{ clientRef: "obsolete" }, { clientRef: "amendment" }],
        },
      },
    });
    await fixture.engine.applyTicket(ticketCommand(
      fixture.planId,
      planning,
      planningClaim!,
      "complete-planning-before-supersede",
      completePayload(),
    ));
    const preparedPlan = await fixture.engine.getPlan(fixture.planId);
    const obsoleteTicketId = preparedPlan.graph.ticketIds[1]!;
    const amendmentTicketId = preparedPlan.graph.ticketIds[2]!;
    expect(await fixture.engine.getTicket(obsoleteTicketId)).toMatchObject({ status: "ready" });
    const amendmentClaim = await fixture.engine.claimReady({
      requestId: "claim-amendment-for-supersede",
      planId: fixture.planId,
      ticketId: amendmentTicketId,
      expectedTicketVersion: 2,
      principalId: "planner",
      leaseDurationMs: 60_000,
    });
    const planBeforeReplacement = await fixture.engine.getPlan(fixture.planId);

    const changed = await fixture.engine.applyPlan({
      commandId: "supersede-without-explicit-cancel",
      planId: fixture.planId,
      actorPrincipalId: "planner",
      issuedAt: now,
      payload: {
        type: "apply_change",
        expectedPlanVersion: planBeforeReplacement.version,
        sourceTicketId: amendmentTicketId,
        sourceAuthority: {
          kind: "claim",
          claimId: amendmentClaim!.claimId,
          fencingToken: amendmentClaim!.fencingToken,
        },
        change: {
          additions: [draft("replacement", "替代交付链")],
          dependencyAdditions: [{ from: { ticketId: amendmentTicketId }, to: { clientRef: "replacement" } }],
          cancelTicketIds: [],
          requiredTerminalRefs: [{ clientRef: "replacement" }],
        },
      },
    });

    expect(changed).toMatchObject({ accepted: true, planStatus: "active" });
    expect(await fixture.engine.getTicket(obsoleteTicketId)).toMatchObject({ status: "cancelled" });
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

  it("does not apply a late Agent command while the Plan is paused", async () => {
    const fixture = await createFixture();
    const ticketId = fixture.plan.graph.ticketIds[0]!;
    const claim = await fixture.engine.claimReady({ requestId: "claim-late-command", planId: fixture.planId, ticketId, expectedTicketVersion: 1, principalId: "planner", leaseDurationMs: 60_000 });
    expect(claim).toBeDefined();
    expect(await fixture.engine.applyPlan({
      commandId: "pause-before-late-command",
      planId: fixture.planId,
      actorPrincipalId: "planner",
      issuedAt: now,
      payload: { type: "pause", expectedPlanVersion: 2 },
    })).toMatchObject({ accepted: true, planStatus: "paused" });

    const late = await fixture.engine.applyTicket(ticketCommand(fixture.planId, ticketId, claim!, "late-command-after-pause", {
      type: "block",
      reason: "provider request was aborted by operator pause",
      requiredInput: { kind: "credential", description: "should not become a Ticket blocker" },
    }));

    expect(late).toMatchObject({ accepted: false, code: "plan_paused" });
    expect(await fixture.engine.getPlan(fixture.planId)).toMatchObject({ status: "paused" });
    expect(await fixture.engine.getTicket(ticketId)).toMatchObject({ status: "running" });
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
async function findTicketByTitle(engine: TicketEngine, planId: PlanId, title: string): Promise<TicketId> {
  const plan = await engine.getPlan(planId);
  for (const ticketId of plan.graph.ticketIds) {
    const work = await engine.getWorkItem(ticketId);
    if (work?.definition.title === title) return ticketId;
  }
  throw new Error(`Ticket not found: ${title}`);
}
function ticketCommand(planId: PlanId, ticketId: TicketId, claim: NonNullable<Awaited<ReturnType<TicketEngine["claimReady"]>>>, commandId: string, payload: TicketCommandEnvelope["payload"]): TicketCommandEnvelope {
  return { commandId, proposalId: `proposal-${commandId}`, planId, ticketId, expectedTicketVersion: claim.ticketVersion, actorPrincipalId: claim.principalId, executionRef: "goal", authority: { kind: "claim", claimId: claim.claimId, fencingToken: claim.fencingToken }, issuedAt: now, payload };
}
