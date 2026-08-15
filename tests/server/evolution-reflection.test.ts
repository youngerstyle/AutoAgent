import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EvolutionReflectionWorker } from "../../src/server/evolution/reflection-worker.js";
import { EvolutionSignalStore } from "../../src/server/evolution/evolution-signal-store.js";
import { ExperienceStore } from "../../src/server/evolution/experience-store.js";
import { projectExperience } from "../../src/server/evolution/experience-projector.js";
import { PracticeDraftStore } from "../../src/server/evolution/practice-draft-store.js";

describe("Evolution fast reflection", () => {
  it("turns an explicit attribution into an agent-project PracticeDraft without activating an asset", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-reflection-"));
    const now = () => new Date("2026-08-15T01:00:00.000Z");
    const experience = new ExperienceStore("workspace-a", root);
    const projected = projectExperience({
      commandId: "corrected-episode", workspaceId: "workspace-a", taskId: "task-a", taskRunId: "run-a",
      ticket: { ticketId: "ticket-a", attemptId: "attempt-a", status: "failed", startedAt: "2026-08-15T00:00:00.000Z", updatedAt: "2026-08-15T00:10:00.000Z" },
      goal: { goalId: "goal-a", agentId: "workspace-agent-a", profileId: "profile-a", status: "failed" },
      sourceRefs: [{ kind: "human_feedback", ref: "feedback-a", workspaceId: "workspace-a", profileId: "profile-a" }],
      failures: [{ component: "workflow", symptom: "Participants started with different document versions", cause: "The authoritative document was not briefed before collaborative execution", sourceRefs: [{ kind: "human_feedback", ref: "feedback-a", workspaceId: "workspace-a", profileId: "profile-a" }] }],
    }, now);
    projected.attributions[0]!.counterEvidenceRefs = [{ kind: "evidence", ref: "counter-a", workspaceId: "workspace-a" }];
    await experience.record("corrected-episode", projected);
    const signals = new EvolutionSignalStore("workspace-a", root, now);
    const signal = await signals.enqueue({ commandId: "signal-a", trigger: "user_correction", priority: 1, profileId: "profile-a", episodeId: projected.episode.episodeId, sourceRefs: projected.episode.sourceRefs, salience: 1, novelty: 0, occurredAt: projected.episode.endedAt });
    const drafts = new PracticeDraftStore("workspace-a", root, now);
    const worker = new EvolutionReflectionWorker("workspace-a", root, signals, experience, drafts);

    const result = await worker.runNext("reflection-worker");

    expect(result).toMatchObject({ signalId: signal.signalId, drafts: [expect.objectContaining({
      statement: "The authoritative document was not briefed before collaborative execution",
      trigger: "Participants started with different document versions",
      applicability: { ownerLevel: "agent_project", workspaceId: "workspace-a", profileId: "profile-a" },
      contraindications: ["evidence:counter-a"], status: "draft",
    })] });
    expect((await signals.list())[0]).toMatchObject({ status: "succeeded" });
    expect(await worker.runNext("reflection-worker")).toBeUndefined();
    expect(await drafts.list()).toHaveLength(1);
  });
});
