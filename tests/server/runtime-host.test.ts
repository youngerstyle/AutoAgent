import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentProfileStore } from "../../src/server/agents/profile-store.js";
import { ProviderRegistry } from "../../src/server/providers/provider-registry.js";
import { ProviderError } from "../../src/server/providers/types.js";
import { RuntimeHost } from "../../src/server/runtime/runtime-host.js";
import { seedMinimalTeamWorkflowPolicy, DEFAULT_MINIMAL_TEAM_POLICY_CONFIG } from "../../src/server/tickets/workflow-policy-config.js";
import { WorkflowPolicyStore } from "../../src/server/tickets/workflow-policy-store.js";
import type { Workspace } from "../../src/shared/types.js";

describe("RuntimeHost", () => {
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
    expect(modelTurns).toBe(1);
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

  it("does not spend another model turn on the same correction without new input", async () => {
    const fixture = await createFixture();
    let planningTurns = 0;
    fixture.providers.get = async () => ({
      name: "mock",
      async runModelTurn(input) {
        const planning = input.instructions.includes("输出契约：ticket-graph-v2");
        if (planning) planningTurns += 1;
        const structured = planning
          ? {
              goalResolution: {
                status: "completed",
                summary: "仍然缺少 graph",
                evidence: [],
                domainOutcome: { result: { plan: "incomplete" } },
              },
            }
          : {
              goalResolution: {
                status: "completed",
                summary: "需求接收完成",
                evidence: [],
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
    expect(modelTurns).toBe(1);
    expect(await context.engines.get("wa_boss")!.getGoal(bossLink.agentGoalId!)).toMatchObject({ status: "paused" });
    expect((await context.tickets.getWorkflow((await context.manager.current()).record.workflowId)).status).toBe("active");
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
    const context = fixture.host.context("task-provider-resume")!;
    const link = (await context.manager.current()).links.find((item) => item.agentId === "wa_boss")!;
    expect(await context.engines.get("wa_boss")!.getGoal(link.agentGoalId!)).toMatchObject({ status: "paused" });

    providerAvailable = true;
    await fixture.host.sendAgentMessage("task-provider-resume", "wa_boss", "余额已恢复，请继续");
    await waitFor(async () => (await context.engines.get("wa_boss")!.getGoal(link.agentGoalId!))?.status === "active");

    expect(await context.engines.get("wa_boss")!.getGoal(link.agentGoalId!)).toMatchObject({ status: "active" });
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
    const liveBoss = fixture.host.context("task-live-snapshot")!.engines.get("wa_boss")!;
    const liveThread = (await liveBoss.getThreadForAgent("wa_boss", "task-live-snapshot"))!;
    await liveBoss.sendMessage({
      messageId: "new-input-before-held-model",
      threadId: liveThread.threadId,
      senderPrincipalId: "human",
      content: "继续处理新的事实",
      createdAt: "2026-07-10T00:04:00.000Z",
    });
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

async function createFixture() {
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
  const policyStore = new WorkflowPolicyStore(home);
  const policyRef = await seedMinimalTeamWorkflowPolicy(policyStore, DEFAULT_MINIMAL_TEAM_POLICY_CONFIG);
  const host = new RuntimeHost(workspace, profiles, providers, policyStore, policyRef, { intervalMs: 60_000 });
  return { home, root, workspace, profiles, providers, policyStore, policyRef, host };
}
