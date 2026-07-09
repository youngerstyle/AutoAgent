import { describe, expect, it } from "vitest";
import { createTicketRuntime } from "../../src/server/mission/ticket-runtime";
import type { WorkspaceAgent } from "../../src/shared/types";

describe("ticket runtime", () => {
  it("queues delivery when the target agent is already busy", () => {
    const runtime = createTicketRuntime();
    const boss = agent("wa_boss", "boss");

    const first = runtime.createTicket({
      workspaceId: "ws_1",
      taskId: "task_1",
      taskRunId: "tr_1",
      type: "boss_acceptance",
      brief: "验收交付物",
      expectedArtifact: "验收结论",
      targetAgentId: boss.id
    });
    const second = runtime.createTicket({
      workspaceId: "ws_1",
      taskId: "task_1",
      taskRunId: "tr_1",
      type: "boss_acceptance",
      brief: "回答追问",
      expectedArtifact: "追问回复",
      targetAgentId: boss.id
    });

    const claimed = runtime.claimNext(boss, now("2026-07-01T01:00:00.000Z"));
    const secondClaim = runtime.claimNext(boss, now("2026-07-01T01:00:01.000Z"));

    expect(claimed?.ticket.id).toBe(first.id);
    expect(secondClaim).toBeUndefined();
    expect(runtime.ticket(second.id)?.status).toBe("pending");
    expect(runtime.inboxForAgent(boss.id).map((message) => message.status)).toEqual(["claimed", "pending"]);
  });

  it("routes completed manual QA to boss acceptance", () => {
    const runtime = createTicketRuntime();
    const qaTicket = runtime.createTicket({
      workspaceId: "ws_1",
      taskId: "task_1",
      taskRunId: "tr_1",
      type: "qa",
      brief: "人工测试",
      expectedArtifact: "测试结论",
      targetRole: "qa"
    });

    runtime.blockTicket(qaTicket.id, {
      type: "manual_test_required",
      reason: "缺少浏览器运行环境"
    });
    const next = runtime.completeHumanAction(qaTicket.id, {
      action: "manual_test_passed",
      message: "我已经测试，没有问题"
    });

    expect(runtime.ticket(qaTicket.id)?.status).toBe("completed");
    expect(next).toMatchObject({
      type: "boss_acceptance",
      status: "pending",
      parentTicketId: qaTicket.id,
      targetRole: "boss"
    });
  });

  it("does not claim a ticket until its dependencies are completed", () => {
    const runtime = createTicketRuntime();
    const dev = agent("wa_dev", "dev");
    const qa = agent("wa_qa", "qa");
    const devTicket = runtime.createTicket({
      workspaceId: "ws_1",
      taskId: "task_1",
      taskRunId: "tr_1",
      type: "implementation",
      brief: "开发实现",
      expectedArtifact: "交付物",
      targetAgentId: dev.id
    });
    const qaTicket = runtime.createTicket({
      workspaceId: "ws_1",
      taskId: "task_1",
      taskRunId: "tr_1",
      type: "qa",
      brief: "质量检查",
      expectedArtifact: "测试报告",
      targetAgentId: qa.id,
      dependsOnTicketIds: [devTicket.id]
    });

    expect(runtime.claimNext(qa, now("2026-07-01T01:00:00.000Z"))).toBeUndefined();

    runtime.claimNext(dev, now("2026-07-01T01:00:01.000Z"));
    runtime.ack(devTicket.id, { artifact: "index.html" }, new Date("2026-07-01T01:00:02.000Z"));
    const claimedQa = runtime.claimNext(qa, now("2026-07-01T01:00:03.000Z"));

    expect(claimedQa?.ticket.id).toBe(qaTicket.id);
  });

  it("does not unlock dependents when an upstream ticket is returned", () => {
    const runtime = createTicketRuntime();
    const qa = agent("wa_qa", "qa");
    const boss = agent("wa_boss", "boss");
    const qaTicket = runtime.createTicket({
      workspaceId: "ws_1",
      taskId: "task_1",
      taskRunId: "tr_1",
      type: "qa",
      brief: "质量检查",
      expectedArtifact: "测试报告",
      targetAgentId: qa.id
    });
    const acceptance = runtime.createTicket({
      workspaceId: "ws_1",
      taskId: "task_1",
      taskRunId: "tr_1",
      type: "boss_acceptance",
      brief: "老板验收",
      expectedArtifact: "验收结论",
      targetAgentId: boss.id,
      dependsOnTicketIds: [qaTicket.id]
    });

    runtime.blockTicket(qaTicket.id, { type: "manual_test_required", reason: "需要人工测试" });
    runtime.completeHumanAction(qaTicket.id, {
      action: "manual_test_failed",
      message: "人工测试失败"
    });

    expect(runtime.ticket(qaTicket.id)?.status).toBe("returned");
    expect(runtime.claimNext(boss, now("2026-07-01T01:00:00.000Z"))).toBeUndefined();
    expect(runtime.ticket(acceptance.id)?.status).not.toBe("running");
  });

  it("requeues the same ticket when an execution slice yields", () => {
    const runtime = createTicketRuntime();
    const dev = agent("wa_dev", "dev");
    const ticket = runtime.createTicket({
      workspaceId: "ws_1",
      taskId: "task_1",
      taskRunId: "tr_1",
      type: "implementation",
      brief: "开发实现",
      expectedArtifact: "交付物",
      targetAgentId: dev.id
    });

    const firstClaim = runtime.claimNext(dev, now("2026-07-01T01:00:00.000Z"));
    runtime.yieldTicket(ticket.id, {
      reason: "执行片工具观察预算已用完",
      assignmentRunId: "ar_1",
      nextRunAfter: "2026-07-01T01:00:02.000Z"
    }, new Date("2026-07-01T01:00:01.000Z"));
    const secondClaim = runtime.claimNext(dev, now("2026-07-01T01:00:03.000Z"));

    expect(firstClaim?.ticket.id).toBe(ticket.id);
    expect(secondClaim?.ticket.id).toBe(ticket.id);
    expect(runtime.ticket(ticket.id)).toMatchObject({
      status: "running",
      execution: {
        sliceStatus: "running",
        yieldReason: "执行片工具观察预算已用完",
        continuationCount: 1,
        lastAssignmentRunId: "ar_1",
        nextRunAfter: "2026-07-01T01:00:02.000Z"
      }
    });
    expect(runtime.inboxForAgent(dev.id).map((message) => message.status)).toEqual(["claimed"]);
  });

  it("returns failed manual QA as a development rework ticket", () => {
    const runtime = createTicketRuntime();
    const boss = agent("wa_boss", "boss");
    const qaTicket = runtime.createTicket({
      workspaceId: "ws_1",
      taskId: "task_1",
      taskRunId: "tr_1",
      type: "qa",
      brief: "人工测试",
      expectedArtifact: "测试结论",
      targetRole: "qa"
    });
    const staleAcceptance = runtime.createTicket({
      workspaceId: "ws_1",
      taskId: "task_1",
      taskRunId: "tr_1",
      type: "boss_acceptance",
      brief: "旧验收",
      expectedArtifact: "验收结论",
      targetAgentId: boss.id,
      parentTicketId: qaTicket.id,
      createdByTicketId: qaTicket.id,
      dependsOnTicketIds: [qaTicket.id]
    });

    runtime.blockTicket(qaTicket.id, {
      type: "manual_test_required",
      reason: "缺少浏览器运行环境"
    });
    const next = runtime.completeHumanAction(qaTicket.id, {
      action: "manual_test_failed",
      message: "碰撞有问题"
    });

    expect(runtime.ticket(qaTicket.id)).toMatchObject({
      status: "returned",
      returnReason: "碰撞有问题"
    });
    expect(next).toMatchObject({
      type: "rework",
      status: "pending",
      parentTicketId: qaTicket.id,
      targetRole: "dev",
      returnReason: "碰撞有问题"
    });
    expect(runtime.ticket(staleAcceptance.id)).toMatchObject({
      status: "cancelled",
      returnReason: "人工测试失败，旧下游验收不再有效"
    });
    expect(runtime.inboxForAgent(boss.id).map((message) => message.status)).toEqual(["cancelled"]);
  });

  it("cancels open tickets and messages when a task is stopped", () => {
    const runtime = createTicketRuntime();
    const dev = agent("wa_dev", "dev");
    const ticket = runtime.createTicket({
      workspaceId: "ws_1",
      taskId: "task_1",
      taskRunId: "tr_1",
      type: "implementation",
      brief: "开发实现",
      expectedArtifact: "交付物",
      targetAgentId: dev.id
    });

    runtime.claimNext(dev, now("2026-07-01T01:00:00.000Z"));
    runtime.cancelOpenTickets("任务已停止", new Date("2026-07-01T01:00:01.000Z"));

    expect(runtime.ticket(ticket.id)).toMatchObject({
      status: "cancelled",
      returnReason: "任务已停止"
    });
    expect(runtime.inboxForAgent(dev.id).map((message) => message.status)).toEqual(["cancelled"]);
  });

  it("cancels only open descendants of a ticket branch", () => {
    const runtime = createTicketRuntime();
    const pm = agent("wa_pm", "pm");
    const qa = agent("wa_qa", "qa");
    const boss = agent("wa_boss", "boss");
    const pmTicket = runtime.createTicket({
      workspaceId: "ws_1",
      taskId: "task_1",
      taskRunId: "tr_1",
      type: "pm_plan",
      brief: "计划",
      expectedArtifact: "工单图",
      targetAgentId: pm.id
    });
    const qaTicket = runtime.createTicket({
      workspaceId: "ws_1",
      taskId: "task_1",
      taskRunId: "tr_1",
      type: "qa",
      brief: "旧 QA",
      expectedArtifact: "测试报告",
      targetAgentId: qa.id,
      parentTicketId: pmTicket.id,
      createdByTicketId: pmTicket.id
    });
    const bossTicket = runtime.createTicket({
      workspaceId: "ws_1",
      taskId: "task_1",
      taskRunId: "tr_1",
      type: "boss_acceptance",
      brief: "旧验收",
      expectedArtifact: "验收结论",
      targetAgentId: boss.id,
      parentTicketId: qaTicket.id,
      createdByTicketId: qaTicket.id,
      dependsOnTicketIds: [qaTicket.id]
    });

    runtime.ack(qaTicket.id, { passed: true }, new Date("2026-07-01T01:00:00.000Z"));
    runtime.cancelOpenDescendants(pmTicket.id, "PM 已重新拆解", new Date("2026-07-01T01:00:01.000Z"));

    expect(runtime.ticket(qaTicket.id)?.status).toBe("completed");
    expect(runtime.ticket(bossTicket.id)).toMatchObject({
      status: "cancelled",
      returnReason: "PM 已重新拆解"
    });
    expect(runtime.inboxForAgent(boss.id).map((message) => message.status)).toEqual(["cancelled"]);
  });
});

function agent(id: string, roleInWorkspace: WorkspaceAgent["roleInWorkspace"]): WorkspaceAgent {
  return {
    id,
    workspaceId: "ws_1",
    profileId: `profile_${roleInWorkspace}`,
    roleInWorkspace,
    agentDir: roleInWorkspace,
    status: "waiting"
  };
}

function now(value: string): () => Date {
  return () => new Date(value);
}
