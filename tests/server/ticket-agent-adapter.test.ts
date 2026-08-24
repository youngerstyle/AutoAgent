import { describe, expect, it } from "vitest";
import type { GoalResolutionProposal } from "../../src/shared/contracts/agent-engine.js";
import type { ActiveMissionLink } from "../../src/shared/contracts/mission-control.js";
import type { PlanCommandResult, PlanId, TicketCommandResult, TicketId } from "../../src/shared/contracts/ticket-engine.js";
import { materializeMissionSettlement, materializeSimpleAssuranceCorrection, materializeSimpleAssuranceOutcome, materializeSimpleMissionSettlement, missionOutcomeInstruction, planResultToGoalDecision, projectMissionAssuranceContext, proposalToTicketCommand, ticketResultToGoalDecision, validateMissionAssuranceReport, validateMissionCorrectionOwnership, validateMissionPlanAssurance, validateMissionSettlement, validateMissionTicketOutcome, type MissionTicketOutcome, type SharedPlanContext } from "../../src/server/mission-process/ticket-agent-adapter.js";

describe("Ticket Agent resolution adapter", () => {
  it("requires authorized Agents to bootstrap greenfield deliverables instead of blocking on an empty workspace", () => {
    const instruction = missionOutcomeInstruction("delivery-v1");

    expect(instruction).toContain("空工作区或尚不存在项目文件不属于 human 输入边界");
    expect(instruction).toContain("自行创建所需目录、源码、配置、构建入口和测试");
    expect(instruction).toContain("不可替代的外部事实、凭证、授权、人工操作、不可逆操作确认或工具策略调整");
  });

  it("rejects a blocked proposal that does not identify an external input for human", () => {
    expect(validateMissionTicketOutcome("delivery-v1", "blocked", {
      disposition: "blocked",
      summary: "工作区为空",
    })).toEqual({
      valid: false,
      reason: "blocked 提案只能由 request_human_input 工具产生",
    });
    expect(validateMissionTicketOutcome("delivery-v1", "blocked", {
      disposition: "blocked",
      requiredInput: "生产环境发布凭证",
    })).toMatchObject({ valid: false });
    expect(validateMissionTicketOutcome("delivery-v1", "blocked", undefined, {
      kind: "manual_test" as const,
      description: "需要 human 在浏览器中验证交互",
      details: {
        testFile: "index.html",
        steps: ["打开游戏", "完成一局"],
        expectedResult: "可以正常通关",
      },
    })).toEqual({ valid: true });
  });

  it("preserves a typed human-input request in the Ticket command", () => {
    const requiredInput = {
      kind: "manual_test" as const,
      description: "需要 human 在浏览器中验证交互",
      details: { testFile: "index.html", steps: ["完成一局"] },
    };

    expect(proposalToTicketCommand(proposal("blocked", {}, requiredInput), link, NOW).payload).toEqual({
      type: "block",
      reason: "summary",
      requiredInput,
    });
  });

  it("tells Agents to block on an unavailable execution environment instead of returning upstream work", () => {
    const instruction = missionOutcomeInstruction("qa-report-v1");

    expect(instruction).toContain("当前工具或运行环境无法完成不可替代的验证");
    expect(instruction).toContain('request_human_input(kind="manual_test")');
    expect(instruction).toContain("不得把环境缺口报告成上游纠错");
  });

  it("keeps independent assurance blocked when an irreplaceable external authorization is refused", () => {
    const instruction = missionOutcomeInstruction(
      "mission-assurance-v1",
      [],
      [],
      undefined,
      undefined,
      [],
      {
        ticket: {
          ticketId: "40614afd-9312-4f9b-97fe-d14e18fe4201" as TicketId,
          title: "独立验收",
          objective: "取得原生 Linux CI 证据",
          successCriteria: ["Linux runner 返回真实退出码"],
          outputContract: { schemaRef: "mission-assurance-v1" },
          assurance: { missionCriterionIds: ["criterion-linux"] },
        },
      },
    );

    expect(instruction).toContain("调用 request_human_input 并保持当前 Ticket/Plan blocked");
    expect(instruction).toContain("human 明确本轮不提供该输入时");
    expect(instruction).toContain("不得改写成上游缺陷或计划缺口");
    expect(instruction).toContain("不得生成重复纠错、实现或验收工作");
    expect(instruction).toContain("git status --porcelain --untracked-files=all");
    expect(instruction).toContain("不得在脏工作树上提交完成");
    expect(instruction).toContain("项目文档要求的构建或测试命令会修改原本干净的 checkout");
    expect(instruction).toContain("调用 report_goal_correction");
  });

  it("keeps final Mission acceptance blocked instead of requesting repeated amendments", () => {
    const instruction = missionOutcomeInstruction(
      "mission-settlement-v1",
      [],
      [],
      undefined,
      undefined,
      [],
      {
        ticket: {
          ticketId: "c7504f17-71d1-45f8-8e31-31a8ee99c89c" as TicketId,
          title: "最终验收",
          objective: "根据权威 assurance 决定结算",
          successCriteria: ["结论可追溯"],
          outputContract: { schemaRef: "mission-settlement-v1" },
          permissions: { settleMission: true },
        },
      },
    );

    expect(instruction).toContain("使用 request_human_input 使当前 Ticket/Plan 保持 blocked");
    expect(instruction).toContain("human 明确本轮不提供该输入时");
    expect(instruction).toContain("不得创建重复 amendment、implementation 或 assurance");
  });

  it("renders mission, current Ticket, and upstream handoffs without sharing Agent history", () => {
    const instruction = missionOutcomeInstruction(
      "qa-report-v1",
      [],
      [],
      undefined,
      {
        planId: "plan-a",
        version: 4,
        tickets: [
          {
            ticketId: "ticket-intake",
            status: "completed",
            title: "需求接收",
            objective: "形成正式目标说明",
            successCriteria: ["目标边界已对齐"],
            outputContract: { schemaRef: "brief-v1" },
          },
          {
            ticketId: "40614afd-9312-4f9b-97fe-d14e18fe4201",
            status: "running",
            title: "质量检查",
            objective: "验证核心玩法",
            successCriteria: ["形成可复现结论"],
            outputContract: { schemaRef: "qa-report-v1" },
          },
        ],
        dependencyEdges: [{ fromTicketId: "ticket-intake", toTicketId: "40614afd-9312-4f9b-97fe-d14e18fe4201" }],
        requiredTerminalTicketIds: ["40614afd-9312-4f9b-97fe-d14e18fe4201"],
        teamMembers: [{ principalId: "principal:qa", name: "测试", capabilities: ["delivery:verify"], enabledTools: ["browser"] }],
      },
      [{
        ticketId: "c7504f17-71d1-45f8-8e31-31a8ee99c89c" as TicketId,
        title: "开发实现",
        objective: "实现可运行游戏",
        successCriteria: ["implementation is independently verifiable"],
        outputContract: { schemaRef: "delivery-v1" },
        handoff: {
          schemaVersion: 1,
          summary: "实现了核心玩法",
          output: { artifact: "src/game.ts" },
          evidence: [{ evidenceId: "ev-game-ts" }],
          criterionResults: [],
          residualRisks: [],
        },
      }],
      {
        ticket: {
          ticketId: "40614afd-9312-4f9b-97fe-d14e18fe4201" as TicketId,
          title: "质量检查",
          objective: "验证核心玩法",
          successCriteria: ["形成可复现结论"],
          outputContract: { schemaRef: "qa-report-v1" },
        },
      },
    );

    expect(instruction).not.toContain('"missionObjective"');
    expect(instruction).toContain('"currentPlan"');
    expect(instruction).toContain('"successCriteria":["目标边界已对齐"]');
    expect(instruction).toContain('"outputContract":{"schemaRef":"brief-v1"}');
    expect(instruction).toContain('"summary":"实现了核心玩法"');
    expect(instruction).toContain('"artifact":"src/game.ts"');
    expect(instruction).not.toContain("tool_call");
    expect(instruction).not.toContain("Thread");
  });

  it("keeps the current Ticket boundary separate from downstream delivery work", () => {
    const instruction = missionOutcomeInstruction(
      "mission-baseline-v2",
      [],
      [],
      undefined,
      {
        planId: "plan-intake",
        version: 1,
        tickets: [],
        dependencyEdges: [],
        requiredTerminalTicketIds: [],
        teamMembers: [{ principalId: "principal:boss", name: "老板", capabilities: ["mission:intake"], enabledTools: ["listFiles", "readFile"] }],
      },
      [],
      {
        ticket: {
          ticketId: "ticket-intake" as TicketId,
          title: "需求接收",
          objective: "形成正式目标基线",
          successCriteria: ["记录目标与约束"],
          outputContract: { schemaRef: "mission-baseline-v2" },
        },
      },
    );

    expect(instruction).toContain("当前 Ticket 的责任边界");
    expect(instruction).toContain("只完成 currentTicket 中声明的 objective、successCriteria 和 outputContract");
    expect(instruction).toContain("不要替下游实现、验证或结算");
    expect(instruction).toContain("不要因为下游需要不同的文件、命令或浏览器能力而阻塞当前 Ticket");
  });

  it("injects a bounded handoff projection instead of recursively carrying an upstream payload", () => {
    const oversized = `important-prefix:${"x".repeat(8_000)}:forbidden-tail`;
    const instruction = missionOutcomeInstruction(
      "delivery-v1",
      [],
      [],
      undefined,
      undefined,
      [{
        ticketId: "c7504f17-71d1-45f8-8e31-31a8ee99c89c" as TicketId,
        title: "upstream",
        objective: "deliver facts",
        successCriteria: ["traceable"],
        outputContract: { schemaRef: "delivery-v1" },
        handoff: {
          schemaVersion: 1,
          summary: "formal delivery",
          output: { report: oversized },
          evidence: [{ evidenceId: "ev-upstream" }],
          criterionResults: [],
          residualRisks: [],
        },
      }],
    );

    expect(instruction).toContain('"truncated":true');
    expect(instruction).toContain('"sha256"');
    expect(instruction).toContain("important-prefix");
    expect(instruction).not.toContain("forbidden-tail");
    expect(instruction.length).toBeLessThan(15_000);
  });

  it("passes formal rework requests as current Ticket context", () => {
    const targetTicketId = "40614afd-9312-4f9b-97fe-d14e18fe4201" as TicketId;
    const sourceTicketId = "c7504f17-71d1-45f8-8e31-31a8ee99c89c" as TicketId;
    const instruction = missionOutcomeInstruction(
      "delivery-v1",
      [],
      [],
      undefined,
      undefined,
      [],
      {
        ticket: {
          ticketId: targetTicketId,
          title: "dev",
          objective: "fix implementation",
          successCriteria: ["playable"],
          outputContract: { schemaRef: "delivery-v1" },
          reworkRequests: [{
            sourceTicketId,
            sourceTitle: "qa",
            reason: "player starts inside a wall",
            handoff: {
              schemaVersion: 1,
              summary: "QA found all current deviations",
              output: { findings: ["player starts inside a wall", "shooting does not work"] },
              evidence: [{ evidenceId: "ev-qa-batch" }],
              criterionResults: [{ criterionIndex: 0, status: "not_satisfied", evidence: [{ evidenceId: "ev-qa-batch" }] }],
              residualRisks: [],
            },
            occurredAt: NOW,
          }],
        },
      },
    );

    expect(instruction).toContain('"reworkRequests"');
    expect(instruction).toContain(sourceTicketId);
    expect(instruction).toContain("shooting does not work");
    expect(instruction).toContain("player starts inside a wall");
  });

  it("treats a correctable Host rejection as a proposal retry rather than Goal failure", () => {
    const instruction = missionOutcomeInstruction("delivery-v1");

    expect(instruction).toContain("Host 返回 correctable 只表示当前提案需要修正并重新提交");
    expect(instruction).toContain("不得仅因提案结构或契约校验被退回就改成 failed");
  });

  it("keeps assignment and terminal policy out of the planner contract", () => {
    const instruction = missionOutcomeInstruction("plan-intent-v1", ["delivery:implement", "delivery:verify", "delivery:accept"], [], undefined, {
      planId: "plan-a",
      version: 1,
      tickets: [],
      dependencyEdges: [],
      requiredTerminalTicketIds: [],
      requiredTerminalCapabilities: ["delivery:accept"],
      teamMembers: [
        { principalId: "principal:dev", name: "Developer", capabilities: ["delivery:implement"], enabledTools: ["writeFile", "shell"] },
        { principalId: "principal:qa", name: "QA", capabilities: ["delivery:verify"], enabledTools: ["browser", "shell"] },
        { principalId: "principal:boss", name: "Boss", capabilities: ["delivery:accept"], enabledTools: [] },
      ],
    });

    expect(instruction).toContain("像负责人写 TodoList 一样");
    expect(instruction).toContain("Plan Compiler 会固定追加独立验证和最终验收");
    expect(instruction).toContain("不要生成 capability、tool、schemaRef");
    expect(instruction).not.toContain('"requiredTerminalCapabilities"');
    expect(instruction).not.toContain('"enabledTools"');
  });

  it("requires a structured authoritative Mission baseline", () => {
    expect(validateMissionTicketOutcome("mission-baseline-v1", "completed", {
      baseline: {
        objective: "1:1 复刻目标产品",
        successCriteria: ["核心行为和视觉可按证据验收"],
        verificationPlan: [{
          criterionIndex: 0,
          anchors: [{ observableOutcome: "核心行为与视觉均可观察", evidenceRequirements: ["浏览器交互记录与截图"] }],
        }],
        constraints: ["在当前工作区交付"],
        assumptions: [],
        exclusions: [],
      },
    })).toEqual({ valid: true });

    expect(validateMissionTicketOutcome("mission-baseline-v1", "completed", {
      baseline: { objective: "先做个简版", successCriteria: [] },
    })).toMatchObject({ valid: false, reason: expect.stringContaining("successCriteria") });
    expect(validateMissionTicketOutcome("mission-baseline-v1", "completed", {
      baseline: {
        objective: "1:1 复刻目标产品",
        successCriteria: ["核心行为和视觉可按证据验收"],
        constraints: [],
        assumptions: [],
        exclusions: [],
      },
    })).toMatchObject({ valid: false, reason: expect.stringContaining("verificationPlan") });
  });

  it("accepts a Mission baseline whose criteria own their verification anchors", () => {
    expect(validateMissionTicketOutcome("mission-baseline-v2", "completed", {
      objective: "1:1 复刻目标产品",
      criteria: [{
        text: "核心行为和视觉可按证据验收",
        anchors: [{
          observableOutcome: "核心行为与视觉均可观察",
          evidenceRequirements: ["浏览器交互记录与截图"],
        }],
      }],
      constraints: ["在当前工作区交付"],
      assumptions: [],
      exclusions: [],
    })).toEqual({ valid: true });

    expect(validateMissionTicketOutcome("mission-baseline-v2", "completed", {
      objective: "1:1 复刻目标产品",
      criteria: ["核心行为正常"],
      constraints: [],
      assumptions: [],
      exclusions: [],
    })).toMatchObject({ valid: false, reason: expect.stringContaining("criteria[0].text") });
  });

  it("keeps intake Ticket completion separate from final Mission acceptance", () => {
    const instruction = missionOutcomeInstruction("mission-baseline-v1");

    expect(instruction).toContain('"constraints":[]');
    expect(instruction).toContain("verificationPlan 只能放");
    expect(instruction).toContain("当前需求接收 Ticket 的流程标准");
    expect(instruction).toContain("最终交付给 human 的产品或业务结果");
    expect(instruction).toContain("严禁");
  });

  it("describes the compact Mission baseline contract without parallel index arrays", () => {
    const instruction = missionOutcomeInstruction("mission-baseline-v2");

    expect(instruction).toContain("domainOutcome 直接包含");
    expect(instruction).toContain('"criteria"');
    expect(instruction).toContain("不使用分离的 successCriteria/verificationPlan");
  });

  it("accepts Mission settlement only with exact current baseline coverage", () => {
    const baseline = {
      baselineId: "baseline-a",
      version: 2,
      objective: "deliver the agreed product",
      criteria: [
        baselineCriterion("criterion-a", "artifact runs"),
        baselineCriterion("criterion-b", "behavior is verified"),
      ],
      constraints: [], assumptions: [], exclusions: [],
      establishedByTicketId: "ticket-intake" as TicketId,
      establishedAt: NOW,
    };
    const resolution = {
      baselineVersion: 2,
      summary: "accepted",
      criterionResults: baseline.criteria.map(({ criterionId }) => ({
        criterionId,
        status: "satisfied" as const,
        assuranceTicketIds: [`assurance-${criterionId}`],
        evidence: [{ evidenceId: `ev-acceptance-${criterionId}` }],
        anchorResults: [anchorResult(`ev-acceptance-${criterionId}`)],
      })),
      residualRisks: [],
    };

    const assuranceSources = baseline.criteria.map(({ criterionId }) => ({
      ticketId: `assurance-${criterionId}` as TicketId,
      baselineVersion: 2,
      criterionResults: [{
        criterionId,
        status: "satisfied" as const,
        evidence: [{ evidenceId: `ev-acceptance-${criterionId}` }],
        anchorResults: [anchorResult(`ev-acceptance-${criterionId}`)],
      }],
    }));

    expect(validateMissionSettlement(baseline, resolution, assuranceSources)).toEqual({ valid: true });
    expect(validateMissionSettlement(baseline, { ...resolution, criterionResults: resolution.criterionResults.slice(0, 1) }, assuranceSources))
      .toMatchObject({ valid: false, reason: expect.stringContaining("criterion-b") });
    expect(validateMissionSettlement(baseline, { ...resolution, baselineVersion: 1 }, assuranceSources))
      .toMatchObject({ valid: false, reason: expect.stringContaining("version") });
    expect(validateMissionSettlement(baseline, resolution, []))
      .toMatchObject({ valid: false, reason: expect.stringContaining("assurance") });
    expect(validateMissionSettlement(baseline, {
      ...resolution,
      criterionResults: resolution.criterionResults.map((result) => ({
        ...result,
        assuranceTicketIds: ["unrelated-ticket"],
      })),
    }, assuranceSources)).toMatchObject({ valid: false, reason: expect.stringContaining("unrelated-ticket") });
    expect(materializeMissionSettlement(baseline, {
      baselineVersion: 2,
      summary: "final acceptance copied an evidence field",
      criterionResults: resolution.criterionResults.map(({ criterionId, assuranceTicketIds }) => ({
        criterionId,
        status: "satisfied",
        assuranceTicketIds,
        evidence: [{ evidenceId: "copied-ticket-id" }],
      })),
      residualRisks: [],
    }, assuranceSources)).toMatchObject({
      valid: false,
      reason: expect.stringContaining("只能包含 criterionId、status、assuranceTicketIds"),
    });
    expect(validateMissionSettlement(baseline, {
      ...resolution,
      criterionResults: resolution.criterionResults.map((result) => ({
        ...result,
        anchorResults: result.anchorResults.map((anchor) => ({
          ...anchor,
          observations: ["最终验收擅自提高了 QA 的结论强度"],
        })),
      })),
    }, assuranceSources)).toMatchObject({ valid: false, reason: expect.stringContaining("原样来自 assurance Ticket") });

    const materialized = materializeMissionSettlement(baseline, {
      baselineVersion: 2,
      summary: "accepted without manually copying evidence IDs",
      criterionResults: baseline.criteria.map(({ criterionId }) => ({
        criterionId,
        status: "satisfied",
        assuranceTicketIds: [`assurance-${criterionId}`],
      })),
      residualRisks: [],
    }, assuranceSources);
    expect(materialized).toMatchObject({
      valid: true,
      resolution: {
        criterionResults: [
          { criterionId: "criterion-a", evidence: [{ evidenceId: "ev-acceptance-criterion-a" }] },
          { criterionId: "criterion-b", evidence: [{ evidenceId: "ev-acceptance-criterion-b" }] },
        ],
      },
    });
    if (materialized.valid) {
      expect(validateMissionSettlement(baseline, materialized.resolution, assuranceSources)).toEqual({ valid: true });
    }
  });

  it("materializes a flat assurance checklist into the authoritative audit report", () => {
    const baseline = {
      baselineId: "baseline-a",
      version: 2,
      objective: "deliver",
      criteria: [baselineCriterion("criterion-a", "artifact runs")],
      constraints: [], assumptions: [], exclusions: [],
      establishedByTicketId: "ticket-intake" as TicketId,
      establishedAt: NOW,
    };
    const outcome = materializeSimpleAssuranceOutcome(
      baseline,
      ["criterion-a"],
      {
        summary: "checked the artifact",
        checks: [{ verificationBasis: "npm test", observations: ["all tests passed"] }],
      },
      [{ evidenceId: "ev-npm-test" }],
    );

    expect(outcome).toEqual({
      assuranceReport: {
        baselineVersion: 2,
        missionCriterionResults: [{
          criterionId: "criterion-a",
          status: "satisfied",
          evidence: [{ evidenceId: "ev-npm-test" }],
          anchorResults: [{
            anchorIndex: 0,
            status: "satisfied",
            evidence: [{ evidenceId: "ev-npm-test" }],
            verificationBasis: { summary: "npm test", evidence: [{ evidenceId: "ev-npm-test" }] },
            observations: ["all tests passed"],
            deviations: [],
          }],
        }],
      },
    });
    expect(validateMissionAssuranceReport(baseline, ["criterion-a"], outcome)).toEqual({ valid: true });
  });

  it("derives correction scope and evidence from platform-owned facts", () => {
    const baseline = {
      baselineId: "baseline-a",
      version: 2,
      objective: "deliver",
      criteria: [baselineCriterion("criterion-a", "artifact runs")],
      constraints: [], assumptions: [], exclusions: [],
      establishedByTicketId: "ticket-intake" as TicketId,
      establishedAt: NOW,
    };
    const outcome = materializeSimpleAssuranceCorrection(
      baseline,
      {
        disposition: "correction_required",
        targetTicketId: "ticket-dev",
        reason: "startup failed",
        findings: [{ summary: "entrypoint broken", details: "process exited with code 1" }],
      },
      [{ evidenceId: "ev-startup" }],
      [{ ticketId: "ticket-dev" as TicketId, title: "implementation", missionCriterionIds: ["criterion-a"] }],
    );

    expect(outcome).toMatchObject({
      correctionMissionCriterionIds: ["criterion-a"],
      findings: [{ evidence: [{ evidenceId: "ev-startup" }], affectedMissionCriterionIds: ["criterion-a"] }],
      assuranceReport: {
        baselineVersion: 2,
        missionCriterionResults: [{ criterionId: "criterion-a", status: "not_satisfied" }],
      },
    });
    expect(validateMissionAssuranceReport(baseline, ["criterion-a"], outcome, "correction")).toEqual({ valid: true });
  });

  it("materializes final acceptance from satisfied authoritative assurance", () => {
    const baseline = {
      baselineId: "baseline-a",
      version: 2,
      objective: "deliver",
      criteria: [
        baselineCriterion("criterion-a", "artifact runs"),
        baselineCriterion("criterion-b", "behavior is verified"),
      ],
      constraints: [], assumptions: [], exclusions: [],
      establishedByTicketId: "ticket-intake" as TicketId,
      establishedAt: NOW,
    };
    const assuranceSources = baseline.criteria.map(({ criterionId }) => ({
      ticketId: `assurance-${criterionId}` as TicketId,
      baselineVersion: 2,
      criterionResults: [{
        criterionId,
        status: "satisfied" as const,
        evidence: [{ evidenceId: `ev-${criterionId}` }],
        anchorResults: [anchorResult(`ev-${criterionId}`)],
      }],
    }));

    const simple = materializeSimpleMissionSettlement(
      baseline,
      { summary: "accepted", residualRisks: [] },
      assuranceSources,
    );
    expect(simple).toMatchObject({
      valid: true,
      outcome: {
        disposition: "complete",
        missionResolution: {
          baselineVersion: 2,
          criterionResults: [
            { criterionId: "criterion-a", assuranceTicketIds: ["assurance-criterion-a"] },
            { criterionId: "criterion-b", assuranceTicketIds: ["assurance-criterion-b"] },
          ],
        },
      },
    });
    if (!simple.valid) throw new Error(simple.reason);
    const materialized = materializeMissionSettlement(
      baseline,
      simple.outcome.missionResolution,
      assuranceSources,
    );
    expect(materialized).toMatchObject({
      valid: true,
      resolution: {
        criterionResults: [
          { criterionId: "criterion-a", evidence: [{ evidenceId: "ev-criterion-a" }] },
          { criterionId: "criterion-b", evidence: [{ evidenceId: "ev-criterion-b" }] },
        ],
      },
    });
  });

  it("gives the settlement agent a criterion-scoped authoritative evidence matrix", () => {
    const instruction = missionOutcomeInstruction(
      "mission-acceptance-v1",
      [],
      [],
      undefined,
      undefined,
      [],
      {
        ticket: {
          ticketId: "settlement" as TicketId,
          title: "最终验收",
          objective: "验收",
          successCriteria: ["逐项验收"],
          outputContract: { schemaRef: "mission-acceptance-v1" },
          permissions: { settleMission: true },
        },
      },
      {
        baselineVersion: 2,
        criteria: [{
          criterionId: "criterion-a",
          criterionText: "可运行",
          verification: baselineCriterion("criterion-a", "可运行").verification,
          assuranceSources: [{
            ticketId: "qa-a" as TicketId,
            baselineVersion: 2,
            criterionResults: [{
              criterionId: "criterion-a",
              status: "satisfied",
              evidence: [{ evidenceId: "ev-npm-test" }],
              anchorResults: [anchorResult("ev-npm-test")],
            }],
          }],
        }],
      },
    );

    expect(instruction).toContain("权威验收证据矩阵");
    expect(instruction).toContain('\"ticketId\":\"qa-a\"');
    expect(instruction).toContain('\"criterionId\":\"criterion-a\"');
    expect(instruction).toContain('\"evidenceId\":\"ev-npm-test\"');
    expect(instruction).toContain("不替你作出验收判断");
    expect(instruction).toContain("domainOutcome 只提交 {summary,residualRisks}");
    expect(instruction).toContain("Mission Control 会从权威状态机械装配最终结算");
    expect(instruction).toContain("不得把 disposition 嵌入 missionResolution");
  });

  it("requires assurance reports to cover the declared baseline criteria without hiding unverified work", () => {
    const baseline = {
      baselineId: "baseline-a",
      version: 3,
      objective: "deliver the agreed product",
      criteria: [
        baselineCriterion("criterion-a", "artifact runs"),
        baselineCriterion("criterion-b", "behavior matches"),
      ],
      constraints: [], assumptions: [], exclusions: [],
      establishedByTicketId: "ticket-intake" as TicketId,
      establishedAt: NOW,
    };
    const report = {
      assuranceReport: {
        baselineVersion: 3,
        missionCriterionResults: [
          { criterionId: "criterion-a", status: "satisfied", evidence: [{ evidenceId: "ev-browser-a" }], anchorResults: [anchorResult("ev-browser-a")] },
          { criterionId: "criterion-b", status: "satisfied", evidence: [{ evidenceId: "ev-browser-b" }], anchorResults: [anchorResult("ev-browser-b")] },
        ],
      },
    };

    expect(validateMissionAssuranceReport(baseline, ["criterion-a", "criterion-b"], report)).toEqual({ valid: true });
    expect(validateMissionAssuranceReport(baseline, ["criterion-a", "criterion-b"], {
      assuranceReport: {
        ...report.assuranceReport,
        missionCriterionResults: [
          report.assuranceReport.missionCriterionResults[0],
          { criterionId: "criterion-b", status: "not_verified", evidence: [], anchorResults: [] },
        ],
      },
    })).toMatchObject({ valid: false, reason: expect.stringContaining("not_verified") });
    expect(validateMissionAssuranceReport(baseline, ["criterion-a", "criterion-b"], {
      assuranceReport: {
        ...report.assuranceReport,
        missionCriterionResults: report.assuranceReport.missionCriterionResults.map((item) => ({
          ...item,
          anchorResults: [],
        })),
      },
    })).toMatchObject({ valid: false, reason: expect.stringContaining("anchorResults") });
    expect(validateMissionAssuranceReport(baseline, ["criterion-a", "criterion-b"], {
      assuranceReport: {
        ...report.assuranceReport,
        missionCriterionResults: report.assuranceReport.missionCriterionResults.map((item) => ({
          ...item,
          anchorResults: item.anchorResults.map((anchor) => ({
            ...anchor,
            deviations: ["实际结果只达到同类体验，未达到高度一致"],
          })),
        })),
      },
    })).toMatchObject({ valid: false, reason: expect.stringContaining("不能标记 satisfied") });
  });

  it("requires a correction to report exactly the affected criteria without replaying unaffected QA results", () => {
    const baseline = {
      baselineId: "baseline-correction",
      version: 4,
      objective: "deliver the agreed product",
      criteria: [
        baselineCriterion("criterion-a", "artifact runs"),
        baselineCriterion("criterion-b", "behavior matches"),
      ],
      constraints: [], assumptions: [], exclusions: [],
      establishedByTicketId: "ticket-intake" as TicketId,
      establishedAt: NOW,
    };
    const failedAnchor = {
      ...anchorResult("ev-failure-b"),
      status: "not_satisfied" as const,
      observations: ["The behavior was exercised in the target environment"],
      deviations: ["The observed behavior does not match the agreed anchor"],
    };
    const outcome = {
      disposition: "correction_required",
      targetTicketId: "dev" as TicketId,
      reason: "The complete verification batch contains a failed behavior criterion",
      correctionMissionCriterionIds: ["criterion-b"],
      findings: [{
        summary: "Behavior mismatch",
        details: "The observed behavior does not match the agreed anchor",
        evidence: [{ evidenceId: "ev-failure-b" }],
        affectedMissionCriterionIds: ["criterion-b"],
      }],
      assuranceReport: {
        baselineVersion: 4,
        missionCriterionResults: [
          { criterionId: "criterion-b", status: "not_satisfied", evidence: [{ evidenceId: "ev-failure-b" }], anchorResults: [failedAnchor] },
        ],
      },
    };

    expect(validateMissionAssuranceReport(
      baseline,
      ["criterion-b"],
      outcome,
      "correction",
    )).toEqual({ valid: true });
    expect(validateMissionAssuranceReport(
      baseline,
      ["criterion-b"],
      {
        ...outcome,
        assuranceReport: {
          ...outcome.assuranceReport,
          missionCriterionResults: [
            { criterionId: "criterion-a", status: "satisfied", evidence: [{ evidenceId: "ev-pass-a" }], anchorResults: [anchorResult("ev-pass-a")] },
            ...outcome.assuranceReport.missionCriterionResults,
          ],
        },
      },
      "correction",
    )).toMatchObject({ valid: false, reason: expect.stringContaining("criterion") });
    expect(validateMissionAssuranceReport(
      baseline,
      ["criterion-b"],
      { ...outcome, correctionMissionCriterionIds: ["criterion-a"] },
      "correction",
    )).toMatchObject({ valid: false, reason: expect.stringContaining("完全一致") });
  });

  it("describes the flat mission assurance checklist", () => {
    const instruction = missionOutcomeInstruction(
      "mission-assurance-v1",
      [],
      [],
      undefined,
      {
        planId: "plan-a",
        version: 1,
        tickets: [],
        dependencyEdges: [],
        requiredTerminalTicketIds: [],
        missionBaseline: {
          baselineId: "baseline-a",
          version: 3,
          establishedByTicketId: "intake-a" as TicketId,
          establishedAt: NOW,
          objective: "deliver",
          criteria: [baselineCriterion("criterion-a", "artifact runs")],
          constraints: [],
          assumptions: [],
          exclusions: [],
        },
        teamMembers: [],
      },
      [],
      {
        ticket: {
          ticketId: "assurance-a" as TicketId,
          title: "verify",
          objective: "verify the artifact",
          successCriteria: ["produce a reproducible conclusion"],
          outputContract: { schemaRef: "mission-assurance-v1" },
          assurance: { missionCriterionIds: ["criterion-a"] },
        },
      },
    );

    expect(instruction).toContain("orderedCheckList");
    expect(instruction).toContain("domainOutcome 只提交 {summary,checks:[{verificationBasis,observations}]}");
    expect(instruction).toContain("平台自动绑定 criterion、anchor、satisfied 状态");
    expect(instruction).toContain("本 Goal 的真实工具证据");
    expect(instruction).toContain("条件链停止后，不得声称");
    expect(instruction).toContain("需要验证成功、预期失败或不同退出码时分别调用 shell");
    expect(instruction).toContain("verificationBasis");
    expect(instruction).toContain("不要填写 criterionId、anchorIndex、status 或 evidenceId");
    expect(instruction).toContain("可由团队内部返工修复的缺陷时调用 report_goal_correction");
    expect(instruction).toContain("缺少不可替代的外部事实、凭证、授权或人工操作");
    expect(instruction).toContain("request_human_input 并保持当前 Ticket/Plan blocked");
  });

  it("isolates the current assurance scope from unrelated Plan criteria", () => {
    const baseline = {
      baselineId: "baseline-a",
      version: 7,
      objective: "deliver",
      criteria: [
        baselineCriterion("criterion-current", "当前功能必须可以完成核心操作"),
        baselineCriterion("criterion-unrelated", "这个标准属于另一个交付增量"),
      ],
      constraints: [],
      assumptions: [],
      exclusions: [],
      establishedByTicketId: "intake-a" as TicketId,
      establishedAt: NOW,
    };
    const plan: SharedPlanContext = {
      planId: "plan-a",
      version: 4,
      tickets: [{
        ticketId: "unrelated-ticket",
        status: "completed",
        title: "另一个增量",
        objective: "不要把这个目标混入当前验收",
        successCriteria: ["另一个工单的标准不能进入当前报告"],
        outputContract: { schemaRef: "delivery-v1" },
        missionContribution: { missionCriterionIds: ["criterion-unrelated"] },
      }],
      dependencyEdges: [],
      requiredTerminalTicketIds: [],
      missionBaseline: baseline,
      teamMembers: [],
    };
    const assignment = {
      ticket: {
        ticketId: "assurance-a" as TicketId,
        title: "当前验收",
        objective: "验证当前功能",
        successCriteria: ["形成当前 Ticket 的逐项结论"],
        outputContract: { schemaRef: "mission-assurance-v1" },
        assurance: { missionCriterionIds: ["criterion-current"] },
      },
    };

    expect(projectMissionAssuranceContext(plan, assignment)).toEqual({
      planRef: { planId: "plan-a", version: 4 },
      baselineVersion: 7,
      criterionIds: ["criterion-current"],
      criteria: [baseline.criteria[0]],
      missingCriterionIds: [],
    });

    const instruction = missionOutcomeInstruction(
      "mission-assurance-v1",
      [],
      [],
      undefined,
      plan,
      [{
        ticketId: "unrelated-ticket" as TicketId,
        title: "另一个增量",
        objective: "不要把这个目标混入当前验收",
        successCriteria: ["另一个工单的标准不能进入当前报告"],
        outputContract: { schemaRef: "delivery-v1" },
        handoff: {
          schemaVersion: 1,
          summary: "另一个增量的历史交付",
          output: { note: "historical" },
          evidence: [],
          criterionResults: [],
          residualRisks: [],
        },
      }],
      assignment,
    );

    expect(instruction).toContain('"assuranceScope"');
    expect(instruction).toContain("当前功能必须可以完成核心操作");
    expect(instruction).not.toContain("这个标准属于另一个交付增量");
    expect(instruction).not.toContain("另一个工单的标准不能进入当前报告");
    expect(instruction).not.toContain('"currentPlan"');
  });

  it("requires every Mission settlement terminal to inherit baseline assurance from strict upstream Tickets", () => {
    const baseline = {
      baselineId: "baseline-a",
      version: 1,
      objective: "deliver the agreed product",
      criteria: [
        baselineCriterion("criterion-a", "artifact runs"),
        baselineCriterion("criterion-b", "behavior matches"),
      ],
      constraints: [], assumptions: [], exclusions: [],
      establishedByTicketId: "ticket-intake" as TicketId,
      establishedAt: NOW,
    };
    const currentPlan: SharedPlanContext = {
      planId: "plan-a",
      version: 1,
      missionBaseline: baseline,
      tickets: [],
      dependencyEdges: [],
      requiredTerminalTicketIds: [],
      teamMembers: [],
    };
    const terminal = {
      ...draft("acceptance", "acceptance-v1", ["delivery:accept"]),
      permissions: { settleMission: true },
    };
    const unverified = {
      additions: [draft("work"), terminal],
      dependencyAdditions: [{ from: { clientRef: "work" }, to: { clientRef: "acceptance" } }],
      cancelTicketIds: [],
      requiredTerminalRefs: [{ clientRef: "acceptance" }],
    };
    const verified = {
      additions: [
        {
          ...draft("work"),
          missionContribution: { missionCriterionIds: ["criterion-a", "criterion-b"] },
        },
        {
          ...draft("assurance-a", "mission-assurance-v1", ["delivery:verify"]),
          assurance: { missionCriterionIds: ["criterion-a"] },
        },
        {
          ...draft("assurance-b", "mission-assurance-v1", ["delivery:verify"]),
          assurance: { missionCriterionIds: ["criterion-b"] },
        },
        terminal,
      ],
      dependencyAdditions: [
        { from: { clientRef: "work" }, to: { clientRef: "assurance-a" } },
        { from: { clientRef: "work" }, to: { clientRef: "assurance-b" } },
        { from: { clientRef: "assurance-a" }, to: { clientRef: "acceptance" } },
        { from: { clientRef: "assurance-b" }, to: { clientRef: "acceptance" } },
      ],
      cancelTicketIds: [],
      requiredTerminalRefs: [{ clientRef: "acceptance" }],
    };

    expect(validateMissionPlanAssurance(baseline, unverified, currentPlan))
      .toMatchObject({ valid: false, reason: expect.stringContaining("criterion-a") });
    expect(validateMissionPlanAssurance(baseline, verified, currentPlan)).toEqual({ valid: true });
  });

  it("retains completed assurance for untouched criteria while requiring a fresh chain for revised criteria", () => {
    const baseline = {
      baselineId: "baseline-a",
      version: 1,
      objective: "deliver the agreed product",
      criteria: [
        baselineCriterion("criterion-a", "existing behavior remains valid"),
        baselineCriterion("criterion-b", "broken link is repaired"),
      ],
      constraints: [], assumptions: [], exclusions: [],
      establishedByTicketId: "ticket-intake" as TicketId,
      establishedAt: NOW,
    };
    const currentPlan: SharedPlanContext = {
      planId: "plan-a",
      version: 2,
      missionBaseline: baseline,
      tickets: [{
        ticketId: "old-assurance",
        status: "completed",
        completedAt: NOW,
        title: "Existing assurance",
        objective: "Verify the first criterion",
        successCriteria: ["verified"],
        outputContract: { schemaRef: "mission-assurance-v1" },
        assurance: { missionCriterionIds: ["criterion-a"] },
        satisfiedMissionCriterionIds: ["criterion-a"],
      }],
      dependencyEdges: [],
      requiredTerminalTicketIds: [],
      teamMembers: [],
    };
    const change = {
      additions: [
        {
          ...draft("repair"),
          missionContribution: { missionCriterionIds: ["criterion-b"] },
        },
        {
          ...draft("verify-repair", "mission-assurance-v1"),
          assurance: { missionCriterionIds: ["criterion-b"] },
        },
        {
          ...draft("terminal"),
          permissions: { settleMission: true },
        },
      ],
      dependencyAdditions: [
        { from: { clientRef: "repair" }, to: { clientRef: "verify-repair" } },
        { from: { clientRef: "verify-repair" }, to: { clientRef: "terminal" } },
      ],
      failureResolutions: [],
      cancelTicketIds: [],
      requiredTerminalRefs: [{ clientRef: "terminal" }],
    };

    expect(validateMissionPlanAssurance(baseline, change, currentPlan)).toEqual({ valid: true });
  });

  it("does not retain a completed assurance definition without an accepted satisfied result", () => {
    const baseline = {
      baselineId: "baseline-a",
      version: 1,
      objective: "deliver the agreed product",
      criteria: [baselineCriterion("criterion-a", "behavior remains valid")],
      constraints: [], assumptions: [], exclusions: [],
      establishedByTicketId: "ticket-intake" as TicketId,
      establishedAt: NOW,
    };
    const currentPlan: SharedPlanContext = {
      planId: "plan-a",
      version: 2,
      missionBaseline: baseline,
      tickets: [{
        ticketId: "old-assurance",
        status: "completed",
        completedAt: NOW,
        title: "Unverified assurance",
        objective: "Attempt verification",
        successCriteria: ["verified"],
        outputContract: { schemaRef: "mission-assurance-v1" },
        assurance: { missionCriterionIds: ["criterion-a"] },
        satisfiedMissionCriterionIds: [],
      }],
      dependencyEdges: [],
      requiredTerminalTicketIds: [],
      teamMembers: [],
    };
    const change = {
      additions: [{
        ...draft("terminal"),
        permissions: { settleMission: true },
      }],
      dependencyAdditions: [],
      failureResolutions: [],
      cancelTicketIds: [],
      requiredTerminalRefs: [{ clientRef: "terminal" }],
    };

    expect(validateMissionPlanAssurance(baseline, change, currentPlan))
      .toMatchObject({ valid: false, reason: expect.stringContaining("criterion-a") });
  });

  it("does not retain old assurance for a criterion touched by the revision", () => {
    const baseline = {
      baselineId: "baseline-a",
      version: 1,
      objective: "deliver the agreed product",
      criteria: [baselineCriterion("criterion-a", "behavior is repaired")],
      constraints: [], assumptions: [], exclusions: [],
      establishedByTicketId: "ticket-intake" as TicketId,
      establishedAt: NOW,
    };
    const currentPlan: SharedPlanContext = {
      planId: "plan-a",
      version: 2,
      missionBaseline: baseline,
      tickets: [{
        ticketId: "old-assurance",
        status: "completed",
        completedAt: NOW,
        title: "Old assurance",
        objective: "Verify old behavior",
        successCriteria: ["verified"],
        outputContract: { schemaRef: "mission-assurance-v1" },
        assurance: { missionCriterionIds: ["criterion-a"] },
      }],
      dependencyEdges: [],
      requiredTerminalTicketIds: [],
      teamMembers: [],
    };
    const change = {
      additions: [
        {
          ...draft("repair"),
          missionContribution: { missionCriterionIds: ["criterion-a"] },
        },
        {
          ...draft("terminal"),
          permissions: { settleMission: true },
        },
      ],
      dependencyAdditions: [
        { from: { clientRef: "repair" }, to: { clientRef: "terminal" } },
      ],
      failureResolutions: [],
      cancelTicketIds: [],
      requiredTerminalRefs: [{ clientRef: "terminal" }],
    };

    expect(validateMissionPlanAssurance(baseline, change, currentPlan))
      .toMatchObject({ valid: false, reason: expect.stringContaining("criterion-a") });
  });

  it("rejects a compiled assurance Ticket without authoritative criterion binding", () => {
    const baseline = {
      baselineId: "baseline-a",
      version: 1,
      objective: "deliver the agreed product",
      criteria: [baselineCriterion("criterion-a", "artifact runs")],
      constraints: [], assumptions: [], exclusions: [],
      establishedByTicketId: "ticket-intake" as TicketId,
      establishedAt: NOW,
    };
    const currentPlan: SharedPlanContext = {
      planId: "plan-a",
      version: 1,
      missionBaseline: baseline,
      tickets: [],
      dependencyEdges: [],
      requiredTerminalTicketIds: [],
      teamMembers: [],
    };
    const result = validateMissionPlanAssurance(baseline, {
      additions: [{
        ...draft("verify", "mission-assurance-v1"),
        missionContribution: { missionCriterionIds: ["criterion-a"] },
      }],
      dependencyAdditions: [],
      cancelTicketIds: [],
      requiredTerminalRefs: [],
    }, currentPlan);

    expect(result).toEqual({
      valid: false,
      reason: expect.stringContaining("authoritative assurance criterion binding"),
    });
    if (!result.valid) expect(result.reason).toContain("authoritative assurance criterion binding");
  });

  it("requires each later delivery increment to start after every previous increment exit", () => {
    const baseline = {
      baselineId: "baseline-a",
      version: 1,
      objective: "deliver the agreed product",
      criteria: [baselineCriterion("criterion-a", "artifact runs")],
      constraints: [], assumptions: [], exclusions: [],
      establishedByTicketId: "ticket-intake" as TicketId,
      establishedAt: NOW,
    };
    const currentPlan: SharedPlanContext = {
      planId: "plan-a",
      version: 1,
      missionBaseline: baseline,
      tickets: [],
      dependencyEdges: [],
      requiredTerminalTicketIds: [],
      teamMembers: [],
    };
    const incrementOne = { incrementId: "increment-1", sequence: 1, title: "可玩基线", objective: "形成可玩版本" };
    const incrementTwo = { incrementId: "increment-2", sequence: 2, title: "质量逼近", objective: "达到最终质量" };
    const addition = (clientRef: string, increment: typeof incrementOne, schemaRef = "delivery-v1") => ({
      ...draft(clientRef, schemaRef),
      deliveryIncrement: increment,
      ...(schemaRef === "mission-assurance-v1"
        ? { assurance: { missionCriterionIds: ["criterion-a"] } }
        : { missionContribution: { missionCriterionIds: ["criterion-a"] } }),
    });
    const terminal = {
      ...draft("acceptance", "acceptance-v1"),
      deliveryIncrement: undefined,
      permissions: { settleMission: true },
    };
    const baselineReview = {
      ...draft("assurance-1", "artifact-review-v1"),
      deliveryIncrement: incrementOne,
    };
    const additions = [
      addition("work-1", incrementOne),
      baselineReview,
      addition("work-2", incrementTwo),
      addition("assurance-2", incrementTwo, "mission-assurance-v1"),
      terminal,
    ];
    const invalid = {
      additions,
      dependencyAdditions: [
        { from: { clientRef: "work-1" }, to: { clientRef: "assurance-1" } },
        { from: { clientRef: "work-1" }, to: { clientRef: "work-2" } },
        { from: { clientRef: "work-2" }, to: { clientRef: "assurance-2" } },
        { from: { clientRef: "assurance-2" }, to: { clientRef: "acceptance" } },
      ],
      cancelTicketIds: [],
      requiredTerminalRefs: [{ clientRef: "acceptance" }],
    };
    const valid = {
      ...invalid,
      dependencyAdditions: [
        { from: { clientRef: "work-1" }, to: { clientRef: "assurance-1" } },
        { from: { clientRef: "assurance-1" }, to: { clientRef: "work-2" } },
        { from: { clientRef: "work-2" }, to: { clientRef: "assurance-2" } },
        { from: { clientRef: "assurance-2" }, to: { clientRef: "acceptance" } },
      ],
    };

    expect(validateMissionPlanAssurance(baseline, invalid, currentPlan))
      .toMatchObject({ valid: false, reason: expect.stringContaining("上一增量") });
    expect(validateMissionPlanAssurance(baseline, valid, currentPlan)).toEqual({ valid: true });
  });

  it("treats a failure-resolution chain as a new increment boundary", () => {
    const baseline = {
      baselineId: "baseline-a",
      version: 1,
      objective: "deliver the agreed product",
      criteria: [baselineCriterion("criterion-a", "artifact runs")],
      constraints: [], assumptions: [], exclusions: [],
      establishedByTicketId: "ticket-intake" as TicketId,
      establishedAt: NOW,
    };
    const currentPlan: SharedPlanContext = {
      planId: "plan-a",
      version: 1,
      missionBaseline: baseline,
      tickets: [{
        ticketId: "failed-qa",
        status: "returned",
        title: "Failed QA",
        objective: "Verify",
        successCriteria: ["Verify"],
        outputContract: { schemaRef: "mission-assurance-v1" },
        deliveryIncrement: { incrementId: "old-qa", sequence: 5, title: "Old QA", objective: "Verify" },
        assurance: { missionCriterionIds: ["criterion-a"] },
      }, {
        ticketId: "blocked-acceptance",
        status: "pending",
        title: "Blocked acceptance",
        objective: "Accept",
        successCriteria: ["Accept"],
        outputContract: { schemaRef: "acceptance-v1" },
        deliveryIncrement: { incrementId: "old-acceptance", sequence: 6, title: "Old acceptance", objective: "Accept" },
      }, {
        ticketId: "planner",
        status: "running",
        title: "Replan",
        objective: "Replace failed delivery",
        successCriteria: ["Plan"],
        outputContract: { schemaRef: "plan-intent-v1" },
      }],
      dependencyEdges: [{ fromTicketId: "failed-qa", toTicketId: "blocked-acceptance" }],
      requiredTerminalTicketIds: ["blocked-acceptance"],
      teamMembers: [],
    };
    const increment = { incrementId: "replacement", sequence: 7, title: "Replacement", objective: "Replace" };
    const result = validateMissionPlanAssurance(baseline, {
      additions: [{
        ...draft("replacement-work"),
        deliveryIncrement: increment,
        missionContribution: { missionCriterionIds: ["criterion-a"] },
      }, {
        ...draft("replacement-assurance", "mission-assurance-v1"),
        deliveryIncrement: increment,
        assurance: { missionCriterionIds: ["criterion-a"] },
      }, {
        ...draft("replacement-acceptance", "acceptance-v1"),
        deliveryIncrement: increment,
        permissions: { settleMission: true },
      }],
      dependencyAdditions: [
        { from: { ticketId: "planner" }, to: { clientRef: "replacement-work" } },
        { from: { clientRef: "replacement-work" }, to: { clientRef: "replacement-assurance" } },
        { from: { clientRef: "replacement-assurance" }, to: { clientRef: "replacement-acceptance" } },
      ],
      failureResolutions: [{ failedTicketId: "failed-qa", resolvedBy: { clientRef: "replacement-assurance" } }],
      cancelTicketIds: [],
      requiredTerminalRefs: [{ clientRef: "replacement-acceptance" }],
    }, currentPlan);

    expect(result).toEqual({ valid: true });
  });

  it("allows correction work inside an existing increment to start after the amendment Ticket", () => {
    const baseline = {
      baselineId: "baseline-a",
      version: 1,
      objective: "deliver the agreed product",
      criteria: [baselineCriterion("criterion-a", "artifact runs")],
      constraints: [], assumptions: [], exclusions: [],
      establishedByTicketId: "ticket-intake" as TicketId,
      establishedAt: NOW,
    };
    const existingIncrement = {
      incrementId: "increment-2",
      sequence: 2,
      title: "质量逼近",
      objective: "达到最终质量",
    };
    const currentPlan: SharedPlanContext = {
      planId: "plan-a",
      version: 4,
      missionBaseline: baseline,
      tickets: [
        {
          ticketId: "ticket-amendment",
          status: "running",
          title: "计划修订",
          objective: "处理上一轮验证发现的缺陷",
          successCriteria: ["追加返工链"],
          outputContract: { schemaRef: "plan-intent-v1" },
        },
        {
          ticketId: "ticket-returned-assurance",
          status: "returned",
          title: "独立验证",
          objective: "验证上一版交付",
          successCriteria: ["给出验证结论"],
          outputContract: { schemaRef: "mission-assurance-v1" },
          deliveryIncrement: existingIncrement,
          assurance: { missionCriterionIds: ["criterion-a"] },
        },
      ],
      dependencyEdges: [],
      requiredTerminalTicketIds: [],
      teamMembers: [],
    };
    const change = {
      additions: [
        {
          ...draft("repair", "delivery-v1"),
          deliveryIncrement: existingIncrement,
          missionContribution: { missionCriterionIds: ["criterion-a"] },
        },
        {
          ...draft("verify-repair", "mission-assurance-v1"),
          deliveryIncrement: existingIncrement,
          assurance: { missionCriterionIds: ["criterion-a"] },
        },
        {
          ...draft("acceptance", "acceptance-v1"),
          deliveryIncrement: undefined,
          permissions: { settleMission: true },
        },
      ],
      dependencyAdditions: [
        { from: { ticketId: "ticket-amendment" }, to: { clientRef: "repair" } },
        { from: { clientRef: "repair" }, to: { clientRef: "verify-repair" } },
        { from: { clientRef: "verify-repair" }, to: { clientRef: "acceptance" } },
      ],
      cancelTicketIds: [],
      requiredTerminalRefs: [{ clientRef: "acceptance" }],
    };
    expect(validateMissionPlanAssurance(baseline, change, currentPlan)).toEqual({ valid: true });
  });

  it("starts a later repair increment from the amendment after declaring how the historical failure is resolved", () => {
    const baseline = {
      baselineId: "baseline-a",
      version: 1,
      objective: "deliver the agreed product",
      criteria: [baselineCriterion("criterion-a", "artifact runs")],
      constraints: [], assumptions: [], exclusions: [],
      establishedByTicketId: "ticket-intake" as TicketId,
      establishedAt: NOW,
    };
    const failedIncrement = {
      incrementId: "increment-3",
      sequence: 3,
      title: "original verification",
      objective: "verify the original delivery",
    };
    const repairIncrement = {
      incrementId: "increment-4",
      sequence: 4,
      title: "verified repair",
      objective: "repair and independently verify the failed delivery",
    };
    const currentPlan: SharedPlanContext = {
      planId: "plan-a",
      version: 7,
      missionBaseline: baseline,
      tickets: [
        {
          ticketId: "ticket-amendment",
          status: "running",
          title: "plan amendment",
          objective: "plan a correction for the returned assurance",
          successCriteria: ["append a verifiable repair chain"],
          outputContract: { schemaRef: "plan-intent-v1" },
        },
        {
          ticketId: "ticket-returned-assurance",
          status: "returned",
          title: "original assurance",
          objective: "verify the original delivery",
          successCriteria: ["record an independent conclusion"],
          outputContract: { schemaRef: "mission-assurance-v1" },
          deliveryIncrement: failedIncrement,
          assurance: { missionCriterionIds: ["criterion-a"] },
        },
        {
          ticketId: "ticket-old-settlement",
          status: "pending",
          title: "old settlement",
          objective: "settle the original chain",
          successCriteria: ["settle only after assurance"],
          outputContract: { schemaRef: "mission-settlement-v1" },
        },
      ],
      dependencyEdges: [
        { fromTicketId: "ticket-returned-assurance", toTicketId: "ticket-old-settlement" },
      ],
      requiredTerminalTicketIds: ["ticket-old-settlement"],
      teamMembers: [],
    };
    const change = {
      additions: [
        {
          ...draft("repair", "delivery-v1"),
          deliveryIncrement: repairIncrement,
          missionContribution: { missionCriterionIds: ["criterion-a"] },
        },
        {
          ...draft("verify-repair", "mission-assurance-v1"),
          deliveryIncrement: repairIncrement,
          assurance: { missionCriterionIds: ["criterion-a"] },
        },
        {
          ...draft("new-settlement", "mission-settlement-v1"),
          permissions: { settleMission: true },
        },
      ],
      dependencyAdditions: [
        { from: { ticketId: "ticket-amendment" }, to: { clientRef: "repair" } },
        { from: { clientRef: "repair" }, to: { clientRef: "verify-repair" } },
        { from: { clientRef: "verify-repair" }, to: { clientRef: "new-settlement" } },
      ],
      failureResolutions: [{
        failedTicketId: "ticket-returned-assurance",
        resolvedBy: { clientRef: "verify-repair" },
      }],
      cancelTicketIds: ["ticket-old-settlement"],
      requiredTerminalRefs: [{ clientRef: "new-settlement" }],
    };
    expect(validateMissionPlanAssurance(baseline, change, currentPlan)).toEqual({ valid: true });
    expect(validateMissionPlanAssurance(
      baseline,
      { ...change, failureResolutions: [] },
      currentPlan,
    )).toMatchObject({ valid: false, reason: expect.stringContaining("上一增量") });
  });

  it("still sequences later affected increments behind the corrected increment assurance", () => {
    const baseline = {
      baselineId: "baseline-a",
      version: 1,
      objective: "deliver the agreed product",
      criteria: [baselineCriterion("criterion-a", "artifact runs")],
      constraints: [], assumptions: [], exclusions: [],
      establishedByTicketId: "ticket-intake" as TicketId,
      establishedAt: NOW,
    };
    const incrementTwo = { incrementId: "increment-2", sequence: 2, title: "规则返工", objective: "修正规则" };
    const incrementThree = { incrementId: "increment-3", sequence: 3, title: "视听返工", objective: "修正视听" };
    const currentPlan: SharedPlanContext = {
      planId: "plan-a",
      version: 4,
      missionBaseline: baseline,
      tickets: [
        {
          ticketId: "ticket-amendment",
          status: "running",
          title: "计划修订",
          objective: "处理上一轮验证发现的缺陷",
          successCriteria: ["追加返工链"],
          outputContract: { schemaRef: "plan-intent-v1" },
        },
        {
          ticketId: "ticket-old-rules",
          status: "completed",
          title: "旧规则实现",
          objective: "实现规则",
          successCriteria: ["规则可运行"],
          outputContract: { schemaRef: "delivery-v1" },
          deliveryIncrement: incrementTwo,
          missionContribution: { missionCriterionIds: ["criterion-a"] },
        },
        {
          ticketId: "ticket-old-visual",
          status: "pending",
          title: "旧视听实现",
          objective: "实现视听",
          successCriteria: ["视听可运行"],
          outputContract: { schemaRef: "delivery-v1" },
          deliveryIncrement: incrementThree,
          missionContribution: { missionCriterionIds: ["criterion-a"] },
        },
      ],
      dependencyEdges: [],
      requiredTerminalTicketIds: [],
      teamMembers: [],
    };
    const addition = (clientRef: string, increment: typeof incrementTwo, schemaRef = "delivery-v1") => ({
      ...draft(clientRef, schemaRef),
      deliveryIncrement: increment,
      ...(schemaRef === "mission-assurance-v1"
        ? { assurance: { missionCriterionIds: ["criterion-a"] } }
        : { missionContribution: { missionCriterionIds: ["criterion-a"] } }),
    });
    const additions = [
      addition("repair-rules", incrementTwo),
      addition("verify-rules", incrementTwo, "mission-assurance-v1"),
      addition("repair-visual", incrementThree),
      addition("verify-visual", incrementThree, "mission-assurance-v1"),
      {
        ...draft("acceptance", "acceptance-v1"),
        deliveryIncrement: undefined,
        permissions: { settleMission: true },
      },
    ];
    const baseEdges = [
      { from: { ticketId: "ticket-amendment" }, to: { clientRef: "repair-rules" } },
      { from: { clientRef: "repair-rules" }, to: { clientRef: "verify-rules" } },
      { from: { clientRef: "repair-visual" }, to: { clientRef: "verify-visual" } },
      { from: { clientRef: "verify-visual" }, to: { clientRef: "acceptance" } },
    ];
    const invalid = {
      additions,
      dependencyAdditions: [
        ...baseEdges,
        { from: { ticketId: "ticket-amendment" }, to: { clientRef: "repair-visual" } },
      ],
      cancelTicketIds: [],
      requiredTerminalRefs: [{ clientRef: "acceptance" }],
    };
    const valid = {
      ...invalid,
      dependencyAdditions: [
        ...baseEdges,
        { from: { clientRef: "verify-rules" }, to: { clientRef: "repair-visual" } },
      ],
    };
    expect(validateMissionPlanAssurance(baseline, invalid, currentPlan))
      .toMatchObject({ valid: false, reason: expect.stringContaining("上一增量") });
    expect(validateMissionPlanAssurance(baseline, valid, currentPlan)).toEqual({ valid: true });
  });

  it("rejects a Plan whose verification covers Mission criteria but whose execution work does not own them", () => {
    const baseline = {
      baselineId: "baseline-a",
      version: 1,
      objective: "deliver the agreed product",
      criteria: [
        baselineCriterion("criterion-a", "artifact runs"),
        baselineCriterion("criterion-b", "behavior matches"),
      ],
      constraints: [], assumptions: [], exclusions: [],
      establishedByTicketId: "ticket-intake" as TicketId,
      establishedAt: NOW,
    };
    const currentPlan: SharedPlanContext = {
      planId: "plan-a",
      version: 1,
      missionBaseline: baseline,
      tickets: [],
      dependencyEdges: [],
      requiredTerminalTicketIds: [],
      teamMembers: [],
    };
    const change = {
      additions: [
        {
          ...draft("narrow-work"),
          missionContribution: { missionCriterionIds: ["criterion-a"] },
        },
        {
          ...draft("assurance", "mission-assurance-v1"),
          assurance: { missionCriterionIds: ["criterion-a", "criterion-b"] },
        },
        {
          ...draft("acceptance"),
          permissions: { settleMission: true },
        },
      ],
      dependencyAdditions: [
        { from: { clientRef: "narrow-work" }, to: { clientRef: "assurance" } },
        { from: { clientRef: "assurance" }, to: { clientRef: "acceptance" } },
      ],
      cancelTicketIds: [],
      requiredTerminalRefs: [{ clientRef: "acceptance" }],
    };

    expect(validateMissionPlanAssurance(baseline, change, currentPlan))
      .toMatchObject({ valid: false, reason: expect.stringContaining("criterion-b") });
  });

  it("reports every Mission criterion missing upstream execution in one validation result", () => {
    const baseline = {
      baselineId: "baseline-a",
      version: 1,
      objective: "deliver the agreed product",
      criteria: [
        baselineCriterion("criterion-a", "artifact runs"),
        baselineCriterion("criterion-b", "behavior matches"),
      ],
      constraints: [], assumptions: [], exclusions: [],
      establishedByTicketId: "ticket-intake" as TicketId,
      establishedAt: NOW,
    };
    const currentPlan: SharedPlanContext = {
      planId: "plan-a",
      version: 1,
      missionBaseline: baseline,
      tickets: [],
      dependencyEdges: [],
      requiredTerminalTicketIds: [],
      teamMembers: [],
    };
    const change = {
      additions: [
        {
          ...draft("assurance", "mission-assurance-v1"),
          assurance: { missionCriterionIds: ["criterion-a", "criterion-b"] },
        },
        {
          ...draft("acceptance"),
          permissions: { settleMission: true },
        },
      ],
      dependencyAdditions: [
        { from: { clientRef: "assurance" }, to: { clientRef: "acceptance" } },
      ],
      cancelTicketIds: [],
      requiredTerminalRefs: [{ clientRef: "acceptance" }],
    };

    const result = validateMissionPlanAssurance(baseline, change, currentPlan);

    expect(result).toMatchObject({ valid: false });
    if (result.valid) throw new Error("expected invalid Mission Plan assurance");
    expect(result.reason).toContain("criterion-a");
    expect(result.reason).toContain("criterion-b");
  });

  it("does not let a planning Goal recursively request another Plan amendment", () => {
    expect(validateMissionTicketOutcome("plan-intent-v1", "completed", {
      disposition: "plan_change_required",
      reason: "再次修订",
    })).toMatchObject({
      valid: false,
      reason: expect.stringContaining("plan-intent-v1"),
    });
    expect(missionOutcomeInstruction("plan-intent-v1")).toContain("TodoList");
  });

  it("maps an explicit correction disposition without role or keyword inference", () => {
    const targetTicketId = "c7504f17-71d1-45f8-8e31-31a8ee99c89c" as TicketId;
    const outcome = { disposition: "correction_required", targetTicketId, reason: "碰撞测试失败" };
    expect(validateMissionTicketOutcome("result-v1", "completed", outcome)).toEqual({ valid: true });
    expect(proposalToTicketCommand(proposal("completed", outcome), link, NOW).payload).toEqual({
      type: "request_correction",
      targetTicketId,
      reason: "碰撞测试失败",
      evidence: [],
      handoff: {
        schemaVersion: 1,
        summary: "summary",
        output: outcome,
        evidence: [],
        criterionResults: [{ criterionIndex: 0, status: "satisfied", evidence: [] }],
        residualRisks: [],
      },
    });
  });

  it("requires Mission assurance corrections to identify the criteria owned by the target work", () => {
    const targetTicketId = "c7504f17-71d1-45f8-8e31-31a8ee99c89c" as TicketId;
    expect(validateMissionTicketOutcome("mission-assurance-v1", "completed", {
      disposition: "correction_required",
      targetTicketId,
      reason: "behavior does not match",
    })).toMatchObject({ valid: false, reason: expect.stringContaining("correctionMissionCriterionIds") });
    expect(validateMissionTicketOutcome("mission-assurance-v1", "completed", {
      disposition: "correction_required",
      targetTicketId,
      reason: "behavior does not match",
      correctionMissionCriterionIds: ["criterion-b"],
      findings: [{
        summary: "behavior mismatch",
        details: "observed behavior differs from the baseline",
        evidence: [{ evidenceId: "ev-b" }],
        affectedMissionCriterionIds: ["criterion-b"],
      }],
      assuranceReport: {},
    })).toEqual({ valid: true });

    const assuranceTicket = {
      ticketId: "assurance" as TicketId,
      title: "assurance",
      objective: "verify",
      successCriteria: ["verified"],
      outputContract: { schemaRef: "mission-assurance-v1" },
      assurance: { missionCriterionIds: ["criterion-a", "criterion-b"] },
    };
    expect(validateMissionCorrectionOwnership(assuranceTicket, {
      disposition: "correction_required",
      targetTicketId,
      reason: "behavior does not match",
      correctionMissionCriterionIds: ["criterion-b"],
      assuranceReport: {
        baselineVersion: 1,
        missionCriterionResults: [
          { criterionId: "criterion-a", status: "satisfied", evidence: [] },
          { criterionId: "criterion-b", status: "not_satisfied", evidence: [] },
        ],
      },
    }, [{ ticketId: targetTicketId, title: "behavior work", missionCriterionIds: ["criterion-b"] }]))
      .toEqual({ valid: true });
    expect(validateMissionCorrectionOwnership(assuranceTicket, {
      disposition: "correction_required",
      targetTicketId,
      reason: "behavior does not match",
      correctionMissionCriterionIds: ["criterion-b"],
    }, [{ ticketId: targetTicketId, title: "narrow work", missionCriterionIds: ["criterion-a"] }]))
      .toMatchObject({ valid: false, reason: expect.stringContaining("plan_change_required") });
  });

  it("allows assurance work to report a target-owned criterion outside its assigned verification slice", () => {
    const targetTicketId = "c7504f17-71d1-45f8-8e31-31a8ee99c89c" as TicketId;
    const assuranceTicket = {
      ticketId: "audio-assurance" as TicketId,
      title: "audio assurance",
      objective: "verify audio",
      successCriteria: ["verified"],
      outputContract: { schemaRef: "mission-assurance-v1" },
      assurance: { missionCriterionIds: ["criterion-audio"] },
    };

    expect(validateMissionCorrectionOwnership(assuranceTicket, {
      disposition: "correction_required",
      targetTicketId,
      reason: "startup failed during audio verification",
      correctionMissionCriterionIds: ["criterion-lifecycle"],
    }, [{
      ticketId: targetTicketId,
      title: "core implementation",
      missionCriterionIds: ["criterion-lifecycle"],
    }])).toEqual({ valid: true });
  });

  it("rejects a settlement correction aimed at assurance work before Ticket state is mutated", () => {
    const assuranceTicketId = "c7504f17-71d1-45f8-8e31-31a8ee99c89c" as TicketId;
    const settlementTicket = {
      ticketId: "settlement" as TicketId,
      title: "settlement",
      objective: "decide final acceptance",
      successCriteria: ["decision is traceable"],
      outputContract: { schemaRef: "mission-settlement-v1" },
      permissions: { settleMission: true },
    };

    expect(validateMissionCorrectionOwnership(settlementTicket, {
      disposition: "correction_required",
      targetTicketId: assuranceTicketId,
      reason: "assurance evidence is incomplete",
      correctionMissionCriterionIds: ["criterion-delivery"],
    }, [])).toMatchObject({
      valid: false,
      reason: expect.stringContaining("assurance 或 settlement Ticket"),
    });
  });

  it("maps Plan change separately from ordinary correction", () => {
    const outcome = { disposition: "plan_change_required", reason: "成功标准相互冲突" };
    expect(proposalToTicketCommand(proposal("completed", outcome), link, NOW).payload).toEqual({
      type: "request_plan_change",
      reason: "成功标准相互冲突",
      evidence: [],
    });
  });

  it("rejects malformed structured dispositions instead of guessing from prose", () => {
    expect(validateMissionTicketOutcome("result-v1", "completed", { disposition: "correction_required", reason: "缺少目标" })).toMatchObject({ valid: false });
    expect(validateMissionTicketOutcome("result-v1", "completed", { disposition: "plan_change_required" })).toMatchObject({ valid: false });
  });

  it.each([
    [{ accepted: false, commandId: "c", proposalId: "p", code: "stale_authority", reason: "stale" }, "stale_claim"],
    [{ accepted: false, commandId: "c", proposalId: "p", code: "plan_terminal", reason: "done" }, "plan_terminal"],
    [{ accepted: false, commandId: "c", proposalId: "p", code: "invalid_command", reason: "fix" }, "correctable"],
  ] as Array<[TicketCommandResult, string]>)("maps Ticket rejection to Goal decision", (result, disposition) => {
    expect(ticketResultToGoalDecision(proposal("completed", { ok: true }), result)).toMatchObject({ accepted: false, disposition });
  });

  it.each([
    [{ accepted: false, commandId: "c", code: "invalid_command", reason: "unknown Ticket" }, "correctable"],
    [{ accepted: false, commandId: "c", code: "invalid_definition", reason: "invalid graph" }, "correctable"],
    [{ accepted: false, commandId: "c", code: "version_conflict", reason: "stale graph" }, "correctable"],
    [{ accepted: false, commandId: "c", code: "plan_terminal", reason: "done" }, "plan_terminal"],
    [{ accepted: false, commandId: "c", code: "policy_violation", reason: "denied" }, "host_error"],
  ] as Array<[PlanCommandResult, string]>)("maps Plan rejection to Goal decision", (result, disposition) => {
    expect(planResultToGoalDecision(result)).toMatchObject({ accepted: false, disposition });
  });
});

const NOW = "2026-07-14T00:00:00.000Z";
const TEST_INCREMENT = { incrementId: "increment-1", sequence: 1, title: "可验证交付", objective: "形成可运行且可验收的结果" };
function baselineCriterion(criterionId: string, text: string) {
  return {
    criterionId,
    text,
    verification: {
      anchors: [{ observableOutcome: text, evidenceRequirements: ["可追溯工具证据"] }],
    },
  };
}
function anchorResult(evidenceId: string) {
  return {
    anchorIndex: 0,
    status: "satisfied" as const,
    evidence: [{ evidenceId }],
    verificationBasis: { summary: "按验收锚点与可追溯证据判断", evidence: [{ evidenceId }] },
    observations: ["工具观察结果与验收锚点一致"],
    deviations: [],
  };
}
function draft(clientRef: string, schemaRef = "result-v1", requiredCapabilities: string[] = []) {
  return {
    clientRef,
    title: clientRef,
    objective: `完成 ${clientRef}`,
    successCriteria: ["完成"],
    assignment: { requiredCapabilities },
    outputContract: { schemaRef },
    deliveryIncrement: TEST_INCREMENT,
  };
}
function proposal(status: "completed" | "blocked" | "failed", domainOutcome: MissionTicketOutcome, humanInputRequest?: GoalResolutionProposal["humanInputRequest"]): GoalResolutionProposal<any, MissionTicketOutcome> { return { proposalId: "proposal", goalId: "goal", expectedGoalVersion: 1, resolvingGoalVersion: 2, status, summary: "summary", evidence: [], criterionResults: status === "completed" ? [{ criterionIndex: 0, status: "satisfied", evidence: [] }] : [], residualRisks: [], domainOutcome, ...(humanInputRequest ? { humanInputRequest } : {}), createdAt: NOW }; }
const link: ActiveMissionLink = { dispatchId: "dispatch", missionId: "mission", planId: "ca24185e-4957-4bb2-973f-ea4d89382557" as PlanId, ticketId: "40614afd-9312-4f9b-97fe-d14e18fe4201" as TicketId, ticketVersion: 2, agentId: "pm", agentPrincipalId: "planner", claimRequestId: "claim", goalStartKey: "start", updatedAt: NOW, status: "resolving", authority: { kind: "claim", claimId: "claim", fencingToken: 1 }, agentThreadId: "thread", agentGoalId: "goal" };
