import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EvolutionPhaseJobStore } from "../../src/server/evolution/phase-job-store.js";

describe("Evolution phase jobs", () => {
  it("keeps phases independently durable and recovers expired leases", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-phase-jobs-"));
    let time = Date.parse("2026-08-15T08:00:00.000Z");
    const jobs = new EvolutionPhaseJobStore("workspace-a", root, () => new Date(time));
    const reflection = await jobs.enqueue({ commandId: "reflect-a", kind: "reflection", priority: 0, profileId: "profile-a", sourceSignalId: "signal-a", sourceDraftRefs: [], scheduleReason: "high_salience", availableAt: new Date(time).toISOString() });
    const consolidation = await jobs.enqueue({ commandId: "dream-a", kind: "consolidation", priority: 4, sourceDraftRefs: ["draft-a"], scheduleReason: "maintenance", availableAt: new Date(time + 60_000).toISOString() });
    const claimed = await jobs.claim("reflection", "worker-a", 1_000);
    expect(claimed).toMatchObject({ jobId: reflection.jobId, status: "running", attempts: 1 });
    expect(await jobs.claim("consolidation", "worker-a")).toBeUndefined();
    time += 1_001;
    const recovered = await jobs.claim("reflection", "worker-b", 1_000);
    expect(recovered).toMatchObject({ jobId: reflection.jobId, status: "running", attempts: 2, lease: { workerId: "worker-b" } });
    await jobs.succeed(recovered!.jobId, recovered!.lease!.token);
    time += 60_000;
    expect(await jobs.claim("consolidation", "worker-b")).toMatchObject({ jobId: consolidation.jobId, status: "running" });
  });

  it("uses durable least-recently-served Agent ordering within the same P0-P4 priority", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-phase-fairness-"));
    const now = () => new Date("2026-08-15T08:00:00.000Z"); const jobs = new EvolutionPhaseJobStore("workspace-a", root, now);
    for (const [commandId, profileId] of [["a-1", "profile-a"], ["a-2", "profile-a"], ["b-1", "profile-b"]] as const) {
      await jobs.enqueue({ commandId, kind: "reflection", priority: 2, profileId, sourceSignalId: `signal-${commandId}`, sourceDraftRefs: [], scheduleReason: "recovery", availableAt: now().toISOString() });
    }
    const first = await jobs.claim("reflection", "worker"); await jobs.succeed(first!.jobId, first!.lease!.token);
    const second = await jobs.claim("reflection", "worker");
    expect([first!.profileId, second!.profileId]).toEqual(["profile-a", "profile-b"]);
  });

  it("replays a command when only its scheduling timestamp changes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-phase-job-idempotency-"));
    let time = Date.parse("2026-08-15T08:00:00.000Z");
    const jobs = new EvolutionPhaseJobStore("workspace-a", root, () => new Date(time));
    const first = await jobs.enqueue({ commandId: "dream-a", kind: "consolidation", priority: 3, sourceDraftRefs: ["draft-a"], scheduleReason: "idle", availableAt: new Date(time).toISOString() });
    time += 30_000;
    const replay = await jobs.enqueue({ commandId: "dream-a", kind: "consolidation", priority: 3, sourceDraftRefs: ["draft-a"], scheduleReason: "idle", availableAt: new Date(time).toISOString() });
    expect(replay).toEqual(first);
  });
});
