import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EvaluationJobStore } from "../../src/server/evolution/evaluation-job-store.js";

describe("evolution evaluation job reliability", () => {
  it("provides durable command idempotency, leases, bounded retry, redaction, and stale-owner rejection", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-evaluation-jobs-"));
    let time = Date.parse("2026-08-14T03:00:00.000Z");
    const now = () => new Date(time);
    const jobs = new EvaluationJobStore("workspace-a", root, now);
    const request = evaluationRequest();
    const queued = await jobs.enqueue("evaluation-request-a", request, 3);
    expect((await new EvaluationJobStore("workspace-a", root, now).enqueue("evaluation-request-a", request, 3)).jobId).toBe(queued.jobId);
    await expect(jobs.enqueue("evaluation-request-a", { ...request, runtimeSnapshotRef: "changed" }, 3))
      .rejects.toMatchObject({ code: "EVOLUTION_EVALUATION_JOB_CONFLICT" });

    const first = await jobs.claim("worker-a", 1_000);
    expect(first).toMatchObject({ status: "running", attempts: 1, lease: { workerId: "worker-a" } });
    await expect(jobs.claim("worker-b", 1_000)).resolves.toBeUndefined();
    const waiting = await jobs.fail(first!.jobId, first!.lease!.token, { category: "transient", message: "api_key=sk-abcdefghijklmnop" });
    expect(waiting).toMatchObject({ status: "retry_wait", lastError: { message: "api_key=[REDACTED]" } });

    time += 1_000;
    const retried = await jobs.claim("worker-b", 1_000);
    expect(retried).toMatchObject({ status: "running", attempts: 2 });
    const heartbeated = await jobs.heartbeat(retried!.jobId, retried!.lease!.token, 2_000);
    expect(Date.parse(heartbeated.lease!.expiresAt)).toBe(time + 2_000);
    await expect(jobs.succeed(retried!.jobId, first!.lease!.token, { evaluationId: "eval-stale", decision: "pass" }))
      .rejects.toMatchObject({ code: "EVOLUTION_EVALUATION_JOB_CONFLICT" });
    const done = await jobs.succeed(retried!.jobId, retried!.lease!.token, { evaluationId: "eval-a", decision: "pass" });
    expect(done).toMatchObject({ status: "succeeded", result: { evaluationId: "eval-a", decision: "pass" } });
  });

  it("takes over an expired lease and eventually dead-letters a bounded job", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-evaluation-takeover-"));
    let time = Date.parse("2026-08-14T04:00:00.000Z");
    const jobs = new EvaluationJobStore("workspace-a", root, () => new Date(time));
    await jobs.enqueue("evaluation-request-b", evaluationRequest(), 2);
    const abandoned = await jobs.claim("dead-worker", 1_000);
    time += 1_001;
    const takeover = await jobs.claim("recovery-worker", 1_000);
    expect(takeover).toMatchObject({ jobId: abandoned!.jobId, attempts: 2, lease: { workerId: "recovery-worker" } });
    const dead = await jobs.fail(takeover!.jobId, takeover!.lease!.token, { category: "transient", message: "sandbox host unavailable" });
    expect(dead).toMatchObject({ status: "dead_letter", attempts: 2 });
  });
});

function evaluationRequest() {
  return {
    candidateId: "candidate-a", expectedContentHash: "a".repeat(64),
    suiteRef: { id: "suite-a", version: "1", contentHash: "b".repeat(64) },
    baselineRef: { id: "baseline-a", version: "1", contentHash: "c".repeat(64) },
    runtimeSnapshotRef: "runtime-a", evaluatorPrincipal: { type: "system" as const, id: "evaluation-worker" },
  };
}
