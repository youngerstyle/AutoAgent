import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MissionControl } from "../../src/server/mission/mission-control";
import { EventLedger } from "../../src/server/storage/event-ledger";
import { WorkspaceStore } from "../../src/server/storage/workspace-store";
import { ProviderRegistry } from "../../src/server/providers/provider-registry";
import type { ProviderRunner } from "../../src/server/agents/agent-runtime";
import type { AgentTurnInput, AgentTurnResult } from "../../src/server/providers/types";

describe("MissionControl", () => {
  it("runs the fixed team happy path to completion", async () => {
    const fixture = await missionFixture();

    const snapshot = await fixture.mission.startTask(
      { workspaceId: fixture.workspace.id, goal: "Build a tiny demo" },
      { runSynchronously: true }
    );

    expect(snapshot.status).toBe("completed");
    expect(snapshot.phase).toBe("completed");
    expect(snapshot.agents.map((agent) => agent.roleInWorkspace)).toEqual(expect.arrayContaining(["boss", "pm", "architect", "dev", "qa"]));
    const events = await fixture.ledger.read(fixture.workspace.rootPath, snapshot.activeTask!.id, snapshot.activeTaskRun!.id);
    expect(events.map((event) => event.type)).toContain("run.completed");
    expect(events.find((event) => event.type === "run.completed")?.summary).toBe("任务已完成");
  });

  it("keeps the latest completed TaskRun visible in the workspace snapshot", async () => {
    const fixture = await missionFixture();

    const completed = await fixture.mission.startTask(
      { workspaceId: fixture.workspace.id, goal: "Build a persistent snapshot" },
      { runSynchronously: true }
    );
    const snapshot = await fixture.mission.snapshotByWorkspace(fixture.workspace.id);

    expect(completed.status).toBe("completed");
    expect(snapshot.status).toBe("completed");
    expect(snapshot.activeTask?.id).toBe(completed.activeTask?.id);
    expect(snapshot.recentEvents.map((event) => event.type)).toContain("run.completed");
  });

  it("enforces one active TaskRun per workspace", async () => {
    const fixture = await missionFixture();

    await fixture.mission.startTask({ workspaceId: fixture.workspace.id, goal: "Wait here" }, { autoRun: false });

    await expect(fixture.mission.startTask({ workspaceId: fixture.workspace.id, goal: "Second" }, { autoRun: false })).rejects.toMatchObject({
      status: 409,
      code: "ACTIVE_TASK_RUN"
    });
  });

  it("supports pause, resume, and stop controls", async () => {
    const fixture = await missionFixture();
    const snapshot = await fixture.mission.startTask({ workspaceId: fixture.workspace.id, goal: "Controllable task" }, { autoRun: false });
    const taskId = snapshot.activeTask!.id;

    const paused = await fixture.mission.pauseTask(fixture.workspace.id, taskId);
    expect(paused.status).toBe("paused");

    const resumed = await fixture.mission.resumeTask(fixture.workspace.id, taskId, true);
    expect(resumed.status).toBe("completed");

    const second = await missionFixture();
    const secondSnapshot = await second.mission.startTask({ workspaceId: second.workspace.id, goal: "Stop me" }, { autoRun: false });
    const stopped = await second.mission.stopTask(second.workspace.id, secondSnapshot.activeTask!.id);
    expect(stopped.status).toBe("interrupted");
  });

  it("recruits a specialist when the architect reports a capability gap", async () => {
    const fixture = await missionFixture();

    const snapshot = await fixture.mission.startTask(
      { workspaceId: fixture.workspace.id, goal: "Build auth security checks" },
      { runSynchronously: true }
    );

    expect(snapshot.status).toBe("completed");
    expect(snapshot.agents.some((agent) => agent.roleInWorkspace === "specialist")).toBe(true);
    const events = await fixture.ledger.read(fixture.workspace.rootPath, snapshot.activeTask!.id, snapshot.activeTaskRun!.id);
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(["recruitment.requested", "recruitment.approved"]));
    expect(events.find((event) => event.type === "recruitment.requested")?.summary).toBe("老板发起专家招聘：安全/认证");
    expect(events.find((event) => event.type === "recruitment.approved")?.summary).toBe("老板已招募安全/认证专家");
  });

  it("routes failed QA back to implementation before completing", async () => {
    const fixture = await missionFixture(new QaFailsOnceProvider());

    const snapshot = await fixture.mission.startTask(
      { workspaceId: fixture.workspace.id, goal: "Build with a QA retry" },
      { runSynchronously: true }
    );

    expect(snapshot.status).toBe("completed");
    const events = await fixture.ledger.read(fixture.workspace.rootPath, snapshot.activeTask!.id, snapshot.activeTaskRun!.id);
    expect(events.map((event) => event.type)).toContain("qa.failed");
    expect(events.filter((event) => event.type === "assignment.completed" && event.summary.includes("开发执行"))).toHaveLength(2);
  });
});

async function missionFixture(providerOverride?: ProviderRunner) {
  const home = await mkdtemp(path.join(os.tmpdir(), "autoagent-home-"));
  const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-ws-"));
  const store = new WorkspaceStore(home);
  const workspace = await store.create({ name: "Mission", rootPath: root, policyProfile: "development" });
  const ledger = new EventLedger();
  const provider = new ProviderRegistry({ homeDir: home, env: { NODE_ENV: "test" }, retryCount: 0 });
  const mission = new MissionControl(store, ledger, providerOverride ?? provider);
  return { home, root, store, workspace, ledger, mission };
}

class QaFailsOnceProvider implements ProviderRunner {
  private qaCalls = 0;

  async runWithRetry(input: AgentTurnInput): Promise<AgentTurnResult> {
    if (input.role === "qa") {
      this.qaCalls += 1;
      const passed = this.qaCalls > 1;
      return result({ passed, report: passed ? "Pass" : "Needs changes" });
    }
    if (input.role === "architect") return result({ architecture: "small", needsSpecialist: false });
    return result({ ok: true });
  }
}

function result(structured: Record<string, unknown>): AgentTurnResult {
  return {
    text: JSON.stringify(structured),
    structured,
    events: [{ type: "text", text: "ok" }],
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
  };
}
