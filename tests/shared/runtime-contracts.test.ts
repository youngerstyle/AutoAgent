import { describe, expect, expectTypeOf, it } from "vitest";
import { AGENT_GOAL_STATUSES, type AgentGoalStatus, type SendAgentMessageRequest } from "../../src/shared/contracts/agent-engine.js";
import { PLAN_STATUSES, type ClaimCommandEnvelope, type PlanCommandEnvelope, type PlanId, type TicketCommandPayload, type TicketEvent, type TicketId } from "../../src/shared/contracts/ticket-engine.js";
import { classifyRuntimeRecord, classifyRuntimeRecordVersion, type MissionRecord } from "../../src/shared/contracts/mission-control.js";

describe("Agent Engine runtime contracts", () => {
  it("keeps human messages in the ordinary chronological Thread protocol", () => {
    const message = { messageId: "m1", threadId: "th1", goalId: "g1", senderPrincipalId: "human", content: "继续", createdAt: "2026-07-14T00:00:00.000Z" } satisfies SendAgentMessageRequest;
    expect(message.content).toBe("继续");
    expectTypeOf<(typeof AGENT_GOAL_STATUSES)[number]>().toEqualTypeOf<AgentGoalStatus>();
  });
});

describe("Ticket Engine runtime contracts", () => {
  it("uses Plan as the only Ticket partition", () => {
    const planId = "5deef401-b641-402d-b879-84909d3a2061" as PlanId;
    const ticketId = "e529480a-9364-4370-887d-e57cd4e09228" as TicketId;
    const create = { commandId: "c1", planId, actorPrincipalId: "planner", issuedAt: "2026-07-14T00:00:00.000Z", payload: { type: "create_plan", missionId: "mission", definition: { definitionId: "d", definitionVersion: 1, policyRef: { policyId: "p", policyVersion: 1, contentHash: "hash" }, plannerAssignment: {}, amendmentTemplate: { title: "修订", successCriteria: ["完成修订"], outputContract: { schemaRef: "change-v1" } }, initialChange: { additions: [{ clientRef: "work", title: "工作", objective: "完成", successCriteria: ["完成"], assignment: {}, outputContract: { schemaRef: "result-v1" } }], dependencyAdditions: [], cancelTicketIds: [], requiredTerminalRefs: [{ clientRef: "work" }] } } } } satisfies PlanCommandEnvelope;
    const claim = { commandId: "c2", planId, actorPrincipalId: "agent", issuedAt: "2026-07-14T00:00:00.000Z", payload: { type: "claim", requestId: "r1", ticketId, expectedTicketVersion: 1, leaseDurationMs: 1000 } } satisfies ClaimCommandEnvelope;
    expect(create.payload.type).toBe("create_plan");
    expect(claim.planId).toBe(planId);
    expect(PLAN_STATUSES).toContain("active");
  });

  it("keeps Ticket commands closed and role-agnostic", () => {
    const accept = (_payload: TicketCommandPayload) => undefined;
    accept({
      type: "complete",
      handoff: { schemaVersion: 1, summary: "完成工作", output: {}, evidence: [], criterionResults: [], residualRisks: [] },
    });
    if (false) {
      // @ts-expect-error Ticket Engine never routes directly to a team role.
      accept({ type: "advance_to_role", role: "qa" });
    }
  });

  it("binds events to Plan IDs", () => {
    const planId = "5deef401-b641-402d-b879-84909d3a2061" as PlanId;
    const event: TicketEvent<"plan"> = { eventId: "e", planId, aggregateType: "plan", aggregateId: planId, aggregateVersion: 1, occurredAt: "2026-07-14T00:00:00.000Z", payload: { type: "PlanStatusChanged", status: "active" } };
    expect(event.planId).toBe(planId);
  });
});

describe("Mission Control runtime contracts", () => {
  it("stores exactly one Plan identity per Mission in schema v3", () => {
    const record = { missionId: "mission", objective: "完成项目目标", planId: "5deef401-b641-402d-b879-84909d3a2061" as PlanId, planCreateCommandId: "create", status: "linked", linkedAt: "2026-07-14T00:00:00.000Z" } satisfies MissionRecord;
    expect(record.planId).toBeDefined();
    expect(record.objective).toBe("完成项目目标");
  });

  it("keeps v2 runtime records read-only and schedules only v3", () => {
    const v2 = { engine: "ticket_agent", schemaVersion: 2, record: {} };
    const v3 = { engine: "ticket_agent", schemaVersion: 3, record: { missionId: "m", objective: "goal", planId: "p", planCreateCommandId: "c", status: "starting" } };
    expect(classifyRuntimeRecordVersion(v2)).toBe("ticket_agent@2");
    expect(classifyRuntimeRecord(v2).schedulable).toBe(false);
    expect(classifyRuntimeRecordVersion(v3)).toBe("ticket_agent@3");
    expect(classifyRuntimeRecord(v3).schedulable).toBe(true);
  });
});
