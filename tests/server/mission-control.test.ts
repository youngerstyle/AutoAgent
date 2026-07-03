import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MissionControl } from "../../src/server/mission/mission-control";
import { EventLedger } from "../../src/server/storage/event-ledger";
import { WorkspaceStore } from "../../src/server/storage/workspace-store";
import { ProviderRegistry } from "../../src/server/providers/provider-registry";
import { AgentProfileStore } from "../../src/server/agents/profile-store";
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
    expect(snapshot.tickets?.map((ticket) => ticket.type)).toEqual(expect.arrayContaining(["boss_intake", "pm_plan", "architect_plan", "implementation", "qa", "boss_acceptance"]));
    expect(snapshot.inboxMessages?.every((message) => message.status === "acked")).toBe(true);
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

  it("keeps the agent loop autonomous when a role asks for clarification", async () => {
    const fixture = await missionFixture(new BossClarifiesThenTeamCompletesProvider());

    const snapshot = await fixture.mission.startTask(
      { workspaceId: fixture.workspace.id, goal: "一个高仿的FC坦克98" },
      { runSynchronously: true }
    );

    expect(snapshot.status).toBe("completed");
    const events = await fixture.ledger.read(fixture.workspace.rootPath, snapshot.activeTask!.id, snapshot.activeTaskRun!.id);
    expect(events.map((event) => event.type)).toContain("run.completed");
    expect(events.map((event) => event.type)).not.toContain("run.blocked");
    expect(events.some((event) => event.summary.includes("Agent 自治继续"))).toBe(true);
  });

  it("does not stop at boss intake when the model returns a Chinese clarification decision", async () => {
    const provider = new ChineseClarificationProvider();
    const fixture = await missionFixture(provider);

    const snapshot = await fixture.mission.startTask(
      { workspaceId: fixture.workspace.id, goal: "一个高仿的FC坦克98" },
      { runSynchronously: true }
    );

    expect(snapshot.status).toBe("completed");
    expect(provider.rolesSeen).toEqual(expect.arrayContaining(["boss", "pm", "architect", "dev", "qa"]));
    const events = await fixture.ledger.read(fixture.workspace.rootPath, snapshot.activeTask!.id, snapshot.activeTaskRun!.id);
    expect(events.map((event) => event.type)).toContain("run.completed");
    expect(events.map((event) => event.type)).not.toContain("run.blocked");
  });

  it("retries and then fails implementation that reports success without real tool evidence", async () => {
    const fixture = await missionFixture(new NoImplementationEvidenceProvider());

    const snapshot = await fixture.mission.startTask(
      { workspaceId: fixture.workspace.id, goal: "Build without files" },
      { runSynchronously: true }
    );

    expect(snapshot.status).toBe("failed");
    const events = await fixture.ledger.read(fixture.workspace.rootPath, snapshot.activeTask!.id, snapshot.activeTaskRun!.id);
    expect(events.map((event) => event.type)).not.toContain("run.blocked");
    expect(events.find((event) => event.type === "run.failed")?.summary).toContain("开发无法产出真实交付证据");
  });

  it("accepts an existing declared workspace artifact as implementation evidence", async () => {
    const fixture = await missionFixture(new ExistingArtifactProvider());
    await writeFile(path.join(fixture.workspace.rootPath, "index.html"), "<!doctype html><canvas></canvas>\n", "utf8");

    const snapshot = await fixture.mission.startTask(
      { workspaceId: fixture.workspace.id, goal: "Verify existing canvas game" },
      { runSynchronously: true }
    );

    expect(snapshot.status).toBe("completed");
    const events = await fixture.ledger.read(fixture.workspace.rootPath, snapshot.activeTask!.id, snapshot.activeTaskRun!.id);
    expect(events.map((event) => event.type)).not.toContain("run.failed");
  });

  it("accepts an existing manual test file as implementation evidence", async () => {
    const fixture = await missionFixture(new ManualTestFileImplementationProvider());
    await writeFile(path.join(fixture.workspace.rootPath, "index.html"), "<!doctype html><canvas></canvas>\n", "utf8");

    const snapshot = await fixture.mission.startTask(
      { workspaceId: fixture.workspace.id, goal: "Verify existing canvas game manually" },
      { runSynchronously: true }
    );

    expect(snapshot.status).toBe("completed");
    const events = await fixture.ledger.read(fixture.workspace.rootPath, snapshot.activeTask!.id, snapshot.activeTaskRun!.id);
    expect(events.map((event) => event.type)).not.toContain("run.failed");
    expect(events.map((event) => event.type)).toContain("run.completed");
  });

  it("accepts an existing workspace artifact path mentioned in manual test steps", async () => {
    const fixture = await missionFixture(new ManualTestStepsPathImplementationProvider());
    await writeFile(path.join(fixture.workspace.rootPath, "index.html"), "<!doctype html><canvas></canvas>\n", "utf8");

    const snapshot = await fixture.mission.startTask(
      { workspaceId: fixture.workspace.id, goal: "Verify existing canvas game from manual test steps" },
      { runSynchronously: true }
    );

    expect(snapshot.status).toBe("completed");
    const events = await fixture.ledger.read(fixture.workspace.rootPath, snapshot.activeTask!.id, snapshot.activeTaskRun!.id);
    expect(events.map((event) => event.type)).not.toContain("run.failed");
    expect(events.map((event) => event.type)).toContain("run.completed");
  });

  it("records human follow-up as in-flow context without requiring a blocked task", async () => {
    const provider = new ClarifiesAfterHumanProvider();
    const fixture = await missionFixture(provider);

    const started = await fixture.mission.startTask(
      { workspaceId: fixture.workspace.id, goal: "一个高仿的FC坦克98" },
      { autoRun: false }
    );
    expect(started.status).toBe("running");

    const resumed = await fixture.mission.followUpTask(
      fixture.workspace.id,
      started.activeTask!.id,
      "不用继续澄清，先按 Web Canvas 单人 MVP 做一关可玩版本。",
      true
    );

    expect(resumed.status).toBe("completed");
    expect(resumed.activeTask?.id).toBe(started.activeTask?.id);
    expect(provider.seenFollowup).toContain("Web Canvas 单人 MVP");
    const events = await fixture.ledger.read(fixture.workspace.rootPath, resumed.activeTask!.id, resumed.activeTaskRun!.id);
    expect(events.map((event) => event.type)).toContain("human.followup");
    expect(events.find((event) => event.type === "task.phase_changed" && event.summary.includes("收到补充"))?.payload).toMatchObject({
      phase: "boss_intake",
      fromPhase: "boss_intake"
    });
  });

  it("continues after a missing observation file when the agent can plan from an empty workspace", async () => {
    const provider = new MissingFileThenEmptyProjectProvider();
    const fixture = await missionFixture(provider);

    const started = await fixture.mission.startTask(
      { workspaceId: fixture.workspace.id, goal: "一个高仿的FC坦克98" },
      { autoRun: false }
    );

    const resumed = await fixture.mission.followUpTask(
      fixture.workspace.id,
      started.activeTask!.id,
      "按默认 Web Canvas 单人 MVP 继续。",
      true
    );

    expect(resumed.status).toBe("completed");
    expect(resumed.phase).toBe("completed");
    expect(provider.sawMissingFile).toBe(true);
    const events = await fixture.ledger.read(fixture.workspace.rootPath, resumed.activeTask!.id, resumed.activeTaskRun!.id);
    expect(events.map((event) => event.type)).toContain("human.followup");
    expect(events.map((event) => event.type)).toContain("tool.denied");
    expect(events.map((event) => event.type)).toContain("run.completed");
    expect(events.map((event) => event.type)).not.toContain("run.failed");
    expect(events.map((event) => event.type)).not.toContain("assignment.blocked");
  });

  it("uses blocked only for human authorization boundaries and can resume from them", async () => {
    const fixture = await missionFixture(new RequiresAuthorizationProvider());

    const blocked = await fixture.mission.startTask(
      { workspaceId: fixture.workspace.id, goal: "Deploy to production" },
      { runSynchronously: true }
    );

    expect(blocked.status).toBe("blocked");
    expect(blocked.phase).toBe("boss_intake");

    const resumed = await fixture.mission.resumeTask(fixture.workspace.id, blocked.activeTask!.id, true);

    expect(resumed.status).toBe("completed");
    const events = await fixture.ledger.read(fixture.workspace.rootPath, resumed.activeTask!.id, resumed.activeTaskRun!.id);
    expect(events.map((event) => event.type)).toContain("run.blocked");
    expect(events.map((event) => event.type)).toContain("run.completed");
  });

  it("blocks as manual testing required when QA cannot browser-test an interactive deliverable", async () => {
    const fixture = await missionFixture(new ManualBrowserQaProvider());

    const snapshot = await fixture.mission.startTask(
      { workspaceId: fixture.workspace.id, goal: "Build a canvas game" },
      { runSynchronously: true }
    );

    expect(snapshot.status).toBe("blocked");
    expect(snapshot.phase).toBe("qa");
    const events = await fixture.ledger.read(fixture.workspace.rootPath, snapshot.activeTask!.id, snapshot.activeTaskRun!.id);
    expect(events.find((event) => event.type === "run.blocked")?.summary).toContain("需要人工测试");
    expect(events.find((event) => event.type === "assignment.blocked")?.payload).toMatchObject({
      reason: expect.stringContaining("缺少浏览器运行环境")
    });
    expect(events.map((event) => event.type)).not.toContain("run.failed");
  });

  it("routes QA-found acceptance risks back to development instead of human manual testing", async () => {
    const fixture = await missionFixture(new ManualQaWithDefectRiskProvider());

    const snapshot = await fixture.mission.startTask(
      { workspaceId: fixture.workspace.id, goal: "Build a canvas game with static QA risks" },
      { runSynchronously: true }
    );

    expect(snapshot.status).toBe("completed");
    const events = await fixture.ledger.read(fixture.workspace.rootPath, snapshot.activeTask!.id, snapshot.activeTaskRun!.id);
    expect(events.map((event) => event.type)).not.toContain("run.blocked");
    expect(events.some((event) => event.type === "handoff.created" && event.summary.includes("敌人生成点"))).toBe(true);
    expect(events.filter((event) => event.type === "assignment.completed" && event.summary.includes("开发执行"))).toHaveLength(2);
  });

  it("routes nested QA failure reports back to development instead of treating them as manual testing", async () => {
    const fixture = await missionFixture(new NestedQaFailureReportProvider());

    const snapshot = await fixture.mission.startTask(
      { workspaceId: fixture.workspace.id, goal: "Build a canvas game with QA failure report" },
      { runSynchronously: true }
    );

    expect(snapshot.status).toBe("completed");
    const events = await fixture.ledger.read(fixture.workspace.rootPath, snapshot.activeTask!.id, snapshot.activeTaskRun!.id);
    expect(events.map((event) => event.type)).not.toContain("run.blocked");
    expect(events.some((event) => event.type === "handoff.created" && event.summary.includes("DEFECT-001"))).toBe(true);
    expect(events.filter((event) => event.type === "assignment.completed" && event.summary.includes("开发执行"))).toHaveLength(2);
  });

  it("routes developer requirement conflicts back to PM instead of human", async () => {
    const fixture = await missionFixture(new DevReturnsRequirementConflictProvider());

    const snapshot = await fixture.mission.startTask(
      { workspaceId: fixture.workspace.id, goal: "Build with conflicting acceptance criteria" },
      { runSynchronously: true }
    );

    expect(snapshot.status).toBe("completed");
    const events = await fixture.ledger.read(fixture.workspace.rootPath, snapshot.activeTask!.id, snapshot.activeTaskRun!.id);
    expect(events.map((event) => event.type)).not.toContain("run.blocked");
    expect(events.some((event) => event.type === "handoff.created" && event.summary.includes("需求和验收标准冲突"))).toBe(true);
    expect(events.filter((event) => event.type === "assignment.completed" && event.summary.includes("计划拆解"))).toHaveLength(2);
  });

  it("continues to boss acceptance after human confirms manual QA passed", async () => {
    const provider = new ManualBrowserQaProvider();
    const fixture = await missionFixture(provider);

    const blocked = await fixture.mission.startTask(
      { workspaceId: fixture.workspace.id, goal: "Build a canvas game" },
      { runSynchronously: true }
    );

    expect(blocked.status).toBe("blocked");
    expect(blocked.phase).toBe("qa");

    const resumed = await fixture.mission.followUpTask(
      fixture.workspace.id,
      blocked.activeTask!.id,
      "我已经人工测试了，没有问题，可以验收。",
      true
    );

    expect(resumed.status).toBe("completed");
    const events = await fixture.ledger.read(fixture.workspace.rootPath, resumed.activeTask!.id, resumed.activeTaskRun!.id);
    const followupPhase = events.find((event) => event.type === "task.phase_changed" && event.summary.includes("收到补充"))?.payload;
    expect(followupPhase).toMatchObject({ phase: "boss_acceptance", fromPhase: "qa" });
    expect(resumed.tickets?.find((ticket) => ticket.type === "qa")).toMatchObject({ status: "completed" });
    expect(resumed.tickets?.find((ticket) => ticket.type === "boss_acceptance")).toMatchObject({ parentTicketId: resumed.tickets?.find((ticket) => ticket.type === "qa")?.id });
    expect(events.filter((event) => event.type === "assignment.completed" && event.summary.includes("开发执行"))).toHaveLength(1);
    expect(events.map((event) => event.type)).toContain("run.completed");
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
    expect(stopped.tickets?.every((ticket) => ticket.status !== "running" && ticket.status !== "pending")).toBe(true);
    expect(stopped.inboxMessages?.every((message) => message.status !== "claimed" && message.status !== "pending")).toBe(true);
  });

  it("does not let a late agent result overwrite an interrupted task", async () => {
    const fixture = await missionFixture(new SlowDevProvider());
    const started = await fixture.mission.startTask({ workspaceId: fixture.workspace.id, goal: "Stop during dev" });

    await new Promise((resolve) => setTimeout(resolve, 80));
    await fixture.mission.stopTask(fixture.workspace.id, started.activeTask!.id);
    await new Promise((resolve) => setTimeout(resolve, 220));
    const snapshot = await fixture.mission.snapshotByWorkspace(fixture.workspace.id);

    expect(snapshot.status).toBe("interrupted");
    expect(snapshot.tickets?.every((ticket) => ticket.status !== "running" && ticket.status !== "pending")).toBe(true);
    expect(snapshot.inboxMessages?.every((message) => message.status !== "claimed" && message.status !== "pending")).toBe(true);
  });

  it("recruits a specialist when the architect reports a capability gap", async () => {
    const fixture = await missionFixture(new NeedsSpecialistProvider());
    for (const profile of await fixture.profileStore.list()) {
      await fixture.profileStore.update(profile.id, { defaultProvider: "openai", defaultModel: "gpt-default" });
    }

    const snapshot = await fixture.mission.startTask(
      { workspaceId: fixture.workspace.id, goal: "Build auth security checks" },
      { runSynchronously: true }
    );

    expect(snapshot.status).toBe("completed");
    expect(snapshot.agents.some((agent) => agent.roleInWorkspace === "specialist")).toBe(true);
    const specialist = snapshot.agents.find((agent) => agent.roleInWorkspace === "specialist");
    expect(specialist?.provider).toBe("openai");
    expect(specialist?.model).toBe("gpt-default");
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
  const profileStore = new AgentProfileStore(home);
  const provider = new ProviderRegistry({ homeDir: home, env: { NODE_ENV: "test" }, retryCount: 0 });
  const mission = new MissionControl(store, ledger, providerOverride ?? provider, profileStore);
  return { home, root, store, workspace, ledger, mission, profileStore };
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
    if (input.role === "dev" || input.role === "specialist") return implementationResult();
    return result({ ok: true });
  }
}

class NeedsSpecialistProvider implements ProviderRunner {
  async runWithRetry(input: AgentTurnInput): Promise<AgentTurnResult> {
    if (input.role === "architect") return result({ architecture: "small", needsSpecialist: true, capabilityGap: "安全/认证" });
    if (input.role === "dev" || input.role === "specialist") return implementationResult();
    return result({ ok: true });
  }
}

class BossClarifiesThenTeamCompletesProvider implements ProviderRunner {
  async runWithRetry(input: AgentTurnInput): Promise<AgentTurnResult> {
    if (input.role === "boss" && input.assignmentType === "boss_intake") {
      return result({
        decision: "暂不执行，需澄清",
        clarification_required: true,
        reason: "目标缺少验收标准和交付边界",
        action: "awaiting_clarification"
      });
    }
    if (input.role === "architect") return result({ architecture: "small", needsSpecialist: false });
    if (input.role === "dev" || input.role === "specialist") return implementationResult();
    if (input.role === "qa") return result({ passed: true, report: "Pass" });
    if (input.assignmentType === "boss_acceptance") return result({ accepted: true, summary: "验收通过" });
    return result({ ok: true });
  }
}

class ChineseClarificationProvider implements ProviderRunner {
  rolesSeen: string[] = [];

  async runWithRetry(input: AgentTurnInput): Promise<AgentTurnResult> {
    this.rolesSeen.push(input.role);
    if (input.assignmentType === "boss_acceptance") return result({ accepted: true, summary: "验收通过" });
    if (input.role === "boss") {
      return result({
        decision: "暂不执行，需澄清",
        reason: "目标缺少验收标准和交付边界",
        action: "check_project_files"
      });
    }
    if (input.role === "architect") return result({ architecture: "small", needsSpecialist: false });
    if (input.role === "dev" || input.role === "specialist") return implementationResult();
    if (input.role === "qa") return result({ passed: true, report: "Pass" });
    return result({ ok: true });
  }
}

class NoImplementationEvidenceProvider implements ProviderRunner {
  async runWithRetry(input: AgentTurnInput): Promise<AgentTurnResult> {
    if (input.role === "architect") return result({ architecture: "small", needsSpecialist: false });
    if (input.role === "dev") return result({ ok: true, summary: "已完成" });
    return result({ ok: true });
  }
}

class ExistingArtifactProvider implements ProviderRunner {
  async runWithRetry(input: AgentTurnInput): Promise<AgentTurnResult> {
    if (input.role === "architect") return result({ architecture: "small", needsSpecialist: false });
    if (input.role === "dev") return result({ status: "delivered", deliverable: "index.html", summary: "已交付 index.html" });
    if (input.role === "qa") return result({ passed: true, report: "Pass" });
    if (input.assignmentType === "boss_acceptance") return result({ accepted: true, summary: "验收通过" });
    return result({ ok: true });
  }
}

class ManualTestFileImplementationProvider implements ProviderRunner {
  async runWithRetry(input: AgentTurnInput): Promise<AgentTurnResult> {
    if (input.role === "architect") return result({ architecture: "small", needsSpecialist: false });
    if (input.role === "dev") {
      return result({
        status: "manual_test_required",
        manual_test_file: "index.html",
        report: "index.html 已实现，需要 QA 或人工浏览器测试"
      });
    }
    if (input.role === "qa") return result({ passed: true, report: "Pass" });
    if (input.assignmentType === "boss_acceptance") return result({ accepted: true, summary: "验收通过" });
    return result({ ok: true });
  }
}

class ManualTestStepsPathImplementationProvider implements ProviderRunner {
  async runWithRetry(input: AgentTurnInput): Promise<AgentTurnResult> {
    if (input.role === "architect") return result({ architecture: "small", needsSpecialist: false });
    if (input.role === "dev") {
      return result({
        status: "manual_test_required",
        changes_description: "项目路径下已有完整可运行的 index.html，无需代码变更。",
        manual_test_steps: [
          "在浏览器中打开 index.html",
          "验证移动、射击、敌人、墙体、基地和胜负条件"
        ]
      });
    }
    if (input.role === "qa") return result({ passed: true, report: "Pass" });
    if (input.assignmentType === "boss_acceptance") return result({ accepted: true, summary: "验收通过" });
    return result({ ok: true });
  }
}

class ClarifiesAfterHumanProvider implements ProviderRunner {
  seenFollowup = "";

  async runWithRetry(input: AgentTurnInput): Promise<AgentTurnResult> {
    const latest = input.context?.latestHumanFollowup as { message?: string } | undefined;
    if (!latest?.message && input.role === "boss") {
      return result({
        decision: "暂不执行，需澄清",
        clarification_required: true,
        reason: "目标缺少验收标准和交付边界",
        action: "awaiting_clarification"
      });
    }
    if (latest?.message) this.seenFollowup = latest.message;
    if (input.role === "architect") return result({ architecture: "small", needsSpecialist: false });
    if (input.role === "dev" || input.role === "specialist") return implementationResult();
    if (input.role === "qa") return result({ passed: true, report: "Pass" });
    if (input.assignmentType === "boss_acceptance") return result({ accepted: true, summary: "验收通过" });
    return result({ ok: true });
  }
}

class MissingFileThenEmptyProjectProvider implements ProviderRunner {
  sawMissingFile = false;

  async runWithRetry(input: AgentTurnInput): Promise<AgentTurnResult> {
    const latest = input.context?.latestHumanFollowup as { message?: string } | undefined;
    if (!latest?.message && input.role === "boss") {
      return result({
        decision: "暂不执行，需澄清",
        clarification_required: true,
        reason: "目标缺少验收标准和交付边界",
        action: "awaiting_clarification"
      });
    }
    if (input.role === "pm") {
      const toolResults = (input.context?.toolResults as Array<Record<string, unknown>> | undefined) ?? [];
      this.sawMissingFile = toolResults.some((result) => result.tool === "readFile" && result.ok === false && String(result.error).includes("ENOENT"));
      if (this.sawMissingFile) {
        return result({
          plan: "从空项目创建 Web Canvas MVP",
          tasks: ["创建 package.json", "实现 Canvas 坦克大战", "补充验收命令"]
        });
      }
      return result({
        toolIntents: [{ tool: "readFile", path: "missing-package.json" }],
        reason: "需要读取项目文件后再计划"
      });
    }
    if (input.role === "architect") return result({ architecture: "small", needsSpecialist: false });
    if (input.role === "dev" || input.role === "specialist") return implementationResult();
    if (input.role === "qa") return result({ passed: true, report: "Pass" });
    if (input.assignmentType === "boss_acceptance") return result({ accepted: true, summary: "验收通过" });
    return result({ ok: true });
  }
}

class RequiresAuthorizationProvider implements ProviderRunner {
  private blockedOnce = false;

  async runWithRetry(input: AgentTurnInput): Promise<AgentTurnResult> {
    if (!this.blockedOnce && input.role === "boss") {
      this.blockedOnce = true;
      return result({
        status: "await_human_authorization",
        reason: "生产部署需要人工授权"
      });
    }
    if (input.role === "architect") return result({ architecture: "small", needsSpecialist: false });
    if (input.role === "dev" || input.role === "specialist") return implementationResult();
    if (input.role === "qa") return result({ passed: true, report: "Pass" });
    if (input.assignmentType === "boss_acceptance") return result({ accepted: true, summary: "验收通过" });
    return result({ ok: true });
  }
}

class ManualBrowserQaProvider implements ProviderRunner {
  async runWithRetry(input: AgentTurnInput): Promise<AgentTurnResult> {
    if (input.role === "architect") return result({ architecture: "small", needsSpecialist: false });
    if (input.role === "dev" || input.role === "specialist") return implementationResult();
    if (input.role === "qa") {
      return result({
        passed: false,
        status: "manual_test_required",
        report: "缺少浏览器运行环境，无法实际执行手动测试（移动、射击、碰撞等交互验证）。请人工打开 index.html，测试移动、射击、敌人、墙、基地和胜负条件。"
      });
    }
    if (input.assignmentType === "boss_acceptance") return result({ accepted: true, summary: "验收通过" });
    return result({ ok: true });
  }
}

class ManualQaWithDefectRiskProvider implements ProviderRunner {
  private qaCalls = 0;

  async runWithRetry(input: AgentTurnInput): Promise<AgentTurnResult> {
    if (input.role === "architect") return result({ architecture: "small", needsSpecialist: false });
    if (input.role === "dev" || input.role === "specialist") return implementationResult();
    if (input.role === "qa") {
      this.qaCalls += 1;
      if (this.qaCalls === 1) {
        return result({
          status: "manual_test_required",
          report: "缺少浏览器能力，需要人工测试。",
          static_analysis_risks: [
            "敌人生成点若全被占据，可能永远达不到8个敌人，影响胜利条件。",
            "玩家重生位置无无敌帧，可能落地瞬死。"
          ]
        });
      }
      return result({ passed: true, report: "Pass after rework" });
    }
    if (input.assignmentType === "boss_acceptance") return result({ accepted: true, summary: "验收通过" });
    return result({ ok: true });
  }
}

class NestedQaFailureReportProvider implements ProviderRunner {
  private qaCalls = 0;

  async runWithRetry(input: AgentTurnInput): Promise<AgentTurnResult> {
    if (input.role === "architect") return result({ architecture: "small", needsSpecialist: false });
    if (input.role === "dev" || input.role === "specialist") return implementationResult();
    if (input.role === "qa") {
      this.qaCalls += 1;
      if (this.qaCalls === 1) {
        return result({
          status: "fail",
          report: {
            summary: "静态分析发现 index.html 仍有缺陷。结论：打回开发，修复后再进入人工测试。",
            defects: [
              {
                id: "DEFECT-001",
                severity: "High",
                description: "子弹可穿透多块砖墙，需要在碰撞到第一块砖墙后停止处理。"
              }
            ],
            missing_fixes: ["子弹碰撞后 break"],
            recommendation: "开发需修改 index.html，完成后 QA 再检查。"
          }
        });
      }
      return result({ passed: true, report: "Pass after rework" });
    }
    if (input.assignmentType === "boss_acceptance") return result({ accepted: true, summary: "验收通过" });
    return result({ ok: true });
  }
}

class DevReturnsRequirementConflictProvider implements ProviderRunner {
  private devCalls = 0;

  async runWithRetry(input: AgentTurnInput): Promise<AgentTurnResult> {
    if (input.role === "architect") return result({ architecture: "small", needsSpecialist: false });
    if (input.role === "dev") {
      this.devCalls += 1;
      if (this.devCalls === 1) {
        return result({
          status: "blocked",
          reason: "需求和验收标准冲突：目标说只做单文件，但验收要求包含后端接口。需要 PM 重新拆解范围。"
        });
      }
      return implementationResult();
    }
    if (input.role === "qa") return result({ passed: true, report: "Pass" });
    if (input.assignmentType === "boss_acceptance") return result({ accepted: true, summary: "验收通过" });
    return result({ ok: true });
  }
}

class SlowDevProvider implements ProviderRunner {
  async runWithRetry(input: AgentTurnInput): Promise<AgentTurnResult> {
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (input.role === "architect") return result({ architecture: "small", needsSpecialist: false });
    if (input.role === "dev" || input.role === "specialist") return implementationResult();
    if (input.role === "qa") return result({ passed: true, report: "Pass" });
    if (input.assignmentType === "boss_acceptance") return result({ accepted: true, summary: "验收通过" });
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

function implementationResult(): AgentTurnResult {
  return result({
    artifact: "AUTOAGENT_RESULT.md",
    toolIntents: [{ tool: "writeFile", path: "AUTOAGENT_RESULT.md", content: "done\n" }]
  });
}
