import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentProfileStore } from "../../src/server/agents/profile-store.js";
import { ProviderRegistry } from "../../src/server/providers/provider-registry.js";
import { ProviderError } from "../../src/server/providers/types.js";
import { RuntimeHost } from "../../src/server/runtime/runtime-host.js";
import { missionProcessFile, runtimeHostFile } from "../../src/server/storage/paths.js";
import { seedMinimalTeamPlanPolicy, DEFAULT_MINIMAL_TEAM_POLICY_CONFIG } from "../../src/server/tickets/plan-policy-config.js";
import { PlanPolicyStore } from "../../src/server/tickets/plan-policy-store.js";
import type { Workspace } from "../../src/shared/types.js";

describe("RuntimeHost", () => {
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
    for (let index = 0; index < 12; index += 1) await fixture.host.tick();

    expect(await fixture.host.listTasks()).toContainEqual(expect.objectContaining({ taskId: "task-a", status: "completed" }));
    fixture.host.stop();

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
    restarted.stop();
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
        expectedArtifact: "boss-intake-v1",
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
              criterionResults: [],
              residualRisks: [],
              domainOutcome: { accepted: true },
            },
          }],
        };
      },
    });

    const objective = "1:1复刻 CF 红白机的坦克98 游戏";
    await fixture.host.createTask({ taskId: "task-pi-history-origin", title: "坦克98", objective });
    await fixture.host.tick();

    expect(histories.length).toBeGreaterThanOrEqual(1);
    expect(histories[0]).toContainEqual({ type: "user_message", content: objective });
    expect(instructions[0]).toContain("当前工作上下文（由 Mission Control 从 Ticket Engine 的权威状态组装");
  });

  it("delivers a new ticket instruction to an existing Pi session instead of replacing it with Goal metadata", async () => {
    const fixture = await createFixture();
    const instructions: string[] = [];
    const originalGet = fixture.providers.get.bind(fixture.providers);
    fixture.providers.get = async (name) => {
      const provider = await originalGet(name);
      return {
        ...provider,
        async runModelTurn(input) {
        instructions.push(input.instructions);
          return provider.runModelTurn(input);
        },
      };
    };

    await fixture.host.createTask({ taskId: "task-new-goal-message", title: "演示", objective: "构建可运行演示" });
    for (let index = 0; index < 12; index += 1) await fixture.host.tick();

    expect(instructions.length).toBeGreaterThanOrEqual(2);
    const reusedBossSessionTurn = instructions.find((value) => value.includes("本轮按时间序收到的消息"));
    expect(reusedBossSessionTurn).toContain("当前工作上下文（由 Mission Control 从 Ticket Engine 的权威状态组装");
    expect(reusedBossSessionTurn).toContain("handoffLineage");
  });

  it("does not replay an active goal after a waiting tail without new input", async () => {
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
    await boss.appendToolItem({
      itemId: "legacy-waiting",
      threadId: thread!.threadId,
      goalId: link.agentGoalId,
      kind: "control",
      value: { status: "waiting" },
      createdAt: "2026-07-10T00:02:00.000Z",
    });

    await fixture.host.tick();

    const updated = await boss.getThread(thread!.threadId);
    expect(modelTurns).toBe(3);
    expect(updated.items.at(-1)?.itemId).toBe("legacy-waiting");
    expect(await boss.getGoal(link.agentGoalId!)).toMatchObject({ status: "paused" });
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
    expect(modelTurns).toBe(3);
  });

  it("does not spend another model turn on the same correction without new input", async () => {
    const fixture = await createFixture();
    let planningTurns = 0;
    fixture.providers.get = async () => ({
      name: "mock",
      async runModelTurn(input) {
        const planning = input.instructions.includes("输出契约 plan-change-set-v3");
        if (planning) planningTurns += 1;
        const structured = planning
          ? {
              goalResolution: {
                status: "completed",
                summary: "仍然缺少 graph",
                evidence: [],
                criterionResults: Array.from({ length: 5 }, (_, criterionIndex) => ({ criterionIndex, status: "satisfied", evidence: [] })),
                residualRisks: [],
                domainOutcome: { result: { plan: "incomplete" } },
              },
            }
          : {
              goalResolution: {
                status: "completed",
                summary: "需求接收完成",
                evidence: [],
                criterionResults: Array.from({ length: 3 }, (_, criterionIndex) => ({ criterionIndex, status: "satisfied", evidence: [] })),
                residualRisks: [],
                domainOutcome: { accepted: true },
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
    for (let index = 0; index < 6; index += 1) await fixture.host.tick();

    expect(planningTurns).toBe(2);
  });

  it("pauses one turn after the same invalid tool call repeats without progress", async () => {
    const fixture = await createFixture();
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
    expect(modelTurns).toBe(3);
    expect(await context.engines.get("wa_boss")!.getGoal(link.agentGoalId!)).toMatchObject({ status: "paused" });
    expect((await context.tickets.getPlan((await context.manager.current()).record.planId)).status).toBe("active");

    await fixture.host.tick();
    expect(modelTurns).toBe(3);
  });

  it("continues beyond twenty successful Pi tool calls and returns each result to the next model turn", async () => {
    const fixture = await createFixture();
    let modelTurns = 0;
    let correlatedResults = 0;
    fixture.providers.get = async () => ({
      name: "mock",
      async runModelTurn(input) {
        modelTurns += 1;
        if (modelTurns > 1 && input.history.at(-1)?.type === "tool_result") correlatedResults += 1;
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
              criterionResults: [],
              residualRisks: [],
              domainOutcome: { accepted: true },
            },
          }],
        };
      },
    });

    await fixture.host.createTask({ taskId: "task-many-tools", title: "演示", objective: "构建演示" });
    await fixture.host.tick();

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
              criterionResults: [],
              residualRisks: [],
              domainOutcome: { accepted: true },
            },
          }],
        };
      },
    });

    await fixture.host.createTask({ taskId: "task-goal-continuation", title: "演示", objective: "构建演示" });
    await fixture.host.tick();

    expect(modelTurns).toBe(3);
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
    expect((await context.tickets.getPlan((await context.manager.current()).record.planId)).status).toBe("active");
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
    expect(snapshot.agents.find((agent) => agent.id === "wa_boss")?.status).toBe("paused");
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
        throw new ProviderError("502 status code (no body)", false, "OPENAI_ERROR");
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
    });

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
              criterionResults: [],
              residualRisks: [],
              domainOutcome: { accepted: true },
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
    fixture.host.stop();

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
    restarted.stop();
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

    expect(snapshotResult).toBe("running");
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
    fixture.host.stop();
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
    fixture.host.stop();

    const mission = await fixture.host.context("task-production-scheduler")!.manager.current();
    expect(mission.links).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentId: "wa_boss", status: "settled" }),
      expect.objectContaining({ agentId: "wa_pm" }),
    ]));
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
    const turnStarted = new Promise<void>((resolve) => {
      const loop = context.loops.get("wa_boss")!;
      loop.runSlice = async () => {
        resolve();
        await new Promise<void>((release) => { releaseTurn = release; });
        return { turnId: "slow-turn", status: "waiting", toolCalls: 0 };
      };
    });

    await turnStarted;
    const controlResult = await Promise.race([
      fixture.host.pauseTask("task-slow-agent").then(() => "paused"),
      new Promise<string>((resolve) => setTimeout(() => resolve("timed-out"), 250)),
    ]);
    fixture.host.stop();
    releaseTurn();

    expect(controlResult).toBe("paused");
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

async function createFixture(options: { intervalMs?: number } = {}) {
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
  const providers = new ProviderRegistry({ homeDir: home, retryCount: 0 });
  const policyStore = new PlanPolicyStore(home);
  const policyRef = await seedMinimalTeamPlanPolicy(policyStore, DEFAULT_MINIMAL_TEAM_POLICY_CONFIG);
  const host = new RuntimeHost(workspace, profiles, providers, policyStore, policyRef, {
    intervalMs: options.intervalMs ?? 60_000,
  });
  return { home, root, workspace, profiles, providers, policyStore, policyRef, host };
}
