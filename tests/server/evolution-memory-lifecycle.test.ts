import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { EvolutionCandidate, PromotionRecord } from "../../src/shared/contracts/evolution.js";
import type { Workspace } from "../../src/shared/types.js";
import { AgentEngine } from "../../src/server/agent-engine/agent-engine.js";
import { AgentStore } from "../../src/server/agent-engine/agent-store.js";
import { AgentTraceStore } from "../../src/server/agent-engine/trace-store.js";
import { addWorkspaceAgent } from "../../src/server/agents/roster.js";
import { ExperienceStore } from "../../src/server/evolution/experience-store.js";
import { projectExperience } from "../../src/server/evolution/experience-projector.js";
import { MemoryLifecycleStore } from "../../src/server/evolution/memory-lifecycle-store.js";
import { MemoryUsageReconciler } from "../../src/server/evolution/memory-usage-reconciler.js";
import { PlatformEvolutionObservationAdapter } from "../../src/server/evolution-adapters/platform-observation-adapter.js";

describe("evolution Memory lifecycle", () => {
  it("tracks evidence-correlated successful use and applies pin, stale, archive, and restore transitions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-memory-lifecycle-"));
    let time = Date.parse("2026-01-01T00:00:00.000Z");
    const lifecycle = new MemoryLifecycleStore("workspace-a", root, () => new Date(time));
    await lifecycle.register(promotion(), candidate());
    const used = await lifecycle.recordUsage({
      commandId: "usage-a", releaseId: "release-memory-a", episodeId: "episode-a", outcome: "succeeded",
      sourceRefs: [{ kind: "trace", ref: "trace-a", workspaceId: "workspace-a" }], occurredAt: "2026-01-02T00:00:00.000Z",
    });
    expect(used).toMatchObject({ useCount: 1, successfulEpisodeCount: 1, failedEpisodeCount: 0, lastOutcome: "succeeded" });
    expect((await lifecycle.recordUsage({
      commandId: "usage-a", releaseId: "release-memory-a", episodeId: "episode-a", outcome: "succeeded",
      sourceRefs: [{ kind: "trace", ref: "trace-a", workspaceId: "workspace-a" }], occurredAt: "2026-01-02T00:00:00.000Z",
    })).useCount).toBe(1);

    await lifecycle.pin("pin-a", "release-memory-a", true, { type: "human", id: "governor" });
    time = Date.parse("2026-04-05T00:00:00.000Z");
    expect((await lifecycle.maintain({ staleAfterDays: 30, archiveAfterDays: 90 }))[0]).toMatchObject({ status: "active", pinned: true });
    await lifecycle.pin("unpin-a", "release-memory-a", false, { type: "human", id: "governor" });
    expect((await lifecycle.maintain({ staleAfterDays: 30, archiveAfterDays: 90 }))[0].status).toBe("stale");
    time = Date.parse("2026-05-01T00:00:00.000Z");
    expect((await lifecycle.maintain({ staleAfterDays: 30, archiveAfterDays: 90 }))[0].status).toBe("archived");
    expect((await lifecycle.transition("restore-a", "release-memory-a", "active", "Human restored after review", { type: "human", id: "governor" })).status).toBe("active");
  });

  it("counts usage only when a terminal Episode and its Goal-scoped Runtime trace prove that Memory was loaded", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-memory-usage-"));
    const workspace: Workspace = { id: "workspace-a", name: "Memory company", rootPath: root, policyProfile: "development", createdAt: "2026-01-01T00:00:00.000Z" };
    const profile = { id: "profile-dev", name: "Dev", role: "dev" as const, capabilities: [], defaultProvider: "mock" as const, defaultModel: "mock", defaultPolicy: {} };
    const agent = await addWorkspaceAgent(workspace, profile);
    const store = new AgentStore(root, agent.id);
    const engine = new AgentEngine(store);
    const thread = await engine.ensureThread({ agentId: agent.id, scopeId: "task-a", idempotencyKey: "thread-a" });
    const goal = await engine.startGoal({
      agentId: agent.id, threadId: thread.threadId, idempotencyKey: "goal-a",
      spec: { id: "goal-a", threadId: thread.threadId, objective: "deliver", successCriteria: ["verified"], contextRefs: [], createdAt: "2026-01-01T00:00:00.000Z" },
    });
    const lifecycle = new MemoryLifecycleStore(workspace.id, root, fixedNow);
    await lifecycle.register(promotion(), candidate());
    await new AgentTraceStore(root, agent.id).append({
      traceId: "context-trace-a", agentId: agent.id, threadId: thread.threadId, goalId: goal.spec.id, turnId: "turn-a",
      kind: "context", createdAt: "2026-01-02T00:00:00.000Z",
      data: { evolutionMemories: [{ target: "experience.tool.browser", releaseId: "release-memory-a", contentHash: "a".repeat(64) }] },
    });
    const projected = projectExperience({
      commandId: "episode-a", workspaceId: workspace.id, taskId: "task-a", taskRunId: "run-a",
      ticket: { ticketId: "ticket-a", attemptId: "attempt-a", status: "completed", startedAt: "2026-01-02T00:00:00.000Z", updatedAt: "2026-01-02T00:05:00.000Z" },
      goal: { goalId: goal.spec.id, agentId: agent.id, profileId: agent.profileId, status: "completed" },
      sourceRefs: [{ kind: "ticket", ref: "ticket-a", workspaceId: workspace.id }],
    }, fixedNow);
    await new ExperienceStore(workspace.id, root).record("episode-a", projected);
    const reconciler = new MemoryUsageReconciler(workspace, new PlatformEvolutionObservationAdapter(workspace));
    expect(await reconciler.reconcile()).toMatchObject({ inspectedEpisodes: 1, correlatedEpisodes: 1, recordedUsages: 1 });
    expect(await lifecycle.get("release-memory-a")).toMatchObject({ useCount: 1, successfulEpisodeCount: 1, lastEpisodeId: projected.episode.episodeId });
    expect(await reconciler.reconcile()).toMatchObject({ recordedUsages: 0 });
    expect((await lifecycle.get("release-memory-a"))!.useCount).toBe(1);
  });

  it("does not let failed usage postpone staleness", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-memory-failed-freshness-"));
    let time = Date.parse("2026-01-01T00:00:00.000Z");
    const lifecycle = new MemoryLifecycleStore("workspace-a", root, () => new Date(time));
    await lifecycle.register(promotion(), candidate());
    await lifecycle.recordUsage({
      commandId: "usage-failed", releaseId: "release-memory-a", episodeId: "episode-failed", outcome: "failed",
      sourceRefs: [{ kind: "trace", ref: "trace-failed", workspaceId: "workspace-a" }], occurredAt: "2026-01-29T00:00:00.000Z",
    });
    time = Date.parse("2026-02-01T00:00:00.000Z");
    expect((await lifecycle.maintain({ staleAfterDays: 30, archiveAfterDays: 90 }))[0]).toMatchObject({
      status: "stale", useCount: 1, successfulEpisodeCount: 0, failedEpisodeCount: 1,
    });
  });
});

function candidate(): EvolutionCandidate {
  return {
    candidateId: "candidate-memory-a", revision: 1, kind: "memory", target: "experience.tool.browser", title: "Browser lesson", rationale: "Repeated evidence",
    artifactRef: "artifacts/a/artifact.txt", contentHash: "a".repeat(64), hypothesis: "Improve success", sourceRefs: [{ kind: "trace", ref: "trace-a", workspaceId: "workspace-a" }],
    scope: { workspaceId: "workspace-a", roles: ["dev"] }, expectedMetrics: [{ metric: "task_success_rate", direction: "increase", minimumDelta: 0.01 }],
    riskLevel: "low", status: "validated", proposedBy: { type: "system", id: "memory-consolidator" }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    validation: { passed: true, checkedAt: "2026-01-01T00:00:00.000Z", checks: [{ name: "memory_safety", passed: true, message: "passed" }] },
  };
}
function promotion(): PromotionRecord {
  return {
    promotionId: "promotion-memory-a", candidateId: "candidate-memory-a", evaluationId: "evaluation-a",
    toRelease: { id: "release-memory-a", version: "1", contentHash: "a".repeat(64) }, stage: "production",
    scope: { workspaceId: "workspace-a", roles: ["dev"] }, approvedBy: { type: "human", id: "governor" },
    policyRef: { id: "policy", version: "1", contentHash: "policy-hash" }, status: "active", createdAt: "2026-01-01T00:00:00.000Z",
  };
}
function fixedNow(): Date { return new Date("2026-01-02T00:05:00.000Z"); }
