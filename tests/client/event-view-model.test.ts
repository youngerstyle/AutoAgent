import { describe, expect, it } from "vitest";
import { buildEventTimelineGroups, buildEventTimelineItem, buildVisibleTimelineEvents } from "../../src/client/event-view-model";
import type { AutoAgentEvent } from "../../src/shared/types";

describe("event view model", () => {
  it("turns provider events into readable timeline entries", () => {
    const item = buildEventTimelineItem(event("provider.started", "开发正在调用模型服务：openai", {
      provider: "openai",
      model: "deepseek-v4-flash"
    }));

    expect(item.actor).toBe("开发");
    expect(item.title).toBe("正在调用模型");
    expect(item.detail).toBe("OpenAI · deepseek-v4-flash");
    expect(item.debugType).toBe("provider.started");
  });

  it("turns context assembly events into readable budget summaries", () => {
    const item = buildEventTimelineItem(event("context.assembled", "老板完成上下文组装", {
      report: {
        originalSessionChars: 12000,
        injectedChars: 1333,
        estimatedTokens: 333,
        sections: [
          { name: "stable_prompt", originalChars: 79, injectedChars: 79, estimatedTokens: 20, truncated: false },
          { name: "dynamic_context", originalChars: 1054, injectedChars: 1054, estimatedTokens: 264, truncated: false }
        ],
        compaction: { compacted: false }
      }
    }));

    expect(item).toMatchObject({
      actor: "老板",
      title: "上下文组装完成",
      detail: "发送 1,333 字，约 333 tokens，原始 session 12,000 字，未压缩"
    });
    expect(item.detail).not.toContain("originalChars");
    expect(item.detail).not.toContain("{");
  });

  it("turns agent step events into actor, action, and detail", () => {
    const item = buildEventTimelineItem(event("agent.step_started", "架构师: 判断架构方案、技术路径和能力缺口", {
      step: "判断架构方案、技术路径和能力缺口"
    }));

    expect(item.actor).toBe("架构师");
    expect(item.title).toBe("开始执行");
    expect(item.detail).toBe("判断架构方案、技术路径和能力缺口");
  });

  it("turns phase, status, and assignment events into human labels", () => {
    expect(buildEventTimelineItem(event("task.phase_changed", "进入阶段：开发执行", { phase: "implementation" }))).toMatchObject({
      actor: "任务阶段",
      title: "进入开发执行"
    });

    expect(buildEventTimelineItem(event("agent.status_changed", "开发正在运行", {}))).toMatchObject({
      actor: "开发",
      title: "运行中"
    });

    expect(buildEventTimelineItem(event("assignment.created", "已创建开发执行任务", {
      assignment: { type: "implementation" }
    }))).toMatchObject({
      actor: "开发",
      title: "已创建开发执行任务",
      detail: "准备进入开发执行"
    });

    expect(buildEventTimelineItem(event("assignment.completed", "开发已完成开发执行", {
      assignment: { type: "implementation" }
    }))).toMatchObject({
      actor: "开发",
      title: "开发执行阶段结束",
      detail: "这只是阶段记录，不代表项目已交付"
    });

    expect(buildEventTimelineItem(event("assignment.yielded", "开发已保存进度，等待继续", {
      assignment: { type: "implementation" },
      observedToolCount: 2
    }))).toMatchObject({
      actor: "开发",
      title: "已保存进度",
      detail: "执行片已保存，稍后继续同一张工单；工具观察 2 次",
      tone: "running"
    });

    expect(buildEventTimelineItem(event("agent.step_started", "Boss: Accept or reject the completed task", {}))).toMatchObject({
      actor: "老板",
      title: "开始执行",
      detail: "验收或驳回已完成任务"
    });

    expect(buildEventTimelineItem(event("run.completed", "任务已完成", {}))).toMatchObject({
      actor: "任务",
      title: "已完成"
    });

    expect(buildEventTimelineItem(event("human.followup", "human 已补充说明", {
      message: "按 Web Canvas 单人 MVP 继续",
      resumePhase: "pm_plan"
    }))).toMatchObject({
      actor: "human",
      title: "补充说明",
      detail: "继续到计划拆解"
    });

    expect(buildEventTimelineItem(event("agent.message_handled", "开发已回复 human 私聊", {
      role: "dev",
      response: "我会继续检查报错。"
    }))).toMatchObject({
      actor: "开发",
      title: "已回复私聊",
      detail: "我会继续检查报错。",
      tone: "success"
    });
  });

  it("hides task-level blocked echo when an assignment already explains the same blocker", () => {
    const assignmentBlocked = event("assignment.blocked", "质量检查受阻：需要人工测试", {
      assignmentId: "as_qa",
      reason: "需要人工测试"
    });
    const runBlocked = event("run.blocked", "任务受阻：质量检查受阻：需要人工测试", {
      phase: "qa",
      reason: "需要人工测试"
    });

    expect(buildVisibleTimelineEvents([runBlocked, assignmentBlocked]).map((item) => item.type)).toEqual([
      "assignment.blocked"
    ]);
  });

  it("keeps task-level blocked events when no assignment blocker exists", () => {
    const runBlocked = event("run.blocked", "任务受阻：需求不清", {
      phase: "boss_intake",
      reason: "需求不清"
    });

    expect(buildVisibleTimelineEvents([runBlocked])).toEqual([runBlocked]);
  });

  it("turns structured manual-test blockers into compact timeline cards", () => {
    const item = buildEventTimelineItem(event("assignment.blocked", `质量检查受阻：需要人工测试：${JSON.stringify({
      status: "manual_test_required",
      report: {
        summary: "多关卡功能已实现，代码层面满足要求。需人工在浏览器中验证实际游戏流程。",
        required_manual_tests: "打开 index.html 执行测试计划。"
      },
      tools_used: ["readFile", "listFiles"]
    })}`, {
      reason: `需要人工测试：${JSON.stringify({
        status: "manual_test_required",
        report: {
          summary: "多关卡功能已实现，代码层面满足要求。需人工在浏览器中验证实际游戏流程。",
          required_manual_tests: "打开 index.html 执行测试计划。"
        },
        tools_used: ["readFile", "listFiles"]
      })}`
    }));

    expect(item).toMatchObject({
      actor: "测试",
      title: "质量检查受阻：需要人工测试",
      detail: "多关卡功能已实现，代码层面满足要求。需人工在浏览器中验证实际游戏流程。"
    });
    expect(item.title).not.toContain("{");
    expect(item.detail).not.toContain("tools_used");
  });

  it("groups consecutive timeline events by actor and phase without reordering", () => {
    const events = [
      event("task.phase_changed", "进入阶段：需求接收", { phase: "boss_intake" }, "ev_1"),
      event("assignment.created", "已创建需求接收任务", { assignment: { type: "boss_intake" } }, "ev_2"),
      event("agent.step_started", "老板: 判断需求是否可执行", { step: "判断需求是否可执行" }, "ev_3"),
      event("provider.started", "老板正在调用模型服务：openai", { provider: "openai", model: "deepseek-v4-flash" }, "ev_4"),
      event("tool.started", "读取文件：index.html", { tool: "readFile", path: "index.html" }, "ev_5"),
      event("tool.completed", "文件读取完成：index.html", { tool: "readFile", path: "index.html" }, "ev_6"),
      event("assignment.completed", "老板已完成需求接收", { assignment: { type: "boss_intake" } }, "ev_7"),
      event("task.phase_changed", "进入阶段：计划拆解", { phase: "pm_plan" }, "ev_8"),
      event("assignment.created", "已创建计划拆解任务", { assignment: { type: "pm_plan" } }, "ev_9")
    ];

    const groups = buildEventTimelineGroups(events);

    expect(groups.map((group) => group.title)).toEqual([
      "老板 · 需求接收",
      "产品/项目 · 计划拆解"
    ]);
    expect(groups[0].events.map((item) => item.id)).toEqual(["ev_1", "ev_2", "ev_3", "ev_4", "ev_5", "ev_6", "ev_7"]);
    expect(groups[0].summary).toContain("模型 1 次");
    expect(groups[0].summary).toContain("工具 2 次");
  });

  it("merges repeated phase change markers for the same actor and phase", () => {
    const events = [
      event("task.phase_changed", "任务继续：计划拆解", { phase: "pm_plan" }, "ev_1"),
      event("task.phase_changed", "进入阶段：计划拆解", { phase: "pm_plan" }, "ev_2"),
      event("assignment.created", "已创建计划拆解任务", { assignment: { type: "pm_plan" } }, "ev_3")
    ];

    const groups = buildEventTimelineGroups(events);

    expect(groups.map((group) => group.title)).toEqual(["产品/项目 · 计划拆解"]);
    expect(groups[0].events.map((item) => item.id)).toEqual(["ev_1", "ev_2", "ev_3"]);
  });

  it("uses the structured agent identity instead of parsing model JSON as an actor", () => {
    const modelEvent = {
      ...event("agent.status_changed", '{"goalResolution":{"outcome":"completed"}}', {}, "ev_model"),
      actorId: "wa_custom_dev"
    };

    const groups = buildEventTimelineGroups([modelEvent], [{ id: "wa_custom_dev", name: "前端工程师" }]);

    expect(groups.map((group) => group.title)).toEqual(["前端工程师 · 任务流"]);
    expect(groups[0].title).not.toContain("goalResolution");
    expect(groups[0].summary).toContain("最新：已提交目标结论");
    expect(buildEventTimelineItem(modelEvent)).toMatchObject({
      title: "已提交目标结论",
      detail: undefined,
      tone: "success"
    });
  });

  it("shows handoff records as queued ticket-flow events instead of fake agents", () => {
    const item = buildEventTimelineItem(event("handoff.created", "老板正在忙，老板验收工单已进入队列", {
      phase: "boss_intake",
      reason: "老板验收工单已进入队列"
    }));

    expect(item).toMatchObject({
      actor: "任务流",
      title: "工单排队",
      detail: "需求接收：老板验收工单已进入队列"
    });
  });

  it("shows run failures as task failures instead of the previous phase", () => {
    const groups = buildEventTimelineGroups([
      event("task.phase_changed", "进入阶段：计划拆解", { phase: "pm_plan" }, "ev_1"),
      event("assignment.completed", "产品/项目已完成计划拆解", { assignment: { type: "pm_plan" } }, "ev_2"),
      event("run.failed", "需求接收无法完成后续处理，任务失败", {
        reason: "当前工具无写文件权限且无浏览器，需要人工修改并验证。已确认缺失砖块精确坐标。",
        attempts: 3
      }, "ev_3")
    ]);

    expect(groups.map((group) => group.title)).toEqual([
      "产品/项目 · 计划拆解",
      "任务 · 任务失败"
    ]);
    expect(groups[1].summary).toContain("关注：任务失败");
    expect(buildEventTimelineItem(groups[1].events[0])).toMatchObject({
      actor: "任务",
      title: "任务失败",
      detail: "需求接收无法完成后续处理，任务失败：当前工具无写文件权限且无浏览器，需要人工修改并验证。已确认缺失砖块精确坐标。；工单尝试 3 次"
    });
  });
});

function event(type: AutoAgentEvent["type"], summary: string, payload: Record<string, unknown>, id = `ev_${type}`): AutoAgentEvent {
  return {
    id,
    workspaceId: "ws_1",
    type,
    summary,
    payload,
    timestamp: "2026-07-01T00:00:00.000Z"
  };
}
