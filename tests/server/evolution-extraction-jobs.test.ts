import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ExtractionJobStore } from "../../src/server/evolution/extraction-job-store.js";
import { projectExperience } from "../../src/server/evolution/experience-projector.js";

describe("evolution extraction reliability", () => {
  it("leases one job, applies exponential retry backoff, and rejects stale owners", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-extraction-"));
    let time = Date.parse("2026-08-14T00:00:00.000Z");
    const jobs = new ExtractionJobStore("workspace-a", root, () => new Date(time));
    const queued = await jobs.enqueue("reconcile-a", 3);
    expect((await jobs.enqueue("reconcile-a", 3)).jobId).toBe(queued.jobId);

    const first = await jobs.claim("worker-a", 1_000);
    expect(first).toMatchObject({ status: "running", attempts: 1, lease: { workerId: "worker-a" } });
    await expect(jobs.claim("worker-b", 1_000)).resolves.toBeUndefined();
    const waiting = await jobs.fail(first!.jobId, first!.lease!.token, { category: "transient", message: "Authorization: Bearer secret-token" });
    expect(waiting).toMatchObject({ status: "retry_wait", lastError: { message: "Authorization: Bearer [REDACTED]" } });
    await expect(jobs.claim("worker-b", 1_000)).resolves.toBeUndefined();

    time += 1_000;
    const retried = await jobs.claim("worker-b", 1_000);
    expect(retried).toMatchObject({ status: "running", attempts: 2 });
    await expect(jobs.succeed(retried!.jobId, first!.lease!.token, { inspectedTickets: 1, recordedEpisodes: 1, skippedTickets: 0 }))
      .rejects.toMatchObject({ code: "EVOLUTION_EXTRACTION_JOB_CONFLICT" });
    const done = await jobs.succeed(retried!.jobId, retried!.lease!.token, { inspectedTickets: 1, recordedEpisodes: 1, skippedTickets: 0 });
    expect(done).toMatchObject({ status: "succeeded", result: { recordedEpisodes: 1 } });
  });

  it("redacts credentials before an attribution becomes durable experience", () => {
    const projected = projectExperience({
      commandId: "episode-a", workspaceId: "workspace-a", taskId: "task-a", taskRunId: "run-a",
      ticket: { ticketId: "ticket-a", attemptId: "attempt-a", status: "failed", startedAt: "2026-08-14T00:00:00.000Z", updatedAt: "2026-08-14T00:01:00.000Z" },
      goal: { goalId: "goal-a", agentId: "agent-a", profileId: "profile-a", status: "failed" },
      sourceRefs: [{ kind: "ticket", ref: "ticket-a", workspaceId: "workspace-a" }],
      failures: [{ component: "provider", symptom: "api_key=sk-abcdefghijklmnop", cause: "Authorization: Bearer top-secret", sourceRefs: [{ kind: "trace", ref: "trace-a", workspaceId: "workspace-a" }] }],
    }, () => new Date("2026-08-14T00:02:00.000Z"));
    expect(projected.attributions[0]).toMatchObject({
      symptom: "api_key=[REDACTED]", cause: "Authorization: Bearer [REDACTED]",
      redaction: { count: 2, policyRef: "evolution-secret-redaction/v1" },
    });
  });
});
