import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { EvidenceLedger } from "../../src/server/evidence/evidence-ledger.js";
import { PlatformEvolutionTrialAdapter, type EvolutionTrialRuntimeFacade } from "../../src/server/evolution-adapters/platform-trial-adapter.js";
import { fixtureRequest } from "./evolution-paired-trial-store.test.js";

describe("Platform evolution trial adapter", () => {
  it("dispatches frozen baseline/candidate Mission pairs without leaking the candidate into the task objective", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-platform-trial-"));
    await new EvidenceLedger(root).append({
      evidenceId: "evidence-a", agentId: "source", threadId: "thread", goalId: "goal", turnId: "turn", toolCallId: "call", toolName: "fixture", kind: "tool",
      capture: { status: "recorded" }, observation: { status: "observed", result: { task: "prepare a project briefing" } }, input: { task: "brief the team" }, workspaceRoot: root, createdAt: "2026-08-19T00:00:00.000Z",
    });
    const started: Array<Parameters<EvolutionTrialRuntimeFacade["start"]>[0]> = [];
    const observation = { success: true, qualityScore: 1, costUsd: 0, costMeasured: false, latencyMs: 1, toolFailures: 0, policyViolations: 0, safetyViolations: 0 };
    const runtime: EvolutionTrialRuntimeFacade = {
      async available() { return true; },
      start: vi.fn(async (input) => { started.push(input); }),
      async observe() { return { status: "succeeded", observation, evidenceRefs: [] }; },
    };
    const adapter = new PlatformEvolutionTrialAdapter("workspace-a", root, runtime);
    const request = fixtureRequest("workspace-a");
    const dispatched = await adapter.dispatch({ workspaceId: "workspace-a", trialId: "trial-a", request });
    expect(dispatched).toEqual({ dispatchRef: "trial-a" });
    expect(started).toHaveLength(6);
    for (const evalCase of request.cases) {
      const pair = started.filter((item) => item.trial.caseId === evalCase.caseId);
      expect(pair.map((item) => item.trial.variant).sort()).toEqual(["baseline", "candidate"]);
      expect(pair[0]!.objective).toBe(pair[1]!.objective);
      expect(pair[0]!.objective).not.toContain(request.candidateId);
    }

    const result = await adapter.observe({ workspaceId: "workspace-a", trialId: "trial-a", dispatchRef: "trial-a" });
    expect(result).toMatchObject({ status: "succeeded", caseResults: expect.arrayContaining([expect.objectContaining({ caseId: "target" })]) });
    if (result.status === "succeeded") expect(result.caseResults.every((item) => item.evidenceRefs.some((ref) => ref.kind === "evidence"))).toBe(true);
  });

  it("rejects cross-workspace dispatch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-platform-trial-scope-"));
    const runtime = { available: async () => true, start: async () => {}, observe: async () => ({ status: "pending" as const }) };
    await expect(new PlatformEvolutionTrialAdapter("workspace-a", root, runtime).dispatch({ workspaceId: "workspace-b", trialId: "trial", request: fixtureRequest("workspace-b") }))
      .rejects.toThrow("workspace boundary");
  });
});
