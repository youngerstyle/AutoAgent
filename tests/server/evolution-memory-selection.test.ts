import { describe, expect, it } from "vitest";
import type { MemoryLifecycleState } from "../../src/shared/contracts/evolution.js";
import { explainMemorySelection, rankEvolutionMemories, type RuntimeEvolutionMemory } from "../../src/server/evolution/runtime-projection.js";

describe("evolution Memory selection", () => {
  it("combines scope, measured effectiveness, confidence, freshness, and bounded exploration", () => {
    const now = new Date("2026-08-15T00:00:00.000Z");
    const recent = explainMemorySelection("agent_project", "production", lifecycle({
      successfulEpisodeCount: 4, failedEpisodeCount: 1, useCount: 5, lastSuccessfulAt: "2026-08-15T00:00:00.000Z",
    }), "2026-08-01T00:00:00.000Z", now);
    const old = explainMemorySelection("company", "production", lifecycle({
      successfulEpisodeCount: 1, failedEpisodeCount: 4, useCount: 5, lastSuccessfulAt: "2026-07-16T00:00:00.000Z",
    }), "2026-07-01T00:00:00.000Z", now);
    const canary = explainMemorySelection("project", "canary", undefined, "2026-08-15T00:00:00.000Z", now);

    expect(recent.score).toBeGreaterThan(old.score);
    expect(old.components.freshness).toBe(0.5);
    expect(recent.components.evidenceConfidence).toBe(1);
    expect(canary.components.exploration).toBe(1);
  });

  it("does not turn pinning into forced injection and ranks deterministically", () => {
    const now = new Date("2026-08-15T00:00:00.000Z");
    const unpinned = explainMemorySelection("project", "production", lifecycle({ pinned: false }), "2026-08-15T00:00:00.000Z", now);
    const pinned = explainMemorySelection("project", "production", lifecycle({ pinned: true }), "2026-08-15T00:00:00.000Z", now);
    expect(pinned).toEqual(unpinned);

    const lower = memory("z-lower", { ...unpinned, score: 0.4 });
    const higherB = memory("b-higher", { ...unpinned, score: 0.8 });
    const higherA = memory("a-higher", { ...unpinned, score: 0.8 });
    expect(rankEvolutionMemories([lower, higherB, higherA], 2).map((item) => item.target)).toEqual(["a-higher", "b-higher"]);
  });
});

function lifecycle(overrides: Partial<MemoryLifecycleState>): MemoryLifecycleState {
  return {
    releaseId: "release-memory", releaseRef: { id: "release-memory", version: "1", contentHash: "a".repeat(64) },
    target: "memory", scope: { workspaceId: "workspace-a" }, status: "active", pinned: false,
    registeredAt: "2026-08-15T00:00:00.000Z", updatedAt: "2026-08-15T00:00:00.000Z",
    useCount: 0, successfulEpisodeCount: 0, failedEpisodeCount: 0, ...overrides,
  };
}

function memory(target: string, selection: RuntimeEvolutionMemory["selection"]): RuntimeEvolutionMemory {
  return {
    target, content: target, releaseId: `release-${target}`, releaseVersion: "1", contentHash: target,
    generation: 1, stage: "production", ownerLevel: "project", selection,
  };
}
