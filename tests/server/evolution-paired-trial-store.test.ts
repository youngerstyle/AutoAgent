import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { EvolutionPairedTrialRequest } from "../../src/shared/contracts/evolution.js";
import { EvolutionPairedTrialStore } from "../../src/server/evolution/paired-trial-store.js";
import { RuntimeHostStore, type RuntimeTaskRecord } from "../../src/server/runtime/runtime-host-store.js";
import { reconcileTerminalEvolutionTrialTasks } from "../../src/server/runtime/runtime-host-registry.js";
import type { Workspace } from "../../src/shared/types.js";

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
    expect(failed).toMatchObject({ status: "retry_wait", attempts: 1, lastError: { category: "transient" } });
    expect(failed.lastError?.message).not.toContain("\n");
    expect(await store.list()).toHaveLength(1);
  });

  it("rejects a trial case that crosses its workspace boundary", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-paired-trial-scope-"));
    await expect(new EvolutionPairedTrialStore("workspace-a", root).enqueue("trial-command", fixtureRequest("workspace-b")))
      .rejects.toThrow("locally resolvable authoritative facts");
  });

  it("accepts local human feedback and Ticket facts as frozen trial inputs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-paired-trial-facts-"));
    const request = fixtureRequest("workspace-a");
    request.cases[0]!.inputRef = { kind: "human_feedback", ref: "message-a", workspaceId: "workspace-a", agentId: "agent-a" };
    request.cases[1]!.inputRef = { kind: "ticket", ref: "ticket-a", workspaceId: "workspace-a", taskId: "task-a", taskRunId: "run-a" };
    expect(await new EvolutionPairedTrialStore("workspace-a", root).enqueue("trial-authoritative-facts", request)).toMatchObject({ status: "pending" });
  });

  it("suppresses terminal and orphan trial tasks during Runtime recovery while preserving live trials", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-paired-trial-recovery-"));
    const workspace: Workspace = { id: "workspace-a", name: "Workspace", rootPath: root, policyProfile: "development", createdAt: "2026-08-19T02:00:00.000Z" };
    const trials = new EvolutionPairedTrialStore(workspace.id, root);
    const terminal = await trials.enqueue("terminal-trial", fixtureRequest(workspace.id));
    await trials.fail(terminal.trialId, { status: "failed", category: "terminal", message: "evaluation complete" });
    const live = await trials.enqueue("live-trial", { ...fixtureRequest(workspace.id), candidateId: "candidate-live" });
    const runtime = new RuntimeHostStore(root);
    await runtime.save(trialTask("terminal-task", terminal.trialId));
    await runtime.save(trialTask("live-task", live.trialId));
    await runtime.save(trialTask("orphan-task", "paired_trial_missing"));

    expect(await reconcileTerminalEvolutionTrialTasks(workspace, runtime, () => new Date("2026-08-19T03:00:00.000Z")))
      .toEqual(["terminal-task", "orphan-task"]);
    expect(await runtime.get("terminal-task")).toMatchObject({ status: "cancelled", runtimeError: { source: "scheduler", message: expect.stringContaining("is failed") } });
    expect(await runtime.get("orphan-task")).toMatchObject({ status: "cancelled", runtimeError: { message: expect.stringContaining("is missing") } });
    const liveTask = await runtime.get("live-task");
    expect(liveTask).toMatchObject({ status: "active" });
    expect(liveTask).not.toHaveProperty("runtimeError");
  });
});

function trialTask(taskId: string, trialId: string): RuntimeTaskRecord {
  return {
    taskId, runId: `run-${taskId}`, missionId: `mission-${taskId}`, title: taskId, objective: taskId, status: "active",
    evolutionTrial: { trialId, candidateId: "candidate-a", candidateHash: "a".repeat(64), baselineRef: { id: "baseline-a", version: "1", contentHash: "b".repeat(64) }, caseId: "case-a", group: "target", variant: "candidate", assertions: ["task succeeds"] },
    createdAt: "2026-08-19T02:00:00.000Z", updatedAt: "2026-08-19T02:00:00.000Z",
  };
}

export function fixtureRequest(workspaceId: string): EvolutionPairedTrialRequest {
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
