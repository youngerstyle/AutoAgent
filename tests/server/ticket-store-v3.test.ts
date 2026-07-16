import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PlanId, TicketId } from "../../src/shared/contracts/ticket-engine.js";
import { TicketStore, TicketStoreCorruptionError } from "../../src/server/tickets/ticket-store.js";

describe("TicketStore v5", () => {
  it("reloads one Plan and immutable UUID Tickets", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ticket-store-v3-"));
    const store = new TicketStore(root, "task", "run");
    const planId = "a1e40b41-65dc-4be3-b07d-f3dd86e32955" as PlanId;
    const ticketId = "8e7b647f-fd65-4cbc-936c-b6aaf63510ab" as TicketId;
    await store.create(seed(planId, ticketId));
    const reloaded = await new TicketStore(root, "task", "run").read(planId);
    expect(reloaded?.schemaVersion).toBe(5);
    expect(reloaded?.plan.graph.ticketIds).toEqual([ticketId]);
    expect(reloaded?.definitionsByTicketId[ticketId].title).toBe("开发");
  });

  it("allows reopening a Ticket but rejects changing an ended Attempt", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ticket-store-v3-"));
    const store = new TicketStore(root, "task", "run");
    const planId = "a1e40b41-65dc-4be3-b07d-f3dd86e32955" as PlanId;
    const ticketId = "8e7b647f-fd65-4cbc-936c-b6aaf63510ab" as TicketId;
    const attempt = { attemptId: "attempt-1", attemptNumber: 1, status: "completed" as const, principalId: "dev", startedAt: "2026-07-16T00:00:00.000Z", endedAt: "2026-07-16T00:01:00.000Z" };
    const created = await store.create({ ...seed(planId, ticketId), tickets: [{ ticketId, planId, version: 2, status: "completed", attempts: [attempt] }] });
    const reopened = await store.transact(planId, { aggregateVersion: created.aggregateVersion, planVersion: created.plan.version }, (current) => ({ ...current, plan: { ...current.plan, version: current.plan.version + 1 }, tickets: [{ ...current.tickets[0], status: "ready", version: 3 }] }));
    await expect(store.transact(planId, { aggregateVersion: reopened.aggregateVersion, planVersion: reopened.plan.version }, (current) => ({ ...current, plan: { ...current.plan, version: current.plan.version + 1 }, tickets: [{ ...current.tickets[0], attempts: [{ ...attempt, reason: "篡改历史" }], version: 4 }] }))).rejects.toBeInstanceOf(TicketStoreCorruptionError);
  });
});

function seed(planId: PlanId, ticketId: TicketId) {
  return {
    schemaVersion: 5 as const,
    plan: { planId, missionId: "mission", version: 1, status: "active" as const, graph: { schemaVersion: 3 as const, ticketIds: [ticketId], dependencyEdges: [] }, completionPolicy: { requiredTerminalTicketIds: [ticketId], failurePolicy: "require_resolution" as const, blockedPolicy: "wait" as const }, policyRef: { policyId: "p", policyVersion: 1, contentHash: "sha256:test" }, plannerAssignment: {}, amendmentTemplate: { title: "计划修订", successCriteria: ["完成修订"], outputContract: { schemaRef: "change-v1" } } },
    definitionsByTicketId: { [ticketId]: { title: "开发", objective: "实现", successCriteria: ["完成"], assignment: {}, outputContract: { schemaRef: "result-v1" } } },
    tickets: [{ ticketId, planId, version: 1, status: "ready" as const, attempts: [] }],
  };
}
