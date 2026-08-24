import { describe, expect, it } from "vitest";
import type { MemoryLifecycleState } from "../../src/shared/contracts/evolution.js";
import { explainMemorySelection, rankEvolutionMemories, retrieveEvolutionMemories, type RuntimeEvolutionMemory } from "../../src/server/evolution/runtime-projection.js";

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

  it("retrieves task-relevant memories with local BM25 and records exclusions", () => {
    const selection = explainMemorySelection("project", "production", lifecycle({ successfulEpisodeCount: 4, useCount: 4 }), "2026-08-15T00:00:00.000Z");
    const relevant = { ...memory("migration-rollback", selection), content: "Before every database migration, prepare and verify a rollback plan with a restore checkpoint." };
    const irrelevant = { ...memory("social-calendar", { ...selection, score: 0.99 }), content: "Schedule social media posts and review campaign artwork." };
    const result = retrieveEvolutionMemories([irrelevant, relevant], {
      objective: "Repair the database migration and verify its rollback plan",
      tokenBudget: 200,
    });

    expect(result.memories.map((item) => item.releaseId)).toEqual([relevant.releaseId]);
    expect(result.memories[0]!.retrieval).toMatchObject({ policyVersion: "memory-retrieval/v2", normalizedRelevance: 1 });
    expect(result.trace).toMatchObject({ queryPresent: true, tokenBudget: 200, selectedReleaseIds: [relevant.releaseId] });
    expect(result.trace.excluded).toContainEqual({ releaseId: irrelevant.releaseId, reason: "lexical_irrelevant" });
  });

  it("supports Chinese lexical retrieval and deterministic token-budget packing", () => {
    const selection = explainMemorySelection("agent_project", "production", lifecycle({ successfulEpisodeCount: 3, useCount: 3 }), "2026-08-15T00:00:00.000Z");
    const briefing = { ...memory("project-briefing", selection), content: "项目开始前先向所有成员宣讲最新文档，确认理解后再执行。".repeat(20) };
    const release = { ...memory("release-check", selection), content: "发布前检查数据库回滚和监控告警。" };
    const input = { objective: "提前向项目成员宣讲项目文档", constraints: ["所有人确认理解"], tokenBudget: 100 };
    const first = retrieveEvolutionMemories([release, briefing], input);
    const second = retrieveEvolutionMemories([release, briefing], input);

    expect(first).toEqual(second);
    expect(first.memories.map((item) => item.releaseId)).toEqual([briefing.releaseId]);
    expect(first.memories[0]!.retrieval).toMatchObject({ truncated: true });
    expect(first.trace.usedTokens).toBeLessThanOrEqual(100);
  });

  it("uses MMR to suppress near-duplicate memories after relevance filtering", () => {
    const selection = explainMemorySelection("project", "production", lifecycle({ successfulEpisodeCount: 2, useCount: 2 }), "2026-08-15T00:00:00.000Z");
    const shared = Array.from({ length: 50 }, (_, index) => `rollback${index}`).join(" ");
    const first = { ...memory("migration-first", { ...selection, score: 0.8 }), content: shared };
    const duplicate = { ...memory("migration-copy", { ...selection, score: 0.7 }), content: shared };
    const result = retrieveEvolutionMemories([duplicate, first], { objective: "rollback17 migration", tokenBudget: 1_000 });

    expect(result.memories.map((item) => item.releaseId)).toEqual([first.releaseId]);
    expect(result.trace.excluded).toContainEqual({ releaseId: duplicate.releaseId, reason: "redundant" });
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
