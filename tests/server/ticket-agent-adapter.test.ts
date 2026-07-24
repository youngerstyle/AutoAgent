import { describe, expect, it } from "vitest";
import type { GoalResolutionProposal } from "../../src/shared/contracts/agent-engine.js";
import type { ActiveMissionLink } from "../../src/shared/contracts/mission-control.js";
import type { PlanCommandResult, PlanId, TicketCommandResult, TicketId } from "../../src/shared/contracts/ticket-engine.js";
import { missionOutcomeInstruction, planResultToGoalDecision, proposalToPlanChangeCommand, proposalToTicketCommand, ticketResultToGoalDecision, validateMissionAssuranceReport, validateMissionCorrectionOwnership, validateMissionPlanAssurance, validateMissionSettlement, validateMissionTicketOutcome, type MissionTicketOutcome, type SharedPlanContext } from "../../src/server/mission-process/ticket-agent-adapter.js";

describe("Ticket Agent resolution adapter", () => {
  it("keeps PM domain output separate from Plan and Ticket commands", () => {
    const outcome = { result: { plan: "dev then qa" }, change: { additions: [draft("dev")], dependencyAdditions: [], cancelTicketIds: [], requiredTerminalRefs: [{ clientRef: "dev" }] } };
    const planCommand = proposalToPlanChangeCommand(proposal("completed", outcome), link, 4, NOW);
    const ticketCommand = proposalToTicketCommand(proposal("completed", outcome), link, NOW);
    expect(planCommand?.payload).toMatchObject({ type: "apply_change", change: outcome.change });
    expect(ticketCommand.payload.type).toBe("complete");
  });

  it("uses the aggregate version in command identity so an optimistic conflict can be retried", () => {
    const outcome = { result: {}, change: { additions: [draft("dev")], dependencyAdditions: [], cancelTicketIds: [], requiredTerminalRefs: [{ clientRef: "dev" }] } };
    const proposalValue = proposal("completed", outcome);
    expect(proposalToPlanChangeCommand(proposalValue, link, 4, NOW)?.commandId)
      .not.toBe(proposalToPlanChangeCommand(proposalValue, link, 5, NOW)?.commandId);
    expect(proposalToTicketCommand(proposalValue, link, NOW).commandId)
      .not.toBe(proposalToTicketCommand(proposalValue, { ...link, ticketVersion: link.ticketVersion + 1 }, NOW).commandId);
  });

  it("uses the delivery strategy as the single source of increment metadata", () => {
    const outcome = {
      result: planResult(),
      change: {
        additions: [{
          ...draft("dev"),
          deliveryIncrement: {
            incrementId: TEST_INCREMENT.incrementId,
            sequence: 99,
            title: "duplicated stale title",
            objective: "duplicated stale objective",
          },
        }],
        dependencyAdditions: [],
        cancelTicketIds: [],
        requiredTerminalRefs: [{ clientRef: "dev" }],
      },
    };

    expect(validateMissionTicketOutcome("plan-change-set-v3", "completed", outcome)).toEqual({ valid: true });
    const command = proposalToPlanChangeCommand(proposal("completed", outcome), link, 4, NOW);
    expect(command?.payload).toMatchObject({
      type: "apply_change",
      change: {
        additions: [{
          deliveryIncrement: TEST_INCREMENT,
        }],
      },
    });
  });

  it("never exposes internal command names to the Agent", () => {
    const targetTicketId = "c7504f17-71d1-45f8-8e31-31a8ee99c89c" as TicketId;
    const sourceTicketId = "ce699a21-cdbc-4612-91f9-b607970668a6" as TicketId;
    const instruction = missionOutcomeInstruction("plan-change-set-v3", ["implementation", "quality:verify"], [{ ticketId: targetTicketId, title: "开发" }], sourceTicketId);
    expect(instruction).toContain("plan-change-set-v3");
    expect(instruction).toContain("goal_resolution");
    expect(instruction).toContain("唯一提交入口");
    expect(instruction).not.toContain("goalResolution");
    expect(instruction).toContain(targetTicketId);
    expect(instruction).toContain(sourceTicketId);
    expect(instruction).toContain("新增执行链必须位于当前规划工单");
    expect(instruction).toContain("开发");
    expect(instruction).not.toContain("apply_change");
    expect(instruction).not.toContain("return_to_parent");
  });

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

    expect(instruction).toContain("当前启用的工具或运行环境无法完成不可替代的验证");
    expect(instruction).toContain('request_human_input(kind="manual_test")');
    expect(instruction).toContain("不得使用 correction_required");
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
        teamMembers: [{ principalId: "principal:qa", name: "测试", capabilities: ["delivery:verify"] }],
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
            occurredAt: NOW,
          }],
        },
      },
    );

    expect(instruction).toContain('"reworkRequests"');
    expect(instruction).toContain(sourceTicketId);
    expect(instruction).toContain("player starts inside a wall");
  });

  it("treats a correctable Host rejection as a proposal retry rather than Goal failure", () => {
    const instruction = missionOutcomeInstruction("delivery-v1");

    expect(instruction).toContain("Host 返回 correctable 只表示当前提案需要修正并重新提交");
    expect(instruction).toContain("不得仅因提案结构或契约校验被退回就改成 failed");
  });

  it("describes the complete Plan change contract to the planning Agent", () => {
    const instruction = missionOutcomeInstruction("plan-change-set-v3", ["delivery:implement"], [], undefined, {
      planId: "plan-a",
      version: 3,
      tickets: [
        { ticketId: "ticket-intake", status: "completed", title: "需求接收", objective: "确认目标", successCriteria: ["形成共识"], outputContract: { schemaRef: "brief-v1" } },
        {
          ticketId: "ticket-implementation",
          status: "completed",
          title: "实现",
          objective: "实现基线",
          successCriteria: ["形成可运行交付"],
          outputContract: { schemaRef: "delivery-v1" },
          deliveryIncrement: {
            incrementId: "baseline",
            sequence: 1,
            title: "可运行基线",
            objective: "形成可运行基线并完成独立验证",
          },
        },
      ],
      dependencyEdges: [],
      requiredTerminalTicketIds: ["ticket-planning"],
      requiredTerminalCapabilities: ["delivery:accept"],
      teamMembers: [{ principalId: "principal:dev", name: "开发", capabilities: ["delivery:implement"] }],
    });

    expect(instruction).toContain('"clientRef"');
    expect(instruction).toContain('"objective"');
    expect(instruction).toContain('"assignment":{"requiredCapabilities"');
    expect(instruction).toContain('"outputContract":{"schemaRef"');
    expect(instruction).toContain('"outputContract":{"schemaRef":"由验收工作决定的输出契约"},"permissions":{"settleMission":true}');
    expect(instruction).toContain("permissions 是 additions[] 节点自身的字段，与 assignment 和 outputContract 同级，不能放进 assignment");
    expect(instruction).toContain('{"clientRef":"work"}');
    expect(instruction).toContain('{"ticketId":"');
    expect(instruction).toContain('"ticketId":"ticket-intake"');
    expect(instruction).toContain('"status":"completed"');
    expect(instruction).toContain('"principalId":"principal:dev"');
    expect(instruction).toContain("同一个 assignment 必须能由一名成员完整满足");
    expect(instruction).toContain("delivery:accept");
    expect(instruction).toContain("独立质量检查不能代替最终交付验收");
    expect(instruction).toContain("无需读取工作区文件来猜测 Plan 或 Ticket 状态");
    expect(instruction).toContain("不规定角色名称、工单数量、能力名称、增量名称或业务内容");
    expect(instruction).toContain('"incrementId":"baseline"');
    expect(instruction).toContain("incrementId 是 Plan 内稳定身份");
    expect(instruction).toContain("若复用已有 incrementId");
    expect(instruction).toContain("当前 Plan 中尚未出现的新 incrementId");
    expect(instruction).not.toContain('"incrementId":"increment-1"');
    expect(instruction).toContain('"requiredTerminalRefs":[{"clientRef":"terminal"}]');
  });

  it("validates Plan change shape before invoking Ticket Engine", () => {
    expect(validateMissionTicketOutcome("plan-change-set-v3", "completed", { result: {} })).toMatchObject({ valid: false });
    expect(validateMissionTicketOutcome("plan-change-set-v3", "completed", {
      result: planResult(),
      change: deliveryClosure(),
    })).toEqual({ valid: true });
    expect(validateMissionTicketOutcome("plan-change-set-v3", "completed", {
      result: { summary: "缺少交付策略" },
      change: deliveryClosure(),
    })).toMatchObject({ valid: false, reason: expect.stringContaining("deliveryStrategy") });
    expect(validateMissionTicketOutcome("plan-change-set-v3", "completed", {
      result: {
        deliveryStrategy: {
          mode: "multi_increment",
          rationale: "范围较大，需要逐步交付",
          increments: [TEST_INCREMENT],
        },
      },
      change: deliveryClosure(),
    })).toMatchObject({ valid: false, reason: expect.stringContaining("至少两个增量") });
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

  it("keeps intake Ticket completion separate from final Mission acceptance", () => {
    const instruction = missionOutcomeInstruction("mission-baseline-v1");

    expect(instruction).toContain("当前需求接收 Ticket 的流程标准");
    expect(instruction).toContain("最终交付给 human 的产品或业务结果");
    expect(instruction).toContain("严禁");
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
        criterionResults: [
          { criterionId: "criterion-a", status: "satisfied", evidence: [{ evidenceId: "ev-browser-a" }], anchorResults: [anchorResult("ev-browser-a")] },
          { criterionId: "criterion-b", status: "satisfied", evidence: [{ evidenceId: "ev-browser-b" }], anchorResults: [anchorResult("ev-browser-b")] },
        ],
      },
    };

    expect(validateMissionAssuranceReport(baseline, ["criterion-a", "criterion-b"], report)).toEqual({ valid: true });
    expect(validateMissionAssuranceReport(baseline, ["criterion-a", "criterion-b"], {
      assuranceReport: {
        ...report.assuranceReport,
        criterionResults: [
          report.assuranceReport.criterionResults[0],
          { criterionId: "criterion-b", status: "not_verified", evidence: [], anchorResults: [] },
        ],
      },
    })).toMatchObject({ valid: false, reason: expect.stringContaining("not_verified") });
    expect(validateMissionAssuranceReport(baseline, ["criterion-a", "criterion-b"], {
      assuranceReport: {
        ...report.assuranceReport,
        criterionResults: report.assuranceReport.criterionResults.map((item) => ({
          ...item,
          anchorResults: [],
        })),
      },
    })).toMatchObject({ valid: false, reason: expect.stringContaining("anchorResults") });
  });

  it("describes the exact mission assurance result shape", () => {
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

    expect(instruction).toContain("domainOutcome.assuranceReport");
    expect(instruction).toContain("baselineVersion:3");
    expect(instruction).toContain('criterionId:"<Mission criterionId>"');
    expect(instruction).toContain('["criterion-a"]');
    expect(instruction).toContain("goal_resolution 顶层 criterionResults");
    expect(instruction).toContain("criterionIndex");
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

  it("does not impose fixed role names or output schemas on a structurally valid Plan", () => {
    expect(validateMissionTicketOutcome("plan-change-set-v3", "completed", {
      result: planResult(),
      change: {
        additions: [
          draft("dev", "delivery-v1", ["delivery:implement"]),
          draft("qa", "qa-report-v1", ["delivery:verify"]),
        ],
        dependencyAdditions: [{ from: { clientRef: "dev" }, to: { clientRef: "qa" } }],
        cancelTicketIds: [],
        requiredTerminalRefs: [{ clientRef: "qa" }],
      },
    })).toEqual({ valid: true });
  });

  it("returns the exact malformed Plan change field to the planning Agent", () => {
    const malformed = {
      clientRef: "dev",
      title: "开发",
      requiredCapabilities: ["delivery:implement"],
      successCriteria: ["完成"],
      outputContract: "实现结果",
    };

    expect(validateMissionTicketOutcome("plan-change-set-v3", "completed", {
      result: {},
      change: { additions: [malformed], dependencyAdditions: [], cancelTicketIds: [], requiredTerminalRefs: [] },
    })).toEqual({ valid: false, reason: "change.additions[0].objective 必须是非空字符串" });
  });

  it("does not let a Plan amendment recursively request another Plan amendment", () => {
    expect(validateMissionTicketOutcome("plan-change-set-v3", "completed", {
      disposition: "plan_change_required",
      reason: "再次修订",
    })).toEqual({
      valid: false,
      reason: "计划修订工单不能再次请求计划修订；缺少输入时应 blocked，能够规划时应提交 change",
    });
    expect(missionOutcomeInstruction("plan-change-set-v3")).toContain("不能再次请求计划修订");
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
        criterionResults: [
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
  return { anchorIndex: 0, status: "satisfied" as const, evidence: [{ evidenceId }] };
}
function planResult() {
  return {
    deliveryStrategy: {
      mode: "single_increment",
      rationale: "测试使用单个可验证增量",
      increments: [TEST_INCREMENT],
    },
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
function deliveryClosure() {
  return {
    additions: [
      draft("dev", "delivery-v1", ["delivery:implement"]),
      draft("qa", "qa-report-v1", ["delivery:verify"]),
      { ...draft("acceptance", "acceptance-v1", ["delivery:accept"]), permissions: { settleMission: true } },
    ],
    dependencyAdditions: [
      { from: { clientRef: "dev" }, to: { clientRef: "qa" } },
      { from: { clientRef: "qa" }, to: { clientRef: "acceptance" } },
    ],
    cancelTicketIds: [],
    requiredTerminalRefs: [{ clientRef: "acceptance" }],
  };
}
function proposal(status: "completed" | "blocked" | "failed", domainOutcome: MissionTicketOutcome, humanInputRequest?: GoalResolutionProposal["humanInputRequest"]): GoalResolutionProposal<any, MissionTicketOutcome> { return { proposalId: "proposal", goalId: "goal", expectedGoalVersion: 1, resolvingGoalVersion: 2, status, summary: "summary", evidence: [], criterionResults: status === "completed" ? [{ criterionIndex: 0, status: "satisfied", evidence: [] }] : [], residualRisks: [], domainOutcome, ...(humanInputRequest ? { humanInputRequest } : {}), createdAt: NOW }; }
const link: ActiveMissionLink = { dispatchId: "dispatch", missionId: "mission", planId: "ca24185e-4957-4bb2-973f-ea4d89382557" as PlanId, ticketId: "40614afd-9312-4f9b-97fe-d14e18fe4201" as TicketId, ticketVersion: 2, agentId: "pm", agentPrincipalId: "planner", claimRequestId: "claim", goalStartKey: "start", updatedAt: NOW, status: "resolving", authority: { kind: "claim", claimId: "claim", fencingToken: 1 }, agentThreadId: "thread", agentGoalId: "goal" };
