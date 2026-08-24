import { describe, expect, it } from "vitest";
import { buildTicketInspectorItems } from "../../src/client/ticket-inspector";
import type { Ticket } from "../../src/shared/types";

describe("ticket inspector", () => {
  it("keeps current project tickets readable while preserving raw ticket JSON", () => {
    const items = buildTicketInspectorItems([
      ticket({
        id: "tk_pm",
        type: "pm_plan",
        status: "completed",
        targetRole: "pm",
        brief: "把目标拆成小规模执行计划",
        expectedArtifact: "执行计划",
        result: {
          plan: [
            { id: 1, name: "设计关卡数据结构" },
            { id: 2, name: "实现关卡切换" }
          ]
        }
      }),
      ticket({
        id: "tk_dev",
        type: "implementation",
        status: "running",
        targetRole: "dev",
        targetAgentName: "开发二组",
        workstream: "frontend",
        brief: "按计划开发并产出交付物",
        expectedArtifact: "可运行变更",
        attempt: 2,
        execution: {
          attemptId: "12345678-abcd-4abc-8abc-123456789012",
          workspaceMode: "git_worktree",
          workspaceBranch: "autoagent/attempt/12345678-abcd-4abc-8abc-123456789012",
          workspaceStatus: "isolated_active"
        }
      })
    ]);

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      id: "tk_pm",
      title: "产品/项目：计划拆解",
      statusLabel: "已完成",
      brief: "把目标拆成小规模执行计划",
      expectedArtifact: "执行计划",
      resultSummary: "拆出 2 个子任务"
    });
    expect(items[0].resultLines).toEqual(["设计关卡数据结构", "实现关卡切换"]);
    expect(JSON.parse(items[0].rawJson)).toMatchObject({ id: "tk_pm", type: "pm_plan" });

    expect(items[1]).toMatchObject({
      title: "开发二组：开发执行",
      statusLabel: "运行中",
      resultSummary: undefined
    });
    expect(items[1].executionLines).toEqual([
      "固定成员：开发二组（开发）",
      "工作流：frontend",
      "Attempt 2 · 12345678",
      "隔离执行中，可在重启后继续"
    ]);
  });

  it("keeps blocker details as a readable summary without duplicating raw JSON in the card body", () => {
    const items = buildTicketInspectorItems([
      ticket({
        id: "tk_qa",
        type: "qa",
        status: "blocked",
        targetRole: "qa",
        brief: "验证实现并给出通过或失败结论",
        expectedArtifact: "测试报告",
        blocker: {
          type: "manual_test_required",
          reason: JSON.stringify({
            status: "manual_test_required",
            report: { summary: "需要人工浏览器测试", required_manual_tests: "打开 index.html" },
            tools_used: ["readFile"]
          })
        }
      })
    ]);

    expect(items[0]).toMatchObject({
      resultSummary: "需要人工浏览器测试",
      resultLines: ["打开 index.html"]
    });
    expect(items[0].rawJson).toContain("manual_test_required");
  });

  it("shows parent and dependency relationships in readable ticket cards", () => {
    const items = buildTicketInspectorItems([
      ticket({
        id: "tk_pm",
        type: "pm_plan",
        status: "completed",
        targetRole: "pm",
        brief: "拆解计划",
        expectedArtifact: "执行工单图"
      }),
      ticket({
        id: "tk_dev",
        type: "implementation",
        status: "pending",
        targetRole: "dev",
        brief: "实现 MVP",
        expectedArtifact: "index.html",
        parentTicketId: "tk_pm",
        createdByTicketId: "tk_pm",
        dependsOnTicketIds: ["tk_pm"]
      }),
      ticket({
        id: "tk_qa",
        type: "qa",
        status: "pending",
        targetRole: "qa",
        brief: "质量检查",
        expectedArtifact: "测试结论",
        parentTicketId: "tk_dev",
        createdByTicketId: "tk_dev",
        dependsOnTicketIds: ["tk_dev"]
      })
    ]);

    expect(items[1].relationLines).toEqual(["上游：产品/项目：计划拆解", "依赖：产品/项目：计划拆解"]);
    expect(items[2].relationLines).toEqual(["上游：开发：开发执行", "依赖：开发：开发执行"]);
  });
});

function ticket(input: Partial<Ticket> & Pick<Ticket, "id" | "type" | "status" | "brief" | "expectedArtifact">): Ticket {
  return {
    workspaceId: "ws_1",
    taskId: "task_1",
    taskRunId: "run_1",
    priority: 0,
    attempt: 1,
    createdAt: "2026-07-03T00:00:00.000Z",
    updatedAt: "2026-07-03T00:00:00.000Z",
    ...input
  };
}
