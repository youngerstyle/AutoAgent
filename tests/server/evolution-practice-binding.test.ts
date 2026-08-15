import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EvolutionStore } from "../../src/server/evolution/evolution-store.js";
import { platformEvolutionStore } from "../../src/server/evolution-adapters/platform-source-verifier.js";
import { PracticeBindingCompiler } from "../../src/server/evolution/practice-binding-compiler.js";
import { PracticeBindingStore } from "../../src/server/evolution/practice-binding-store.js";
import { PracticeStore } from "../../src/server/evolution/practice-store.js";
import { EvidenceLedger } from "../../src/server/agent-engine/evidence-ledger.js";

describe("Practice asset bindings", () => {
  it("creates provenance-linked Memory and runnable Workflow candidates", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-binding-"));
    const now = () => new Date("2026-08-15T03:00:00.000Z");
    for (const evidenceId of ["memory-practice-feedback", "workflow-practice-feedback"]) await new EvidenceLedger(root).append({ evidenceId, agentId: "agent-a", threadId: "thread-a", goalId: "goal-a", turnId: "turn-a", toolCallId: evidenceId, toolName: "practice-observer", kind: "tool", capture: { status: "recorded" }, observation: { status: "observed", result: {} }, workspaceRoot: root, createdAt: now().toISOString(), input: {} });
    const practices = new PracticeStore("workspace-a", root, now);
    const memoryPractice = await practices.createCandidate(practiceInput("memory-practice", ["memory"]));
    const workflowPractice = await practices.createCandidate(practiceInput("workflow-practice", ["workflow"]));
    const bindings = new PracticeBindingStore(root, now);
    const candidates = platformEvolutionStore("workspace-a", root, now);
    const compiler = new PracticeBindingCompiler("workspace-a", practices, bindings, candidates);

    const result = await compiler.compile();

    expect(result).toMatchObject({ practicesInspected: 2, bindingsProposed: 2 });
    expect(result.candidatesCreated).toHaveLength(2);
    expect(result.candidatesCreated.find((item) => item.kind === "memory")).toMatchObject({
      kind: "memory", status: "proposed",
      scope: { workspaceId: "workspace-a", ownerLevel: "agent_project", profileId: "profile-a" },
      practiceRef: { id: memoryPractice.practiceId, version: "1", contentHash: memoryPractice.provenanceHash },
    });
    expect(await bindings.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({ practiceRef: expect.objectContaining({ id: memoryPractice.practiceId }), kind: "memory", status: "candidate_created" }),
      expect.objectContaining({ practiceRef: expect.objectContaining({ id: workflowPractice.practiceId }), kind: "workflow", status: "candidate_created" }),
    ]));
    const workflow = result.candidatesCreated.find((item) => item.kind === "workflow")!;
    expect(workflow).toMatchObject({ target: "minimal-team", scope: { ownerLevel: "agent_project", profileId: "profile-a" }, practiceRef: { id: workflowPractice.practiceId } });
    expect(await candidates.validate({ commandId: "validate-learned-workflow", candidateId: workflow.candidateId, expectedContentHash: workflow.contentHash })).toMatchObject({ validation: { passed: true, checks: expect.arrayContaining([expect.objectContaining({ name: "workflow_contract", passed: true })]) } });

    expect(await compiler.compile()).toMatchObject({ bindingsProposed: 0, candidatesCreated: [] });
    expect(await candidates.list()).toHaveLength(2);
  });
});

function practiceInput(commandId: string, observedComponents: Array<"memory" | "workflow">) {
  return {
    commandId,
    statement: "Brief the authoritative document before collaboration",
    trigger: "Several agents begin a shared project task",
    procedure: "Brief the current document, confirm acknowledgement, then begin execution.",
    expectedOutcome: [{ metric: "task_success_rate", direction: "increase" as const, minimumDelta: 0.01 }],
    observedComponents,
    applicability: { ownerLevel: "agent_project" as const, workspaceId: "workspace-a", profileId: "profile-a" },
    contraindications: [],
    sourceDraftRefs: [`${commandId}-draft-a`, `${commandId}-draft-b`],
    sourceEpisodeRefs: [`${commandId}-episode-a`, `${commandId}-episode-b`],
    sourceRefs: [{ kind: "evidence" as const, ref: `${commandId}-feedback`, workspaceId: "workspace-a", profileId: "profile-a" }],
  };
}
