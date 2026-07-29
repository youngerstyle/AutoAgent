import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  abortPiSessionPromptly,
  awaitPiPromptOutcome,
  compactPiToolEventDetails,
  createPiToolExecutionBarrier,
  createPiPromptInactivityWatchdog,
  goalResolutionDomainOutcomeSchema,
  goalResolutionTransportDomainOutcomeSchema,
  isUsefulToolProgress,
  modelFacingToolResultText,
  toolFailureFingerprint,
  turnToolBudgetMessage,
  unresolvedGoalPrompt,
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
    expect(projected).toContain("Rejected arguments omitted");
    expect(projected).not.toContain("recursive-payload");
    expect(projected.length).toBeLessThan(1_000);
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

describe("Pi goal resolution transport boundary", () => {
  it("passes domain payloads through transport while the Mission contract remains authoritative", () => {
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
        criterionResults: ["not-a-domain-result"],
      },
    };

    expect(Value.Check(goalResolutionTransportDomainOutcomeSchema(), malformed)).toBe(true);
    expect(Value.Check(goalResolutionDomainOutcomeSchema(contract), malformed)).toBe(false);
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
          criterionResults: [{
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
    const watchdog = createPiPromptInactivityWatchdog(10, () => {
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
    const prompt = deferred<void>();
    const terminal = deferred<string>();
    const watchdog = createPiPromptInactivityWatchdog(30, () => undefined);
    const outcome = awaitPiPromptOutcome(
      prompt.promise,
      terminal.promise,
      undefined,
      watchdog.timeout,
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    watchdog.touch();
    await new Promise((resolve) => setTimeout(resolve, 20));
    prompt.resolve();

    await expect(outcome).resolves.toEqual({ kind: "settled" });
    watchdog.dispose();
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
          status: "not_verified",
        }],
      },
    })).toBe(false);
  });

  it("binds an assurance Goal to its assigned criteria and baseline version", () => {
    const schema = outputSchema({
      outputContract: { schemaRef: "mission-assurance-v1" },
      assurance: { missionCriterionIds: ["criterion-1"] },
    }, baseline);
    const valid = {
      assuranceReport: {
        baselineVersion: 3,
        criterionResults: [{
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
        criterionResults: [{
          ...valid.assuranceReport.criterionResults[0],
          criterionId: "criterion-outside-ticket",
        }],
      },
    })).toBe(false);
    expect(Value.Check(schema, {
      assuranceReport: {
        baselineVersion: 3,
        criterionResults: [{
          ...valid.assuranceReport.criterionResults[0],
          status: "not_verified",
        }],
      },
    })).toBe(false);
  });

  it("exposes the Plan change contract without duplicating delivery increment definitions", () => {
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
});
