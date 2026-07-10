import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentProfileStore } from "../../src/server/agents/profile-store.js";
import { ProviderRegistry } from "../../src/server/providers/provider-registry.js";
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

  it("starts and stops an unrefed production timer", async () => {
    const fixture = await createFixture();
    await fixture.host.start();
    fixture.host.stop();
  });

  it("runs an ordinary turn only on the selected idle Agent", async () => {
    const fixture = await createFixture();
    await fixture.host.createTask({ taskId: "task-a", title: "演示", objective: "构建演示" });
    await fixture.host.sendAgentMessage("task-a", "wa_architect", "请独立评估技术风险");
    const context = fixture.host.context("task-a")!;
    const architect = context.engines.get("wa_architect")!;
    const thread = await architect.getThreadForAgent("wa_architect", "task-a");

    expect(thread?.items.map((item) => item.kind)).toEqual([
      "message",
      "control",
      "model",
      "control",
    ]);
    expect(await architect.getGoalByStartKey("does-not-exist")).toBeUndefined();
  });
});

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
