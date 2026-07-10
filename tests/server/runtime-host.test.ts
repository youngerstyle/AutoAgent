import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentProfileStore } from "../../src/server/agents/profile-store.js";
import { ProviderRegistry } from "../../src/server/providers/provider-registry.js";
import { isWaitingControl, RuntimeHost } from "../../src/server/runtime/runtime-host.js";
import { seedMinimalTeamWorkflowPolicy, DEFAULT_MINIMAL_TEAM_POLICY_CONFIG } from "../../src/server/tickets/workflow-policy-config.js";
import { WorkflowPolicyStore } from "../../src/server/tickets/workflow-policy-store.js";
import type { Workspace } from "../../src/shared/types.js";

describe("RuntimeHost", () => {
  it("does not schedule a new slice while the chronological thread tail is waiting", () => {
    expect(isWaitingControl({ turnId: "turn-a", status: "waiting" })).toBe(true);
    expect(isWaitingControl({ turnId: "turn-a", status: "yielded" })).toBe(false);
    expect(isWaitingControl({ status: "running" })).toBe(false);
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
    });
    const thread = await architect.getThreadForAgent("wa_architect", "task-a");

    expect(thread?.items.map((item) => item.kind)).toEqual([
      "message",
      "control",
      "model",
      "control",
    ]);
    expect(await architect.getGoalByStartKey("does-not-exist")).toBeUndefined();
  });

  it("acknowledges a persisted human message without waiting for the model turn", async () => {
    const fixture = await createFixture();
    await fixture.host.createTask({ taskId: "task-async-message", title: "演示", objective: "构建演示" });
    fixture.providers.get = async () => ({
      name: "mock",
      async runModelTurn() {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return { text: "收到", events: [{ type: "text" as const, text: "收到" }] };
      },
    });

    const startedAt = Date.now();
    await fixture.host.sendAgentMessage("task-async-message", "wa_architect", "请评估风险");
    expect(Date.now() - startedAt).toBeLessThan(250);

    const architect = fixture.host.context("task-async-message")!.engines.get("wa_architect")!;
    await waitFor(async () => (await architect.getThreadForAgent("wa_architect", "task-async-message"))?.items.some((item) => item.kind === "model") === true);
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
