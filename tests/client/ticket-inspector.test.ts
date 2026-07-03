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
        brief: "按计划开发并产出交付物",
        expectedArtifact: "可运行变更"
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
      title: "开发：开发执行",
      statusLabel: "运行中",
      resultSummary: undefined
    });
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
