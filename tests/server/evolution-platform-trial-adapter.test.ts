import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { EvidenceLedger } from "../../src/server/evidence/evidence-ledger.js";
import { PlatformEvolutionTrialAdapter, type EvolutionTrialRuntimeFacade } from "../../src/server/evolution-adapters/platform-trial-adapter.js";
import { TrialWorkspaceIsolationManager } from "../../src/server/evolution-adapters/trial-workspace-isolation.js";
import { workspaceEvolutionTrialDispatchFile } from "../../src/server/storage/paths.js";
import { fixtureRequest } from "./evolution-paired-trial-store.test.js";

describe("Platform evolution trial adapter", () => {
  it("prepares one idempotent frozen generation under concurrent dispatch preparation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-platform-trial-concurrent-isolation-"));
    await writeFile(path.join(root, "project.txt"), "one frozen value", "utf8");
    const isolation = new TrialWorkspaceIsolationManager(root);
    const [left, right] = await Promise.all([
      isolation.prepare("trial-concurrent", 1, [{ caseId: "target" }]),
      isolation.prepare("trial-concurrent", 1, [{ caseId: "target" }]),
    ]);
    expect(left.get("target")!.baseline).toEqual(right.get("target")!.baseline);
    expect(await readFile(path.join(left.get("target")!.baseline.rootPath, "project.txt"), "utf8")).toBe("one frozen value");
    await isolation.cleanupGeneration("trial-concurrent", 1);
  });

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
      start: vi.fn(async (input) => {
        started.push(input);
        expect(input.execution).toBeDefined();
        await writeFile(path.join(input.execution!.rootPath, "arm-output.txt"), input.trial.variant, "utf8");
      }),
      async observe() { return { status: "succeeded", observation, evidenceRefs: [] }; },
      release: vi.fn(async () => undefined),
    };
    const adapter = new PlatformEvolutionTrialAdapter("workspace-a", root, runtime);
    const request = fixtureRequest("workspace-a");
    const dispatched = await adapter.dispatch({ workspaceId: "workspace-a", trialId: "trial-a", request });
    expect(dispatched).toEqual({ dispatchRef: "trial-a:1" });
    expect(started).toHaveLength(6);
    expect(new Set(started.map((item) => item.execution!.rootPath)).size).toBe(6);
    expect(new Set(started.map((item) => item.execution!.snapshotHash)).size).toBe(1);
    for (const evalCase of request.cases) {
      const pair = started.filter((item) => item.trial.caseId === evalCase.caseId);
      expect(pair.map((item) => item.trial.variant).sort()).toEqual(["baseline", "candidate"]);
      expect(pair[0]!.trial).toMatchObject({ group: evalCase.group, assertions: evalCase.assertions });
      expect(pair[0]!.objective).toBe(pair[1]!.objective);
      expect(pair[0]!.objective).not.toContain(request.candidateId);
      const baseline = pair.find((item) => item.trial.variant === "baseline")!;
      const candidate = pair.find((item) => item.trial.variant === "candidate")!;
      expect(baseline.execution!.rootPath).not.toBe(candidate.execution!.rootPath);
      expect(await readFile(path.join(baseline.execution!.rootPath, "arm-output.txt"), "utf8")).toBe("baseline");
      expect(await readFile(path.join(candidate.execution!.rootPath, "arm-output.txt"), "utf8")).toBe("candidate");
      if (evalCase.group === "target") {
        expect(pair[0]!.objective).toContain("Execute only the frozen assertions");
        expect(pair[0]!.objective).toContain('"historicalSourceRef"');
        expect(pair[0]!.objective).not.toContain("prepare a project briefing");
        expect(pair[0]!.objective).not.toContain("brief the team");
      } else {
        expect(pair[0]!.objective).toContain("prepare a project briefing");
      }
    }

    const result = await adapter.observe({ workspaceId: "workspace-a", trialId: "trial-a", dispatchRef: "trial-a:1" });
    expect(result).toMatchObject({ status: "succeeded", caseResults: expect.arrayContaining([expect.objectContaining({ caseId: "target" })]) });
    if (result.status === "succeeded") expect(result.caseResults.every((item) => item.evidenceRefs.some((ref) => ref.kind === "evidence"))).toBe(true);
    expect(runtime.release).toHaveBeenCalledTimes(6);
    await expect(access(started[0]!.execution!.rootPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(path.join(root, "arm-output.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    const record = JSON.parse(await readFile(workspaceEvolutionTrialDispatchFile(root, "trial-a"), "utf8")) as {
      cleanup: { status: string; manifestRef: string };
    };
    expect(record.cleanup.status).toBe("completed");
    const manifest = JSON.parse(await readFile(path.join(root, record.cleanup.manifestRef), "utf8")) as { tasks: Array<{ sourceSnapshotHash: string }> };
    expect(manifest.tasks).toHaveLength(3);
    expect(new Set(manifest.tasks.map((item) => item.sourceSnapshotHash)).size).toBe(1);
  });

  it("imports isolated Runtime evidence into the project ledger before deleting arm workspaces", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-platform-trial-evidence-import-"));
    await new EvidenceLedger(root).append({
      evidenceId: "evidence-a", agentId: "source", threadId: "thread", goalId: "goal", turnId: "turn", toolCallId: "call", toolName: "fixture", kind: "tool",
      capture: { status: "recorded" }, observation: { status: "observed", result: { task: "evidence import" } }, input: {}, workspaceRoot: root, createdAt: "2026-08-19T00:00:00.000Z",
    });
    const observation = { success: true, qualityScore: 1, costUsd: 0, costMeasured: false, latencyMs: 1, toolFailures: 0, policyViolations: 0, safetyViolations: 0 };
    const runtime: EvolutionTrialRuntimeFacade = {
      async available() { return true; },
      async start() { return undefined; },
      async observe(input) {
        const evidenceId = `isolated-${input.taskId}`;
        const detailEvidenceId = `isolated-detail-${input.taskId}`;
        const ledger = new EvidenceLedger(input.execution!.rootPath);
        if (!await ledger.get(evidenceId)) await ledger.append({
          evidenceId, agentId: "trial-agent", threadId: input.taskId, turnId: input.taskId, toolCallId: input.taskId,
          toolName: "trial-observer", kind: "tool", capture: { status: "recorded" }, observation: { status: "observed", result: { isolated: true } },
          input: {}, workspaceRoot: input.execution!.rootPath, createdAt: "2026-08-19T00:00:01.000Z",
        });
        if (!await ledger.get(detailEvidenceId)) await ledger.append({
          evidenceId: detailEvidenceId, agentId: "trial-agent", threadId: input.taskId, turnId: input.taskId, toolCallId: detailEvidenceId,
          toolName: "trial-detail", kind: "tool", capture: { status: "recorded" }, observation: { status: "observed", result: { retainedDetail: true } },
          input: {}, workspaceRoot: input.execution!.rootPath, createdAt: "2026-08-19T00:00:02.000Z",
        });
        return { status: "succeeded", observation, evidenceRefs: [{ kind: "evidence", ref: evidenceId, workspaceId: "workspace-a" }] };
      },
      async release() { return undefined; },
    };
    const adapter = new PlatformEvolutionTrialAdapter("workspace-a", root, runtime);
    await adapter.dispatch({ workspaceId: "workspace-a", trialId: "trial-evidence", request: fixtureRequest("workspace-a") });
    const result = await adapter.observe({ workspaceId: "workspace-a", trialId: "trial-evidence", dispatchRef: "trial-evidence:1" });
    expect(result.status).toBe("succeeded");
    if (result.status === "succeeded") {
      const imported = result.caseResults.flatMap((item) => item.evidenceRefs).find((ref) => ref.ref.startsWith("isolated-"));
      expect(imported).toBeDefined();
      const projectLedger = new EvidenceLedger(root);
      expect(await projectLedger.get(imported!.ref)).toMatchObject({ workspaceRoot: path.resolve(root), observation: { result: { isolated: true } } });
      expect((await projectLedger.list()).filter((fact) => fact.evidenceId.startsWith("isolated-detail-"))).toHaveLength(6);
    }
  });

  it("rejects cross-workspace dispatch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-platform-trial-scope-"));
    const runtime = { available: async () => true, start: async () => {}, observe: async () => ({ status: "pending" as const }) };
    await expect(new PlatformEvolutionTrialAdapter("workspace-a", root, runtime).dispatch({ workspaceId: "workspace-b", trialId: "trial", request: fixtureRequest("workspace-b") }))
      .rejects.toThrow("workspace boundary");
  });

  it("keeps replay assertions intact when authoritative source context exceeds the objective budget", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-platform-trial-bounded-source-"));
    await new EvidenceLedger(root).append({
      evidenceId: "evidence-a", agentId: "source", threadId: "thread", goalId: "goal", turnId: "turn", toolCallId: "call", toolName: "fixture", kind: "tool",
      capture: { status: "recorded" }, observation: { status: "observed", result: { oversized: "x".repeat(30_000) } }, input: {}, workspaceRoot: root, createdAt: "2026-08-19T00:00:00.000Z",
    });
    const started: Array<Parameters<EvolutionTrialRuntimeFacade["start"]>[0]> = [];
    const runtime: EvolutionTrialRuntimeFacade = {
      async available() { return true; },
      async start(input) { started.push(input); },
      async observe() { return { status: "pending" }; },
    };
    const request = fixtureRequest("workspace-a");
    await new PlatformEvolutionTrialAdapter("workspace-a", root, runtime).dispatch({ workspaceId: "workspace-a", trialId: "trial-bounded", request });
    const replay = started.find((item) => item.trial.group === "regression")!;
    const payload = JSON.parse(replay.objective.split("\n\n").at(-1)!) as { source: { truncated: boolean }; assertions: string[] };
    expect(payload.source.truncated).toBe(true);
    expect(payload.assertions).toEqual(request.cases.find((item) => item.group === "regression")!.assertions);
  });

  it("creates one new task generation after infrastructure failure and reuses it after dispatch response loss", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-platform-trial-retry-"));
    await new EvidenceLedger(root).append({
      evidenceId: "evidence-a", agentId: "source", threadId: "thread", goalId: "goal", turnId: "turn", toolCallId: "call", toolName: "fixture", kind: "tool",
      capture: { status: "recorded" }, observation: { status: "observed", result: { task: "retry" } }, input: {}, workspaceRoot: root, createdAt: "2026-08-19T00:00:00.000Z",
    });
    const started: string[] = []; let failedTaskId = "";
    const runtime: EvolutionTrialRuntimeFacade = {
      async available() { return true; },
      async start(input) { started.push(input.taskId); },
      async observe(input) { return input.taskId === failedTaskId ? { status: "infrastructure_failed", message: "staffing collision" } : { status: "pending" }; },
    };
    const adapter = new PlatformEvolutionTrialAdapter("workspace-a", root, runtime);
    const first = await adapter.dispatch({ workspaceId: "workspace-a", trialId: "trial-retry", request: fixtureRequest("workspace-a") });
    const firstIds = [...started]; failedTaskId = firstIds[0]!;
    const second = await adapter.dispatch({ workspaceId: "workspace-a", trialId: "trial-retry", request: fixtureRequest("workspace-a") });
    const secondIds = started.slice(6);
    expect(first).toEqual({ dispatchRef: "trial-retry:1" });
    expect(second).toEqual({ dispatchRef: "trial-retry:2" });
    expect(new Set(secondIds)).not.toEqual(new Set(firstIds));
    failedTaskId = "";
    const replay = await adapter.dispatch({ workspaceId: "workspace-a", trialId: "trial-retry", request: fixtureRequest("workspace-a") });
    expect(replay).toEqual(second);
    expect(started.slice(12)).toEqual(secondIds);
  });

  it("detects a later case infrastructure failure even while the first case is still running", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-platform-trial-observe-all-"));
    await new EvidenceLedger(root).append({
      evidenceId: "evidence-a", agentId: "source", threadId: "thread", goalId: "goal", turnId: "turn", toolCallId: "call", toolName: "fixture", kind: "tool",
      capture: { status: "recorded" }, observation: { status: "observed", result: { task: "observe all" } }, input: {}, workspaceRoot: root, createdAt: "2026-08-19T00:00:00.000Z",
    });
    const started: Array<Parameters<EvolutionTrialRuntimeFacade["start"]>[0]> = [];
    const runtime: EvolutionTrialRuntimeFacade = {
      async available() { return true; },
      async start(input) { started.push(input); },
      async observe(input) {
        const task = started.find((item) => item.taskId === input.taskId);
        return task?.trial.caseId === "regression" && task.trial.variant === "baseline"
          ? { status: "infrastructure_failed", message: "later staffing failure" }
          : { status: "running" };
      },
    };
    const adapter = new PlatformEvolutionTrialAdapter("workspace-a", root, runtime);
    await adapter.dispatch({ workspaceId: "workspace-a", trialId: "trial-observe-all", request: fixtureRequest("workspace-a") });

    await expect(adapter.observe({ workspaceId: "workspace-a", trialId: "trial-observe-all", dispatchRef: "trial-observe-all:1" }))
      .resolves.toMatchObject({ status: "inconclusive", category: "transient", message: "later staffing failure" });
  });
});
