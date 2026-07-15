import { describe, expect, it } from "vitest";
import type { GoalResolutionProposal } from "../../src/shared/contracts/agent-engine.js";
import type { ActiveMissionLink } from "../../src/shared/contracts/mission-control.js";
import type { PlanId, TicketCommandResult, TicketId } from "../../src/shared/contracts/ticket-engine.js";
import { missionOutcomeInstruction, proposalToPlanChangeCommand, proposalToTicketCommand, ticketResultToGoalDecision, validateMissionTicketOutcome, type MissionTicketOutcome } from "../../src/server/mission-process/ticket-agent-adapter.js";

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

  it("never exposes internal command names to the Agent", () => {
    const targetTicketId = "c7504f17-71d1-45f8-8e31-31a8ee99c89c" as TicketId;
    const sourceTicketId = "ce699a21-cdbc-4612-91f9-b607970668a6" as TicketId;
    const instruction = missionOutcomeInstruction("plan-change-set-v3", ["implementation", "quality:verify"], [{ ticketId: targetTicketId, title: "开发" }], sourceTicketId);
    expect(instruction).toContain("plan-change-set-v3");
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
    expect(instruction).toContain("不可替代的外部事实、凭证、授权或不可逆操作确认");
  });

  it("renders mission, current Ticket, and upstream handoffs without sharing Agent history", () => {
    const instruction = missionOutcomeInstruction(
      "qa-report-v1",
      [],
      [],
      undefined,
      undefined,
      [{
        ticketId: "c7504f17-71d1-45f8-8e31-31a8ee99c89c" as TicketId,
        title: "开发实现",
        objective: "实现可运行游戏",
        outputContract: { schemaRef: "delivery-v1" },
        handoff: {
          schemaVersion: 1,
          summary: "实现了核心玩法",
          output: { artifact: "src/game.ts" },
          evidence: [{ kind: "file", ref: "src/game.ts" }],
        },
      }],
      {
        missionObjective: "交付可玩的坦克游戏",
        ticket: {
          ticketId: "40614afd-9312-4f9b-97fe-d14e18fe4201" as TicketId,
          title: "质量检查",
          objective: "验证核心玩法",
          successCriteria: ["形成可复现结论"],
          outputContract: { schemaRef: "qa-report-v1" },
        },
      },
    );

    expect(instruction).toContain('"missionObjective":"交付可玩的坦克游戏"');
    expect(instruction).toContain('"summary":"实现了核心玩法"');
    expect(instruction).toContain('"artifact":"src/game.ts"');
    expect(instruction).not.toContain("tool_call");
    expect(instruction).not.toContain("Thread");
  });

  it("treats a correctable Host rejection as a proposal retry rather than Goal failure", () => {
    const instruction = missionOutcomeInstruction("delivery-v1");

    expect(instruction).toContain("Host 返回 correctable 只表示当前提案需要修正并重新提交");
    expect(instruction).toContain("不得仅因提案结构或契约校验被退回就改成 failed 或 blocked");
  });

  it("describes the complete Plan change contract to the planning Agent", () => {
    const instruction = missionOutcomeInstruction("plan-change-set-v3", ["delivery:implement"], [], undefined, {
      planId: "plan-a",
      version: 3,
      tickets: [{ ticketId: "ticket-intake", status: "completed", title: "需求接收", objective: "确认目标" }],
      dependencyEdges: [],
      requiredTerminalTicketIds: ["ticket-planning"],
      teamMembers: [{ principalId: "principal:dev", name: "开发", capabilities: ["delivery:implement"] }],
    });

    expect(instruction).toContain('"clientRef"');
    expect(instruction).toContain('"objective"');
    expect(instruction).toContain('"assignment":{"requiredCapabilities"');
    expect(instruction).toContain('"outputContract":{"schemaRef"');
    expect(instruction).toContain('{"clientRef":"dev"}');
    expect(instruction).toContain('{"ticketId":"');
    expect(instruction).toContain('"ticketId":"ticket-intake"');
    expect(instruction).toContain('"status":"completed"');
    expect(instruction).toContain('"principalId":"principal:dev"');
    expect(instruction).toContain("同一个 assignment 必须能由一名成员完整满足");
    expect(instruction).toContain("无需读取工作区文件来猜测 Plan 或 Ticket 状态");
    expect(instruction).toContain('"schemaRef":"qa-report-v1"');
    expect(instruction).toContain('"schemaRef":"acceptance-v1"');
    expect(instruction).toContain('"requiredTerminalRefs":[{"clientRef":"acceptance"}]');
  });

  it("validates Plan change shape before invoking Ticket Engine", () => {
    expect(validateMissionTicketOutcome("plan-change-set-v3", "completed", { result: {} })).toMatchObject({ valid: false });
    expect(validateMissionTicketOutcome("plan-change-set-v3", "completed", {
      result: {},
      change: deliveryClosure(),
    })).toEqual({ valid: true });
  });

  it("rejects a structurally valid Plan that stops at QA without final acceptance", () => {
    expect(validateMissionTicketOutcome("plan-change-set-v3", "completed", {
      result: {},
      change: {
        additions: [
          draft("dev", "delivery-v1", ["delivery:implement"]),
          draft("qa", "qa-report-v1", ["delivery:verify"]),
        ],
        dependencyAdditions: [{ from: { clientRef: "dev" }, to: { clientRef: "qa" } }],
        cancelTicketIds: [],
        requiredTerminalRefs: [{ clientRef: "qa" }],
      },
    })).toEqual({
      valid: false,
      reason: "新增交付链必须包含 acceptance-v1 最终验收工单，并把该工单设为 requiredTerminalRefs 终点",
    });
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
});

const NOW = "2026-07-14T00:00:00.000Z";
function draft(clientRef: string, schemaRef = "result-v1", requiredCapabilities: string[] = []) { return { clientRef, title: clientRef, objective: `完成 ${clientRef}`, successCriteria: ["完成"], assignment: { requiredCapabilities }, outputContract: { schemaRef } }; }
function deliveryClosure() {
  return {
    additions: [
      draft("dev", "delivery-v1", ["delivery:implement"]),
      draft("qa", "qa-report-v1", ["delivery:verify"]),
      draft("acceptance", "acceptance-v1", ["delivery:accept"]),
    ],
    dependencyAdditions: [
      { from: { clientRef: "dev" }, to: { clientRef: "qa" } },
      { from: { clientRef: "qa" }, to: { clientRef: "acceptance" } },
    ],
    cancelTicketIds: [],
    requiredTerminalRefs: [{ clientRef: "acceptance" }],
  };
}
function proposal(status: "completed" | "blocked" | "failed", domainOutcome: MissionTicketOutcome): GoalResolutionProposal<any, MissionTicketOutcome> { return { proposalId: "proposal", goalId: "goal", expectedGoalVersion: 1, resolvingGoalVersion: 2, status, summary: "summary", evidence: [], domainOutcome, createdAt: NOW }; }
const link: ActiveMissionLink = { dispatchId: "dispatch", missionId: "mission", planId: "ca24185e-4957-4bb2-973f-ea4d89382557" as PlanId, ticketId: "40614afd-9312-4f9b-97fe-d14e18fe4201" as TicketId, ticketVersion: 2, agentId: "pm", agentPrincipalId: "planner", claimRequestId: "claim", goalStartKey: "start", updatedAt: NOW, status: "resolving", authority: { kind: "claim", claimId: "claim", fencingToken: 1 }, agentThreadId: "thread", agentGoalId: "goal" };
