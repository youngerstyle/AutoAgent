import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { EvolutionPairedTrialRequest } from "../../src/shared/contracts/evolution.js";
import { EvolutionPairedTrialStore } from "../../src/server/evolution/paired-trial-store.js";

describe("Evolution paired trial store", () => {
  it("persists an idempotent paired real-task request and its recoverable lifecycle", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-paired-trial-"));
    const now = () => new Date("2026-08-19T02:00:00.000Z");
    const store = new EvolutionPairedTrialStore("workspace-a", root, now);
    const request = fixtureRequest("workspace-a");

    const created = await store.enqueue("trial-command-a", request);
    expect(await store.enqueue("trial-command-a", request)).toEqual(created);
    await expect(store.enqueue("trial-command-a", { ...request, runtimeSnapshotRef: "changed" })).rejects.toThrow("idempotency conflict");

    const dispatched = await store.markDispatched(created.trialId, "mission-pair-a");
    expect(dispatched).toMatchObject({ status: "dispatched", dispatchRef: "mission-pair-a" });
    expect(await new EvolutionPairedTrialStore("workspace-a", root, now).get(created.trialId)).toMatchObject({ status: "dispatched" });

    const failed = await store.fail(created.trialId, { status: "inconclusive", category: "transient", message: "provider token secret-123\nnot enough samples" });
    expect(failed).toMatchObject({ status: "inconclusive", lastError: { category: "transient" } });
    expect(failed.lastError?.message).not.toContain("\n");
    expect(await store.list()).toHaveLength(1);
  });

  it("rejects a trial case that crosses its workspace boundary", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-paired-trial-scope-"));
    await expect(new EvolutionPairedTrialStore("workspace-a", root).enqueue("trial-command", fixtureRequest("workspace-b")))
      .rejects.toThrow("local evidence");
  });
});

function fixtureRequest(workspaceId: string): EvolutionPairedTrialRequest {
  const ref = (id: string) => ({ id, version: "1", contentHash: id.repeat(64).slice(0, 64) });
  const inputRef = { kind: "evidence" as const, ref: "evidence-a", workspaceId };
  return {
    candidateId: "candidate-a", expectedContentHash: "a".repeat(64), suiteRef: ref("b"), baselineRef: ref("c"),
    runtimeSnapshotRef: "runtime-snapshot-a", policyRef: ref("d"),
    cases: [
      { caseId: "target", group: "target", partition: "historical", inputRef, assertions: ["task succeeds"] },
      { caseId: "regression", group: "regression", partition: "sealed_holdout", inputRef, assertions: ["quality does not regress"] },
      { caseId: "safety", group: "safety", partition: "sealed_holdout", inputRef, assertions: ["policy remains satisfied"] },
    ],
  };
}
