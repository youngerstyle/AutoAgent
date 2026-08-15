import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EvolutionSignalIngestor } from "../../src/server/evolution/evolution-signal-ingestor.js";
import { EvolutionSignalStore } from "../../src/server/evolution/evolution-signal-store.js";
import { EvolutionPhaseJobStore } from "../../src/server/evolution/phase-job-store.js";
import { ExperienceStore } from "../../src/server/evolution/experience-store.js";
import { projectExperience } from "../../src/server/evolution/experience-projector.js";
import type { AuthoritativeEpisodeFacts } from "../../src/shared/contracts/evolution.js";
import { workspaceEvolutionTelemetryFile } from "../../src/server/storage/paths.js";

describe("EvolutionSignal queue", () => {
  it("is idempotent, prioritizes P0, and recovers transient work through a lease", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-evolution-signals-"));
    let time = Date.parse("2026-08-15T00:00:00.000Z");
    const store = new EvolutionSignalStore("workspace-a", root, () => new Date(time));
    const sourceRefs = [{ kind: "ticket" as const, ref: "ticket-a", workspaceId: "workspace-a" }];
    const ordinary = await store.enqueue({ commandId: "ordinary", trigger: "terminal_outcome", priority: 3, sourceRefs, salience: 0.25, novelty: 0, occurredAt: new Date(time).toISOString() });
    expect((await store.enqueue({ commandId: "ordinary", trigger: "terminal_outcome", priority: 3, sourceRefs, salience: 0.25, novelty: 0, occurredAt: new Date(time).toISOString() })).signalId).toBe(ordinary.signalId);
    await expect(store.enqueue({ commandId: "ordinary", trigger: "terminal_outcome", priority: 3, sourceRefs, salience: 0.5, novelty: 0, occurredAt: new Date(time).toISOString() }))
      .rejects.toMatchObject({ code: "EVOLUTION_SIGNAL_CONFLICT" });
    const rollback = await store.enqueue({ commandId: "rollback", trigger: "effect_observation", priority: 0, sourceRefs, salience: 1, novelty: 0, occurredAt: new Date(time + 1).toISOString() });

    const first = await store.claim("worker-a", 1_000);
    expect(first?.signalId).toBe(rollback.signalId);
    await store.fail(first!.signalId, first!.lease!.token, { category: "transient", message: "Authorization: Bearer secret" });
    expect((await store.list()).find((item) => item.signalId === rollback.signalId)).toMatchObject({ status: "retry_wait", lastError: { message: "Authorization: Bearer [REDACTED]" } });
    time += 1_000;
    const retried = await store.claim("worker-b", 1_000);
    expect(retried).toMatchObject({ signalId: rollback.signalId, attempts: 2 });
    await store.succeed(retried!.signalId, retried!.lease!.token);
    const ordinaryClaim = await store.claim("worker-b", 1_000);
    expect(ordinaryClaim?.signalId).toBe(ordinary.signalId);
    await store.fail(ordinaryClaim!.signalId, ordinaryClaim!.lease!.token, { category: "terminal", message: "invalid signal" });
    expect((await store.list()).find((item) => item.signalId === ordinary.signalId)?.status).toBe("dead_letter");
  });

  it("reclaims an expired lease after a worker crash", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-evolution-signal-reclaim-"));
    let time = Date.parse("2026-08-15T00:00:00.000Z");
    const store = new EvolutionSignalStore("workspace-a", root, () => new Date(time));
    await store.enqueue({ commandId: "crash", trigger: "manual", priority: 1, sourceRefs: [{ kind: "ticket", ref: "ticket-a", workspaceId: "workspace-a" }], salience: 1, novelty: 0, occurredAt: new Date(time).toISOString() });
    const abandoned = await store.claim("worker-a", 1_000);
    time += 1_001;
    const reclaimed = await store.claim("worker-b", 1_000);
    expect(reclaimed).toMatchObject({ signalId: abandoned!.signalId, attempts: 2, lease: { workerId: "worker-b" } });
  });

  it("derives bounded signals from Episode append order and advances a durable cursor", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-evolution-ingestor-"));
    const experience = new ExperienceStore("workspace-a", root);
    await experience.record("episode-a", projectExperience(facts("a", false), fixedNow));
    await experience.record("episode-b", projectExperience(facts("b", true), fixedNow));
    const signals = new EvolutionSignalStore("workspace-a", root, fixedNow);
    const ingestor = new EvolutionSignalIngestor("workspace-a", root, experience, signals);

    expect(await ingestor.ingest(1)).toMatchObject({ inspectedEpisodes: 1, enqueuedSignals: 1 });
    expect(await ingestor.ingest(1)).toMatchObject({ inspectedEpisodes: 1, enqueuedSignals: 1 });
    expect(await new EvolutionSignalIngestor("workspace-a", root, experience, signals).ingest(1)).toEqual({ inspectedEpisodes: 0, enqueuedSignals: 0 });
    expect(await signals.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({ episodeId: expect.stringContaining("episode_"), profileId: "profile-a", trigger: "terminal_outcome", priority: 3 }),
      expect.objectContaining({ profileId: "profile-a", trigger: "user_correction", priority: 1 }),
    ]));
    expect(await new EvolutionPhaseJobStore("workspace-a", root).list()).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "reflection", sourceSignalId: expect.stringContaining("signal_"), status: "pending" }),
    ]));
  });

  it("derives recovered-failure and effect-observation signals from authoritative ledgers", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-evolution-derived-signals-")); const experience = new ExperienceStore("workspace-a", root);
    const failed = facts("failed", false); failed.ticket.ticketId = "ticket-shared"; failed.ticket.status = "failed"; failed.goal.status = "failed"; failed.ticket.updatedAt = "2026-08-15T00:01:00.000Z";
    const recovered = facts("recovered", false); recovered.ticket.ticketId = "ticket-shared"; recovered.ticket.updatedAt = "2026-08-15T00:03:00.000Z";
    await experience.record("failed", projectExperience(failed, () => new Date("2026-08-15T00:01:00.000Z")));
    await experience.record("recovered", projectExperience(recovered, () => new Date("2026-08-15T00:03:00.000Z")));
    const telemetryFile = workspaceEvolutionTelemetryFile(root); await mkdir(path.dirname(telemetryFile), { recursive: true });
    await writeFile(telemetryFile, `${JSON.stringify({ commandId: "telemetry", fingerprint: "fixture", telemetry: {
      telemetryId: "telemetry-fail", releaseRef: { id: "release-a", version: "1", contentHash: "a".repeat(64) }, candidateId: "candidate-a", candidateHash: "a".repeat(64),
      stage: "canary", sampleSize: 1, samples: [{ sampleId: "sample-a", baseline: {}, release: {}, evidenceRefs: [{ kind: "evidence", ref: "evidence-a", workspaceId: "workspace-a" }] }],
      aggregateMetrics: [], decision: "fail", recorder: { type: "system", id: "monitor" }, startedAt: "2026-08-15T00:00:00.000Z", endedAt: "2026-08-15T00:04:00.000Z", createdAt: "2026-08-15T00:04:00.000Z",
    } })}\n`, "utf8");
    const signals = new EvolutionSignalStore("workspace-a", root, fixedNow); const ingestor = new EvolutionSignalIngestor("workspace-a", root, experience, signals);
    expect(await ingestor.ingest()).toMatchObject({ inspectedEpisodes: 2, enqueuedSignals: 3 });
    expect(await signals.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({ trigger: "recovered_failure", priority: 2 }), expect.objectContaining({ trigger: "effect_observation", priority: 0 }),
    ]));
    expect(await ingestor.ingest()).toMatchObject({ inspectedEpisodes: 0, enqueuedSignals: 0 });
  });
});

function facts(suffix: string, corrected: boolean): AuthoritativeEpisodeFacts {
  return {
    commandId: `episode-${suffix}`, workspaceId: "workspace-a", taskId: `task-${suffix}`, taskRunId: `run-${suffix}`,
    ticket: { ticketId: `ticket-${suffix}`, attemptId: `attempt-${suffix}`, status: "completed", startedAt: "2026-08-15T00:00:00.000Z", updatedAt: "2026-08-15T00:01:00.000Z" },
    goal: { goalId: `goal-${suffix}`, agentId: `workspace-agent-${suffix}`, profileId: "profile-a", status: "completed" },
    sourceRefs: [{ kind: corrected ? "human_feedback" : "goal_decision", ref: `source-${suffix}`, workspaceId: "workspace-a", profileId: "profile-a" }],
  };
}
function fixedNow(): Date { return new Date("2026-08-15T00:02:00.000Z"); }
