import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PlanId, TicketId } from "../../src/shared/contracts/ticket-engine.js";
import { TicketStore, TicketStoreCorruptionError } from "../../src/server/tickets/ticket-store.js";

describe("TicketStore v4", () => {
  it("reloads one Plan and immutable UUID Tickets", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ticket-store-v3-"));
    const store = new TicketStore(root, "task", "run");
    const planId = "a1e40b41-65dc-4be3-b07d-f3dd86e32955" as PlanId;
    const ticketId = "8e7b647f-fd65-4cbc-936c-b6aaf63510ab" as TicketId;
    await store.create(seed(planId, ticketId));
    const reloaded = await new TicketStore(root, "task", "run").read(planId);
    expect(reloaded?.schemaVersion).toBe(4);
    expect(reloaded?.plan.graph.ticketIds).toEqual([ticketId]);
    expect(reloaded?.definitionsByTicketId[ticketId].title).toBe("开发");
  });

  it("rejects changing a terminal Ticket in a transaction", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ticket-store-v3-"));
    const store = new TicketStore(root, "task", "run");
    const planId = "a1e40b41-65dc-4be3-b07d-f3dd86e32955" as PlanId;
    const ticketId = "8e7b647f-fd65-4cbc-936c-b6aaf63510ab" as TicketId;
    const created = await store.create({ ...seed(planId, ticketId), tickets: [{ ticketId, planId, version: 2, status: "completed" }] });
    await expect(store.transact(planId, { aggregateVersion: created.aggregateVersion, planVersion: created.plan.version }, (current) => ({ ...current, plan: { ...current.plan, version: current.plan.version + 1 }, tickets: [{ ...current.tickets[0], status: "ready", version: 3 }] }))).rejects.toBeInstanceOf(TicketStoreCorruptionError);
  });
});

function seed(planId: PlanId, ticketId: TicketId) {
  return {
    schemaVersion: 4 as const,
    plan: { planId, missionId: "mission", version: 1, status: "active" as const, graph: { schemaVersion: 3 as const, ticketIds: [ticketId], dependencyEdges: [] }, completionPolicy: { requiredTerminalTicketIds: [ticketId], failurePolicy: "require_resolution" as const, blockedPolicy: "wait" as const }, policyRef: { policyId: "p", policyVersion: 1, contentHash: "sha256:test" }, plannerAssignment: {} },
    definitionsByTicketId: { [ticketId]: { title: "开发", objective: "实现", successCriteria: ["完成"], assignment: {}, outputContract: { schemaRef: "result-v1" } } },
    tickets: [{ ticketId, planId, version: 1, status: "ready" as const }],
  };
}
