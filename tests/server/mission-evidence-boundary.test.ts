import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { AgentGoal, GoalResolutionProposal } from "../../src/shared/contracts/agent-engine.js";
import { EvidenceLedger } from "../../src/server/agent-engine/evidence-ledger.js";
import { validateEvidenceFacts } from "../../src/server/mission-process/mission-goal-resolution-port.js";

describe("Mission completion evidence boundary", () => {
  it("accepts a successful tool fact from the current Agent Goal", async () => {
    const fixture = await evidenceFixture();

    await expect(validateEvidenceFacts(
      fixture.root,
      "dev",
      fixture.goal,
      proposal(fixture.evidenceId),
    )).resolves.toBeUndefined();
  });

  it("keeps successful evidence valid across retries of the same Goal", async () => {
    const fixture = await evidenceFixture({ attemptId: "previous-attempt" });

    await expect(validateEvidenceFacts(
      fixture.root,
      "dev",
      fixture.goal,
      proposal(fixture.evidenceId),
    )).resolves.toBeUndefined();
  });

  it("rejects invented evidence IDs", async () => {
    const fixture = await evidenceFixture();

    await expect(validateEvidenceFacts(
      fixture.root,
      "dev",
      fixture.goal,
      proposal("invented-evidence"),
    )).resolves.toContain("invented-evidence");
  });

  it("rejects evidence from another Goal", async () => {
    const fixture = await evidenceFixture({ goalId: "other-goal", attemptId: "other-attempt" });

    await expect(validateEvidenceFacts(
      fixture.root,
      "dev",
      fixture.goal,
      proposal(fixture.evidenceId),
    )).resolves.toContain("Agent Goal");
  });

  it("accepts explicitly inherited upstream evidence in criterion results", async () => {
    const fixture = await evidenceFixture({ goalId: "upstream-goal", attemptId: "upstream-attempt" });
    const inheritedGoal = {
      ...fixture.goal,
      spec: {
        ...fixture.goal.spec,
        evidencePolicy: { inheritedEvidenceIds: [fixture.evidenceId] },
      },
    };

    await expect(validateEvidenceFacts(
      fixture.root,
      "boss",
      inheritedGoal,
      proposal(fixture.evidenceId),
    )).resolves.toBeUndefined();
  });

  it("still rejects stale inherited file evidence", async () => {
    const fixture = await evidenceFixture({ goalId: "upstream-goal", attemptId: "upstream-attempt" });
    const inheritedGoal = {
      ...fixture.goal,
      spec: {
        ...fixture.goal.spec,
        evidencePolicy: { inheritedEvidenceIds: [fixture.evidenceId] },
      },
    };
    await writeFile(path.join(fixture.root, "src", "game.ts"), "changed after upstream verification", "utf8");

    await expect(validateEvidenceFacts(
      fixture.root,
      "boss",
      inheritedGoal,
      proposal(fixture.evidenceId),
    )).resolves.toContain("发生变化");
  });

  it("rejects file evidence after the artifact changed", async () => {
    const fixture = await evidenceFixture();
    await writeFile(path.join(fixture.root, "src", "game.ts"), "changed after verification", "utf8");

    await expect(validateEvidenceFacts(
      fixture.root,
      "dev",
      fixture.goal,
      proposal(fixture.evidenceId),
    )).resolves.toContain("用 readFile 或 readImage 重新读取该文件");
  });

  it("uses the latest submitted evidence for the same artifact path", async () => {
    const fixture = await evidenceFixture();
    const target = path.join(fixture.root, "src", "game.ts");
    const content = "export const playable = 'updated';";
    await writeFile(target, content, "utf8");
    const info = await stat(target);
    const ledger = new EvidenceLedger(fixture.root);
    const current = await ledger.append({
      agentId: "dev",
      threadId: "thread-dev",
      goalId: "goal-dev",
      attemptId: "attempt-dev",
      turnId: "turn-dev-current",
      toolCallId: "tool-call-read-current",
      toolName: "readFile",
      kind: "file_read",
      status: "succeeded",
      workspaceRoot: fixture.root,
      createdAt: new Date(Date.now() + 1_000).toISOString(),
      input: { path: path.join("src", "game.ts") },
      result: { path: path.join("src", "game.ts") },
      artifact: {
        path: path.join("src", "game.ts"),
        size: info.size,
        modifiedAt: info.mtime.toISOString(),
        sha256: createHash("sha256").update(content).digest("hex"),
      },
    });
    const evidence = [{ evidenceId: fixture.evidenceId }, { evidenceId: current.evidenceId }];

    await expect(validateEvidenceFacts(
      fixture.root,
      "dev",
      fixture.goal,
      {
        evidence,
        criterionResults: [{ criterionIndex: 0, status: "satisfied", evidence }],
        domainOutcome: undefined,
      },
    )).resolves.toBeUndefined();
  });
});

async function evidenceFixture(overrides: { goalId?: string; attemptId?: string } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-evidence-"));
  const relativePath = path.join("src", "game.ts");
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  const content = "export const playable = true;";
  await writeFile(target, content, "utf8");
  const info = await stat(target);
  const ledger = new EvidenceLedger(root);
  const fact = await ledger.append({
    agentId: "dev",
    threadId: "thread-dev",
    goalId: overrides.goalId ?? "goal-dev",
    attemptId: overrides.attemptId ?? "attempt-dev",
    turnId: "turn-dev",
    toolCallId: "tool-call-read",
    toolName: "readFile",
    kind: "file_read",
    status: "succeeded",
    workspaceRoot: root,
    createdAt: new Date().toISOString(),
    input: { path: relativePath },
    result: { path: relativePath },
    artifact: {
      path: relativePath,
      size: info.size,
      modifiedAt: info.mtime.toISOString(),
      sha256: createHash("sha256").update(content).digest("hex"),
    },
  });
  return { root, evidenceId: fact.evidenceId, goal: goalFixture() };
}

function goalFixture(): AgentGoal {
  return {
    spec: {
      id: "goal-dev",
      threadId: "thread-dev",
      objective: "Implement the delivery",
      successCriteria: ["The delivery is verifiable"],
      contextRefs: [],
      attemptId: "attempt-dev",
      createdAt: new Date().toISOString(),
    },
    version: 1,
    status: "active",
    updatedAt: new Date().toISOString(),
  };
}

function proposal(evidenceId: string): Pick<GoalResolutionProposal, "evidence" | "criterionResults" | "domainOutcome"> {
  const evidence = [{ evidenceId }];
  return {
    evidence,
    criterionResults: [{ criterionIndex: 0, status: "satisfied", evidence }],
    domainOutcome: undefined,
  };
}
