import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MissionStore, MissionStoreConflictError } from "../../src/server/mission-process/mission-store.js";
import type { MissionRecord } from "../../src/shared/contracts/mission-control.js";
import type { WorkflowId } from "../../src/shared/contracts/ticket-engine.js";

describe("MissionStore", () => {
  it("persists saga links, namespaced cursors and steps across restart", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-mission-store-"));
    const store = new MissionStore(root, "mission-a");
    await store.create(record);
    await store.transact(1, (current) => ({
      ...current,
      version: 2,
      links: [dispatchingLink()],
      cursors: [{ partition: "ticket:workflow-a", cursor: { position: "1" }, appliedVersions: { "ticket-a": 1 } }],
      steps: [{ stepId: "dispatch-a", fingerprint: "hash-a", result: { ok: true } }],
    }));

    const restored = await new MissionStore(root, "mission-a").read();
    expect(restored).toMatchObject({ version: 2, links: [{ status: "dispatching" }] });
    expect(restored?.cursors[0]?.partition).toBe("ticket:workflow-a");
  });

  it("rejects stale writers", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-mission-store-"));
    const store = new MissionStore(root, "mission-a");
    await store.create(record);
    await store.transact(1, (current) => ({ ...current, version: 2 }));
    await expect(store.transact(1, (current) => ({ ...current, version: 2 })))
      .rejects.toBeInstanceOf(MissionStoreConflictError);
  });
});

const record: MissionRecord = {
  missionId: "mission-a",
  workflowId: "workflow-a" as WorkflowId,
  workflowCreateCommandId: "create-a",
  status: "starting",
};

function dispatchingLink() {
  return {
    dispatchId: "dispatch-a",
    missionId: "mission-a",
    workflowId: "workflow-a" as WorkflowId,
    ticketId: "ticket-a" as never,
    ticketVersion: 1,
    agentId: "dev",
    agentPrincipalId: "principal-dev",
    claimRequestId: "claim-a",
    goalStartKey: "goal-a",
    updatedAt: "2026-07-10T00:00:00.000Z",
    status: "dispatching" as const,
  };
}
