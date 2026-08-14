import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AuthoritativeEpisodeFacts } from "../../src/shared/contracts/evolution.js";
import { projectExperience } from "../../src/server/evolution/experience-projector.js";
import { ExperienceStore } from "../../src/server/evolution/experience-store.js";
import { EvolutionStore } from "../../src/server/evolution/evolution-store.js";
import { MemoryConsolidator } from "../../src/server/evolution/memory-consolidator.js";
import { PromptConsolidator } from "../../src/server/evolution/prompt-consolidator.js";

describe("evolution experience pipeline", () => {
  it("projects a stable successful episode only from terminal authoritative facts", () => {
    const first = projectExperience(facts({ ticket: { status: "completed" } }), fixedNow);
    const second = projectExperience(facts({ ticket: { status: "completed" } }), fixedNow);
    expect(first).toEqual(second);
    expect(first.episode).toMatchObject({ outcome: "succeeded", ticketId: "ticket-a", goalId: "goal-a" });
    expect(first.episode.sourceRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "ticket", ref: "ticket-a" }),
      expect.objectContaining({ kind: "goal_decision", ref: "decision-a" }),
    ]));
    expect(first.attributions).toEqual([]);
  });

  it("keeps provider, policy, tool, and environment failures separate from Skill defects", () => {
    const projected = projectExperience(facts({
      ticket: { status: "failed" },
      failures: [{
        component: "provider",
        symptom: "Provider returned HTTP 502",
        cause: "The configured provider was temporarily unavailable",
        sourceRefs: [{ kind: "trace", ref: "trace-provider-502", workspaceId: "workspace-a" }],
      }],
    }), fixedNow);
    expect(projected.episode.outcome).toBe("failed");
    expect(projected.attributions).toHaveLength(1);
    expect(projected.attributions[0]).toMatchObject({ component: "provider", confidence: 1 });
    expect(projected.attributions[0]?.component).not.toBe("skill");
  });

  it("records an Agent capability defect only when an authoritative source explicitly classifies it", () => {
    const projected = projectExperience(facts({
      ticket: { status: "failed" },
      failures: [{
        component: "skill", symptom: "The required release analysis was absent", cause: "The active release-review Skill lacks rollback verification",
        sourceRefs: [{ kind: "human_feedback", ref: "review-capability-finding", workspaceId: "workspace-a" }],
      }],
    }), fixedNow);
    expect(projected.attributions).toEqual([expect.objectContaining({ component: "skill", confidence: 1 })]);
  });

  it("uses unknown attribution instead of inventing a capability defect", () => {
    const projected = projectExperience(facts({ ticket: { status: "returned" }, failures: [] }), fixedNow);
    expect(projected.attributions[0]).toMatchObject({ component: "unknown", confidence: 0 });
    expect(projected.attributions[0]?.cause).toContain("do not infer a Skill defect");
  });

  it("rejects non-terminal and cross-workspace facts", () => {
    expect(() => projectExperience(facts({ ticket: { status: "running" } }), fixedNow)).toThrow("terminal Ticket status");
    expect(() => projectExperience(facts({
      sourceRefs: [{ kind: "evidence", ref: "evidence-foreign", workspaceId: "workspace-b" }],
    }), fixedNow)).toThrow("workspace boundary");
  });

  it("records append-only episodes idempotently", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-experience-"));
    const store = new ExperienceStore("workspace-a", root);
    const projected = projectExperience(facts({ ticket: { status: "failed" } }), fixedNow);
    const first = await store.record("episode-command-a", projected);
    const replay = await store.record("episode-command-a", projected);
    expect(replay).toEqual(first);
    expect(await store.listEpisodes()).toHaveLength(1);
    expect(await store.listAttributions()).toHaveLength(1);
    await expect(store.record("episode-command-a", projectExperience(facts({ ticket: { status: "cancelled" } }), fixedNow)))
      .rejects.toMatchObject({ code: "EXPERIENCE_CONFLICT" });
  });

  it("consolidates repeated evidence-backed causes into a scoped Memory candidate only", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-memory-consolidation-"));
    const experience = new ExperienceStore("workspace-a", root);
    const repeatedFailure: NonNullable<AuthoritativeEpisodeFacts["failures"]>[number] = {
      component: "tool", symptom: "Browser navigation failed", cause: "Required browser session was not initialized",
      sourceRefs: [{ kind: "trace", ref: "trace-shared-cause", workspaceId: "workspace-a" }],
    };
    const firstFacts = facts({ ticket: { status: "failed" }, failures: [repeatedFailure] });
    const secondFacts: AuthoritativeEpisodeFacts = {
      ...firstFacts, commandId: "project-episode-b", taskId: "task-b", taskRunId: "run-b",
      ticket: { ...firstFacts.ticket, ticketId: "ticket-b", attemptId: "attempt-b" },
      goal: { ...firstFacts.goal, goalId: "goal-b" },
      sourceRefs: [{ kind: "goal_decision", ref: "decision-b", workspaceId: "workspace-a" }],
    };
    await experience.record("episode-a", projectExperience(firstFacts, fixedNow));
    await experience.record("episode-b", projectExperience(secondFacts, fixedNow));
    const candidates = new EvolutionStore("workspace-a", root, fixedNow);
    const consolidator = new MemoryConsolidator("workspace-a", experience, candidates);
    const result = await consolidator.consolidate(2);
    expect(result).toMatchObject({ inspectedAttributions: 2, eligibleClusters: 1, conflictedClusters: 0 });
    expect(result.candidates[0]).toMatchObject({ kind: "memory", status: "proposed", scope: { workspaceId: "workspace-a" }, proposedBy: { type: "system", id: "memory-consolidator/v1" } });
    expect(await candidates.artifactContent(result.candidates[0].candidateId)).toContain("do not generalize it into a Skill defect");
    expect((await consolidator.consolidate(2)).candidates[0].candidateId).toBe(result.candidates[0].candidateId);
  });

  it("quarantines a supported Memory cluster when authoritative counter-evidence exists", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-memory-conflict-"));
    const experience = new ExperienceStore("workspace-a", root);
    const failure = {
      component: "tool" as const, symptom: "Browser navigation failed", cause: "Browser sessions must always be recreated",
      sourceRefs: [{ kind: "trace" as const, ref: "trace-cause", workspaceId: "workspace-a" }],
    };
    const first = projectExperience(facts({ ticket: { status: "failed" }, failures: [failure] }), fixedNow);
    const secondFacts = facts({ ticket: { status: "failed" }, failures: [failure] });
    secondFacts.commandId = "conflict-b";
    secondFacts.taskId = "task-b";
    secondFacts.taskRunId = "run-b";
    secondFacts.ticket = { ...secondFacts.ticket, ticketId: "ticket-b", attemptId: "attempt-b" };
    secondFacts.goal = { ...secondFacts.goal, goalId: "goal-b" };
    const second = projectExperience(secondFacts, fixedNow);
    second.attributions[0]!.counterEvidenceRefs = [{ kind: "evidence", ref: "evidence-session-reuse-is-safe", workspaceId: "workspace-a" }];
    await experience.record("conflict-a", first);
    await experience.record("conflict-b", second);
    const result = await new MemoryConsolidator(
      "workspace-a", experience, new EvolutionStore("workspace-a", root, fixedNow),
    ).consolidate(2);
    expect(result).toMatchObject({ eligibleClusters: 0, conflictedClusters: 1, candidates: [] });
  });

  it("selects a high-risk Prompt mutation for repeated prompt-attributed episodes instead of disguising it as Memory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-prompt-consolidation-"));
    const experience = new ExperienceStore("workspace-a", root);
    const failure = {
      component: "prompt" as const, symptom: "The answer asserted a deployment without runtime evidence",
      cause: "The active prompt does not require an inheritance proof before claiming activation",
      sourceRefs: [{ kind: "trace" as const, ref: "trace-prompt-proof", workspaceId: "workspace-a" }],
    };
    const first = facts({ ticket: { status: "failed" }, failures: [failure] });
    const second = facts({ ticket: { status: "failed" }, failures: [failure] });
    second.commandId = "prompt-episode-b"; second.taskId = "task-b"; second.taskRunId = "run-b";
    second.ticket = { ...second.ticket, ticketId: "ticket-b", attemptId: "attempt-b" };
    second.goal = { ...second.goal, goalId: "goal-b" };
    await experience.record("prompt-a", projectExperience(first, fixedNow));
    await experience.record("prompt-b", projectExperience(second, fixedNow));
    const candidates = new EvolutionStore("workspace-a", root, fixedNow);
    expect((await new MemoryConsolidator("workspace-a", experience, candidates).consolidate(2)).candidates).toEqual([]);
    const result = await new PromptConsolidator("workspace-a", experience, candidates).consolidate(2);
    expect(result.candidates).toEqual([expect.objectContaining({ kind: "prompt", riskLevel: "high", proposedBy: { type: "system", id: "prompt-consolidator/v1" }, mutationSet: expect.objectContaining({ activationBoundary: "next_turn" }) })]);
    expect(await candidates.artifactContent(result.candidates[0]!.candidateId)).toContain("cite the current trace/evidence");
    expect((await new PromptConsolidator("workspace-a", experience, candidates).consolidate(2)).candidates[0]!.candidateId).toBe(result.candidates[0]!.candidateId);
  });
});

function facts(overrides: {
  ticket?: Partial<AuthoritativeEpisodeFacts["ticket"]>;
  sourceRefs?: AuthoritativeEpisodeFacts["sourceRefs"];
  failures?: AuthoritativeEpisodeFacts["failures"];
} = {}): AuthoritativeEpisodeFacts {
  return {
    commandId: "project-episode-a",
    workspaceId: "workspace-a",
    taskId: "task-a",
    taskRunId: "run-a",
    ticket: {
      ticketId: "ticket-a",
      attemptId: "attempt-a",
      status: "completed",
      startedAt: "2026-08-14T00:00:00.000Z",
      updatedAt: "2026-08-14T00:05:00.000Z",
      ...overrides.ticket,
    },
    goal: { goalId: "goal-a", agentId: "agent-a", status: "completed" },
    sourceRefs: overrides.sourceRefs ?? [{ kind: "goal_decision", ref: "decision-a", workspaceId: "workspace-a" }],
    failures: overrides.failures,
  };
}

function fixedNow(): Date { return new Date("2026-08-14T00:10:00.000Z"); }
