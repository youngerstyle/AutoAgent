import { describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  abortPiSessionPromptly,
  awaitPiPromptOutcome,
  compactPiToolEventDetails,
  createPiToolExecutionBarrier,
  createPiPromptWatchdog,
  goalResolutionDomainOutcomeSchema,
  goalResolutionCriterionResultsSchema,
  goalResolutionTransportDomainOutcomeSchema,
  installPiTurnBoundary,
  isUsefulToolProgress,
  modelFacingToolResultText,
  replaceLivePiModelContext,
  toolFailureFingerprint,
  toolObservationFingerprint,
  turnToolBudgetMessage,
  unresolvedGoalPrompt,
  waitForCleanupPromptly,
  workspaceToolExecutionMode,
} from "../../src/server/agent-engine/pi-runtime.js";
import {
  compileMissionGoalOutputContract,
} from "../../src/server/mission-process/mission-output-contract.js";
import { parseResolutionProposal } from "../../src/server/agent-engine/resolution-proposal.js";
import type { AgentGoal } from "../../src/shared/contracts/agent-engine.js";
import type { MissionBaseline } from "../../src/shared/contracts/mission-control.js";
import type { TicketDefinition, TicketId } from "../../src/shared/contracts/ticket-engine.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("Pi tool error projection", () => {
  it("removes rejected argument payloads from model-facing validation errors", () => {
    const raw = {
      content: [{
        type: "text",
        text: `Validation failed for tool "goal_resolution":\n- criterionResults/0 must be object\n\nReceived arguments:\n${JSON.stringify({
          criterionResults: ["recursive-payload".repeat(10_000)],
        })}`,
      }],
    };

    const projected = modelFacingToolResultText(raw, true);

    expect(projected).toContain("criterionResults/0 must be object");
    expect(projected).toContain("重新提交完整参数");
    expect(projected).toContain("不会替你推断缺失字段");
    expect(projected).toContain("Rejected arguments omitted");
    expect(projected).not.toContain("recursive-payload");
    expect(projected.length).toBeLessThan(1_000);
  });

  it("explains an array-boundary error without deciding the domain result", () => {
    const raw = {
      content: [{
        type: "text",
        text: `Validation failed for tool "goal_resolution":\n- domainOutcome/assuranceReport/missionCriterionResults/4 must be object\n\nReceived arguments:\n{"domainOutcome":{"assuranceReport":{"missionCriterionResults":[{},"disposition"]}}}`,
      }],
    };

    const projected = modelFacingToolResultText(raw, true);

    expect(projected).toContain("数组项");
    expect(projected).toContain("完整对象");
    expect(projected).toContain("数组外字段必须放回父对象");
    expect(projected).toContain("只修复参数结构");
    expect(projected).not.toContain("disposition");
  });
});

describe("Pi live context recovery", () => {
  it("replaces the in-memory transcript from the projected session context", () => {
    const modelContext = SessionManager.inMemory("C:\\workspace");
    modelContext.appendMessage({
      role: "user",
      content: "根据纠正后的结构重新提交完整结论",
      timestamp: Date.now(),
    });
    let queuesCleared = false;
    const agent = {
      clearAllQueues() {
        queuesCleared = true;
      },
      state: { messages: [] },
    } as unknown as Parameters<typeof replaceLivePiModelContext>[0];

    replaceLivePiModelContext(agent, modelContext);

    expect(queuesCleared).toBe(true);
    expect(agent.state.messages).toEqual(modelContext.buildSessionContext().messages);
    expect(JSON.stringify(agent.state.messages)).toContain("根据纠正后的结构");
  });
});

describe("Pi turn execution budget", () => {
  it("describes a bounded turn without claiming that the Mission or Goal failed", () => {
    const message = turnToolBudgetMessage(200);

    expect(message).toContain("200 次工具调用");
    expect(message).toContain("Mission 和 Goal 均保持原状");
    expect(message).toContain("本轮会话已释放");
    expect(message).not.toContain("任务失败");
  });
});

describe("Pi terminal submission recovery", () => {
  it("groups terminal contract failures by semantic error instead of attempt count", () => {
    const first = toolFailureFingerprint(
      "goal_resolution",
      { domainOutcome: { objective: "目标 A" } },
      { content: [{ type: "text", text: "domainOutcome.assuranceReport is required" }] },
    );
    const second = toolFailureFingerprint(
      "goal_resolution",
      { domainOutcome: { objective: "目标 B", summary: "仍在修正" } },
      { content: [{ type: "text", text: "domainOutcome.assuranceReport is required" }] },
    );

    expect(first).toBe(second);
  });

  it("treats an identical tool observation as the same no-progress cycle", () => {
    const first = toolObservationFingerprint(
      "readFile",
      { path: "src/index.ts" },
      { ok: true, content: "export const ready = true;", timestamp: "ignored" },
      false,
    );
    const second = toolObservationFingerprint(
      "readFile",
      { path: "src/index.ts" },
      { ok: true, content: "export const ready = true;", timestamp: "changed" },
      false,
    );
    const changed = toolObservationFingerprint(
      "readFile",
      { path: "src/index.ts" },
      { ok: true, content: "export const ready = false;", timestamp: "changed" },
      false,
    );

    expect(second).toBe(first);
    expect(changed).not.toBe(first);
  });
});

describe("Pi workspace tool execution", () => {
  it("serializes stateful tools while preserving parallel reads", () => {
    expect(workspaceToolExecutionMode("browser")).toBe("sequential");
    expect(workspaceToolExecutionMode("shell")).toBe("sequential");
    expect(workspaceToolExecutionMode("writeFile")).toBe("sequential");
    expect(workspaceToolExecutionMode("readFile")).toBe("parallel");
    expect(workspaceToolExecutionMode("listFiles")).toBe("parallel");
  });
});

describe("Pi platform turn boundary", () => {
  it("marks each completed tool batch to stop before Pi starts another provider request", async () => {
    let previousCalls = 0;
    const agent = {
      afterToolCall: async () => {
        previousCalls += 1;
        return { details: { preserved: true } };
      },
    } as unknown as Parameters<typeof installPiTurnBoundary>[0];

    installPiTurnBoundary(agent);
    const result = await agent.afterToolCall?.({} as never, new AbortController().signal);

    expect(previousCalls).toBe(1);
    expect(result).toEqual({ details: { preserved: true }, terminate: true });
  });
});

describe("Pi goal resolution transport boundary", () => {
  it("validates domain payloads inside the current turn before Mission settlement", () => {
    const contract = compileMissionGoalOutputContract({
      title: "质量检查",
      objective: "验证交付",
      successCriteria: ["形成结论"],
      assignment: {},
      outputContract: { schemaRef: "mission-assurance-v1" },
      assurance: { missionCriterionIds: ["criterion-1"] },
    }, baseline);
    const malformed = {
      assuranceReport: {
        baselineVersion: 3,
        missionCriterionResults: [{ unexpected: "provider-side envelope remains opaque" }],
      },
    };

    expect(Value.Check(goalResolutionTransportDomainOutcomeSchema(contract), malformed)).toBe(true);
    const transportSchema = JSON.stringify(goalResolutionTransportDomainOutcomeSchema(contract));
    expect(transportSchema).not.toContain("criterionId");
    expect(transportSchema).not.toContain("anchorResults");
    expect(Value.Check(goalResolutionDomainOutcomeSchema(contract), malformed)).toBe(false);

    const wrongCollectionItem = {
      assuranceReport: {
        baselineVersion: 3,
        missionCriterionResults: ["not-an-object"],
      },
    };
   expect(Value.Check(goalResolutionTransportDomainOutcomeSchema(contract), wrongCollectionItem)).toBe(false);
 });

  it("keeps positive assurance completion separate from routing dispositions", () => {
    const contract = compileMissionGoalOutputContract({
      title: "质量检查",
      objective: "验证交付",
      successCriteria: ["形成结论"],
      assignment: {},
      outputContract: { schemaRef: "mission-assurance-v1" },
      assurance: { missionCriterionIds: ["criterion-1"] },
    }, baseline);
    const report = {
      assuranceReport: {
        baselineVersion: 3,
        missionCriterionResults: [{
          criterionId: "criterion-1",
          status: "satisfied",
          evidence: [{ evidenceId: "evidence-1" }],
          anchorResults: [{
            anchorIndex: 0,
            status: "satisfied",
            evidence: [{ evidenceId: "evidence-1" }],
            verificationBasis: { summary: "按当前验收锚点检查", evidence: [{ evidenceId: "evidence-1" }] },
            observations: ["实际观察到目标行为"],
            deviations: [],
          }],
        }],
      },
    };
    expect(contract.completionOutcomeSchema).toBeDefined();
    const schema = contract.completionOutcomeSchema as Parameters<typeof Value.Check>[0];

    expect(Value.Check(schema, report)).toBe(true);
    expect(Value.Check(schema, { ...report, disposition: "complete" })).toBe(false);
    expect(Value.Check(schema, { ...report, disposition: "verified" })).toBe(false);
  });

  it("rejects undeclared assurance criteria before creating a durable proposal", () => {
    const contract = compileMissionGoalOutputContract({
      title: "质量检查",
      objective: "验证交付",
      successCriteria: ["形成结论"],
      assignment: {},
      outputContract: { schemaRef: "mission-assurance-v1" },
      assurance: { missionCriterionIds: ["criterion-1"] },
    }, baseline);
    const malformed = {
      assuranceReport: {
        baselineVersion: 3,
        missionCriterionResults: [{
          criterionId: "criterion-1",
          status: "satisfied",
          evidence: [{ evidenceId: "evidence-1" }],
          anchorResults: [{
            anchorIndex: 0,
            status: "satisfied",
            evidence: [{ evidenceId: "evidence-1" }],
            verificationBasis: {
              summary: "已验证",
              evidence: [{ evidenceId: "evidence-1" }],
            },
            observations: ["页面可访问"],
            deviations: [],
          }],
        }, {
          criterionId: "undeclared-criterion",
          status: "satisfied",
          evidence: [{ evidenceId: "evidence-1" }],
          anchorResults: [],
        }],
      },
    };

    expect(Value.Check(goalResolutionDomainOutcomeSchema(contract), malformed)).toBe(false);
  });

  it("requires the assurance report to contain exactly the criteria assigned to the Ticket", () => {
    const threeCriterionBaseline: MissionBaseline = {
      ...baseline,
      criteria: [
        baseline.criteria[0]!,
        {
          ...baseline.criteria[0]!,
          criterionId: "criterion-2",
          text: "第二条可观察标准",
        },
        {
          ...baseline.criteria[0]!,
          criterionId: "criterion-3",
          text: "第三条可观察标准",
        },
      ],
    };
    const contract = compileMissionGoalOutputContract({
      title: "质量检查",
      objective: "验证交付",
      successCriteria: ["形成结论"],
      assignment: {},
      outputContract: { schemaRef: "mission-assurance-v1" },
      assurance: { missionCriterionIds: ["criterion-1", "criterion-2", "criterion-3"] },
    }, threeCriterionBaseline);
    const result = (criterionId: string) => ({
      criterionId,
      status: "satisfied" as const,
      evidence: [{ evidenceId: `evidence-${criterionId}` }],
      anchorResults: [{
        anchorIndex: 0,
        status: "satisfied" as const,
        evidence: [{ evidenceId: `evidence-${criterionId}` }],
        verificationBasis: { summary: "browser observation", evidence: [] },
        observations: ["observed the declared outcome"],
        deviations: [],
      }],
    });
    const report = (missionCriterionResults: unknown[]) => ({
      assuranceReport: {
        baselineVersion: 3,
        missionCriterionResults,
      },
    });

    expect(Value.Check(
      goalResolutionDomainOutcomeSchema(contract),
      report([result("criterion-1"), result("criterion-2"), result("criterion-3")]),
    )).toBe(true);
    expect(Value.Check(
      goalResolutionDomainOutcomeSchema(contract),
      report([result("criterion-1"), result("criterion-2")]),
    )).toBe(false);
    expect(Value.Check(
      goalResolutionDomainOutcomeSchema(contract),
      report([result("criterion-1"), result("criterion-2"), result("criterion-3"), result("criterion-extra")]),
    )).toBe(false);
  });

  it("encodes every baseline verification anchor in the correction tool schema", () => {
    const twoAnchorBaseline: MissionBaseline = {
      ...baseline,
      criteria: [{
        ...baseline.criteria[0]!,
        verification: {
          anchors: [
            ...baseline.criteria[0]!.verification.anchors,
            {
              observableOutcome: "直接链接可以在公开浏览器访问",
              evidenceRequirements: ["逐条浏览器访问记录"],
            },
          ],
        },
      }],
    };
    const contract = compileMissionGoalOutputContract({
      title: "质量检查",
      objective: "验证交付",
      successCriteria: ["形成结论"],
      assignment: {},
      outputContract: { schemaRef: "mission-assurance-v1" },
      assurance: { missionCriterionIds: ["criterion-1"] },
    }, twoAnchorBaseline, [{
      ticketId: "ticket-upstream" as TicketId,
      title: "上游交付",
      missionCriterionIds: ["criterion-1"],
    }]);
    const anchor = (anchorIndex: number) => ({
      anchorIndex,
      status: "not_satisfied",
      evidence: [],
      verificationBasis: { summary: "浏览器复核", evidence: [] },
      observations: ["观察到链接不可访问"],
      deviations: ["与可访问要求不符"],
    });
    const correction = {
      targetTicketId: "ticket-upstream",
      reason: "上游链接不可访问",
      correctionMissionCriterionIds: ["criterion-1"],
      findings: [{
        summary: "链接不可访问",
        details: "浏览器复核失败",
        evidence: [{ evidenceId: "evidence-1" }],
        affectedMissionCriterionIds: ["criterion-1"],
      }],
      assuranceReport: {
        baselineVersion: 3,
        missionCriterionResults: [{
          criterionId: "criterion-1",
          status: "not_satisfied",
          evidence: [],
          anchorResults: [anchor(0)],
        }],
      },
    };

    expect(Value.Check(contract.correctionOutcomeSchema!, correction)).toBe(false);
    correction.assuranceReport.missionCriterionResults[0]!.anchorResults.push(anchor(1));
    expect(Value.Check(contract.correctionOutcomeSchema!, correction)).toBe(true);
  });
});

function outputSchema(
  definition: Partial<TicketDefinition> & Pick<TicketDefinition, "outputContract">,
  baseline?: MissionBaseline,
) {
  const contract = compileMissionGoalOutputContract({
    title: "测试工单",
    objective: "完成测试工单",
    successCriteria: ["形成可核验结论"],
    assignment: {},
    ...definition,
  }, baseline);
  return goalResolutionDomainOutcomeSchema(contract);
}

const baseline: MissionBaseline = {
  baselineId: "baseline-1",
  version: 3,
  objective: "1:1 复刻坦克 98",
  criteria: [{
    criterionId: "criterion-1",
    text: "可以启动并完成一局游戏",
    verification: {
      anchors: [{
        observableOutcome: "玩家可以移动、射击并触发胜负结算",
        evidenceRequirements: ["浏览器交互记录和截图"],
      }],
    },
  }],
  constraints: [],
  assumptions: [],
  exclusions: [],
  establishedByTicketId: "ticket-intake" as MissionBaseline["establishedByTicketId"],
  establishedAt: "2026-07-27T00:00:00.000Z",
};

function proposalGoal(outputContract?: AgentGoal["spec"]["outputContract"]): AgentGoal {
  return {
    spec: {
      id: "goal-contract",
      threadId: "thread-contract",
      objective: "verify delivery",
      successCriteria: ["produce a verifiable conclusion"],
      contextRefs: [],
      outputContract,
      createdAt: "2026-07-28T00:00:00.000Z",
    },
    version: 1,
    status: "active",
    updatedAt: "2026-07-28T00:00:00.000Z",
  };
}

describe("Pi runtime terminal propagation", () => {
  it("requires Ticket criteria alongside the domain completion contract", () => {
    const outputContract = compileMissionGoalOutputContract({
      title: "assurance",
      objective: "verify delivery",
      successCriteria: ["produce a verifiable conclusion"],
      assignment: {},
      outputContract: { schemaRef: "mission-assurance-v1" },
      assurance: { missionCriterionIds: ["criterion-1"] },
    }, baseline);
    const parsed = parseResolutionProposal({
      status: "failed",
      summary: "one criterion remains unverified",
      evidence: [],
      criterionResults: [{
        criterionIndex: 0,
        status: "not_verified",
        evidence: [],
      }],
      residualRisks: ["full regression evidence is still required"],
      domainOutcome: {
        assuranceReport: {
          baselineVersion: 3,
          missionCriterionResults: [{
            criterionId: "criterion-1",
            status: "not_verified",
            evidence: [],
            anchorResults: [],
          }],
        },
      },
    }, proposalGoal(outputContract), "turn-contract", "2026-07-28T00:01:00.000Z");

    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.criterionResults).toEqual([{
      criterionIndex: 0,
      status: "not_verified",
      evidence: [],
    }]);
  });

  it("rejects a domain completion proposal that omits Ticket criteria", () => {
    const outputContract = compileMissionGoalOutputContract({
      title: "assurance",
      objective: "verify delivery",
      successCriteria: ["produce a verifiable conclusion"],
      assignment: { requiredCapabilities: ["quality assurance"], requiredTools: [] },
      outputContract: { schemaRef: "mission-assurance-v1" },
      assurance: { missionCriterionIds: ["criterion-1"] },
    }, baseline);
    const parsed = parseResolutionProposal({
      status: "completed",
      summary: "done",
      evidence: [],
      residualRisks: [],
      domainOutcome: {},
    }, proposalGoal(outputContract), "turn-contract-missing-criteria", "2026-07-28T00:01:00.000Z");

    expect(parsed).toMatchObject({ ok: false, reason: expect.stringContaining("criterionResults") });
  });

  it("still requires criterionResults for a generic Goal", () => {
    const parsed = parseResolutionProposal({
      status: "completed",
      summary: "done",
      evidence: [],
      residualRisks: [],
    }, proposalGoal(), "turn-generic", "2026-07-28T00:01:00.000Z");

    expect(parsed).toMatchObject({ ok: false });
  });

  it("bounds top-level resolution criteria to the current Goal", () => {
    const schema = goalResolutionCriterionResultsSchema(true, 3);
    const result = (count: number, indexes = Array.from({ length: count }, (_, index) => index)) =>
      indexes.map((criterionIndex) => ({ criterionIndex, status: "satisfied", evidence: [] }));

    expect(Value.Check(schema, result(3))).toBe(true);
    expect(Value.Check(schema, result(5))).toBe(false);
    expect(Value.Check(schema, result(3, [0, 1, 3]))).toBe(false);
  });

  it("never counts a failed terminal submission as useful progress", () => {
    const seen = new Set<string>();
    expect(isUsefulToolProgress(
      "goal_resolution",
      { domainOutcome: { baseline: { objective: "目标" } } },
      { content: [{ type: "text", text: "baseline.constraints is required" }] },
      true,
      seen,
    )).toBe(false);
    expect(seen.size).toBe(0);
  });

  it("does not count browser input actions as durable progress", () => {
    const seen = new Set<string>();
    expect(isUsefulToolProgress(
      "browser",
      { browserArgs: ["press", "Space"] },
      { ok: true, stdout: "Done" },
      false,
      seen,
    )).toBe(false);
    expect(seen.size).toBe(0);
  });

  it("counts a repeated observation only when its result changes", () => {
    const seen = new Set<string>();
    expect(isUsefulToolProgress(
      "readFile",
      { path: "index.html" },
      { ok: true, content: "before" },
      false,
      seen,
    )).toBe(true);
    expect(isUsefulToolProgress(
      "readFile",
      { path: "index.html" },
      { ok: true, content: "before" },
      false,
      seen,
    )).toBe(false);
    expect(isUsefulToolProgress(
      "readFile",
      { path: "index.html" },
      { ok: true, content: "after" },
      false,
      seen,
    )).toBe(true);
  });

  it("ignores transient evidence metadata when detecting repeated observations", () => {
    const seen = new Set<string>();
    expect(isUsefulToolProgress(
      "readImage",
      { path: "game.png" },
      { ok: true, path: "game.png", size: 240_520, evidenceId: "evidence-1" },
      false,
      seen,
    )).toBe(true);
    expect(isUsefulToolProgress(
      "readImage",
      { path: "game.png" },
      { ok: true, path: "game.png", size: 240_520, evidenceId: "evidence-2" },
      false,
      seen,
    )).toBe(false);
  });

  it("returns control when an aborted Pi session does not become idle promptly", async () => {
    let disposed = 0;
    const neverIdle = new Promise<void>(() => undefined);
    const session = {
      abort: async () => {
        await neverIdle;
      },
      dispose: () => {
        disposed += 1;
      },
    };

    const result = await abortPiSessionPromptly(session, 10);

    expect(result).toBe("detached");
    expect(disposed).toBe(0);
  });

  it("disposes a Pi session that becomes idle inside the abort grace period", async () => {
    let disposed = 0;
    const session = {
      abort: async () => undefined,
      dispose: () => {
        disposed += 1;
      },
    };

    const result = await abortPiSessionPromptly(session, 50);

    expect(result).toBe("idle");
    expect(disposed).toBe(1);
  });

  it("does not let slow execution-resource cleanup block production controls", async () => {
    const neverSettles = new Promise<void>(() => undefined);

    const result = await waitForCleanupPromptly(neverSettles, 10);

    expect(result).toBe("detached");
  });

  it("groups changing terminal arguments by the returned contract failure", () => {
    const first = toolFailureFingerprint(
      "goal_resolution",
      { domainOutcome: { baseline: { objective: "目标 A" } } },
      { content: [{ type: "text", text: "baseline.constraints is required" }] },
    );
    const second = toolFailureFingerprint(
      "goal_resolution",
      { domainOutcome: { baseline: { objective: "目标 B", assumptions: [] } } },
      { content: [{ type: "text", text: "baseline.constraints is required" }] },
    );
    expect(first).toBe(second);
  });

  it("keeps active Goal criteria visible and narrows continuations to missing evidence", () => {
    const prompt = unresolvedGoalPrompt({
      spec: {
        id: "goal-qa",
        threadId: "thread-qa",
        objective: "验证核心可玩闭环",
        successCriteria: ["验证移动与射击", "验证胜负结算"],
        contextRefs: [],
        createdAt: "2026-07-27T00:00:00.000Z",
      },
      version: 1,
      status: "active",
      updatedAt: "2026-07-27T00:00:00.000Z",
    });

    expect(prompt).toContain("Goal：验证核心可玩闭环");
    expect(prompt).toContain("1. 验证移动与射击");
    expect(prompt).toContain("2. 验证胜负结算");
    expect(prompt).toContain("只补尚未覆盖的证据缺口");
    expect(prompt).toContain("不重复已完成的检查");
  });

  it("returns when the Pi prompt settles normally", async () => {
    const terminal = deferred<string>();

    await expect(awaitPiPromptOutcome(Promise.resolve(), terminal.promise))
      .resolves.toEqual({ kind: "settled" });
  });

  it("does not finish a queued Pi prompt until the Agent session is idle", async () => {
    const terminal = deferred<string>();
    const idle = deferred<void>();
    let settled = false;
    const outcome = awaitPiPromptOutcome(
      Promise.resolve(),
      terminal.promise,
      () => idle.promise,
    ).then((value) => {
      settled = true;
      return value;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    idle.resolve();
    await expect(outcome).resolves.toEqual({ kind: "settled" });
  });

  it("does not release a turn while any tool execution is still active", async () => {
    const terminal = deferred<string>();
    const barrier = createPiToolExecutionBarrier();
    barrier.started("browser-1");
    barrier.started("read-image-1");
    let settled = false;
    const outcome = awaitPiPromptOutcome(
      Promise.resolve(),
      terminal.promise,
      () => barrier.waitForIdle(),
    ).then((value) => {
      settled = true;
      return value;
    });

    barrier.finished("browser-1");
    await Promise.resolve();
    expect(settled).toBe(false);

    barrier.finished("read-image-1");
    await expect(outcome).resolves.toEqual({ kind: "settled" });
  });

  it("surfaces a final provider error even when the Pi prompt never settles", async () => {
    const prompt = deferred<void>();
    const terminal = deferred<string>();
    const outcome = awaitPiPromptOutcome(prompt.promise, terminal.promise);

    terminal.resolve("502 status code (no body)");

    await expect(outcome).resolves.toEqual({
      kind: "provider_error",
      message: "502 status code (no body)",
    });
  });

  it("aborts and surfaces a provider failure when a Pi turn stops producing events", async () => {
    const prompt = deferred<void>();
    const terminal = deferred<string>();
    let aborted = 0;
    const watchdog = createPiPromptWatchdog(100, 10, () => {
      aborted += 1;
    });

    await expect(awaitPiPromptOutcome(
      prompt.promise,
      terminal.promise,
      undefined,
      watchdog.timeout,
    )).resolves.toEqual({
      kind: "provider_error",
      message: "Provider turn produced no events for 10ms (inactivity timeout)",
    });
    expect(aborted).toBe(1);
    watchdog.dispose();
  });

  it("extends the Pi inactivity window whenever the session emits progress", async () => {
    vi.useFakeTimers();
    const prompt = deferred<void>();
    const terminal = deferred<string>();
    const watchdog = createPiPromptWatchdog(100, 30, () => undefined);
    const outcome = awaitPiPromptOutcome(
      prompt.promise,
      terminal.promise,
      undefined,
      watchdog.timeout,
    );

    try {
      await vi.advanceTimersByTimeAsync(20);
      watchdog.touch();
      await vi.advanceTimersByTimeAsync(20);
      prompt.resolve();

      await expect(outcome).resolves.toEqual({ kind: "settled" });
    } finally {
      watchdog.dispose();
      vi.useRealTimers();
    }
  });

  it("aborts a Pi turn at the total deadline even while progress keeps arriving", async () => {
    vi.useFakeTimers();
    const prompt = deferred<void>();
    const terminal = deferred<string>();
    let aborted = 0;
    const watchdog = createPiPromptWatchdog(50, 30, () => {
      aborted += 1;
    });
    const outcome = awaitPiPromptOutcome(
      prompt.promise,
      terminal.promise,
      undefined,
      watchdog.timeout,
    );

    try {
      await vi.advanceTimersByTimeAsync(20);
      watchdog.touch();
      await vi.advanceTimersByTimeAsync(20);
      watchdog.touch();
      await vi.advanceTimersByTimeAsync(10);

      await expect(outcome).resolves.toEqual({
        kind: "provider_error",
        message: "Provider turn exceeded 50ms (turn timeout)",
      });
      expect(aborted).toBe(1);
    } finally {
      watchdog.dispose();
      vi.useRealTimers();
    }
  });

  it("keeps tool event metadata without duplicating large text payloads", () => {
    const details = compactPiToolEventDetails({
      content: [{ type: "text", text: "x".repeat(100_000) }],
      details: {
        content: "x".repeat(100_000),
        path: "logs/tank98.log",
        totalChars: 1_000_000,
        truncated: true,
        nextOffset: 32_000,
      },
      isError: false,
    });

    expect(details).toEqual({
      isError: false,
      details: {
        path: "logs/tank98.log",
        totalChars: 1_000_000,
        truncated: true,
        nextOffset: 32_000,
      },
    });
    expect(JSON.stringify(details)).not.toContain("xxxxx");
  });

  it("exposes the Mission baseline contract as a machine-checkable tool schema", () => {
    const schema = outputSchema({
      outputContract: { schemaRef: "mission-baseline-v1" },
      contextPolicy: { establishesMissionBaseline: true },
    });
    const valid = {
      baseline: {
        objective: "1:1 复刻坦克 98",
        successCriteria: ["可以启动并完成一局游戏"],
        verificationPlan: [{
          criterionIndex: 0,
          anchors: [{
            observableOutcome: "玩家可以移动、射击并触发胜负结算",
            evidenceRequirements: ["浏览器交互记录和截图"],
          }],
        }],
        constraints: ["在项目目录内交付"],
        assumptions: [],
        exclusions: [],
      },
    };
    const malformed = {
      baseline: {
        objective: "1:1 复刻坦克 98",
        successCriteria: ["可以启动并完成一局游戏"],
        verificationPlan: [],
        "constraintsList具体如下": ["在项目目录内交付"],
      },
    };

    expect(Value.Check(schema, valid)).toBe(true);
    expect(Value.Check(schema, malformed)).toBe(false);
    expect(JSON.stringify(schema)).not.toContain("\"anyOf\"");
  });

  it("exposes the compact Mission baseline contract without parallel index arrays", () => {
    const schema = outputSchema({
      outputContract: { schemaRef: "mission-baseline-v2" },
      contextPolicy: { establishesMissionBaseline: true },
    });
    const valid = {
      objective: "1:1 复刻坦克 98",
      criteria: [{
        text: "可以启动并完成一局游戏",
        anchors: [{
          observableOutcome: "玩家可以移动、射击并触发胜负结算",
          evidenceRequirements: ["浏览器交互记录和截图"],
        }],
      }],
      constraints: ["在项目目录内交付"],
      assumptions: [],
      exclusions: [],
    };

    expect(Value.Check(schema, valid)).toBe(true);
    expect(Value.Check(schema, { ...valid, criteria: ["可以运行"] })).toBe(false);
    expect(JSON.stringify(schema)).not.toContain("criterionIndex");
    expect(JSON.stringify(schema)).not.toContain("verificationPlan");
  });

  it("compiles correction and plan maintenance as separate Goal actions", () => {
    const contract = compileMissionGoalOutputContract({
      title: "质量检查",
      objective: "验证交付",
      successCriteria: ["形成结论"],
      assignment: {},
      outputContract: { schemaRef: "mission-assurance-v1" },
      assurance: { missionCriterionIds: ["criterion-1"] },
    }, baseline, [{
      ticketId: "ticket-dev" as TicketId,
      title: "开发实现",
      missionCriterionIds: ["criterion-1"],
    }]);

    expect(contract.completionOutcomeSchema).toBeDefined();
    expect(contract.correctionOutcomeSchema).toBeDefined();
    expect(contract.planChangeOutcomeSchema).toBeDefined();
    expect(Value.Check(
      Type.Unsafe(contract.correctionOutcomeSchema!),
      {
        targetTicketId: "ticket-dev",
        reason: "交付与验收标准不符",
        correctionMissionCriterionIds: ["criterion-1"],
        findings: [{
          summary: "交付不符合标准",
          details: "可观察行为与约定不一致",
          evidence: [{ evidenceId: "ev-failure" }],
          affectedMissionCriterionIds: ["criterion-1"],
        }],
        assuranceReport: {
          baselineVersion: 3,
          missionCriterionResults: [{
            criterionId: "criterion-1",
            status: "not_satisfied",
            evidence: [{ evidenceId: "ev-failure" }],
            anchorResults: [{
              anchorIndex: 0,
              status: "not_satisfied",
              evidence: [{ evidenceId: "ev-failure" }],
              verificationBasis: { summary: "observed failure", evidence: [{ evidenceId: "ev-failure" }] },
              observations: ["behavior was exercised"],
              deviations: ["behavior differs from the anchor"],
            }],
          }],
        },
      },
    )).toBe(true);
    expect(Value.Check(
      Type.Unsafe(contract.correctionOutcomeSchema!),
      {
        targetTicketId: "ticket-other",
        reason: "错误目标",
        correctionMissionCriterionIds: ["criterion-1"],
      },
    )).toBe(false);
  });

  it("allows assurance work to report an incidental defect owned by a completed upstream Ticket", () => {
    const contract = compileMissionGoalOutputContract({
      title: "音效验证",
      objective: "验证音效",
      successCriteria: ["形成音效结论"],
      assignment: {},
      outputContract: { schemaRef: "mission-assurance-v1" },
      assurance: { missionCriterionIds: ["criterion-audio"] },
    }, baseline, [{
      ticketId: "ticket-core" as TicketId,
      title: "核心实现",
      missionCriterionIds: ["criterion-lifecycle"],
    }]);

    expect(Value.Check(
      Type.Unsafe(contract.correctionOutcomeSchema!),
      {
        targetTicketId: "ticket-core",
        reason: "验证音效时发现启动入口失效",
        correctionMissionCriterionIds: ["criterion-lifecycle"],
        findings: [{
          summary: "启动入口失效",
          details: "音效验证被上游启动缺陷阻断",
          evidence: [{ evidenceId: "ev-entry-failure" }],
          affectedMissionCriterionIds: ["criterion-lifecycle"],
        }],
        assuranceReport: {
          baselineVersion: 3,
          missionCriterionResults: [{
            criterionId: "criterion-lifecycle",
            status: "not_satisfied",
            evidence: [{ evidenceId: "ev-entry-failure" }],
            anchorResults: [{
              anchorIndex: 0,
              status: "not_satisfied",
              evidence: [{ evidenceId: "ev-entry-failure" }],
              verificationBasis: { summary: "blocked by upstream entry failure", evidence: [{ evidenceId: "ev-entry-failure" }] },
              observations: ["application could not start"],
              deviations: ["startup entry does not satisfy its lifecycle anchor"],
            }],
          }],
        },
      },
    )).toBe(true);
    expect(Value.Check(
      Type.Unsafe(contract.correctionOutcomeSchema!),
      {
        targetTicketId: "ticket-core",
        reason: "不能改写其他目标",
        correctionMissionCriterionIds: ["criterion-unowned"],
      },
    )).toBe(false);
  });

  it("does not expose recursive plan maintenance to a plan amendment Goal", () => {
    const contract = compileMissionGoalOutputContract({
      title: "计划修订",
      objective: "追加工作",
      successCriteria: ["形成可执行 DAG"],
      assignment: {},
      outputContract: { schemaRef: "plan-change-set-v3" },
      permissions: { amendPlan: true },
    }, baseline, [{
      ticketId: "ticket-upstream" as TicketId,
      title: "上游工单",
    }]);

    expect(contract.completionOutcomeSchema).toBeDefined();
    expect(contract.correctionOutcomeSchema).toBeDefined();
    expect(contract.planChangeOutcomeSchema).toBeUndefined();
  });

  it("exposes the final Mission acceptance contract as a machine-checkable tool schema", () => {
    const schema = outputSchema({
      outputContract: { schemaRef: "mission-final-acceptance-v1" },
      permissions: { settleMission: true },
    }, baseline);
    const valid = {
      disposition: "complete",
      missionResolution: {
        baselineVersion: 3,
        summary: "所有验收标准均有独立验证证据",
        criterionResults: [{
          criterionId: "criterion-1",
          status: "satisfied",
          assuranceTicketIds: ["ticket-qa"],
        }],
        residualRisks: [],
      },
    };

    expect(Value.Check(schema, valid)).toBe(true);
    expect(Value.Check(schema, {
      ...valid,
      missionResolution: {
        ...valid.missionResolution,
        criterionResults: [{
          ...valid.missionResolution.criterionResults[0],
          evidence: [{ evidenceId: "evidence-1" }],
        }],
      },
    })).toBe(false);
    expect(Value.Check(schema, {
      ...valid,
      missionResolution: {
        ...valid.missionResolution,
        criterionResults: [{
          ...valid.missionResolution.criterionResults[0],
          status: "not_verified",
        }],
      },
    })).toBe(false);
  });

  it("uses the settlement schema when a terminal ticket was mistakenly labeled as assurance", () => {
    const schema = outputSchema({
      outputContract: { schemaRef: "mission-assurance-v1" },
      assurance: { missionCriterionIds: ["criterion-1"] },
      permissions: { settleMission: true },
    }, baseline);

    expect(Value.Check(schema, {
      disposition: "complete",
      missionResolution: {
        baselineVersion: 3,
        summary: "accepted from authoritative assurance",
        criterionResults: [{
          criterionId: "criterion-1",
          status: "satisfied",
          assuranceTicketIds: ["ticket-qa"],
        }],
        residualRisks: [],
      },
    })).toBe(true);
    expect(Value.Check(schema, {
      assuranceReport: { baselineVersion: 3, missionCriterionResults: [] },
    })).toBe(false);
  });

  it("lets Mission settlement select assurance tickets without copying evidence", () => {
    const schema = outputSchema({
      outputContract: { schemaRef: "mission-final-acceptance-v1" },
      permissions: { settleMission: true },
    }, baseline);

    expect(Value.Check(schema, {
      disposition: "complete",
      missionResolution: {
        baselineVersion: 3,
        summary: "all baseline criteria accepted",
        criterionResults: [{
          criterionId: "criterion-1",
          status: "satisfied",
          assuranceTicketIds: ["ticket-qa"],
        }],
        residualRisks: [],
      },
    })).toBe(true);
  });

  it("binds an assurance Goal to its assigned criteria and baseline version", () => {
    const schema = outputSchema({
      outputContract: { schemaRef: "mission-assurance-v1" },
      assurance: { missionCriterionIds: ["criterion-1"] },
    }, baseline);
    const valid = {
      assuranceReport: {
        baselineVersion: 3,
        missionCriterionResults: [{
          criterionId: "criterion-1",
          status: "satisfied",
          evidence: [{ evidenceId: "evidence-1" }],
          anchorResults: [{
            anchorIndex: 0,
            status: "satisfied",
            evidence: [{ evidenceId: "evidence-1" }],
            verificationBasis: {
              summary: "按 Mission baseline 验收锚点判断",
              evidence: [{ evidenceId: "evidence-1" }],
            },
            observations: ["实际观察结果与锚点一致"],
            deviations: [],
          }],
        }],
      },
    };

    expect(Value.Check(schema, valid)).toBe(true);
    expect(Value.Check(schema, {
        assuranceReport: {
          ...valid.assuranceReport,
        baselineVersion: 2,
      },
    })).toBe(false);
    expect(Value.Check(schema, {
        assuranceReport: {
          baselineVersion: 3,
          missionCriterionResults: [{
            ...valid.assuranceReport.missionCriterionResults[0],
          criterionId: "criterion-outside-ticket",
        }],
      },
    })).toBe(false);
    expect(Value.Check(schema, {
        assuranceReport: {
          baselineVersion: 3,
          missionCriterionResults: [{
            ...valid.assuranceReport.missionCriterionResults[0],
          status: "not_verified",
        }],
      },
    })).toBe(false);
  });

  it("keeps an explicitly versioned plan-change-set-v3 contract stable", () => {
    const schema = outputSchema({
      outputContract: { schemaRef: "plan-change-set-v3" },
      permissions: { amendPlan: true },
    }, baseline);
    const valid = {
      result: {
        deliveryStrategy: {
          mode: "single_increment",
          rationale: "目标可以在一个可验证增量内交付",
          increments: [{
            incrementId: "tank-playable",
            sequence: 1,
            title: "可玩版本",
            objective: "交付可启动、可操作、可验收的游戏",
          }],
        },
      },
      change: {
        additions: [{
          clientRef: "implementation",
          title: "实现游戏",
          objective: "完成游戏实现",
          successCriteria: ["产物可以启动"],
          assignment: { requiredCapabilities: ["delivery:implement"], requiredTools: ["writeFile"] },
          outputContract: { schemaRef: "tank-delivery-v1" },
          deliveryIncrement: { incrementId: "tank-playable" },
          missionContribution: { missionCriterionIndexes: [0] },
        }, {
          clientRef: "acceptance",
          title: "最终验收",
          objective: "依据 Mission 基线验收",
          successCriteria: ["逐项形成验收结论"],
          assignment: { requiredCapabilities: ["delivery:accept"], requiredTools: [] },
          outputContract: { schemaRef: "mission-settlement-v1" },
          deliveryIncrement: { incrementId: "tank-playable" },
          permissions: { settleMission: true },
        }],
        dependencyAdditions: [{
          from: { clientRef: "implementation" },
          to: { clientRef: "acceptance" },
        }],
        failureResolutions: [],
        cancelTicketIds: [],
        requiredTerminalRefs: [{ clientRef: "acceptance" }],
      },
    };

    expect(Value.Check(schema, valid)).toBe(true);
    expect(Value.Check(schema, {
      ...valid,
      change: {
        ...valid.change,
        additions: [{
          ...valid.change.additions[0],
          deliveryIncrement: undefined,
        }, valid.change.additions[1]],
      },
    })).toBe(false);
    expect(Value.Check(schema, {
      ...valid,
      change: {
        ...valid.change,
        additions: [{
          ...valid.change.additions[0],
          missionContribution: { missionCriterionIds: ["criterion-1"] },
        }, valid.change.additions[1]],
      },
    })).toBe(false);
    expect(Value.Check(schema, {
      ...valid,
      change: {
        ...valid.change,
        additions: [{
          ...valid.change.additions[0],
          deliveryIncrement: {
            incrementId: "tank-playable",
            sequence: 1,
            title: "不应在 Ticket 中重复定义",
            objective: "不应在 Ticket 中重复定义",
          },
        }],
      },
    })).toBe(false);
  });

  it("exposes semantic Plan intent without platform graph fields", () => {
    const schema = outputSchema({
      outputContract: { schemaRef: "plan-intent-v1" },
      permissions: { amendPlan: true },
    }, baseline);
    const valid = {
      intent: {
        rationale: "deliver a verified increment",
        increments: [{
          intentRef: "delivery",
          title: "Playable delivery",
          objective: "Build and accept the game",
          workItems: [{
            intentRef: "implementation",
            title: "Build",
            objective: "Implement the game",
            successCriteria: ["The artifact runs"],
            assignment: { requiredCapabilities: ["delivery:implement"], requiredTools: ["writeFile"] },
            outputContract: { schemaRef: "tank-delivery-v1" },
            missionContribution: { missionCriterionIndexes: [0] },
          }, {
            intentRef: "acceptance",
            title: "Accept",
            objective: "Settle against the baseline",
            successCriteria: ["Acceptance is traceable"],
            assignment: { requiredCapabilities: ["delivery:accept"] },
            outputContract: { schemaRef: "mission-settlement-v1" },
            dependsOn: ["implementation"],
            permissions: { settleMission: true },
          }],
        }],
      },
    };

    expect(Value.Check(schema, valid)).toBe(true);
    expect(Value.Check(schema, {
      ...valid,
      dependencyAdditions: [],
    })).toBe(false);
    expect(Value.Check(schema, {
      intent: {
        ...valid.intent,
        increments: [{
          ...valid.intent.increments[0],
          workItems: [{
            ...valid.intent.increments[0].workItems[0],
            assignment: { principalId: "principal-dev", requiredCapabilities: ["delivery:implement"] },
          }],
        }],
      },
    })).toBe(false);
  });
});
