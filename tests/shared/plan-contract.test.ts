import { describe, expect, it } from "vitest";

import {
  PLAN_STATUSES,
  type PlanChangeSet,
  type PlanGraphSnapshot,
  type PlanId,
  type PlanSnapshot,
  type TicketId,
} from "../../src/shared/contracts/ticket-engine.js";
import type { MissionRecord } from "../../src/shared/contracts/mission-control.js";

describe("single Plan runtime contract", () => {
  it("models one independently identified Plan for a Mission", () => {
    const planId = "8e2eb172-3482-4ec1-8a9f-cf2d686bfa29" as PlanId;
    const graph = {
      schemaVersion: 3,
      ticketIds: ["0f25cf43-5128-4a45-b07c-a7ce2df5c81a" as TicketId],
      dependencyEdges: [],
    } satisfies PlanGraphSnapshot;
    const plan = {
      planId,
      missionId: "mission-1",
      version: 1,
      status: "active",
      graph,
      completionPolicy: {
        requiredTerminalTicketIds: graph.ticketIds,
        failurePolicy: "require_resolution",
        blockedPolicy: "wait",
      },
      policyRef: { policyId: "policy-1", policyVersion: 1, contentHash: "sha256:test" },
      plannerAssignment: { requiredCapabilities: ["plan:plan"] },
    } satisfies PlanSnapshot;
    const mission = {
      missionId: plan.missionId,
      objective: "build",
      planId,
      planCreateCommandId: "create-plan-1",
      status: "linked",
      linkedAt: "2026-07-14T00:00:00.000Z",
    } satisfies MissionRecord;

    expect(PLAN_STATUSES).toEqual([
      "active",
      "paused",
      "blocked",
      "completed",
      "failed",
      "cancelled",
    ]);
    expect(mission.planId).toBe(plan.planId);
  });

  it("uses command-local references while persisted graph contains Ticket IDs only", () => {
    const change = {
      additions: [
        {
          clientRef: "implementation",
          title: "开发实现",
          objective: "实现功能并提供可验证证据",
          successCriteria: ["测试通过"],
          assignment: { requiredCapabilities: ["implementation"] },
          outputContract: { schemaRef: "implementation-result-v1" },
        },
      ],
      dependencyAdditions: [
        {
          from: { ticketId: "6cc8f9ca-9f30-40d7-9a76-54f51e00f81a" as TicketId },
          to: { clientRef: "implementation" },
        },
      ],
      cancelTicketIds: [],
      requiredTerminalRefs: [{ clientRef: "implementation" }],
    } satisfies PlanChangeSet;

    expect(change.additions[0].clientRef).toBe("implementation");
    if (false) {
      const invalidGraph = {
        schemaVersion: 3,
        ticketIds: [],
        dependencyEdges: [],
        // @ts-expect-error Persistent Plan graphs do not store semantic node keys.
        nodeKey: "implementation",
      } satisfies PlanGraphSnapshot;
      void invalidGraph;
    }
  });
});
