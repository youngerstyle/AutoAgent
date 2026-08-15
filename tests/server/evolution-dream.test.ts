import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EvolutionDreamWorker } from "../../src/server/evolution/dream-worker.js";
import { PracticeDraftStore } from "../../src/server/evolution/practice-draft-store.js";
import { PracticeStore } from "../../src/server/evolution/practice-store.js";

describe("Evolution Dream consolidation", () => {
  it("requires two independent episodes and creates one versioned agent-project Practice", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-dream-"));
    const now = () => new Date("2026-08-15T02:00:00.000Z");
    const drafts = new PracticeDraftStore("workspace-a", root, now);
    const practices = new PracticeStore("workspace-a", root, now);
    await drafts.create(draftInput("command-a", "signal-a", "episode-a", "evidence-a"));
    await drafts.create(draftInput("command-b", "signal-b", "episode-b", "evidence-b"));
    const worker = new EvolutionDreamWorker("workspace-a", drafts, practices);

    expect(await worker.run(2)).toEqual({ draftsInspected: 2, clustersEligible: 1, clustersConflicted: 0, practicesProduced: 1 });

    const values = await practices.list();
    expect(values).toHaveLength(1);
    expect(values[0]).toMatchObject({
      version: 1,
      status: "candidate",
      applicability: { ownerLevel: "agent_project", workspaceId: "workspace-a", profileId: "profile-a" },
      sourceEpisodeRefs: ["episode-a", "episode-b"],
      sourceDraftRefs: expect.arrayContaining([expect.stringMatching(/^practice_draft_/), expect.stringMatching(/^practice_draft_/)]),
    });
    expect((await drafts.list()).map((draft) => draft.status)).toEqual(["consolidated", "consolidated"]);
    expect(await worker.run(2)).toEqual({ draftsInspected: 0, clustersEligible: 0, clustersConflicted: 0, practicesProduced: 0 });
    expect(await practices.list()).toHaveLength(1);
  });

  it("keeps counter-evidenced clusters unresolved instead of turning them into learned truth", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-dream-conflict-"));
    const drafts = new PracticeDraftStore("workspace-a", root);
    const practices = new PracticeStore("workspace-a", root);
    await drafts.create(draftInput("command-a", "signal-a", "episode-a", "evidence-a"));
    await drafts.create({ ...draftInput("command-b", "signal-b", "episode-b", "evidence-b"), contraindications: ["evidence:counter-b"] });

    expect(await new EvolutionDreamWorker("workspace-a", drafts, practices).run(2)).toMatchObject({ clustersEligible: 0, clustersConflicted: 1, practicesProduced: 0 });
    expect(await practices.list()).toEqual([]);
    expect((await drafts.list()).map((draft) => draft.status)).toEqual(["draft", "draft"]);
  });
});

function draftInput(commandId: string, signalId: string, episodeId: string, evidenceRef: string) {
  return {
    commandId, signalId,
    statement: "Brief the authoritative document before collaborative execution",
    trigger: "A project task starts with multiple participating agents",
    procedure: "Brief the current document, confirm acknowledgement, then begin execution",
    expectedOutcome: [{ metric: "task_success_rate", direction: "increase" as const, minimumDelta: 0.01 }],
    observedComponents: ["workflow" as const],
    applicability: { ownerLevel: "agent_project" as const, workspaceId: "workspace-a", profileId: "profile-a" },
    contraindications: [],
    sourceEpisodeRefs: [episodeId],
    sourceRefs: [{ kind: "evidence" as const, ref: evidenceRef, workspaceId: "workspace-a", profileId: "profile-a" }],
  };
}
