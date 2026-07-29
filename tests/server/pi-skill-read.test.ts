import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Skill } from "@earendil-works/pi-coding-agent";
import {
  activePiToolNames,
  initialGoalMessage,
  isTransientInfrastructureToolFailure,
  promptedGoalIds,
  promptedGoalVersions,
  latestCorrectableDecision,
  piSessionSkillsTraceId,
  piWorkSessionDirectory,
  piWorkSessionKey,
  resolveEnabledSkillFile,
  withDefaultResidualRisks,
} from "../../src/server/agent-engine/pi-runtime.js";

describe("Pi Skill read boundary", () => {
  it("classifies only typed platform transport failures for same-Goal retry", () => {
    expect(isTransientInfrastructureToolFailure({
      content: [{ type: "text", text: "[AUTOAGENT_INFRASTRUCTURE_TRANSPORT] browser session reset" }],
    })).toBe(true);
    expect(isTransientInfrastructureToolFailure({
      content: [{ type: "text", text: "game assertion failed" }],
    })).toBe(false);
  });

  it("keeps read active so Pi can progressively load enabled Skills", () => {
    expect(activePiToolNames(["readFile", "readImage", "shell"], false, true)).toEqual([
      "read",
      "readFile",
      "shell",
      "goal_resolution",
      "request_human_input",
    ]);
  });

  it("exposes only the workflow actions compiled for the current Goal", () => {
    expect(activePiToolNames(["readFile"], false, {
      schemaRef: "test",
      completionOutcomeSchema: { type: "object" },
      correctionOutcomeSchema: { type: "object" },
      planChangeOutcomeSchema: { type: "object" },
    })).toEqual([
      "read",
      "readFile",
      "goal_resolution",
      "report_goal_correction",
      "request_goal_plan_change",
      "request_human_input",
    ]);
  });

  it("normalizes an omitted empty-risk list at the tool boundary", () => {
    expect(withDefaultResidualRisks({ status: "completed" })).toEqual({
      status: "completed",
      residualRisks: [],
    });
    expect(withDefaultResidualRisks({ status: "completed", residualRisks: ["待复核"] })).toEqual({
      status: "completed",
      residualRisks: ["待复核"],
    });
  });

  it("partitions session resource traces by goal and turn", () => {
    const first = piSessionSkillsTraceId("thread-a", "goal-a", "turn-a", ["agent-browser"]);
    expect(piSessionSkillsTraceId("thread-a", "goal-a", "turn-a", ["agent-browser"])).toBe(first);
    expect(piSessionSkillsTraceId("thread-a", "goal-b", "turn-b", ["agent-browser"])).not.toBe(first);
  });

  it("isolates Pi work sessions by Goal while preserving the Agent thread identity", () => {
    expect(piWorkSessionKey("thread-a", "goal-a")).toBe(piWorkSessionKey("thread-a", "goal-a"));
    expect(piWorkSessionKey("thread-a", "goal-b")).not.toBe(piWorkSessionKey("thread-a", "goal-a"));
    expect(piWorkSessionKey("thread-a")).not.toBe(piWorkSessionKey("thread-a", "goal-a"));

    const first = piWorkSessionDirectory("C:\\workspace", "qa", "thread-a", "goal-a");
    const retry = piWorkSessionDirectory("C:\\workspace", "qa", "thread-a", "goal-b");
    expect(first).not.toBe(retry);
    expect(path.dirname(first)).toBe(path.dirname(retry));
    expect(first).toContain(path.join("C:\\workspace", ".autoagent", "pi-sessions", "goal-context-v4"));
  });

  it("recovers the first chronological message for an unprompted Goal", () => {
    const thread = {
      threadId: "thread-a",
      agentId: "agent-a",
      scopeId: "scope-a",
      version: 3,
      items: [
        { itemId: "mission", sequence: 1, kind: "message" as const, createdAt: "2026-07-23T00:00:00.000Z", payloadRef: "payload-mission" },
        { itemId: "started", sequence: 2, kind: "control" as const, createdAt: "2026-07-23T00:00:01.000Z", payloadRef: "payload-started" },
        { itemId: "human", sequence: 3, kind: "message" as const, createdAt: "2026-07-23T00:00:02.000Z", payloadRef: "payload-human" },
      ],
    };
    const payloads = new Map<string, unknown>([
      ["payload-mission", { goalId: "goal-a", senderPrincipalId: "mission-process", content: "正式工单" }],
      ["payload-started", { goalId: "goal-a", status: "running" }],
      ["payload-human", { goalId: "goal-a", senderPrincipalId: "human", content: "继续" }],
    ]);

    expect(initialGoalMessage(thread, payloads, "goal-a")).toBe("正式工单");
    expect(initialGoalMessage(thread, payloads, "goal-b")).toBeUndefined();
  });

  it("marks a Goal prompted only after the formal input was assembled", () => {
    expect(promptedGoalIds([
      { type: "custom", customType: "autoagent_goal", data: { goalId: "legacy-premature" } },
      { type: "custom", customType: "autoagent_goal_prompted", data: { goalId: "goal-a" } },
    ])).toEqual(new Set(["goal-a"]));
  });

  it("tracks the latest prompted version for each Goal", () => {
    expect(promptedGoalVersions([
      { type: "custom", customType: "autoagent_goal_prompted", data: { goalId: "goal-a", goalVersion: 2 } },
      { type: "custom", customType: "autoagent_goal_prompted", data: { goalId: "goal-a", goalVersion: 5 } },
      { type: "custom", customType: "autoagent_goal_prompted", data: { goalId: "legacy-goal" } },
    ])).toEqual(new Map([
      ["goal-a", 5],
      ["legacy-goal", 0],
    ]));
  });

  it("selects the latest Host correction for the current Goal only", () => {
    const thread = {
      threadId: "thread-a",
      agentId: "wa_qa",
      scopeId: "scope-a",
      version: 3,
      items: [
        { itemId: "old", sequence: 1, kind: "control" as const, createdAt: "2026-07-24T00:00:00.000Z", payloadRef: "old" },
        { itemId: "other", sequence: 2, kind: "control" as const, createdAt: "2026-07-24T00:00:01.000Z", payloadRef: "other" },
        { itemId: "latest", sequence: 3, kind: "control" as const, createdAt: "2026-07-24T00:00:02.000Z", payloadRef: "latest" },
      ],
    };
    const payloads = new Map<string, unknown>([
      ["old", { type: "goal_resolution_decision", status: "correctable", goalId: "goal-a", decision: { reason: "old" } }],
      ["other", { type: "goal_resolution_decision", status: "correctable", goalId: "goal-b", decision: { reason: "other" } }],
      ["latest", { type: "goal_resolution_decision", status: "correctable", goalId: "goal-a", decision: { reason: "latest" } }],
    ]);

    expect(latestCorrectableDecision(thread, payloads, "goal-a")).toEqual({ reason: "latest" });
  });

  it("treats only files below an enabled Skill root as Skill resources", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-skill-"));
    const skillRoot = path.join(root, "agent-browser");
    const otherRoot = path.join(root, "other");
    await mkdir(skillRoot, { recursive: true });
    await mkdir(otherRoot, { recursive: true });
    await writeFile(path.join(skillRoot, "SKILL.md"), "# Browser", "utf8");
    await writeFile(path.join(otherRoot, "secret.md"), "secret", "utf8");
    const skill = {
      name: "agent-browser",
      description: "browser",
      filePath: path.join(skillRoot, "SKILL.md"),
      baseDir: skillRoot,
      disableModelInvocation: false,
      sourceInfo: {} as Skill["sourceInfo"],
    } satisfies Skill;

    await expect(resolveEnabledSkillFile(skill.filePath, [skill])).resolves.toBe(await realpath(skill.filePath));
    await expect(resolveEnabledSkillFile(path.join(otherRoot, "secret.md"), [skill])).resolves.toBeUndefined();
    await expect(resolveEnabledSkillFile("SKILL.md", [skill])).resolves.toBeUndefined();
    await rm(root, { recursive: true, force: true });
  });
});
