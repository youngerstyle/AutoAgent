import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentProfileStore } from "../../src/server/agents/profile-store.js";
import { ensureWorkspaceAgent, listWorkspaceAgents, updateWorkspaceAgent } from "../../src/server/agents/roster.js";
import { createTeamBinding } from "../../src/server/product/team-binding.js";
import { ProviderRegistry } from "../../src/server/providers/provider-registry.js";
import { ProviderError } from "../../src/server/providers/types.js";
import {
  canContinueClaimedTicketWork,
  canContinueRecoveredBlockedWork,
  planAllowsActiveAgentExecution,
  projectWorkspaceLifecycle,
  presentationStatus,
  projectTicketBlocker,
  projectedAgentStatus,
  queuedMessageRoute,
  runtimeTaskStatusFor,
  RuntimeHost,
} from "../../src/server/runtime/runtime-host.js";
import { missionProcessFile, runtimeHostFile } from "../../src/server/storage/paths.js";
import { seedMinimalTeamPlanPolicy, DEFAULT_MINIMAL_TEAM_POLICY_CONFIG } from "../../src/server/tickets/plan-policy-config.js";
import { PlanPolicyStore } from "../../src/server/tickets/plan-policy-store.js";
import type { Workspace } from "../../src/shared/types.js";

const fixtureCleanups = new Set<() => Promise<void>>();

afterEach(async () => {
  const cleanups = [...fixtureCleanups];
  fixtureCleanups.clear();
  const results = await Promise.allSettled(cleanups.map((cleanup) => cleanup()));
  const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failure) throw failure.reason;
});

describe("RuntimeHost", () => {
  it("shows active remediation work as running even while the Plan outcome is blocked", () => {
    expect(presentationStatus("blocked", "active", [{ status: "running" }])).toBe("running");
    expect(presentationStatus("blocked", "active", [{ status: "blocked", blocker: { type: "external_dependency", reason: "human input" } }])).toBe("blocked");
    expect(presentationStatus("failed", "linked", [{ status: "pending" }])).toBe("failed");
    expect(presentationStatus("active", "linked", [{ status: "pending" }])).toBe("running");
    expect(presentationStatus("completed", "linked", [])).toBe("waiting");
    expect(presentationStatus("completed", "completed", [])).toBe("completed");
  });

  it("derives the user-facing status and phase from one lifecycle projection", () => {
    expect(projectWorkspaceLifecycle("active", "linked", [{ status: "pending" }])).toEqual({
      status: "running",
      phase: "running",
    });
    expect(projectWorkspaceLifecycle("blocked", "active", [{ status: "running" }])).toEqual({
      status: "running",
      phase: "running",
    });
    expect(projectWorkspaceLifecycle("blocked", "active", [{ status: "blocked" }])).toEqual({
      status: "blocked",
      phase: "blocked",
    });
    expect(projectWorkspaceLifecycle("completed", "linked", [])).toEqual({
      status: "waiting",
      phase: "idle",
    });
    expect(projectWorkspaceLifecycle("completed", "completed", [])).toEqual({
      status: "completed",
      phase: "completed",
    });
  });

  it("removes a completed Plan from the runtime scheduler without completing its Mission", () => {
    expect(runtimeTaskStatusFor("completed", "linked")).toBe("waiting");
    expect(runtimeTaskStatusFor("active", "linked")).toBe("active");
    expect(runtimeTaskStatusFor("completed", "completed")).toBe("completed");
  });

  it("never delivers a queued private message into a later Goal", () => {
    expect(queuedMessageRoute("goal-a", "goal-a")).toBe("active_goal");
    expect(queuedMessageRoute("goal-a", "goal-b")).toBe("defer");
    expect(queuedMessageRoute(undefined, "goal-b")).toBe("defer");
    expect(queuedMessageRoute("goal-a", undefined)).toBe("idle");
  });

  it("uses the durable execution lease and shows provider waits instead of guessing from process memory", () => {
    const waitingEvent = {
      source: "system",
      payload: { status: "provider_retry_wait" },
    } as never;

    expect(projectedAgentStatus("running", "active", [waitingEvent], true)).toBe("waiting");
    expect(projectedAgentStatus("running", "active", [], true)).toBe("running");
    expect(projectedAgentStatus("running", "active", [], false)).toBe("waiting");
  });

  it("does not schedule new Agent turns while the Plan is blocked", () => {
    expect(planAllowsActiveAgentExecution("active")).toBe(true);
    expect(planAllowsActiveAgentExecution("blocked")).toBe(false);
    expect(planAllowsActiveAgentExecution("paused")).toBe(false);
    expect(planAllowsActiveAgentExecution("completed")).toBe(false);
    expect(planAllowsActiveAgentExecution("failed")).toBe(false);
    expect(planAllowsActiveAgentExecution("cancelled")).toBe(false);
  });

  it("continues only the recovered blocked owner while its Plan remains blocked", () => {
    expect(canContinueRecoveredBlockedWork({
      planStatus: "blocked",
      ticketStatus: "running",
      linkStatus: "running",
      authorityKind: "blocked_owner",
      goalStatus: "active",
    })).toBe(true);
    expect(canContinueRecoveredBlockedWork({
      planStatus: "blocked",
      ticketStatus: "running",
      linkStatus: "running",
      authorityKind: "claim",
      goalStatus: "active",
    })).toBe(false);
    expect(canContinueRecoveredBlockedWork({
      planStatus: "blocked",
      ticketStatus: "completed",
      linkStatus: "running",
      authorityKind: "blocked_owner",
      goalStatus: "active",
    })).toBe(false);
    expect(canContinueRecoveredBlockedWork({
      planStatus: "blocked",
      ticketStatus: "running",
      linkStatus: "running",
      authorityKind: "blocked_owner",
      goalStatus: "blocked",
    })).toBe(false);
  });

  it("continues a currently claimed Ticket while its aggregate Plan is blocked", () => {
    const authority = { kind: "claim", claimId: "claim-1", fencingToken: 3 };
    expect(canContinueClaimedTicketWork({
      planStatus: "blocked",
      ticketStatus: "running",
      ticketAuthority: authority,
      linkStatus: "running",
      linkAuthority: authority,
      goalStatus: "active",
    })).toBe(true);
    expect(canContinueClaimedTicketWork({
      planStatus: "blocked",
      ticketStatus: "running",
      ticketAuthority: authority,
      linkStatus: "running",
      linkAuthority: { ...authority, fencingToken: 2 },
      goalStatus: "active",
    })).toBe(false);
    expect(canContinueClaimedTicketWork({
      planStatus: "blocked",
      ticketStatus: "pending",
      ticketAuthority: undefined,
      linkStatus: "running",
      linkAuthority: authority,
      goalStatus: "active",
    })).toBe(false);
    expect(canContinueClaimedTicketWork({
      planStatus: "active",
      ticketStatus: "running",
      ticketAuthority: authority,
      linkStatus: "running",
      linkAuthority: authority,
      goalStatus: "active",
    })).toBe(false);
  });

  it("projects typed manual-test input into the QA human-loop contract", () => {
    expect(projectTicketBlocker("QA 缺少浏览器环境", {
      kind: "manual_test",
      description: "请在浏览器中完成一局",
      details: { testFile: "index.html", steps: ["完成一局"] },
    })).toEqual({
      type: "manual_test_required",
      reason: "请在浏览器中完成一局",
      details: { testFile: "index.html", steps: ["完成一局"] },
    });
  });
  it("turns request_human_input into a blocked Ticket without language inference", async () => {
    const fixture = await createFixture();
    let exposed = false;
    let modelTurns = 0;
    fixture.providers.get = async () => ({
      name: "mock",
      async runModelTurn(input) {
        modelTurns += 1;
        exposed = input.tools.some((tool) => tool.name === "request_human_input");
        return {
          items: [{
            type: "tool_call" as const,
            callId: `human-input-${modelTurns}`,
            name: "request_human_input",
            arguments: {
              kind: "manual_test",
              description: "请在浏览器中完成一局",
              details: { testFile: "index.html", steps: ["完成一局"] },
            },
          }],
        };
      },
    });

    await fixture.host.createTask({ taskId: "task-human-input-tool", title: "人工测试", objective: "验证浏览器交互" });
    await fixture.host.tick();
    await waitFor(async () => (await fixture.host.snapshot()).tickets?.some((ticket) => ticket.status === "blocked") ?? false, 5_000);
    const snapshot = await fixture.host.snapshot();

    expect(exposed).toBe(true);
    expect(snapshot.tickets).toContainEqual(expect.objectContaining({
      status: "blocked",
      blocker: {
        type: "manual_test_required",
        reason: "请在浏览器中完成一局",
        details: { testFile: "index.html", steps: ["完成一局"] },
      },
    }));

    const context = fixture.host.context("task-human-input-tool")!;
    const blockedLink = (await context.manager.current()).links.find((link) => link.status === "blocked")!;
    const blockedGoalId = blockedLink.agentGoalId!;
    const resumedSnapshot = await fixture.host.sendAgentMessage(
      "task-human-input-tool",
      blockedLink.agentId,
      "人工验证发现视觉不符合目标，请依据反馈继续判断",
      "human-manual-test-result",
    );
    expect(resumedSnapshot.tickets?.find((ticket) => ticket.id === blockedLink.ticketId)?.status).toBe("running");
    expect(resumedSnapshot.status).toBe("running");
    await waitFor(async () => modelTurns === 2, 5_000);

    const resumedLink = (await context.manager.current()).links.find((link) => link.agentGoalId === blockedGoalId);
    expect(resumedLink?.agentGoalId).toBe(blockedGoalId);
    expect(modelTurns).toBe(2);
  });
  it("acknowledges a newly persisted task before any Agent model turn finishes", async () => {
    const fixture = await createFixture();
    fixture.providers.get = async () => ({
      name: "mock",
      async runModelTurn() {
        return new Promise(() => undefined);
      },
    });

    const creating = fixture.host.createTask({
      taskId: "task-fast-ack",
      title: "立即确认",
      objective: "创建后由后台执行",
    });
    const acknowledged = await Promise.race([
      creating.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 3_000)),
    ]);

    expect(acknowledged).toBe(true);
    expect(await fixture.host.listTasks()).toContainEqual(expect.objectContaining({
      taskId: "task-fast-ack",
      status: "active",
    }));
  });

  it("exposes an old non-UUID Mission as read-only without scheduling it", async () => {
    const fixture = await createFixture();
    const createdAt = new Date().toISOString();
    const task = {
      taskId: "legacy-task",
      runId: "legacy-run",
      missionId: "legacy-task",
      title: "旧版任务",
      objective: "旧版目标",
      status: "active",
      createdAt,
      updatedAt: createdAt,
    } as const;
    const missionFile = missionProcessFile(fixture.root, task.missionId);
    await mkdir(path.dirname(missionFile), { recursive: true });
    await writeFile(runtimeHostFile(fixture.root), JSON.stringify({ schemaVersion: 2, tasks: [task] }), "utf8");
    await writeFile(missionFile, JSON.stringify({
      schemaVersion: 2,
      missionId: task.missionId,
      version: 1,
      record: {
        missionId: task.missionId,
        planId: "planning-v1",
        planCreateCommandId: "legacy-create",
        status: "linked",
      },
      links: [],
      cursors: [],
      steps: [],
    }), "utf8");

    await fixture.host.recover();
    const snapshot = await fixture.host.snapshot();

    expect(snapshot.status).toBe("interrupted");
    expect(snapshot.readOnlyReason).toContain("旧版任务");
    expect(snapshot.mission).toBeUndefined();

    await fixture.host.createTask({ taskId: "fresh-task", title: "新任务", objective: "重新开始" });
    expect((await fixture.host.snapshot()).mission?.planId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("runs a fresh mock mission through ticket DAG and survives host recreation", async () => {
    const fixture = await createFixture();
    await fixture.host.createTask({ taskId: "task-a", title: "演示", objective: "构建演示" });
    await waitForTaskStatus(fixture.host, "task-a", "completed");

    expect(await fixture.host.listTasks()).toContainEqual(expect.objectContaining({ taskId: "task-a", status: "completed" }));
    await fixture.host.stop();

    const restarted = new RuntimeHost(
      fixture.workspace,
      fixture.profiles,
      fixture.providers,
      fixture.policyStore,
      fixture.policyRef,
      { intervalMs: 60_000 },
    );
    await restarted.recover();
    expect(await restarted.listTasks()).toContainEqual(expect.objectContaining({ taskId: "task-a", status: "completed" }));
    const restoredSnapshot = await restarted.snapshot();
    expect(restoredSnapshot.status).toBe("completed");
    expect(restoredSnapshot.activeTask?.status).toBe("completed");
    expect(restoredSnapshot.tickets?.length).toBeGreaterThan(0);
    await restarted.stop();
  }, 60_000);

  it("keeps the Mission TeamBinding snapshot unchanged when profiles change before restart", async () => {
    const fixture = await createFixture();
    await fixture.host.createTask({ taskId: "task-team-snapshot", title: "snapshot", objective: "preserve assignment authority" });
    const before = await fixture.host.context("task-team-snapshot")!.manager.current();
    const beforeHash = before.record.teamBinding.contentHash;
    const beforeDev = before.record.teamBinding.members.find((member) => member.agentId === "wa_dev")!;
    await fixture.host.stop();

    await fixture.profiles.update("prof_dev", { capabilities: ["changed:after-mission-created"] });
    const restarted = new RuntimeHost(
      fixture.workspace,
      fixture.profiles,
      fixture.providers,
      fixture.policyStore,
      fixture.policyRef,
      { intervalMs: 60_000 },
    );
    await restarted.recover();
    const after = await restarted.context("task-team-snapshot")!.manager.current();

    expect(after.record.teamBinding.contentHash).toBe(beforeHash);
    expect(after.record.teamBinding.members.find((member) => member.agentId === "wa_dev")?.capabilities)
      .toEqual(beforeDev.capabilities);
    await restarted.stop();
  });

  it("routes a global human message to the persisted Mission owner instead of a role name", async () => {
    const fixture = await createFixture();
    const boss = (await fixture.profiles.list()).find((profile) => profile.id === "prof_boss")!;
    const pm = (await fixture.profiles.list()).find((profile) => profile.id === "prof_pm")!;
    await fixture.profiles.update("prof_boss", { capabilities: boss.capabilities.filter((item) => item !== "mission:intake") });
    await fixture.profiles.update("prof_pm", { capabilities: [...pm.capabilities, "mission:intake"] });
    await fixture.host.createTask({ taskId: "task-explicit-owner", title: "owner", objective: "route by persisted authority" });

    const mission = await fixture.host.context("task-explicit-owner")!.manager.current();
    expect(mission.record.ownerPrincipalId).toBe("principal:wa_pm");
    await fixture.host.sendTaskMessage("task-explicit-owner", "global owner message", "owner-message");
    const pmThread = await fixture.host.context("task-explicit-owner")!.engines.get("wa_pm")!
      .getThreadForAgent("wa_pm", "task-explicit-owner");
    const payloads = await fixture.host.context("task-explicit-owner")!.engines.get("wa_pm")!
      .getPayloads(pmThread!.items.map((item) => item.payloadRef));

    expect([...payloads.values()]).toContainEqual(expect.objectContaining({
      messageId: "owner-message",
      senderPrincipalId: "human",
      content: "global owner message",
    }));
  });

  it("does not present an active Plan as paused just because the scheduler is not started", async () => {
    const fixture = await createFixture();
    await fixture.host.createTask({ taskId: "task-hydrated-status", title: "status", objective: "verify projection" });

    const snapshot = await fixture.host.snapshot();

    expect(snapshot.status).toBe("running");
    expect(snapshot.phase).toBe("running");
    expect(snapshot.agents.find((agent) => agent.id === "wa_boss")?.status).toBe("idle");
    expect(snapshot.tickets?.every((ticket) => Boolean(ticket.targetAgentId && ticket.targetRole))).toBe(true);
  });

  it("recovers an unconsumed private message for an idle Agent after host restart", async () => {
    const fixture = await createFixture();
    fixture.providers.get = async () => ({
      name: "mock",
      async runModelTurn() {
        return { items: [{ type: "assistant_message" as const, content: "private reply" }] };
      },
    });
    await fixture.host.createTask({ taskId: "task-idle-message-recovery", title: "recovery", objective: "keep mission active" });
    const engine = fixture.host.context("task-idle-message-recovery")!.engines.get("wa_architect")!;
    const thread = await engine.ensureThread({
      agentId: "wa_architect",
      scopeId: "task-idle-message-recovery",
      idempotencyKey: "architect-recovery-thread",
    });
    await engine.sendMessage({
      messageId: "persisted-idle-private-message",
      turnId: "turn_idle_private_message",
      threadId: thread.threadId,
      senderPrincipalId: "human",
      deliveryKind: "turn",
      content: "please inspect independently",
      createdAt: new Date().toISOString(),
    });
    await fixture.host.stop();

    const restarted = new RuntimeHost(
      fixture.workspace,
      fixture.profiles,
      fixture.providers,
      fixture.policyStore,
      fixture.policyRef,
      { intervalMs: 60_000 },
    );
    await restarted.recover();
    await restarted.tick();

    const recoveredEngine = restarted.context("task-idle-message-recovery")!.engines.get("wa_architect")!;
    const recoveredThread = await recoveredEngine.getThreadForAgent("wa_architect", "task-idle-message-recovery");
    const turnItems = recoveredThread!.items.filter((item) => item.turnId === "turn_idle_private_message");
    expect(turnItems.map((item) => item.kind)).toEqual(expect.arrayContaining(["message", "control", "model"]));
    await restarted.stop();
  });

  it("recovers multiple private messages in chronological order after host restart", async () => {
    const fixture = await createFixture();
    const prompts: string[] = [];
    fixture.providers.get = async () => ({
      name: "mock",
      async runModelTurn(input) {
        const latestUser = [...input.history].reverse().find((item) => item.type === "user_message");
        prompts.push(latestUser?.content ?? "");
        return { items: [{ type: "assistant_message" as const, content: "acknowledged" }] };
      },
    });
    await fixture.host.createTask({ taskId: "task-message-order", title: "order", objective: "keep mission active" });
    const engine = fixture.host.context("task-message-order")!.engines.get("wa_architect")!;
    const thread = await engine.ensureThread({
      agentId: "wa_architect",
      scopeId: "task-message-order",
      idempotencyKey: "architect-message-order-thread",
    });
    for (const [index, content] of ["first private message", "second private message"].entries()) {
      await engine.sendMessage({
        messageId: `persisted-private-message-${index}`,
        turnId: `turn_private_message_${index}`,
        threadId: thread.threadId,
        senderPrincipalId: "human",
        deliveryKind: "turn",
        content,
        createdAt: new Date(Date.now() + index).toISOString(),
      });
    }
    await fixture.host.stop();

    const restarted = new RuntimeHost(
      fixture.workspace,
      fixture.profiles,
      fixture.providers,
      fixture.policyStore,
      fixture.policyRef,
      { intervalMs: 60_000 },
    );
    await restarted.recover();
    await restarted.tick();
    await restarted.tick();

    const privatePrompts = prompts.filter((prompt) => prompt.includes("private message"));
    expect(privatePrompts).toHaveLength(2);
    expect(privatePrompts[0]).toContain("first private message");
    expect(privatePrompts[1]).toContain("second private message");
    await restarted.stop();
  });

  it("projects the original human objective and received Goal before internal Agent instructions", async () => {
    const fixture = await createFixture();
    await fixture.host.createTask({ taskId: "task-thread-origin", title: "坦克98", objective: "1:1复刻 CF 红白机的坦克98 游戏" });
    await fixture.host.tick();

    const snapshot = await fixture.host.snapshot();
    const events = snapshot.agentThreads?.wa_boss ?? [];

    expect(events[0]).toMatchObject({
      source: "human",
      kind: "human_message",
      payload: { content: "1:1复刻 CF 红白机的坦克98 游戏" },
    });
    expect(events[1]).toMatchObject({
      source: "platform",
      kind: "ticket_received",
      payload: {
        brief: expect.stringContaining("当前 Agent thread 中提交的原始诉求"),
        expectedArtifact: "mission-baseline-v2",
      },
    });
    expect(JSON.stringify(events.slice(1))).not.toContain("1:1复刻 CF 红白机的坦克98 游戏");
    expect(events.findIndex((event) => event.kind === "system_note")).toBeGreaterThan(1);
  });

  it("rebuilds an empty Pi session from the chronological Agent thread before the first model turn", async () => {
    const fixture = await createFixture();
    const histories: Array<Array<{ type: string; content?: string }>> = [];
    const instructions: string[] = [];
    fixture.providers.get = async () => ({
      name: "mock",
      async runModelTurn(input) {
        histories.push(input.history);
        instructions.push(input.instructions);
        return {
          items: [{
            type: "tool_call" as const,
            callId: "resolve-after-history-rebuild",
            name: "goal_resolution",
            arguments: {
              status: "completed",
              evidence: [],
              criterionResults: satisfiedCriteria(4),
              residualRisks: [],
              domainOutcome: missionBaselineOutcome(),
            },
          }],
        };
      },
    });

    const objective = "1:1复刻 CF 红白机的坦克98 游戏";
    await fixture.host.createTask({ taskId: "task-pi-history-origin", title: "坦克98", objective });
    await fixture.host.tick();

    expect(histories.length).toBeGreaterThanOrEqual(1);
    expect(histories[0]).toContainEqual(expect.objectContaining({
      type: "user_message",
      content: expect.stringContaining(objective),
    }));
    expect(instructions[0]).not.toContain("当前工作上下文（由 Mission Control 从 Ticket Engine 的权威状态组装");
    expect(JSON.stringify(histories[0])).toContain("当前工作上下文（由 Mission Control 从 Ticket Engine 的权威状态组装");
  });

  it("delivers a new ticket instruction to an existing Pi session instead of replacing it with Goal metadata", async () => {
    const fixture = await createFixture();
    const modelInputs: Array<{ instructions: string; history: unknown[] }> = [];
    const originalGet = fixture.providers.get.bind(fixture.providers);
    fixture.providers.get = async (name) => {
      const provider = await originalGet(name);
      return {
        ...provider,
        async runModelTurn(input) {
          modelInputs.push({ instructions: input.instructions, history: input.history });
          return provider.runModelTurn(input);
        },
      };
    };

    await fixture.host.createTask({ taskId: "task-new-goal-message", title: "演示", objective: "构建可运行演示" });
    for (let index = 0; index < 12; index += 1) await fixture.host.tick();

    expect(modelInputs.length).toBeGreaterThanOrEqual(2);
    const reusedBossSessionTurn = modelInputs
      .map((value) => JSON.stringify(value.history))
      .find((value) => value.includes("本轮按时间序收到的消息"));
    expect(reusedBossSessionTurn).toContain("当前工作上下文（由 Mission Control 从 Ticket Engine 的权威状态组装");
    expect(reusedBossSessionTurn).toContain("handoffLineage");
    expect(modelInputs.every((value) => !value.instructions.includes("handoffLineage"))).toBe(true);
  });

  it("pauses an active goal after repeated idle turns without replaying it forever", async () => {
    const fixture = await createFixture();
    let modelTurns = 0;
    fixture.providers.get = async () => ({
      name: "mock",
      async runModelTurn() {
        modelTurns += 1;
        return { items: [{ type: "assistant_message" as const, content: "目标仍在处理中。" }] };
      },
    });
    await fixture.host.createTask({ taskId: "task-resume-active", title: "演示", objective: "构建演示" });
    await fixture.host.tick();
    const context = fixture.host.context("task-resume-active")!;
    const boss = context.engines.get("wa_boss")!;
    const thread = await boss.getThreadForAgent("wa_boss", "task-resume-active");
    const link = (await context.manager.current()).links.find((item) => item.agentId === "wa_boss")!;
    await fixture.host.tick();
    await fixture.host.tick();

    expect(modelTurns).toBe(2);
    const updated = await boss.getThread(thread!.threadId);
    expect(updated.items.some((item) => item.kind === "control")).toBe(true);
    expect(await boss.getGoal(link.agentGoalId!)).toMatchObject({ status: "paused" });
    expect(fixture.host.providerRetryState("task-resume-active", "wa_boss")).toBeUndefined();
  });

  it("does not replace a long goal with a fixed short idle-turn limit", async () => {
    const fixture = await createFixture();
    let modelTurns = 0;
    fixture.providers.get = async () => ({
      name: "mock",
      async runModelTurn() {
        modelTurns += 1;
        if (modelTurns <= 5) {
          return { items: [{ type: "assistant_message" as const, content: `阶段性进展 ${modelTurns}` }] };
        }
        return {
          items: [{
            type: "tool_call" as const,
            callId: "resolve-after-distinct-progress",
            name: "goal_resolution",
            arguments: {
              status: "completed",
              summary: "完成了连续的阶段性工作",
              evidence: [],
              criterionResults: satisfiedCriteria(4),
              residualRisks: [],
              domainOutcome: missionBaselineOutcome(),
            },
          }],
        };
      },
    });

    await fixture.host.createTask({
      taskId: "task-distinct-idle-progress",
      title: "阶段性进展",
      objective: "验证不同进展不会被固定短轮次截断",
    });
    const context = fixture.host.context("task-distinct-idle-progress")!;
    const boss = context.engines.get("wa_boss")!;
    await fixture.host.tick();
    const bossLink = (await context.manager.current()).links.find((link) => link.agentId === "wa_boss")!;
    await waitFor(async () => {
      await fixture.host.tick();
      return (await boss.getGoal(bossLink.agentGoalId!))?.status === "completed";
    }, 5_000);

    expect(modelTurns).toBeGreaterThanOrEqual(6);
    expect(await boss.getGoal(bossLink.agentGoalId!)).toMatchObject({ status: "completed" });
    const snapshot = await fixture.host.snapshot();
    expect(snapshot.status).toBe("running");
  });

  it("coalesces concurrent timer ticks instead of queueing repeated model turns", async () => {
    const fixture = await createFixture();
    let modelTurns = 0;
    fixture.providers.get = async () => ({
      name: "mock",
      async runModelTurn() {
        modelTurns += 1;
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { items: [{ type: "assistant_message" as const, content: "继续处理。" }] };
      },
    });
    await fixture.host.createTask({ taskId: "task-single-flight", title: "演示", objective: "构建演示" });
    await fixture.host.tick();
    const singleFlightBoss = fixture.host.context("task-single-flight")!.engines.get("wa_boss")!;
    const singleFlightThread = (await singleFlightBoss.getThreadForAgent("wa_boss", "task-single-flight"))!;
    await singleFlightBoss.sendMessage({
      messageId: "new-input-before-concurrent-ticks",
      threadId: singleFlightThread.threadId,
      senderPrincipalId: "human",
      content: "这是新的事实",
      createdAt: "2026-07-10T00:04:00.000Z",
    });

    const first = fixture.host.tick();
    const second = fixture.host.tick();

    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(modelTurns).toBe(2);
  });

  it("coalesces concurrent resume requests with a scheduler tick for one paused Agent", async () => {
    let now = new Date("2026-07-24T09:00:00.000Z");
    const fixture = await createFixture({
      now: () => now,
      providerRetryBaseMs: 5_000,
      providerRetryMaxMs: 5_000,
    });
    let providerAvailable = false;
    let modelTurns = 0;
    fixture.providers.get = async () => ({
      name: "mock",
      async runModelTurn() {
        modelTurns += 1;
        await new Promise((resolve) => setTimeout(resolve, 50));
        if (!providerAvailable) throw new ProviderError("502 Bad Gateway", true, "UPSTREAM_ERROR");
        return {
          items: [{
            type: "tool_call" as const,
            callId: "complete-after-resume-race",
            name: "goal_resolution",
            arguments: {
              status: "completed",
              summary: "恢复后完成",
              evidence: [],
              criterionResults: satisfiedCriteria(4),
              residualRisks: [],
              domainOutcome: missionBaselineOutcome(),
            },
          }],
        };
      },
    });

    await fixture.host.createTask({
      taskId: "task-resume-race",
      title: "恢复竞争",
      objective: "验证重复恢复不会创建第二个 Agent 回合",
    });
    await fixture.host.tick();
    const context = fixture.host.context("task-resume-race")!;
    const before = await context.manager.current();
    const beforeLink = before.links.find((link) => link.agentId === "wa_boss")!;
    const beforeGoalId = beforeLink.agentGoalId;
    expect(modelTurns).toBe(1);
    await fixture.host.pauseTask("task-resume-race");
    expect(await context.engines.get("wa_boss")!.getGoal(beforeGoalId!)).toMatchObject({ status: "paused" });

    providerAvailable = true;
    now = new Date(now.getTime() + 5_000);
    await Promise.all([
      fixture.host.resumeTask("task-resume-race"),
      fixture.host.resumeTask("task-resume-race"),
      fixture.host.tick(),
    ]);

    const boss = context.engines.get("wa_boss")!;
    await waitFor(async () => {
      await fixture.host.tick();
      const goal = await boss.getGoal(beforeGoalId!);
      return goal?.status === "completed";
    }, 5_000);
    const after = await context.manager.current();
    const afterLink = after.links.find((link) => link.agentId === "wa_boss")!;
    expect(afterLink.agentGoalId).toBe(beforeGoalId);
    const bossThread = await boss.getThread(beforeLink.agentThreadId!);
    const startedTurns = bossThread.items.filter((item) => item.kind === "control" && item.itemId.endsWith(":started"));
    expect(startedTurns).toHaveLength(2);
    expect(new Set(startedTurns.map((item) => item.turnId)).size).toBe(2);
    expect(modelTurns).toBeGreaterThanOrEqual(2);
    await fixture.host.stop();
  });

  it("atomically reserves an Agent turn when a private message races the scheduler", async () => {
    const fixture = await createFixture();
    let providerAvailable = false;
    fixture.providers.get = async () => ({
      name: "mock",
      async runModelTurn() {
        if (!providerAvailable) throw new ProviderError("provider unavailable", false, "OPENAI_ERROR");
        await new Promise((resolve) => setTimeout(resolve, 50));
        return {
          items: [{
            type: "tool_call" as const,
            callId: "resolve-after-private-message",
            name: "goal_resolution",
            arguments: {
              status: "completed",
              summary: "需求接收完成",
              evidence: [],
              criterionResults: satisfiedCriteria(4),
              residualRisks: [],
              domainOutcome: missionBaselineOutcome(),
            },
          }],
        };
      },
    });
    await fixture.host.createTask({
      taskId: "task-private-message-race",
      title: "演示",
      objective: "构建演示",
    });
    await fixture.host.tick();
    const context = fixture.host.context("task-private-message-race")!;
    const engine = context.engines.get("wa_boss")!;
    const thread = (await engine.getThreadForAgent("wa_boss", "task-private-message-race"))!;
    const startsBefore = thread.items.filter((item) => item.itemId.endsWith(":started")).length;

    providerAvailable = true;
    const message = fixture.host.sendAgentMessage(
      "task-private-message-race",
      "wa_boss",
      "继续",
      "private-message-race",
    );
    const timerTick = fixture.host.tick();
    await Promise.all([message, timerTick]);
    await waitFor(async () => {
      const updated = await engine.getThread(thread.threadId);
      return updated.items.filter((item) => item.itemId.endsWith(":started")).length > startsBefore;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const updated = await engine.getThread(thread.threadId);
    const startsAfter = updated.items.filter((item) => item.itemId.endsWith(":started")).length;
    expect(startsAfter - startsBefore).toBe(1);
  });

  it("stops repeated schema-invalid provider output at the Agent contract boundary", async () => {
    const fixture = await createFixture();
    let planningTurns = 0;
    fixture.providers.get = async () => ({
      name: "mock",
      async runModelTurn(input) {
        const planning = JSON.stringify(input.history).includes("plan-intent-v1");
        if (planning) planningTurns += 1;
        const structured = planning
          ? {
              goalResolution: {
                status: "completed",
                summary: "仍然缺少 graph",
                evidence: [],
                criterionResults: satisfiedCriteria(7),
                residualRisks: [],
                domainOutcome: { result: { plan: "incomplete" } },
              },
            }
          : {
              goalResolution: {
                status: "completed",
                summary: "需求接收完成",
                evidence: [],
                criterionResults: satisfiedCriteria(4),
                residualRisks: [],
                domainOutcome: missionBaselineOutcome(),
              },
            };
        return {
          items: [{
            type: "tool_call" as const,
            callId: `resolve-${planningTurns}`,
            name: "goal_resolution",
            arguments: structured.goalResolution,
          }],
        };
      },
    });

    await fixture.host.createTask({ taskId: "task-no-progress", title: "演示", objective: "构建演示" });
    for (let index = 0; index < 12 && planningTurns < 2; index += 1) await fixture.host.tick();
    expect(planningTurns).toBe(2);
    for (let index = 0; index < 4; index += 1) await fixture.host.tick();
    expect(planningTurns).toBe(2);
  });

  it("blocks and exposes ownership after repeated invalid terminal submissions", async () => {
    let now = new Date("2026-07-24T07:00:00.000Z");
    const fixture = await createFixture({
      now: () => now,
      providerRetryBaseMs: 5_000,
      providerRetryMaxMs: 5_000,
    });
    let modelTurns = 0;
    fixture.providers.get = async () => ({
      name: "mock",
      async runModelTurn() {
        modelTurns += 1;
        return {
          items: [{
            type: "tool_call" as const,
            callId: `invalid-resolution-${modelTurns}`,
            name: "goal_resolution",
            arguments: {},
          }],
        };
      },
    });

    await fixture.host.createTask({ taskId: "task-repeated-invalid-tool", title: "演示", objective: "构建演示" });
    await fixture.host.tick();

    const context = fixture.host.context("task-repeated-invalid-tool")!;
    const link = (await context.manager.current()).links.find((item) => item.agentId === "wa_boss")!;
    expect(modelTurns).toBe(2);
    expect(await context.engines.get("wa_boss")!.getGoal(link.agentGoalId!)).toMatchObject({ status: "active" });
    expect(fixture.host.providerRetryState("task-repeated-invalid-tool", "wa_boss")).toMatchObject({ failures: 1 });
    expect((await context.tickets.getPlan((await context.manager.current()).record.planId)).status).toBe("active");

    await fixture.host.tick();
    expect(modelTurns).toBe(2);

    now = new Date(now.getTime() + 5_000);
    await fixture.host.tick();
    expect(modelTurns).toBe(4);
    now = new Date(now.getTime() + 5_000);
    await fixture.host.tick();

    const snapshot = await fixture.host.snapshot();
    expect(snapshot.status).toBe("blocked");
    expect(snapshot.tickets?.find((ticket) => ticket.status === "blocked")).toMatchObject({
      targetAgentId: "wa_boss",
      targetRole: "boss",
      blocker: { type: "agent_stalled" },
    });
    expect(snapshot.agents.find((agent) => agent.id === "wa_boss")?.status).toBe("blocked");
  });

  it("continues beyond twenty successful Pi tool calls and returns each result to the next model turn", async () => {
    const fixture = await createFixture();
    let modelTurns = 0;
    let correlatedResults = 0;
    fixture.providers.get = async () => ({
      name: "mock",
      async runModelTurn(input) {
        modelTurns += 1;
        if (modelTurns > 1 && input.history.some((item) => item.type === "tool_result")) correlatedResults += 1;
        if (modelTurns <= 25) {
          return {
            items: [{
              type: "tool_call" as const,
              callId: `list-${modelTurns}`,
              name: "listFiles",
              arguments: { path: "." },
            }],
          };
        }
        return {
          items: [{
            type: "tool_call" as const,
            callId: "resolve-after-progress",
            name: "goal_resolution",
            arguments: {
              status: "completed",
              summary: "完成需求接收",
              evidence: [],
              criterionResults: satisfiedCriteria(4),
              residualRisks: [],
              domainOutcome: missionBaselineOutcome(),
            },
          }],
        };
      },
    });

    await fixture.host.createTask({ taskId: "task-many-tools", title: "演示", objective: "构建演示" });
    for (let index = 0; index < 40 && modelTurns < 26; index += 1) await fixture.host.tick();

    expect(modelTurns).toBe(26);
    expect(correlatedResults).toBe(25);
    const context = fixture.host.context("task-many-tools")!;
    const link = (await context.manager.current()).links.find((item) => item.agentId === "wa_boss")!;
    expect(await context.engines.get("wa_boss")!.getGoal(link.agentGoalId!)).toMatchObject({ status: "completed" });
  });

  it("continues an active Goal after an ordinary assistant reply until a resolution is submitted", async () => {
    const fixture = await createFixture();
    let modelTurns = 0;
    fixture.providers.get = async () => ({
      name: "mock",
      async runModelTurn() {
        modelTurns += 1;
        if (modelTurns === 1) {
          return { items: [{ type: "assistant_message" as const, content: "当前没有现成源码，需要确认是否继续。" }] };
        }
        if (modelTurns === 2) {
          return {
            items: [{
              type: "tool_call" as const,
              callId: "inspect-empty-workspace",
              name: "listFiles",
              arguments: { path: "." },
            }],
          };
        }
        return {
          items: [{
            type: "tool_call" as const,
            callId: "resolve-after-continuation",
            name: "goal_resolution",
            arguments: {
              status: "completed",
              summary: "已继续处理并完成目标",
              evidence: [],
              criterionResults: satisfiedCriteria(4),
              residualRisks: [],
              domainOutcome: missionBaselineOutcome(),
            },
          }],
        };
      },
    });

    await fixture.host.createTask({ taskId: "task-goal-continuation", title: "演示", objective: "构建演示" });
    await fixture.host.tick();
    await fixture.host.tick();
    await fixture.host.tick();

    // Each model decision is now a separate scheduled turn. Background ticks
    // may drain more than one turn while the task is active, but completion
    // must still come from the third provider decision (the resolution).
    expect(modelTurns).toBeGreaterThanOrEqual(3);
    const context = fixture.host.context("task-goal-continuation")!;
    const link = (await context.manager.current()).links.find((item) => item.agentId === "wa_boss")!;
    expect(await context.engines.get("wa_boss")!.getGoal(link.agentGoalId!)).toMatchObject({ status: "completed" });
  });

  it("does not replay an active ticket after a non-retryable provider failure", async () => {
    const fixture = await createFixture();
    let modelTurns = 0;
    fixture.providers.get = async () => ({
      name: "mock",
      async runModelTurn() {
        modelTurns += 1;
        throw new ProviderError("402 Insufficient Balance", false, "OPENAI_ERROR");
      },
    });

    await fixture.host.createTask({ taskId: "task-provider-blocked", title: "演示", objective: "构建演示" });
    await fixture.host.tick();
    await fixture.host.tick();

    const context = fixture.host.context("task-provider-blocked")!;
    const bossLink = (await context.manager.current()).links.find((item) => item.agentId === "wa_boss")!;
    const boss = context.engines.get("wa_boss")!;
    expect(modelTurns).toBe(1);
    expect(await boss.getGoal(bossLink.agentGoalId!)).toMatchObject({ status: "paused" });
    expect((await context.tickets.getPlan((await context.manager.current()).record.planId)).status).toBe("blocked");
    const thread = await boss.getThreadForAgent("wa_boss", "task-provider-blocked");
    await boss.appendToolItem({
      itemId: "stale-running-after-pause",
      threadId: thread!.threadId,
      goalId: bossLink.agentGoalId,
      kind: "control",
      value: { status: "running" },
      createdAt: "2026-07-10T00:05:00.000Z",
    });

    const snapshot = await fixture.host.snapshot();
    expect(snapshot.agents.find((agent) => agent.id === "wa_boss")?.status).toBe("blocked");
  });

  it("keeps the same Goal active and retries a transient provider failure after backoff", async () => {
    let now = new Date("2026-07-24T06:00:00.000Z");
    const fixture = await createFixture({
      now: () => now,
      providerRetryBaseMs: 5_000,
      providerRetryMaxMs: 5_000,
    });
    let providerAvailable = false;
    let modelTurns = 0;
    fixture.providers.get = async () => ({
      name: "mock",
      async runModelTurn() {
        modelTurns += 1;
        if (!providerAvailable && modelTurns === 1) {
          return {
            items: [{
              type: "tool_call" as const,
              callId: "observe-before-provider-failure",
              name: "listFiles",
              arguments: { path: "." },
            }],
          };
        }
        if (!providerAvailable) throw new ProviderError("502 status code (no body)", true, "OPENAI_ERROR");
        return {
          items: [{
            type: "tool_call" as const,
            callId: "resolve-after-provider-recovery",
            name: "goal_resolution",
            arguments: {
              status: "completed",
              summary: "Provider 恢复后完成原 Goal",
              evidence: [],
              criterionResults: satisfiedCriteria(4),
              residualRisks: [],
              domainOutcome: missionBaselineOutcome(),
            },
          }],
        };
      },
    });

    await fixture.host.createTask({ taskId: "task-provider-retry", title: "演示", objective: "构建演示" });
    await fixture.host.tick();
    const context = fixture.host.context("task-provider-retry")!;
    const link = (await context.manager.current()).links.find((item) => item.agentId === "wa_boss")!;
    const boss = context.engines.get("wa_boss")!;

    expect(modelTurns).toBe(1);
    expect(await boss.getGoal(link.agentGoalId!)).toMatchObject({ status: "active" });
    expect(fixture.host.providerRetryState("task-provider-retry", "wa_boss")).toBeUndefined();

    await fixture.host.tick();
    expect(modelTurns).toBe(2);
    expect(fixture.host.providerRetryState("task-provider-retry", "wa_boss")).toMatchObject({ failures: 1 });

    await fixture.host.tick();
    expect(modelTurns).toBe(2);

    providerAvailable = true;
    now = new Date(now.getTime() + 5_000);
    let providerRetryDebug = "";
    await waitFor(async () => {
      await fixture.host.tick();
      const goalStatus = (await boss.getGoal(link.agentGoalId!))?.status;
      providerRetryDebug = JSON.stringify({
        goalStatus,
        modelTurns,
        retry: fixture.host.providerRetryState("task-provider-retry", "wa_boss"),
        linkStatus: (await context.manager.current()).links.find((item) => item.agentGoalId === link.agentGoalId)?.status,
        readiness: await boss.executionReadiness(link.agentGoalId!),
      });
      return goalStatus === "completed";
    }, 5_000).catch((error) => {
      throw new Error(`${String(error)} ${providerRetryDebug}`);
    });

    expect(modelTurns).toBeGreaterThanOrEqual(2);
    expect(await boss.getGoal(link.agentGoalId!)).toMatchObject({ status: "completed" });
    expect(fixture.host.providerRetryState("task-provider-retry", "wa_boss")).toBeUndefined();
  });

  it("keeps the same Goal active and retries a malformed terminal submission after backoff", async () => {
    let now = new Date("2026-07-24T07:00:00.000Z");
    const fixture = await createFixture({
      now: () => now,
      providerRetryBaseMs: 5_000,
      providerRetryMaxMs: 5_000,
    });
    let terminalContractValid = false;
    let modelTurns = 0;
    fixture.providers.get = async () => ({
      name: "mock",
      async runModelTurn() {
        modelTurns += 1;
        return {
          items: [{
            type: "tool_call" as const,
            callId: `terminal-${modelTurns}`,
            name: "goal_resolution",
            arguments: terminalContractValid
              ? {
                  status: "completed",
                  summary: "鍚堟硶缁堝眬鎻愪氦",
                  evidence: [],
                  criterionResults: satisfiedCriteria(4),
                  residualRisks: [],
                  domainOutcome: missionBaselineOutcome(),
                }
              : {
                  summary: "缂哄皯蹇呭～ status",
                  evidence: [],
                  residualRisks: [],
                  domainOutcome: missionBaselineOutcome(),
                },
          }],
        };
      },
    });

    await fixture.host.createTask({
      taskId: "task-terminal-retry",
      title: "缁堝眬鍗忚閲嶈瘯",
      objective: "淇濇寔鍘?Goal 骞堕噸璇曞悎娉曠粓灞€",
    });
    await fixture.host.tick();
    const context = fixture.host.context("task-terminal-retry")!;
    const link = (await context.manager.current()).links.find((item) => item.agentId === "wa_boss")!;
    const boss = context.engines.get("wa_boss")!;

    expect(modelTurns).toBe(2);
    expect(await boss.getGoal(link.agentGoalId!)).toMatchObject({ status: "active" });
    expect(fixture.host.providerRetryState("task-terminal-retry", "wa_boss")).toMatchObject({ failures: 1 });
    expect(await context.tickets.getTicket(link.ticketId!)).toMatchObject({ status: "running" });

    await fixture.host.tick();
    const turnsBeforeRetry = modelTurns;
    expect(modelTurns).toBe(turnsBeforeRetry);

    terminalContractValid = true;
    now = new Date(now.getTime() + 5_000);
    let terminalRetryDebug = "";
    await waitFor(async () => {
      await fixture.host.tick();
      const goalStatus = (await boss.getGoal(link.agentGoalId!))?.status;
      terminalRetryDebug = JSON.stringify({
        goalStatus,
        modelTurns,
        retry: fixture.host.providerRetryState("task-terminal-retry", "wa_boss"),
        linkStatus: (await context.manager.current()).links.find((item) => item.agentGoalId === link.agentGoalId)?.status,
        readiness: await boss.executionReadiness(link.agentGoalId!),
      });
      return goalStatus === "completed";
    }, 5_000).catch((error) => {
      throw new Error(`${String(error)} ${terminalRetryDebug}`);
    });

    expect(await boss.getGoal(link.agentGoalId!)).toMatchObject({ status: "completed" });
    expect(fixture.host.providerRetryState("task-terminal-retry", "wa_boss")).toBeUndefined();
  });

  it("persists provider backoff across host restart without changing Ticket state", async () => {
    let now = new Date("2026-07-24T07:00:00.000Z");
    const fixture = await createFixture({
      now: () => now,
      providerRetryBaseMs: 5_000,
      providerRetryMaxMs: 5_000,
    });
    let providerAvailable = false;
    let modelTurns = 0;
    fixture.providers.get = async () => ({
      name: "mock",
      async runModelTurn() {
        modelTurns += 1;
        if (!providerAvailable) throw new ProviderError("502 Bad Gateway", true, "UPSTREAM_ERROR");
        return {
          items: [{
            type: "tool_call" as const,
            callId: `complete-after-retry-${modelTurns}`,
            name: "goal_resolution",
            arguments: {
              status: "completed",
              summary: "Provider 恢复后完成",
              evidence: [],
              criterionResults: satisfiedCriteria(4),
              residualRisks: [],
              domainOutcome: missionBaselineOutcome(),
            },
          }],
        };
      },
    });

    await fixture.host.createTask({ taskId: "task-provider-restart", title: "重启恢复", objective: "验证 Provider 退避可恢复" });
    await fixture.host.tick();
    expect(modelTurns).toBe(1);
    expect(fixture.host.providerRetryState("task-provider-restart", "wa_boss")).toMatchObject({ failures: 1, retryAt: now.getTime() + 5_000 });
    expect((await fixture.host.context("task-provider-restart")!.tickets.getPlan((await fixture.host.context("task-provider-restart")!.manager.current()).record.planId)).status).toBe("active");

    await fixture.host.stop();
    const restarted = new RuntimeHost(
      fixture.workspace,
      fixture.profiles,
      fixture.providers,
      fixture.policyStore,
      fixture.policyRef,
      { intervalMs: 60_000, now: () => now, providerRetryBaseMs: 5_000, providerRetryMaxMs: 5_000 },
    );
    await restarted.recover();
    expect(restarted.providerRetryState("task-provider-restart", "wa_boss")).toMatchObject({ failures: 1, retryAt: now.getTime() + 5_000 });
    await restarted.tick();
    expect(modelTurns).toBe(1);
    const restartedContext = restarted.context("task-provider-restart")!;
    const restartedLink = (await restartedContext.manager.current()).links.find((link) => link.agentId === "wa_boss")!;
    const restartedBoss = restartedContext.engines.get("wa_boss")!;

    providerAvailable = true;
    now = new Date(now.getTime() + 5_000);
    let retryDebug = "";
    await waitFor(async () => {
      await restarted.tick();
      const snapshot = await restarted.snapshot();
      const goal = await restartedBoss.getGoal(restartedLink.agentGoalId!);
      retryDebug = JSON.stringify({
        modelTurns,
        status: snapshot.status,
        phase: snapshot.phase,
        goalStatus: goal?.status,
        retry: restarted.providerRetryState("task-provider-restart", "wa_boss"),
        tickets: snapshot.tickets?.map((ticket) => ({ id: ticket.id, status: ticket.status })),
      });
      return goal?.status === "completed";
    }, 5_000).catch((error) => {
      throw new Error(`${String(error)} ${retryDebug}`);
    });
    expect(modelTurns).toBe(2);
    expect(restarted.providerRetryState("task-provider-restart", "wa_boss")).toBeUndefined();
    await restarted.stop();
  });

  it("restores a queued human message with the same Goal after Provider backoff and restart", async () => {
    let now = new Date("2026-07-24T08:00:00.000Z");
    const fixture = await createFixture({
      now: () => now,
      providerRetryBaseMs: 5_000,
      providerRetryMaxMs: 5_000,
    });
    let providerAvailable = false;
    let modelTurns = 0;
    const modelTurnsByTicket = new Map<string, number>();
    fixture.providers.get = async () => ({
      name: "mock",
      async runModelTurn(input) {
        modelTurns += 1;
        const prompt = [...input.history].reverse().find((item) => item.type === "user_message")?.content ?? "";
        const ticketId = prompt.match(/- ticket: ([^\r\n]+)/)?.[1];
        if (ticketId) modelTurnsByTicket.set(ticketId, (modelTurnsByTicket.get(ticketId) ?? 0) + 1);
        if (!providerAvailable) throw new ProviderError("502 Bad Gateway", true, "UPSTREAM_ERROR");
        const latestHuman = [...input.history]
          .reverse()
          .find((item) => item.type === "user_message")
          ?.content ?? "";
        return {
          items: [{
            type: "tool_call" as const,
            callId: "complete-after-human-recovery",
            name: "goal_resolution",
            arguments: {
              status: "completed",
              summary: `恢复后完成：${latestHuman}`,
              evidence: [],
              criterionResults: satisfiedCriteria(4),
              residualRisks: [],
              domainOutcome: missionBaselineOutcome(),
            },
          }],
        };
      },
    });

    await fixture.host.createTask({
      taskId: "task-provider-human-restart",
      title: "Provider 与人工消息恢复",
      objective: "验证 Provider 中断后人工补充仍进入原 Goal",
    });
    await fixture.host.tick();
    const context = fixture.host.context("task-provider-human-restart")!;
    const before = await context.manager.current();
    const link = before.links.find((item) => item.agentId === "wa_boss")!;
    const beforeGoalId = link.agentGoalId!;
    const beforeThreadId = link.agentThreadId!;
    const beforeTicketId = link.ticketId;
    expect(modelTurns).toBe(1);
    expect(fixture.host.providerRetryState("task-provider-human-restart", "wa_boss")).toBeDefined();

    await fixture.host.pauseTask("task-provider-human-restart");
    await fixture.host.sendAgentMessage(
      "task-provider-human-restart",
      "wa_boss",
      "Provider 恢复后请继续，并保留这条人工事实",
      "human-after-provider-failure",
    );
    expect(modelTurns).toBe(1);
    await fixture.host.stop();

    providerAvailable = true;
    now = new Date(now.getTime() + 5_000);
    const restarted = new RuntimeHost(
      fixture.workspace,
      fixture.profiles,
      fixture.providers,
      fixture.policyStore,
      fixture.policyRef,
      { intervalMs: 60_000, now: () => now, providerRetryBaseMs: 5_000, providerRetryMaxMs: 5_000 },
    );
    await restarted.recover();
    await restarted.resumeTask("task-provider-human-restart");

    const restartedContext = restarted.context("task-provider-human-restart")!;
    const restartedLink = (await restartedContext.manager.current()).links.find((item) => item.agentId === "wa_boss")!;
    const restartedBoss = restartedContext.engines.get("wa_boss")!;
    await waitFor(async () => {
      await restarted.tick();
      return (await restartedBoss.getGoal(restartedLink.agentGoalId!))?.status === "completed";
    }, 5_000);

    expect(restartedLink.agentGoalId).toBe(beforeGoalId);
    expect(restartedLink.agentThreadId).toBe(beforeThreadId);
    expect(modelTurnsByTicket.get(beforeTicketId)).toBe(2);
    expect(modelTurns).toBeGreaterThanOrEqual(2);
    const thread = await restartedBoss.getThread(beforeThreadId);
    const payloads = await restartedBoss.getPayloads(thread!.items.map((item) => item.payloadRef));
    const restoredPayloads = [...payloads.values()] as Array<{ messageId?: string }>;
    expect(restoredPayloads.filter((payload) => payload.messageId === "human-after-provider-failure")).toHaveLength(1);
    expect([...payloads.values()]).toContainEqual(expect.objectContaining({
      messageId: "human-after-provider-failure",
      content: "Provider 恢复后请继续，并保留这条人工事实",
    }));
    await restarted.stop();
  });

  it("resumes a provider-paused Agent when human sends a new private message", async () => {
    const fixture = await createFixture();
    let providerAvailable = false;
    fixture.providers.get = async () => ({
      name: "mock",
      async runModelTurn() {
        if (!providerAvailable) throw new ProviderError("402 Insufficient Balance", false, "OPENAI_ERROR");
        return { items: [{ type: "assistant_message" as const, content: "继续处理" }] };
      },
    });
    await fixture.host.createTask({ taskId: "task-provider-resume", title: "演示", objective: "构建演示" });
    await fixture.host.tick();
    const context = fixture.host.context("task-provider-resume")!;
    const link = (await context.manager.current()).links.find((item) => item.agentId === "wa_boss")!;
    expect(await context.engines.get("wa_boss")!.getGoal(link.agentGoalId!)).toMatchObject({ status: "paused" });

    providerAvailable = true;
    await fixture.host.sendAgentMessage("task-provider-resume", "wa_boss", "余额已恢复，请继续");
    await waitFor(async () => (await context.engines.get("wa_boss")!.getGoal(link.agentGoalId!))?.status === "active");

    expect(await context.engines.get("wa_boss")!.getGoal(link.agentGoalId!)).toMatchObject({ status: "active" });
  });

  it("starts a new turn when the same human message is sent after another pause", async () => {
    const fixture = await createFixture();
    let providerTurns = 0;
    fixture.providers.get = async () => ({
      name: "mock",
      async runModelTurn() {
        providerTurns += 1;
        throw new ProviderError("402 Insufficient Balance", false, "OPENAI_ERROR");
      },
    });
    await fixture.host.createTask({ taskId: "task-repeated-human-message", title: "演示", objective: "构建演示" });
    await fixture.host.tick();
    const context = fixture.host.context("task-repeated-human-message")!;
    const engine = context.engines.get("wa_boss")!;
    const link = (await context.manager.current()).links.find((item) => item.agentId === "wa_boss")!;
    expect(await engine.getGoal(link.agentGoalId!)).toMatchObject({ status: "paused" });

    await fixture.host.sendAgentMessage("task-repeated-human-message", "wa_boss", "继续", "human-message-1");
    await waitFor(async () => (await engine.getGoal(link.agentGoalId!))?.status === "paused" && providerTurns >= 2);

    await fixture.host.sendAgentMessage("task-repeated-human-message", "wa_boss", "继续", "human-message-2");
    await waitFor(async () => (await engine.getGoal(link.agentGoalId!))?.status === "paused" && providerTurns >= 3);
    const turnsAfterSecondMessage = providerTurns;

    await fixture.host.sendAgentMessage("task-repeated-human-message", "wa_boss", "继续", "human-message-2");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(providerTurns).toBe(turnsAfterSecondMessage);
  });

  it("correlates a human message and every resulting item with one durable turn id", async () => {
    const fixture = await createFixture();
    let providerAvailable = false;
    fixture.providers.get = async () => ({
      name: "mock",
      async runModelTurn() {
        if (!providerAvailable) throw new ProviderError("provider unavailable", false, "OPENAI_ERROR");
        return { items: [{ type: "assistant_message" as const, content: "收到并继续" }] };
      },
    });
    await fixture.host.createTask({ taskId: "task-human-turn", title: "演示", objective: "构建演示" });
    await fixture.host.tick();
    const context = fixture.host.context("task-human-turn")!;
    const engine = context.engines.get("wa_boss")!;
    providerAvailable = true;

    await fixture.host.sendAgentMessage("task-human-turn", "wa_boss", "继续", "human-turn-message");
    await waitFor(async () => {
      const thread = await engine.getThreadForAgent("wa_boss", "task-human-turn");
      return thread?.items.some((item) => item.kind === "model" && item.sequence > 1) === true;
    }, 10_000);

    const thread = (await engine.getThreadForAgent("wa_boss", "task-human-turn"))!;
    const humanIndex = thread.items.findIndex((item) => item.itemId === "human-turn-message");
    const correlated = thread.items.slice(humanIndex);
    const turnId = (correlated[0] as { turnId?: string }).turnId;
    expect(turnId).toMatch(/^turn_/);
    expect(correlated.length).toBeGreaterThan(2);
    expect(correlated.every((item) => (item as { turnId?: string }).turnId === turnId)).toBe(true);

    const snapshot = await fixture.host.snapshot();
    const projected = snapshot.agentThreads?.wa_boss?.filter((item) => item.sequence >= correlated[0].sequence) ?? [];
    expect(projected.length).toBeGreaterThanOrEqual(correlated.length);
    expect(projected.every((item) => item.turnId === turnId)).toBe(true);
  });

  it("recovers a persisted human turn before model execution without changing its turn id", async () => {
    const fixture = await createFixture();
    let providerAvailable = false;
    let providerTurns = 0;
    fixture.providers.get = async () => ({
      name: "mock",
      async runModelTurn() {
        providerTurns += 1;
        if (!providerAvailable) throw new ProviderError("provider unavailable", false, "OPENAI_ERROR");
        return {
          items: [{
            type: "tool_call" as const,
            callId: "resolve-recovered-human-turn",
            name: "goal_resolution",
            arguments: {
              status: "completed",
              evidence: [],
              criterionResults: satisfiedCriteria(4),
              residualRisks: [],
              domainOutcome: missionBaselineOutcome(),
            },
          }],
        };
      },
    });
    await fixture.host.createTask({ taskId: "task-recover-human-turn", title: "演示", objective: "构建演示" });
    await fixture.host.tick();
    const context = fixture.host.context("task-recover-human-turn")!;
    const engine = context.engines.get("wa_boss")!;
    const link = (await context.manager.current()).links.find((item) => item.agentId === "wa_boss")!;
    const goal = (await engine.getGoal(link.agentGoalId!))!;
    const thread = (await engine.getThreadForAgent("wa_boss", "task-recover-human-turn"))!;
    const turnId = "turn_durable_human_message";
    await engine.sendMessage({
      messageId: "human-before-runtime-restart",
      turnId,
      threadId: thread.threadId,
      goalId: goal.spec.id,
      senderPrincipalId: "human",
      content: "继续",
      createdAt: "2026-07-10T00:10:00.000Z",
    });
    await engine.controlGoal({
      requestId: "resume-before-runtime-restart",
      goalId: goal.spec.id,
      expectedGoalVersion: goal.version,
      action: "resume",
      reason: "persisted human message",
    });
    await fixture.host.stop();

    providerAvailable = true;
    const restarted = new RuntimeHost(
      fixture.workspace,
      fixture.profiles,
      fixture.providers,
      fixture.policyStore,
      fixture.policyRef,
      { intervalMs: 60_000 },
    );
    await restarted.recover();
    await restarted.tick();

    expect(providerTurns).toBeGreaterThanOrEqual(2);
    const recoveredEngine = restarted.context("task-recover-human-turn")!.engines.get("wa_boss")!;
    const recoveredThread = (await recoveredEngine.getThreadForAgent("wa_boss", "task-recover-human-turn"))!;
    const correlated = recoveredThread.items.filter((item) => item.turnId === turnId);
    expect(correlated.map((item) => item.kind)).toEqual(expect.arrayContaining(["message", "control", "tool", "observation"]));
    expect(correlated.every((item) => item.turnId === turnId)).toBe(true);
    const started = correlated.find((item) => item.itemId === `${turnId}:started`)!;
    expect(await recoveredEngine.getPayload(started.payloadRef)).toMatchObject({
      turnId,
      triggerMessageId: "human-before-runtime-restart",
      status: "running",
    });
    await restarted.stop();
  });

  it("serves a read-only snapshot while a model turn is still running", async () => {
    const fixture = await createFixture();
    let holdModel = false;
    let releaseModel!: () => void;
    let announceModelStart!: () => void;
    const modelGate = new Promise<void>((resolve) => { releaseModel = resolve; });
    const modelStarted = new Promise<void>((resolve) => { announceModelStart = resolve; });
    fixture.providers.get = async () => ({
      name: "mock",
      async runModelTurn() {
        if (holdModel) {
          announceModelStart();
          await modelGate;
        }
        return { items: [{ type: "assistant_message" as const, content: "继续处理。" }] };
      },
    });
    await fixture.host.createTask({ taskId: "task-live-snapshot", title: "演示", objective: "构建演示" });
    holdModel = true;
    const runningTick = fixture.host.tick();
    await modelStarted;

    const snapshotResult = await Promise.race([
      fixture.host.snapshot().then((snapshot) => snapshot.status),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 1_000)),
    ]);
    releaseModel();
    await runningTick;

    expect(snapshotResult).not.toBe("timeout");
  });

  it("truncates oversized UI event payloads without changing the stored Agent thread", async () => {
    const fixture = await createFixture();
    await fixture.host.createTask({ taskId: "task-large-observation", title: "演示", objective: "构建演示" });
    await fixture.host.tick();
    const engine = fixture.host.context("task-large-observation")!.engines.get("wa_boss")!;
    const thread = (await engine.getThreadForAgent("wa_boss", "task-large-observation"))!;
    const content = "x".repeat(100_000);
    await engine.appendToolItem({
      itemId: "large-observation",
      threadId: thread.threadId,
      kind: "observation",
      value: { tool: "readFile", ok: true, content },
      createdAt: "2026-07-10T00:03:00.000Z",
    });

    const snapshot = await fixture.host.snapshot();
    const event = snapshot.agentThreads!.wa_boss.find((item) => item.id === "large-observation")!;

    expect(String(event.payload.content).length).toBeLessThan(10_000);
    expect(event.payload).toMatchObject({ truncated: true, originalChars: 100_000 });
    expect(await engine.getPayload("observation:large-observation")).toMatchObject({ content });
  });

  it("starts and stops an unrefed production timer", async () => {
    const fixture = await createFixture();
    await fixture.host.start();
    await fixture.host.stop();
  });

  it("contains a background staffing failure inside the affected task", async () => {
    const fixture = await createFixture({ useStaffing: true });
    await fixture.host.createTask({ taskId: "task-staffing-failure", title: "Build", objective: "Build a product" });
    const host = fixture.host as unknown as {
      staffing: { runOnce(taskId: string): Promise<never> };
      tickUnlocked(awaitAgentRuns?: boolean): Promise<void>;
    };
    host.staffing.runOnce = async () => {
      throw new Error("staffing state is inconsistent");
    };

    await expect(host.tickUnlocked(false)).resolves.toBeUndefined();
    let snapshot = await fixture.host.snapshot();
    for (let attempt = 0; attempt < 20 && snapshot.status !== "failed"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      snapshot = await fixture.host.snapshot();
    }

    expect(snapshot.status).toBe("failed");
    expect(snapshot.runtimeError).toMatchObject({
      source: "staffing",
      message: "staffing state is inconsistent",
    });
  });

  it("drains a wake requested while a background tick is already running", async () => {
    const fixture = await createFixture({ intervalMs: 60_000 });
    await fixture.host.start();
    const host = fixture.host as unknown as {
      backgroundTick(): Promise<void>;
      tickUnlocked(awaitAgentRuns?: boolean): Promise<void>;
    };
    const originalTick = host.tickUnlocked.bind(host);
    let calls = 0;
    let releaseFirst!: () => void;
    let announceFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => { announceFirst = resolve; });
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    host.tickUnlocked = async (awaitAgentRuns) => {
      calls += 1;
      if (calls === 1) {
        announceFirst();
        await firstGate;
      }
      await originalTick(awaitAgentRuns);
    };

    const first = host.backgroundTick();
    await firstStarted;
    const coalesced = host.backgroundTick();
    releaseFirst();
    await Promise.all([first, coalesced]);
    await fixture.host.stop();

    expect(calls).toBe(2);
  });

  it("automatically dispatches work made ready by the previous Agent turn", async () => {
    const fixture = await createFixture({ intervalMs: 10 });
    await fixture.host.createTask({
      taskId: "task-production-scheduler",
      title: "生产调度验证",
      objective: "构建一个可验证的演示",
    });

    await fixture.host.start();
    await waitFor(async () => {
      const mission = await fixture.host.context("task-production-scheduler")!.manager.current();
      return mission.links.some((link) => link.agentId === "wa_pm");
    }, 5_000);
    await fixture.host.stop();

    const mission = await fixture.host.context("task-production-scheduler")!.manager.current();
    expect(mission.links).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentId: "wa_boss", status: "settled" }),
      expect.objectContaining({ agentId: "wa_pm" }),
    ]));
  });

  it("re-schedules a downstream Agent without waiting for another timer tick", async () => {
    const fixture = await createFixture({ intervalMs: 60_000 });
    await fixture.host.createTask({
      taskId: "task-downstream-wakeup",
      title: "下游唤醒",
      objective: "验证上游结算后下游会自动开始",
    });
    await fixture.host.start();
    await fixture.host.tick();

    await waitFor(async () => {
      const mission = await fixture.host.context("task-downstream-wakeup")!.manager.current();
      return mission.links.some((link) => link.agentId === "wa_pm");
    }, 5_000);

    const mission = await fixture.host.context("task-downstream-wakeup")!.manager.current();
    expect(mission.links).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentId: "wa_boss", status: "settled" }),
      expect.objectContaining({ agentId: "wa_pm" }),
    ]));
    await fixture.host.stop();
  });

  it("persists a scheduler exception in the task snapshot instead of hiding it in the console", async () => {
    const fixture = await createFixture();
    await fixture.host.createTask({
      taskId: "task-visible-scheduler-error",
      title: "可见调度异常",
      objective: "验证运行时错误可恢复且可见",
    });
    const context = fixture.host.context("task-visible-scheduler-error")!;
    context.manager.tick = async () => {
      throw new Error("scheduler test failure");
    };

    await fixture.host.tick();

    expect((await fixture.host.snapshot()).runtimeError).toMatchObject({
      source: "scheduler",
      message: "scheduler test failure",
    });
    await fixture.host.stop();
  });

  it("keeps production control responsive while an Agent turn is still running", async () => {
    const fixture = await createFixture({ intervalMs: 100 });
    await fixture.host.start();
    await fixture.host.createTask({
      taskId: "task-slow-agent",
      title: "慢 Agent 验证",
      objective: "验证调度隔离",
    });
    const context = fixture.host.context("task-slow-agent")!;
    let releaseTurn!: () => void;
    let releasedGoalResources = 0;
    const turnStarted = new Promise<void>((resolve) => {
      const loop = context.loops.get("wa_boss")!;
      loop.runSlice = async () => {
        resolve();
        await new Promise<void>((release) => { releaseTurn = release; });
        return { turnId: "slow-turn", status: "waiting", toolCalls: 0 };
      };
      loop.releaseGoalResources = async () => {
        releasedGoalResources += 1;
        releaseTurn();
      };
    });

    await turnStarted;
    const controlResult = await Promise.race([
      fixture.host.pauseTask("task-slow-agent").then(() => "paused"),
      new Promise<string>((resolve) => setTimeout(() => resolve("timed-out"), 2_000)),
    ]);
    await fixture.host.stop();

    expect(controlResult).toBe("paused");
    expect(releasedGoalResources).toBe(1);
  });

  it("does not convert an aborted in-flight Agent turn into a blocker after operator pause", async () => {
    const fixture = await createFixture({ intervalMs: 100 });
    await fixture.host.start();
    await fixture.host.createTask({
      taskId: "task-late-result-after-pause",
      title: "暂停后的晚到结果",
      objective: "验证暂停不会被晚到的 Agent 结果改写",
    });
    const context = fixture.host.context("task-late-result-after-pause")!;
    let releaseTurn!: () => void;
    let invocation = 0;
    const turnStarted = new Promise<void>((resolve) => {
      const loop = context.loops.get("wa_boss")!;
      loop.runSlice = async (input) => {
        resolve();
        invocation += 1;
        if (invocation === 1) {
          await new Promise<void>((release) => { releaseTurn = release; });
          const goal = input.goalId ? await context.engines.get("wa_boss")!.getGoal(input.goalId) : undefined;
          return {
            turnId: "late-provider-abort",
            status: "execution_blocked" as const,
            toolCalls: 0,
            goal: goal ? { ...goal, status: "active" as const } : undefined,
            blockReason: "provider_error" as const,
            blockedMessage: "Request was aborted by operator pause",
          };
        }
        return { turnId: input.turnId ?? "after-resume", status: "waiting" as const, toolCalls: 0 };
      };
      loop.releaseGoalResources = async () => { releaseTurn(); };
    });

    await turnStarted;
    await fixture.host.pauseTask("task-late-result-after-pause");
    const paused = await fixture.host.snapshot();
    expect(paused.status).toBe("paused");
    expect((paused.tickets ?? []).some((ticket) => ticket.status === "blocked")).toBe(false);

    await fixture.host.resumeTask("task-late-result-after-pause");
    expect((await fixture.host.snapshot()).status).not.toBe("paused");
    await fixture.host.stop();
  });

  it("releases Agent resources when operator cancellation stops a running turn", async () => {
    const fixture = await createFixture({ intervalMs: 100 });
    await fixture.host.start();
    await fixture.host.createTask({
      taskId: "task-cancel-running-agent",
      title: "运行中取消验证",
      objective: "验证取消不会留下运行中的 Agent",
    });
    const context = fixture.host.context("task-cancel-running-agent")!;
    let releaseTurn!: () => void;
    let releasedGoalResources = 0;
    const turnStarted = new Promise<void>((resolve) => {
      const loop = context.loops.get("wa_boss")!;
      loop.runSlice = async () => {
        resolve();
        await new Promise<void>((release) => { releaseTurn = release; });
        return { turnId: "cancelled-turn", status: "waiting", toolCalls: 0 };
      };
      loop.releaseGoalResources = async () => {
        releasedGoalResources += 1;
        releaseTurn();
      };
    });

    await turnStarted;
    const cancellation = await Promise.race([
      fixture.host.cancelTask("task-cancel-running-agent", "operator cancelled acceptance run").then(() => "cancelled"),
      new Promise<string>((resolve) => setTimeout(() => resolve("timed-out"), 2_000)),
    ]);
    await fixture.host.stop();

    expect(cancellation).toBe("cancelled");
    expect(releasedGoalResources).toBe(1);
    expect((await fixture.host.snapshot()).agents.every((agent) => agent.status !== "running")).toBe(true);
  });

  it("queues a private message while the Plan is paused and delivers it to the same Goal after resume", async () => {
    const fixture = await createFixture({ intervalMs: 100 });
    await fixture.host.createTask({
      taskId: "task-paused-private-message",
      title: "Paused private message",
      objective: "preserve chronological Agent input while paused",
    });
    const context = fixture.host.context("task-paused-private-message")!;
    const initialLink = (await context.manager.tick()).links.find((item) => item.agentId === "wa_boss")!;
    const loop = context.loops.get("wa_boss")!;
    const inputs: Array<{ goalId?: string; triggerMessageId?: string }> = [];
    let delivered!: () => void;
    const delivery = new Promise<void>((resolve) => { delivered = resolve; });
    loop.runSlice = async (input) => {
      inputs.push({ goalId: input.goalId, triggerMessageId: input.triggerMessageId });
      delivered();
      return { turnId: input.turnId ?? "paused-message-turn", status: "waiting", toolCalls: 0 };
    };

    await fixture.host.pauseTask("task-paused-private-message");
    await fixture.host.sendAgentMessage(
      "task-paused-private-message",
      "wa_boss",
      "resume with this chronological fact",
      "paused-private-message",
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(inputs).toHaveLength(0);
    const pausedGoal = await context.engines.get("wa_boss")!.getGoal(initialLink.agentGoalId!);
    expect(pausedGoal?.status).toBe("paused");

    await fixture.host.resumeTask("task-paused-private-message");
    await delivery;

    expect(inputs).toEqual([{
      goalId: initialLink.agentGoalId,
      triggerMessageId: "paused-private-message",
    }]);
  });

  it("resumes a blocked Goal when its human reply was queued while the Plan was paused", async () => {
    const fixture = await createFixture({ intervalMs: 100 });
    let modelTurns = 0;
    fixture.providers.get = async () => ({
      name: "mock",
      async runModelTurn() {
        modelTurns += 1;
        if (modelTurns === 1) {
          return {
            items: [{
              type: "tool_call" as const,
              callId: "blocked-before-pause",
              name: "request_human_input",
              arguments: {
                kind: "external_fact",
                description: "need one human fact",
              },
            }],
          };
        }
        return {
          items: [{
            type: "tool_call" as const,
            callId: "complete-after-resume",
            name: "goal_resolution",
            arguments: {
              status: "completed",
              summary: "completed after the queued human reply",
              evidence: [],
              criterionResults: satisfiedCriteria(4),
              residualRisks: [],
              domainOutcome: missionBaselineOutcome(),
            },
          }],
        };
      },
    });
    await fixture.host.createTask({
      taskId: "task-blocked-paused-message",
      title: "Blocked paused message",
      objective: "resume the same blocked Goal",
    });
    await fixture.host.tick();
    await waitFor(async () => (
      (await fixture.host.context("task-blocked-paused-message")!.manager.current())
        .links.some((link) => link.status === "blocked")
    ), 5_000);

    await fixture.host.pauseTask("task-blocked-paused-message");
    const blocked = (await fixture.host.context("task-blocked-paused-message")!.manager.current())
      .links.find((link) => link.status === "blocked")!;
    await fixture.host.sendAgentMessage(
      "task-blocked-paused-message",
      blocked.agentId,
      "the missing fact",
      "blocked-message-while-paused",
    );
    expect(modelTurns).toBe(1);

    await fixture.host.resumeTask("task-blocked-paused-message");
    await waitFor(async () => modelTurns === 2, 5_000);

    expect(modelTurns).toBe(2);
    const mission = await fixture.host.context("task-blocked-paused-message")!.manager.current();
    const events = await fixture.host.context("task-blocked-paused-message")!.tickets.readEvents({
      planId: mission.record.planId,
      limit: 100,
    });
    expect(events.events).toContainEqual(expect.objectContaining({
      aggregateType: "ticket",
      payload: { type: "TicketResumedAfterInput", inputMessageId: "blocked-message-while-paused" },
    }));
  });

  it("queues a human message behind the active turn for the same Agent", async () => {
    const fixture = await createFixture({ intervalMs: 100 });
    await fixture.host.start();
    await fixture.host.createTask({
      taskId: "task-agent-turn-queue",
      title: "Agent turn queue",
      objective: "verify one turn at a time",
    });
    const context = fixture.host.context("task-agent-turn-queue")!;
    const loop = context.loops.get("wa_boss")!;
    let activeTurns = 0;
    let maxActiveTurns = 0;
    const inputs: Array<{ triggerMessageId?: string }> = [];
    let releaseFirst!: () => void;
    let announceFirst!: () => void;
    let announceSecond!: () => void;
    const firstStarted = new Promise<void>((resolve) => { announceFirst = resolve; });
    const secondStarted = new Promise<void>((resolve) => { announceSecond = resolve; });
    loop.runSlice = async (input) => {
      activeTurns += 1;
      maxActiveTurns = Math.max(maxActiveTurns, activeTurns);
      inputs.push({ triggerMessageId: input.triggerMessageId });
      if (inputs.length === 1) {
        announceFirst();
        await new Promise<void>((resolve) => { releaseFirst = resolve; });
      } else {
        announceSecond();
      }
      activeTurns -= 1;
      return { turnId: input.turnId ?? `turn-${inputs.length}`, status: "waiting", toolCalls: 0 };
    };

    await firstStarted;
    await fixture.host.sendAgentMessage(
      "task-agent-turn-queue",
      "wa_boss",
      "new chronological input",
      "human-message-during-active-turn",
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(inputs).toHaveLength(1);

    releaseFirst();
    await secondStarted;
    await fixture.host.stop();

    expect(maxActiveTurns).toBe(1);
    expect(inputs[1]).toMatchObject({ triggerMessageId: "human-message-during-active-turn" });
  });

  it("keeps a long chronological Human conversation on one Goal without duplicate turns", async () => {
    const fixture = await createFixture({ intervalMs: 10 });
    await fixture.host.createTask({
      taskId: "task-long-human-conversation",
      title: "Long Human conversation",
      objective: "verify durable sequential Human input",
    });
    const context = fixture.host.context("task-long-human-conversation")!;
    const loop = context.loops.get("wa_boss")!;
    const engine = context.engines.get("wa_boss")!;
    let activeTurns = 0;
    let maxActiveTurns = 0;
    const inputs: Array<{ turnId?: string; triggerMessageId?: string }> = [];
    loop.runSlice = async (input) => {
      activeTurns += 1;
      maxActiveTurns = Math.max(maxActiveTurns, activeTurns);
      inputs.push({ turnId: input.turnId, triggerMessageId: input.triggerMessageId });
      await new Promise((resolve) => setTimeout(resolve, 2));
      activeTurns -= 1;
      if (input.triggerMessageId) {
        await engine.appendToolItem({
          itemId: `consumed-${input.triggerMessageId}`,
          turnId: input.turnId,
          threadId: input.threadId,
          goalId: input.goalId,
          kind: "observation",
          value: { type: "human_turn_consumed", triggerMessageId: input.triggerMessageId },
          createdAt: new Date().toISOString(),
        });
      }
      return { turnId: input.turnId ?? `turn-long-human-${inputs.length}`, status: "waiting", toolCalls: 0 };
    };

    await fixture.host.tick();
    await waitFor(() => Promise.resolve(inputs.length >= 1), 5_000);
    const initialThread = (await engine.getThreadForAgent("wa_boss", "task-long-human-conversation"))!;
    const initialGoalId = (await context.manager.current()).links.find((link) => link.agentId === "wa_boss")!.agentGoalId!;

    const messageIds = Array.from({ length: 32 }, (_value, index) => `long-human-message-${String(index + 1).padStart(2, "0")}`);
    for (const [index, messageId] of messageIds.entries()) {
      await fixture.host.sendAgentMessage(
        "task-long-human-conversation",
        "wa_boss",
        `按时间顺序处理第 ${index + 1} 条补充信息`,
        messageId,
      );
      await waitFor(() => Promise.resolve(inputs.some((input) => input.triggerMessageId === messageId)), 5_000);
    }

    const thread = (await engine.getThreadForAgent("wa_boss", "task-long-human-conversation"))!;
    const humanItems = messageIds.map((messageId) => thread.items.filter((item) => item.itemId === messageId));
    expect(humanItems.every((items) => items.length === 1)).toBe(true);
    expect(inputs.filter((input) => input.triggerMessageId && messageIds.includes(input.triggerMessageId))).toHaveLength(messageIds.length);
    expect(maxActiveTurns).toBe(1);
    expect(new Set(inputs.map((input) => input.turnId)).size).toBe(inputs.length);
    expect(thread.items.filter((item) => item.itemId === initialThread.items[0]?.itemId)).toHaveLength(1);
    expect((await context.manager.current()).links.find((link) => link.agentId === "wa_boss")?.agentGoalId).toBe(initialGoalId);
    await fixture.host.stop();
  });

  it("prioritizes the oldest pending human turn over a later correctable control on an active Goal", async () => {
    const fixture = await createFixture();
    await fixture.host.createTask({
      taskId: "task-human-before-correction",
      title: "Human turn priority",
      objective: "verify chronological scheduling",
    });
    const context = fixture.host.context("task-human-before-correction")!;
    const link = (await context.manager.tick()).links.find((item) => item.agentId === "wa_boss")!;
    const engine = context.engines.get("wa_boss")!;
    const loop = context.loops.get("wa_boss")!;
    const thread = (await engine.getThreadForAgent("wa_boss", "task-human-before-correction"))!;
    const humanTurnId = "turn_pending_human_before_correction";
    await engine.sendMessage({
      messageId: "pending-human-before-correction",
      turnId: humanTurnId,
      threadId: thread.threadId,
      goalId: link.agentGoalId,
      senderPrincipalId: "human",
      deliveryKind: "turn",
      content: "这里是必须先处理的人工验收事实",
      createdAt: "2026-07-10T00:10:00.000Z",
    });
    await engine.appendToolItem({
      itemId: "later-correctable-control",
      turnId: "turn_later_correction",
      threadId: thread.threadId,
      goalId: link.agentGoalId,
      kind: "control",
      value: {
        type: "goal_resolution_decision",
        status: "correctable",
        decision: {
          accepted: false,
          disposition: "correctable",
          reason: "先处理排队的人类消息",
        },
      },
      createdAt: "2026-07-10T00:11:00.000Z",
    });
    let captured: { turnId?: string; triggerMessageId?: string } | undefined;
    loop.runSlice = async (input) => {
      captured = { turnId: input.turnId, triggerMessageId: input.triggerMessageId };
      return { turnId: input.turnId!, status: "waiting", toolCalls: 0 };
    };

    await fixture.host.tick();

    expect(captured).toEqual({
      turnId: humanTurnId,
      triggerMessageId: "pending-human-before-correction",
    });
  });

  it("lets operator cancellation bypass business-flow advancement", async () => {
    const fixture = await createFixture();
    await fixture.host.createTask({ taskId: "task-cancel", title: "取消验证", objective: "构建演示" });

    await fixture.host.cancelTask("task-cancel", "operator cancelled");

    expect(await fixture.host.listTasks()).toContainEqual(expect.objectContaining({
      taskId: "task-cancel",
      status: "cancelled",
    }));
    const snapshot = await fixture.host.snapshot();
    expect(snapshot.status).toBe("interrupted");
    expect(snapshot.agents.every((agent) => agent.status !== "running")).toBe(true);
    const links = (await fixture.host.context("task-cancel")!.manager.current()).links;
    expect(links.every((link) => link.status === "settled" || link.status === "cancelled")).toBe(true);
  });

  it("runs an ordinary turn only on the selected idle Agent", async () => {
    const fixture = await createFixture();
    await fixture.host.createTask({ taskId: "task-a", title: "演示", objective: "构建演示" });
    await fixture.host.sendAgentMessage("task-a", "wa_architect", "请独立评估技术风险");
    const context = fixture.host.context("task-a")!;
    const architect = context.engines.get("wa_architect")!;
    await waitFor(async () => {
      const items = (await architect.getThreadForAgent("wa_architect", "task-a"))?.items ?? [];
      return items.some((item) => item.kind === "model") && items.at(-1)?.kind === "control";
    }, 5_000);
    const thread = await architect.getThreadForAgent("wa_architect", "task-a");

    expect(thread?.items.map((item) => item.kind)).toEqual(expect.arrayContaining(["message", "control", "model"]));
    expect(thread?.items.filter((item) => item.kind === "model")).toHaveLength(1);
    expect(await architect.getGoalByStartKey("does-not-exist")).toBeUndefined();
  });

  it("persists a missing provider credential as a blocked Ticket and stops rescheduling", async () => {
    const fixture = await createFixture();
    await updateWorkspaceAgent(fixture.workspace, "wa_boss", {
      provider: "openai",
      model: "gpt-4o-mini",
    });

    await fixture.host.createTask({
      taskId: "task-missing-provider-credential",
      title: "missing provider credential",
      objective: "prove a configuration failure becomes durable work state",
    });
    await fixture.host.tick();

    const firstSnapshot = await fixture.host.snapshot();
    const blockedTicket = firstSnapshot.tickets?.find((ticket) => ticket.status === "blocked");
    expect(blockedTicket).toMatchObject({
      status: "blocked",
      blocker: {
        type: "external_dependency",
        reason: expect.stringContaining("API Key"),
        details: { source: "agent_engine.provider" },
      },
    });

    const context = fixture.host.context("task-missing-provider-credential")!;
    const firstMission = await context.manager.current();
    const blockedLink = firstMission.links.find((link) => link.agentId === "wa_boss");
    expect(blockedLink?.status).toBe("blocked");
    const goal = blockedLink?.agentGoalId
      ? await context.engines.get("wa_boss")?.getGoal(blockedLink.agentGoalId)
      : undefined;
    expect(goal?.status).toBe("paused");

    const firstAttempt = blockedTicket?.attempt;
    await fixture.host.tick();
    const secondSnapshot = await fixture.host.snapshot();
    const secondTicket = secondSnapshot.tickets?.find((ticket) => ticket.id === blockedTicket?.id);
    expect(secondTicket).toMatchObject({
      status: "blocked",
      attempt: firstAttempt,
    });
    await fixture.host.stop();
  });

  it("retries a transient Provider failure for an idle private message on the same turn after recovery", async () => {
    let now = new Date("2026-07-24T05:00:00.000Z");
    const fixture = await createFixture({
      now: () => now,
      providerRetryBaseMs: 5_000,
      providerRetryMaxMs: 5_000,
    });
    let architectModelTurns = 0;
    fixture.providers.get = async () => ({
      name: "mock",
      async runModelTurn(input) {
        if (!input.history.some((item) => item.type === "user_message" && item.content.includes("请继续检查这项工作"))) {
          return { items: [{ type: "assistant_message" as const, content: "非目标 Agent 已收到" }] };
        }
        architectModelTurns += 1;
        if (architectModelTurns === 1) throw new ProviderError("502 status code (no body)", true, "OPENAI_ERROR");
        return { items: [{ type: "assistant_message" as const, content: "已收到，继续处理" }] };
      },
    });

    await fixture.host.createTask({ taskId: "task-idle-provider-retry", title: "空闲私聊恢复", objective: "验证空闲 Agent 的私聊恢复" });
    await fixture.host.sendAgentMessage("task-idle-provider-retry", "wa_architect", "请继续检查这项工作", "idle-provider-message");
    await waitFor(async () => fixture.host.providerRetryState("task-idle-provider-retry", "wa_architect")?.kind === "provider", 5_000);

    const retry = fixture.host.providerRetryState("task-idle-provider-retry", "wa_architect");
    expect(architectModelTurns).toBe(1);
    expect(retry).toMatchObject({
      failures: 1,
      turnId: expect.stringContaining("turn_"),
      triggerMessageId: "idle-provider-message",
    });

    await fixture.host.tick();
    expect(architectModelTurns).toBe(1);

    now = new Date(now.getTime() + 5_000);
    await waitFor(async () => {
      await fixture.host.tick();
      return architectModelTurns === 2;
    }, 5_000);

    const architect = fixture.host.context("task-idle-provider-retry")!.engines.get("wa_architect")!;
    const thread = await architect.getThreadForAgent("wa_architect", "task-idle-provider-retry");
    expect(fixture.host.providerRetryState("task-idle-provider-retry", "wa_architect")).toBeUndefined();
    expect(thread?.items.filter((item) => item.kind === "message")).toHaveLength(1);
    expect(thread?.items.filter((item) => item.kind === "model")).toHaveLength(1);
    expect(thread?.items.some((item) => item.turnId === retry?.turnId && item.kind === "model")).toBe(true);
  });

  it("restores an idle private-message Provider retry after host restart", async () => {
    let now = new Date("2026-07-24T05:30:00.000Z");
    const fixture = await createFixture({
      now: () => now,
      providerRetryBaseMs: 5_000,
      providerRetryMaxMs: 5_000,
    });
    let providerAvailable = false;
    let architectModelTurns = 0;
    fixture.providers.get = async () => ({
      name: "mock",
      async runModelTurn(input) {
        const isTargetTurn = input.history.some((item) => item.type === "user_message" && item.content.includes("重启后继续处理这条私聊"));
        if (!isTargetTurn) return { items: [{ type: "assistant_message" as const, content: "非目标 Agent 已收到" }] };
        architectModelTurns += 1;
        if (!providerAvailable) throw new ProviderError("502 status code (no body)", true, "OPENAI_ERROR");
        return { items: [{ type: "assistant_message" as const, content: "重启后已恢复处理" }] };
      },
    });

    await fixture.host.createTask({ taskId: "task-idle-provider-restart", title: "空闲私聊重启恢复", objective: "验证空闲 Agent 私聊在重启后恢复" });
    await fixture.host.sendAgentMessage(
      "task-idle-provider-restart",
      "wa_architect",
      "重启后继续处理这条私聊",
      "idle-provider-restart-message",
    );
    await waitFor(async () => fixture.host.providerRetryState("task-idle-provider-restart", "wa_architect")?.kind === "provider", 5_000);
    const beforeContext = fixture.host.context("task-idle-provider-restart")!;
    const beforeThread = await beforeContext.engines.get("wa_architect")!.getThreadForAgent("wa_architect", "task-idle-provider-restart");
    const beforeRetry = fixture.host.providerRetryState("task-idle-provider-restart", "wa_architect")!;
    expect(architectModelTurns).toBe(1);
    expect(beforeRetry.turnId).toBe(beforeThread?.items.find((item) => item.itemId === "idle-provider-restart-message")?.turnId);

    await fixture.host.stop();
    providerAvailable = true;
    now = new Date(now.getTime() + 5_000);
    const restarted = new RuntimeHost(
      fixture.workspace,
      fixture.profiles,
      fixture.providers,
      fixture.policyStore,
      fixture.policyRef,
      { intervalMs: 60_000, now: () => now, providerRetryBaseMs: 5_000, providerRetryMaxMs: 5_000 },
    );
    await restarted.recover();
    expect(restarted.providerRetryState("task-idle-provider-restart", "wa_architect")).toMatchObject({
      failures: 1,
      turnId: beforeRetry.turnId,
      triggerMessageId: "idle-provider-restart-message",
    });
    await waitFor(async () => {
      await restarted.tick();
      return architectModelTurns === 2;
    }, 5_000);

    const afterContext = restarted.context("task-idle-provider-restart")!;
    const afterThread = await afterContext.engines.get("wa_architect")!.getThreadForAgent("wa_architect", "task-idle-provider-restart");
    expect(restarted.providerRetryState("task-idle-provider-restart", "wa_architect")).toBeUndefined();
    expect(afterThread?.items.some((item) => item.turnId === beforeRetry.turnId && item.kind === "model")).toBe(true);
    expect(afterThread?.items.filter((item) => item.itemId === "idle-provider-restart-message")).toHaveLength(1);
    await restarted.stop();
  });

  it("acknowledges a persisted human message without waiting for the model turn", async () => {
    const fixture = await createFixture();
    let releaseModel!: () => void;
    const modelGate = new Promise<void>((resolve) => { releaseModel = resolve; });
    await fixture.host.createTask({ taskId: "task-async-message", title: "演示", objective: "构建演示" });
    fixture.providers.get = async () => ({
      name: "mock",
      async runModelTurn() {
        await modelGate;
        return { items: [{ type: "assistant_message" as const, content: "收到" }] };
      },
    });

    const acknowledgement = fixture.host.sendAgentMessage("task-async-message", "wa_architect", "请评估风险");
    const acknowledgedBeforeModel = await Promise.race([
      acknowledgement.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 3_000)),
    ]);
    releaseModel();
    await acknowledgement;
    expect(acknowledgedBeforeModel).toBe(true);

    const architect = fixture.host.context("task-async-message")!.engines.get("wa_architect")!;
    await waitFor(
      async () => (await architect.getThreadForAgent("wa_architect", "task-async-message"))?.items.some((item) => item.kind === "model") === true,
      5_000,
    );
  });
});

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for asynchronous Agent turn");
}

async function waitForTaskStatus(host: RuntimeHost, taskId: string, status: string, maxTicks = 40): Promise<void> {
  for (let index = 0; index < maxTicks; index += 1) {
    await host.tick();
    if ((await host.listTasks()).some((task) => task.taskId === taskId && task.status === status)) return;
  }
  const snapshot = await host.snapshot();
  throw new Error(`Task ${taskId} did not reach ${status} after ${maxTicks} scheduler ticks: ${JSON.stringify({
    status: snapshot.status,
    phase: snapshot.phase,
    tickets: snapshot.tickets?.map((ticket) => ({ id: ticket.id, status: ticket.status, targetAgentId: ticket.targetAgentId })),
  })}`);
}

function missionBaselineOutcome() {
  return {
    schemaRef: "mission-baseline-v2",
    objective: "Complete the current human objective",
    criteria: [{
      text: "Produce a real, verifiable deliverable",
      anchors: [{
        observableOutcome: "The real deliverable can be inspected",
        evidenceRequirements: ["Traceable tool evidence"],
      }],
    }],
    constraints: [],
    assumptions: [],
    exclusions: [],
  };
}

function satisfiedCriteria(count: number) {
  return Array.from({ length: count }, (_value, criterionIndex) => ({
    criterionIndex,
    status: "satisfied",
    evidence: [],
  }));
}

async function createFixture(options: {
  intervalMs?: number;
  now?: () => Date;
  providerRetryBaseMs?: number;
  providerRetryMaxMs?: number;
  useStaffing?: boolean;
} = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), "autoagent-runtime-home-"));
  const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-runtime-ws-"));
  const workspace: Workspace = {
    id: "workspace-a",
    name: "Workspace",
    rootPath: root,
    policyProfile: "development",
    createdAt: new Date().toISOString(),
  };
  const profiles = new AgentProfileStore(home);
  for (const profile of (await profiles.list()).filter((candidate) => candidate.role !== "specialist")) {
    await ensureWorkspaceAgent(workspace, profile, `wa_${profile.role}`);
  }
  const providers = new ProviderRegistry({ homeDir: home, retryCount: 0 });
  const policyStore = new PlanPolicyStore(home);
  const policyRef = await seedMinimalTeamPlanPolicy(policyStore, DEFAULT_MINIMAL_TEAM_POLICY_CONFIG);
  const host = new RuntimeHost(workspace, profiles, providers, policyStore, policyRef, {
    intervalMs: options.intervalMs ?? 60_000,
    now: options.now,
    providerRetryBaseMs: options.providerRetryBaseMs,
    providerRetryMaxMs: options.providerRetryMaxMs,
    initialTeamBinding: options.useStaffing
      ? undefined
      : async () => createTeamBinding(
          workspace,
          await listWorkspaceAgents(workspace),
          await profiles.list(),
          "minimal-team",
        ),
  });
  let cleaned = false;
  fixtureCleanups.add(async () => {
    if (cleaned) return;
    cleaned = true;
    await host.stop();
    await Promise.all([
      rm(home, { recursive: true, force: true }),
      rm(root, { recursive: true, force: true }),
    ]);
  });
  return { home, root, workspace, profiles, providers, policyStore, policyRef, host };
}
