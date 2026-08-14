import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { EvolutionCandidate, FailedEvolutionAttemptRef, ReleaseTelemetry } from "../../src/shared/contracts/evolution.js";
import { EvolutionAssetSelector } from "../../src/server/evolution/asset-selector.js";
import { ExperienceStore } from "../../src/server/evolution/experience-store.js";
import { projectExperience } from "../../src/server/evolution/experience-projector.js";

describe("higher-risk evolution asset selection", () => {
  it("requires repeated direct attribution and a verified failed lower-level release", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-asset-selection-"));
    const experience = new ExperienceStore("workspace-a", root);
    const releaseRef = { id: "release-prompt-a", version: "1", contentHash: "prompt-hash-a" };
    const failedAttempt: FailedEvolutionAttemptRef = { telemetryId: "telemetry-failed-prompt", candidateId: "candidate-prompt", releaseRef };
    await recordWorkflowFailures(experience, undefined, "without-proof");

    const candidate = { candidateId: "candidate-prompt", kind: "prompt" } as EvolutionCandidate;
    const telemetry = { telemetryId: failedAttempt.telemetryId, candidateId: candidate.candidateId, releaseRef, decision: "fail" } as ReleaseTelemetry;
    const selector = new EvolutionAssetSelector(
      "workspace-a", root, experience,
      { get: async (id: string) => id === candidate.candidateId ? candidate : Promise.reject(new Error("not found")) },
      { get: async (id: string) => id === telemetry.telemetryId ? telemetry : undefined },
      fixedNow,
    );
    expect((await selector.select(3)).selections).toEqual([
      expect.objectContaining({ selectedKind: "workflow", status: "insufficient_evidence", verifiedFailedAttempts: [] }),
    ]);

    await recordWorkflowFailures(experience, failedAttempt, "with-proof");
    const selected = (await selector.select(3)).selections.find((item) => item.status === "eligible_for_authoring");
    expect(selected).toMatchObject({
      selectedKind: "workflow", status: "eligible_for_authoring",
      verifiedFailedAttempts: [failedAttempt],
    });
    expect(selected?.reason).toContain("no Candidate or activation has been created");
    expect(await selector.list()).toHaveLength(2);
  });

  it("rejects a failed release that is not less invasive than the selected asset", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-asset-rank-"));
    const experience = new ExperienceStore("workspace-a", root);
    const releaseRef = { id: "release-source", version: "1", contentHash: "source-hash" };
    const failedAttempt: FailedEvolutionAttemptRef = { telemetryId: "telemetry-source", candidateId: "candidate-source", releaseRef };
    await recordWorkflowFailures(experience, failedAttempt, "same-rank");
    const selector = new EvolutionAssetSelector(
      "workspace-a", root, experience,
      { get: async () => ({ candidateId: "candidate-source", kind: "source_patch" } as EvolutionCandidate) },
      { get: async () => ({ telemetryId: "telemetry-source", candidateId: "candidate-source", releaseRef, decision: "fail" } as ReleaseTelemetry) },
      fixedNow,
    );
    expect((await selector.select(3)).selections[0]).toMatchObject({ status: "insufficient_evidence", verifiedFailedAttempts: [] });
  });
});

async function recordWorkflowFailures(store: ExperienceStore, failedAttempt: FailedEvolutionAttemptRef | undefined, prefix: string): Promise<void> {
  for (let index = 0; index < 3; index += 1) {
    const suffix = `${prefix}-${index}`;
    await store.record(`record-${suffix}`, projectExperience({
      commandId: `project-${suffix}`, workspaceId: "workspace-a", taskId: `task-${suffix}`, taskRunId: `run-${suffix}`,
      ticket: { ticketId: `ticket-${suffix}`, attemptId: `attempt-${suffix}`, status: "failed", startedAt: "2026-08-14T00:00:00.000Z", updatedAt: "2026-08-14T00:01:00.000Z" },
      goal: { goalId: `goal-${suffix}`, agentId: "agent-dev", status: "failed" },
      sourceRefs: [{ kind: "trace", ref: `trace-${suffix}`, workspaceId: "workspace-a" }],
      failures: [{
        component: "workflow", symptom: "The task repeatedly used the wrong dependency order",
        cause: "The frozen workflow DAG encodes the wrong dependency edge",
        sourceRefs: [{ kind: "trace", ref: `trace-${suffix}`, workspaceId: "workspace-a" }],
        ...(failedAttempt ? { failedEvolutionAttempts: [failedAttempt] } : {}),
      }],
    }, fixedNow));
  }
}

function fixedNow(): Date { return new Date("2026-08-14T00:10:00.000Z"); }
