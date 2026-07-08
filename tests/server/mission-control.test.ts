import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MissionControl, type MissionState } from "../../src/server/mission/mission-control";
import { EventLedger } from "../../src/server/storage/event-ledger";
import { WorkspaceStore } from "../../src/server/storage/workspace-store";
import { ProviderRegistry } from "../../src/server/providers/provider-registry";
import { AgentProfileStore } from "../../src/server/agents/profile-store";
import type { ProviderRunner } from "../../src/server/agents/agent-runtime";
import type { AgentTurnInput, AgentTurnResult } from "../../src/server/providers/types";
import { readJson, writeJson } from "../../src/server/storage/json";
import { stateFile } from "../../src/server/storage/paths";

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

  it("does not present a completed run when a ticket is still blocked", async () => {
    const fixture = await missionFixture();

    const completed = await fixture.mission.startTask(
      { workspaceId: fixture.workspace.id, goal: "Build a stale completed snapshot" },
      { runSynchronously: true }
    );
    const taskId = completed.activeTask!.id;
    const taskRunId = completed.activeTaskRun!.id;
    const file = stateFile(fixture.workspace.rootPath, taskId, taskRunId);
    const state = await readJson<MissionState | undefined>(file, undefined);
    if (!state) throw new Error("state file missing");
    const pmTicket = state.tickets.find((ticket) => ticket.type === "pm_plan");
    if (!pmTicket) throw new Error("pm ticket missing");
    pmTicket.status = "blocked";
    pmTicket.blocker = { type: "external_dependency", reason: "PM 等待 human 补充" };
    await writeJson(file, state);

    const snapshot = await fixture.mission.snapshotByWorkspace(fixture.workspace.id);

    expect(snapshot.status).toBe("blocked");
    expect(snapshot.phase).toBe("pm_plan");
    expect(snapshot.tickets?.find((ticket) => ticket.id === pmTicket.id)?.status).toBe("blocked");
  });

  it("enforces one active TaskRun per workspace", async () => {
    const fixture = await missionFixture();

    await fixture.mission.startTask({ workspaceId: fixture.workspace.id, goal: "Wait here" }, { autoRun: false });

    await expect(fixture.mission.startTask({ workspaceId: fixture.workspace.id, goal: "Second" }, { autoRun: false })).rejects.toMatchObject({
      status: 409,
      code: "ACTIVE_TASK_RUN"
    });
  });

  it("seeds the boss intake ticket before the runtime loop starts", async () => {
    const fixture = await missionFixture();

    const snapshot = await fixture.mission.startTask(
      { workspaceId: fixture.workspace.id, goal: "Build from a raw idea" },
      { autoRun: false }
    );

    expect(snapshot.status).toBe("running");
    expect(snapshot.tickets).toHaveLength(2);
    const bossTicket = snapshot.tickets?.find((ticket) => ticket.type === "boss_intake");
    const pmTicket = snapshot.tickets?.find((ticket) => ticket.type === "pm_plan");
    expect(bossTicket).toMatchObject({
      type: "boss_intake",
      status: "pending",
      targetRole: "boss"
    });
    expect(bossTicket).not.toHaveProperty("parentTicketId");
    expect(bossTicket).not.toHaveProperty("createdByTicketId");
    expect(pmTicket).toMatchObject({
      type: "pm_plan",
      status: "pending",
      targetRole: "pm",
      parentTicketId: bossTicket?.id,
      createdByTicketId: bossTicket?.id,
      dependsOnTicketIds: [bossTicket?.id]
    });
    expect(snapshot.inboxMessages).toHaveLength(2);
    expect(snapshot.inboxMessages?.find((message) => message.ticketId === bossTicket?.id)).toMatchObject({
      status: "pending",
      toRole: "boss"
    });
    expect(snapshot.inboxMessages?.find((message) => message.ticketId === pmTicket?.id)).toMatchObject({
      status: "pending",
      toRole: "pm"
    });
  });

  it("creates follow-up tickets from completed tickets instead of hidden phase jumps", async () => {
    const fixture = await missionFixture();

    const snapshot = await fixture.mission.startTask(
      { workspaceId: fixture.workspace.id, goal: "Build a ticket linked demo" },
      { runSynchronously: true }
    );

    const tickets = snapshot.tickets ?? [];
    const boss = tickets.find((ticket) => ticket.type === "boss_intake");
    const pm = tickets.find((ticket) => ticket.type === "pm_plan");
    const architect = tickets.find((ticket) => ticket.type === "architect_plan");
    const dev = tickets.find((ticket) => ticket.type === "implementation");
    const qa = tickets.find((ticket) => ticket.type === "qa");
    const acceptance = tickets.find((ticket) => ticket.type === "boss_acceptance");

    expect(snapshot.status).toBe("completed");
    expect(pm).toMatchObject({ parentTicketId: boss?.id, createdByTicketId: boss?.id });
    expect(architect).toMatchObject({ parentTicketId: pm?.id, createdByTicketId: pm?.id });
    expect(dev).toMatchObject({ parentTicketId: architect?.id, createdByTicketId: architect?.id });
    expect(qa).toMatchObject({ parentTicketId: dev?.id, createdByTicketId: dev?.id });
    expect(acceptance).toMatchObject({ parentTicketId: qa?.id, createdByTicketId: qa?.id });
  });

  it("uses the PM returned ticket graph instead of inserting the default fixed chain", async () => {
    const fixture = await missionFixture(new PmReturnsExecutionTicketGraphProvider());

    const snapshot = await fixture.mission.startTask(
      { workspaceId: fixture.workspace.id, goal: "Build a direct implementation task" },
      { runSynchronously: true }
    );

    const tickets = snapshot.tickets ?? [];
    const pm = tickets.find((ticket) => ticket.type === "pm_plan");
    const architect = tickets.find((ticket) => ticket.type === "architect_plan");
    const dev = tickets.find((ticket) => ticket.type === "implementation");
    const qa = tickets.find((ticket) => ticket.type === "qa");
    const acceptance = tickets.find((ticket) => ticket.type === "boss_acceptance");

    expect(snapshot.status).toBe("completed");
    expect(architect).toBeUndefined();
    expect(dev).toMatchObject({
      brief: "直接实现单文件 Web Canvas MVP",
      parentTicketId: pm?.id,
      createdByTicketId: pm?.id
    });
    expect((dev as unknown as { dependsOnTicketIds?: string[] })?.dependsOnTicketIds).toEqual([pm?.id]);
    expect((qa as unknown as { dependsOnTicketIds?: string[] })?.dependsOnTicketIds).toEqual([dev?.id]);
    expect((acceptance as unknown as { dependsOnTicketIds?: string[] })?.dependsOnTicketIds).toEqual([qa?.id]);
  });

  it("treats omitted PM graph dependencies as ordered ticket flow instead of runnable roots", async () => {
    const fixture = await missionFixture(new PmReturnsOrderedTicketGraphWithoutDependsProvider());

    const snapshot = await fixture.mission.startTask(
      { workspaceId: fixture.workspace.id, goal: "Build an ordered flow" },
      { runSynchronously: true }
    );

    const tickets = snapshot.tickets ?? [];
    const pm = tickets.find((ticket) => ticket.type === "pm_plan");
    const dev = tickets.find((ticket) => ticket.type === "implementation");
    const qa = tickets.find((ticket) => ticket.type === "qa");
    const acceptance = tickets.find((ticket) => ticket.type === "boss_acceptance");

    expect(snapshot.status).toBe("completed");
    expect((dev as unknown as { dependsOnTicketIds?: string[] })?.dependsOnTicketIds).toEqual([pm?.id]);
    expect((qa as unknown as { dependsOnTicketIds?: string[] })?.dependsOnTicketIds).toEqual([dev?.id]);
    expect((acceptance as unknown as { dependsOnTicketIds?: string[] })?.dependsOnTicketIds).toEqual([qa?.id]);
  });

  it("routes PM graph tickets by ticket type when the model returns the wrong target role", async () => {
    const fixture = await missionFixture(new PmReturnsAcceptanceTicketWithWrongRoleProvider());

    const snapshot = await fixture.mission.startTask(
      { workspaceId: fixture.workspace.id, goal: "Build with a wrong target role" },
      { runSynchronously: true }
    );

    const acceptance = snapshot.tickets?.find((ticket) => ticket.type === "boss_acceptance");
    const acceptanceMessage = snapshot.inboxMessages?.find((message) => message.ticketId === acceptance?.id);

    expect(snapshot.status).toBe("completed");
    expect(acceptance).toMatchObject({ targetRole: "boss" });
    expect(acceptanceMessage).toMatchObject({ toRole: "boss" });
  });

  it("blocks PM planning when PM does not return a ticket graph instead of falling back to phases", async () => {
    const fixture = await missionFixture(new PmReturnsNarrativeOnlyProvider());

    const snapshot = await fixture.mission.startTask(
      { workspaceId: fixture.workspace.id, goal: "Build from a narrative-only PM plan" },
      { runSynchronously: true }
    );

    expect(snapshot.status).toBe("blocked");
    expect(snapshot.phase).toBe("pm_plan");
    expect(snapshot.tickets?.filter((ticket) => ticket.type === "pm_plan")).toHaveLength(1);
    expect(snapshot.tickets?.some((ticket) => ticket.type === "architect_plan")).toBe(false);
    expect(snapshot.tickets?.some((ticket) => ticket.type === "implementation")).toBe(false);
    expect(snapshot.tickets?.find((ticket) => ticket.type === "pm_plan")).toMatchObject({
      status: "blocked",
      blocker: { type: "external_dependency" }
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
    expect(snapshot.tickets?.some((ticket) => ticket.type === "pm_plan" && ticket.status === "completed")).toBe(true);
  });

  it("routes a boss write attempt to the team instead of blocking human", async () => {
    const fixture = await missionFixture(new BossAttemptsWriteThenTeamCompletesProvider());

    const snapshot = await fixture.mission.startTask(
      { workspaceId: fixture.workspace.id, goal: "创建一个坦克大战页面" },
      { runSynchronously: true }
    );

    expect(snapshot.status).toBe("completed");
    const events = await fixture.ledger.read(fixture.workspace.rootPath, snapshot.activeTask!.id, snapshot.activeTaskRun!.id);
    expect(events.some((event) => event.type === "tool.denied" && event.summary.includes("文件写入被拒绝"))).toBe(true);
    expect(events.map((event) => event.type)).not.toContain("run.blocked");
    expect(events.some((event) => event.summary.includes("开发开始开发执行"))).toBe(true);
    expect(events.find((event) => event.type === "ticket.created" && String((event.payload as Record<string, unknown>).reason).includes("没有写项目文件权限"))?.payload).toMatchObject({
      ticketType: "implementation"
    });
    const bossTicket = snapshot.tickets?.find((ticket) => ticket.type === "boss_intake");
    const implementationTicket = snapshot.tickets?.find((ticket) => ticket.type === "implementation");
    expect(implementationTicket).toMatchObject({
      parentTicketId: bossTicket?.id,
      createdByTicketId: bossTicket?.id
    });
    expect(events.map((event) => event.type)).toContain("run.completed");
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

  it("keeps a non-QA blocked ticket blocked when the owner agent classifies the human reply as a question", async () => {
    const fixture = await missionFixture(new AuthorizationReviewProvider());

    const blocked = await fixture.mission.startTask(
      { workspaceId: fixture.workspace.id, goal: "Deploy to production" },
      { runSynchronously: true }
    );

    expect(blocked.status).toBe("blocked");
    expect(blocked.phase).toBe("boss_intake");

    const afterQuestion = await fixture.mission.followUpTask(
      fixture.workspace.id,
      blocked.activeTask!.id,
      "为什么需要授权？",
      true
    );

    expect(afterQuestion.status).toBe("blocked");
    expect(afterQuestion.phase).toBe("boss_intake");
    expect(afterQuestion.tickets?.find((ticket) => ticket.type === "boss_intake")).toMatchObject({
      status: "blocked",
      blocker: { type: "human_authorization_required" }
    });
    expect(afterQuestion.humanLoop?.latestReply).toMatchObject({
      phase: "boss_intake",
      action: "hold",
      text: "生产部署会影响线上环境，需要你确认是否允许继续。"
    });
    const events = await fixture.ledger.read(fixture.workspace.rootPath, afterQuestion.activeTask!.id, afterQuestion.activeTaskRun!.id);
    expect(events.filter((event) => event.type === "assignment.completed" && event.summary.includes("需求接收"))).toHaveLength(2);
    expect(events.map((event) => event.type)).not.toContain("run.completed");
  });

  it("continues a non-QA blocked ticket only after the owner agent classifies the human reply as continue", async () => {
    const fixture = await missionFixture(new AuthorizationReviewProvider());

    const blocked = await fixture.mission.startTask(
      { workspaceId: fixture.workspace.id, goal: "Deploy to production" },
      { runSynchronously: true }
    );

    const resumed = await fixture.mission.followUpTask(
      fixture.workspace.id,
      blocked.activeTask!.id,
      "我确认授权继续。",
      true
    );

    expect(resumed.status).toBe("completed");
    const events = await fixture.ledger.read(fixture.workspace.rootPath, resumed.activeTask!.id, resumed.activeTaskRun!.id);
    expect(events.filter((event) => event.type === "assignment.completed" && event.summary.includes("需求接收"))).toHaveLength(3);
    expect(events.map((event) => event.type)).toContain("run.completed");
  });

  it("reruns the blocked PM ticket with the latest human reply instead of completing it directly", async () => {
    const provider = new PmResumeReviewProvider();
    const fixture = await missionFixture(provider);

    const blocked = await fixture.mission.startTask(
      { workspaceId: fixture.workspace.id, goal: "1:1 复刻 FC 坦克98" },
      { runSynchronously: true }
    );

    expect(blocked.status).toBe("blocked");
    expect(blocked.phase).toBe("pm_plan");

    const resumed = await fixture.mission.followUpTask(
      fixture.workspace.id,
      blocked.activeTask!.id,
      "1.是；2.和原版一样；3.都可以",
      true
    );

    expect(provider.reviewSawHumanFollowupInPrompt).toBe(true);
    expect(provider.reviewSawDelegationRule).toBe(true);
    expect(provider.reviewSawPmPlanGraphRule).toBe(false);
    expect(provider.pmExecutedAfterHumanReply).toBe(true);
    expect(provider.pmSawLatestHumanReplyDuringExecution).toBe(true);
    expect(resumed.status).toBe("completed");
    expect(resumed.tickets?.find((ticket) => ticket.type === "pm_plan")).toMatchObject({
      status: "completed",
      result: expect.objectContaining({ plan: "按 human 回复重新拆解" })
    });
    expect(resumed.tickets?.some((ticket) => ticket.type === "implementation")).toBe(true);
    const events = await fixture.ledger.read(fixture.workspace.rootPath, resumed.activeTask!.id, resumed.activeTaskRun!.id);
    expect(events.filter((event) => event.type === "assignment.completed" && event.summary.includes("计划拆解"))).toHaveLength(3);
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
    expect(events.some((event) => event.type === "ticket.created" && String((event.payload as Record<string, unknown>).reason).includes("敌人生成点"))).toBe(true);
    expect(events.filter((event) => event.type === "assignment.completed" && event.summary.includes("开发执行"))).toHaveLength(2);
    const qaTicket = snapshot.tickets?.find((ticket) => ticket.type === "qa");
    const reworkTicket = snapshot.tickets?.find((ticket) => ticket.type === "rework" && ticket.returnReason?.includes("敌人生成点"));
    expect(reworkTicket).toMatchObject({
      parentTicketId: qaTicket?.id,
      createdByTicketId: qaTicket?.id
    });
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
    expect(events.some((event) => event.type === "ticket.created" && String((event.payload as Record<string, unknown>).reason).includes("DEFECT-001"))).toBe(true);
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
    expect(events.some((event) => event.type === "ticket.created" && String((event.payload as Record<string, unknown>).reason).includes("需求和验收标准冲突"))).toBe(true);
    expect(events.filter((event) => event.type === "assignment.completed" && event.summary.includes("计划拆解"))).toHaveLength(2);
  });

  it("does not infer rework target phase from free-form agent reason text", async () => {
    const fixture = await missionFixture(new DevReturnsUnroutedRequirementTextProvider());

    const snapshot = await fixture.mission.startTask(
      { workspaceId: fixture.workspace.id, goal: "Build with an unrouted developer concern" },
      { runSynchronously: true }
    );

    expect(snapshot.status).toBe("blocked");
    expect(snapshot.phase).toBe("implementation");
    expect(snapshot.tickets?.find((ticket) => ticket.type === "implementation" && ticket.status === "blocked")).toMatchObject({
      blocker: { type: "external_dependency" }
    });
    const events = await fixture.ledger.read(fixture.workspace.rootPath, snapshot.activeTask!.id, snapshot.activeTaskRun!.id);
    expect(events.filter((event) => event.type === "assignment.completed" && event.summary.includes("计划拆解"))).toHaveLength(1);
    expect(events.filter((event) => event.type === "assignment.completed" && event.summary.includes("开发执行"))).toHaveLength(1);
    expect(events.map((event) => event.type)).toContain("run.blocked");
  });

  it("routes PM implementation artifact blockers to development instead of retrying PM planning", async () => {
    const fixture = await missionFixture(new PmFindsMissingImplementationArtifactProvider());

    const snapshot = await fixture.mission.startTask(
      { workspaceId: fixture.workspace.id, goal: "Fix a missing source file" },
      { runSynchronously: true }
    );

    expect(snapshot.status).toBe("blocked");
    expect(snapshot.phase).toBe("pm_plan");
    expect(snapshot.tickets?.find((ticket) => ticket.type === "pm_plan")).toMatchObject({
      status: "blocked",
      blocker: { type: "external_dependency" }
    });
    const events = await fixture.ledger.read(fixture.workspace.rootPath, snapshot.activeTask!.id, snapshot.activeTaskRun!.id);
    expect(events.filter((event) => event.type === "assignment.completed" && event.summary.includes("计划拆解"))).toHaveLength(1);
    expect(events.filter((event) => event.type === "assignment.completed" && event.summary.includes("开发执行"))).toHaveLength(0);
    expect(events.map((event) => event.type)).toContain("run.blocked");
    expect(events.map((event) => event.type)).not.toContain("run.failed");
  });

  it("blocks the PM ticket for human input when planning needs clarification", async () => {
    const fixture = await missionFixture(new PmNeedsClarificationProvider());

    const snapshot = await fixture.mission.startTask(
      { workspaceId: fixture.workspace.id, goal: "1:1复刻CF坦克98" },
      { runSynchronously: true }
    );

    expect(snapshot.status).toBe("blocked");
    expect(snapshot.phase).toBe("pm_plan");
    expect(snapshot.tickets?.find((ticket) => ticket.type === "pm_plan")).toMatchObject({
      status: "blocked",
      blocker: { type: "external_dependency" }
    });
    expect(snapshot.tickets?.some((ticket) => ticket.type === "implementation")).toBe(false);
    const events = await fixture.ledger.read(fixture.workspace.rootPath, snapshot.activeTask!.id, snapshot.activeTaskRun!.id);
    expect(events.map((event) => event.type)).toContain("run.blocked");
    expect(events.map((event) => event.type)).not.toContain("run.failed");
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
    expect(events.filter((event) => event.type === "assignment.completed" && event.summary.includes("质量检查"))).toHaveLength(2);
    expect(events.map((event) => event.type)).toContain("run.completed");
  });

  it("keeps manual QA blocked when the human asks a question instead of approving or rejecting", async () => {
    const provider = new ManualBrowserQaProvider();
    const fixture = await missionFixture(provider);

    const blocked = await fixture.mission.startTask(
      { workspaceId: fixture.workspace.id, goal: "Build a canvas game" },
      { runSynchronously: true }
    );

    expect(blocked.status).toBe("blocked");
    expect(blocked.phase).toBe("qa");

    const afterQuestion = await fixture.mission.followUpTask(
      fixture.workspace.id,
      blocked.activeTask!.id,
      "页面打不开，这是路径不对吗？",
      true
    );

    expect(afterQuestion.status).toBe("blocked");
    expect(afterQuestion.phase).toBe("qa");
    expect(afterQuestion.tickets?.find((ticket) => ticket.type === "qa")).toMatchObject({
      status: "blocked",
      blocker: { type: "manual_test_required" }
    });
    expect(afterQuestion.tickets?.find((ticket) => ticket.type === "boss_acceptance")).toMatchObject({ status: "pending" });
    const events = await fixture.ledger.read(fixture.workspace.rootPath, afterQuestion.activeTask!.id, afterQuestion.activeTaskRun!.id);
    expect(events.filter((event) => event.type === "assignment.completed" && event.summary.includes("质量检查"))).toHaveLength(2);
    expect(afterQuestion.activeTaskRun?.status).toBe("blocked");
    expect(events.map((event) => event.type)).toContain("human.followup");
    expect(events.map((event) => event.type)).not.toContain("run.completed");
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
    if (input.role === "pm") return defaultTicketGraphResult();
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
    if (input.role === "pm") return defaultTicketGraphResult();
    if (input.role === "architect") return result({ architecture: "small", needsSpecialist: true, capabilityGap: "安全/认证" });
    if (input.role === "dev" || input.role === "specialist") return implementationResult();
    return result({ ok: true });
  }
}

class BossClarifiesThenTeamCompletesProvider implements ProviderRunner {
  async runWithRetry(input: AgentTurnInput): Promise<AgentTurnResult> {
    if (input.role === "boss" && input.assignmentType === "boss_intake") {
      return result({
        decision: "继续交给 PM 拆解",
        reason: "目标还需要细化，但可由 PM 继续拆成工单",
        action: "continue_to_pm"
      });
    }
    if (input.role === "pm") return defaultTicketGraphResult();
    if (input.role === "architect") return result({ architecture: "small", needsSpecialist: false });
    if (input.role === "dev" || input.role === "specialist") return implementationResult();
    if (input.role === "qa") return result({ passed: true, report: "Pass" });
    if (input.assignmentType === "boss_acceptance") return result({ accepted: true, summary: "验收通过" });
    return result({ ok: true });
  }
}

class BossAttemptsWriteThenTeamCompletesProvider implements ProviderRunner {
  async runWithRetry(input: AgentTurnInput): Promise<AgentTurnResult> {
    const toolResults = (input.context?.toolResults as Array<Record<string, unknown>> | undefined) ?? [];
    if (input.role === "boss" && input.assignmentType === "boss_intake" && toolResults.length === 0) {
      return result({
        decision: "可执行",
        reason: "目标可以进入团队执行",
        toolIntents: [{ tool: "writeFile", path: "index.html", content: "<!doctype html><canvas></canvas>\n" }]
      });
    }
    if (input.role === "pm") return defaultTicketGraphResult(false);
    if (input.role === "architect") return result({ architecture: "small", needsSpecialist: false });
    if (input.role === "dev" || input.role === "specialist") return implementationResult();
    if (input.role === "qa") return result({ passed: true, report: "Pass" });
    if (input.assignmentType === "boss_acceptance") return result({ accepted: true, summary: "验收通过" });
    return result({ ok: true });
  }
}

class PmReturnsExecutionTicketGraphProvider implements ProviderRunner {
  async runWithRetry(input: AgentTurnInput): Promise<AgentTurnResult> {
    if (input.role === "pm") {
      return result({
        plan: "任务足够小，不需要单独架构评审，直接进入开发、质量检查和老板验收。",
        ticketGraph: [
          {
            key: "dev_mvp",
            type: "implementation",
            brief: "直接实现单文件 Web Canvas MVP",
            expectedArtifact: "可运行的 index.html",
            targetRole: "dev"
          },
          {
            key: "qa_mvp",
            type: "qa",
            brief: "检查单文件交付物是否满足验收条件",
            expectedArtifact: "质量检查结论",
            targetRole: "qa",
            dependsOn: ["dev_mvp"]
          },
          {
            key: "accept_mvp",
            type: "boss_acceptance",
            brief: "验收已经通过 QA 的 MVP",
            expectedArtifact: "验收结论",
            targetRole: "boss",
            dependsOn: ["qa_mvp"]
          }
        ]
      });
    }
    if (input.role === "dev" || input.role === "specialist") return implementationResult();
    if (input.role === "qa") return result({ passed: true, report: "Pass" });
    if (input.assignmentType === "boss_acceptance") return result({ accepted: true, summary: "验收通过" });
    return result({ ok: true });
  }
}

class PmReturnsOrderedTicketGraphWithoutDependsProvider implements ProviderRunner {
  async runWithRetry(input: AgentTurnInput): Promise<AgentTurnResult> {
    if (input.role === "pm") {
      return result({
        plan: "PM 按自然顺序列出开发、测试、验收，但没有显式填写 dependsOn。",
        ticketGraph: [
          {
            key: "dev_ordered",
            type: "implementation",
            brief: "实现可运行交付物",
            expectedArtifact: "index.html",
            targetRole: "dev"
          },
          {
            key: "qa_ordered",
            type: "qa",
            brief: "验证可运行交付物",
            expectedArtifact: "质量检查结论",
            targetRole: "qa"
          },
          {
            key: "accept_ordered",
            type: "boss_acceptance",
            brief: "验收通过 QA 的交付物",
            expectedArtifact: "验收结论",
            targetRole: "boss"
          }
        ]
      });
    }
    if (input.role === "dev" || input.role === "specialist") return implementationResult();
    if (input.role === "qa") return result({ passed: true, report: "Pass" });
    if (input.assignmentType === "boss_acceptance") return result({ accepted: true, summary: "验收通过" });
    return result({ ok: true });
  }
}

class PmReturnsAcceptanceTicketWithWrongRoleProvider implements ProviderRunner {
  async runWithRetry(input: AgentTurnInput): Promise<AgentTurnResult> {
    if (input.role === "pm") {
      return result({
        ticketGraph: [
          {
            key: "dev_wrong_role",
            type: "implementation",
            brief: "实现交付物",
            expectedArtifact: "index.html",
            targetRole: "dev"
          },
          {
            key: "qa_wrong_role",
            type: "qa",
            brief: "验证交付物",
            expectedArtifact: "测试报告",
            targetRole: "qa",
            dependsOn: ["dev_wrong_role"]
          },
          {
            key: "accept_wrong_role",
            type: "boss_acceptance",
            brief: "验收交付物",
            expectedArtifact: "验收结论",
            targetRole: "pm",
            dependsOn: ["qa_wrong_role"]
          }
        ]
      });
    }
    if (input.role === "dev" || input.role === "specialist") return implementationResult();
    if (input.role === "qa") return result({ passed: true, report: "Pass" });
    if (input.assignmentType === "boss_acceptance") return result({ accepted: true, summary: "验收通过" });
    return result({ ok: true });
  }
}

class PmReturnsNarrativeOnlyProvider implements ProviderRunner {
  async runWithRetry(input: AgentTurnInput): Promise<AgentTurnResult> {
    if (input.role === "pm") {
      return result({
        plan: "先做技术方案，再开发，再测试验收。",
        tasks: ["技术方案", "开发实现", "质量检查"]
      });
    }
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
    if (input.role === "pm") return defaultTicketGraphResult();
    if (input.role === "architect") return result({ architecture: "small", needsSpecialist: false });
    if (input.role === "dev" || input.role === "specialist") return implementationResult();
    if (input.role === "qa") return result({ passed: true, report: "Pass" });
    return result({ ok: true });
  }
}

class NoImplementationEvidenceProvider implements ProviderRunner {
  async runWithRetry(input: AgentTurnInput): Promise<AgentTurnResult> {
    if (input.role === "pm") return defaultTicketGraphResult();
    if (input.role === "architect") return result({ architecture: "small", needsSpecialist: false });
    if (input.role === "dev") return result({ ok: true, summary: "已完成" });
    return result({ ok: true });
  }
}

class ExistingArtifactProvider implements ProviderRunner {
  async runWithRetry(input: AgentTurnInput): Promise<AgentTurnResult> {
    if (input.role === "pm") return defaultTicketGraphResult();
    if (input.role === "architect") return result({ architecture: "small", needsSpecialist: false });
    if (input.role === "dev") return result({ status: "delivered", deliverable: "index.html", summary: "已交付 index.html" });
    if (input.role === "qa") return result({ passed: true, report: "Pass" });
    if (input.assignmentType === "boss_acceptance") return result({ accepted: true, summary: "验收通过" });
    return result({ ok: true });
  }
}

class ManualTestFileImplementationProvider implements ProviderRunner {
  async runWithRetry(input: AgentTurnInput): Promise<AgentTurnResult> {
    if (input.role === "pm") return defaultTicketGraphResult();
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
    if (input.role === "pm") return defaultTicketGraphResult();
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
    if (input.role === "pm") return defaultTicketGraphResult();
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
        return defaultTicketGraphResult();
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
    if (input.role === "pm") return defaultTicketGraphResult();
    if (input.role === "architect") return result({ architecture: "small", needsSpecialist: false });
    if (input.role === "dev" || input.role === "specialist") return implementationResult();
    if (input.role === "qa") return result({ passed: true, report: "Pass" });
    if (input.assignmentType === "boss_acceptance") return result({ accepted: true, summary: "验收通过" });
    return result({ ok: true });
  }
}

class AuthorizationReviewProvider implements ProviderRunner {
  private blockedOnce = false;

  async runWithRetry(input: AgentTurnInput): Promise<AgentTurnResult> {
    if (!this.blockedOnce && input.role === "boss") {
      this.blockedOnce = true;
      return result({
        status: "await_human_authorization",
        reason: "生产部署需要人工授权"
      });
    }
    if (input.role === "boss" && input.context?.humanFollowup === "为什么需要授权？") {
      return result({
        decision: "need_more_info",
        reason: "human 在询问授权原因，不是授权继续",
        reply_to_human: "生产部署会影响线上环境，需要你确认是否允许继续。"
      });
    }
    if (input.role === "boss" && input.context?.humanFollowup === "我确认授权继续。") {
      return result({
        decision: "continue",
        reason: "human 已明确授权继续"
      });
    }
    if (input.role === "pm") return defaultTicketGraphResult();
    if (input.role === "architect") return result({ architecture: "small", needsSpecialist: false });
    if (input.role === "dev" || input.role === "specialist") return implementationResult();
    if (input.role === "qa") return result({ passed: true, report: "Pass" });
    if (input.assignmentType === "boss_acceptance") return result({ accepted: true, summary: "验收通过" });
    return result({ ok: true });
  }
}

class PmResumeReviewProvider implements ProviderRunner {
  private pmBlockedOnce = false;
  reviewSawHumanFollowupInPrompt = false;
  reviewSawDelegationRule = false;
  reviewSawPmPlanGraphRule = false;
  pmExecutedAfterHumanReply = false;
  pmSawLatestHumanReplyDuringExecution = false;

  async runWithRetry(input: AgentTurnInput): Promise<AgentTurnResult> {
    if (input.role === "pm" && input.context?.humanFollowup === "1.是；2.和原版一样；3.都可以") {
      this.reviewSawHumanFollowupInPrompt = input.prompt.includes("本轮 humanFollowup 原文：\n1.是；2.和原版一样；3.都可以");
      this.reviewSawDelegationRule = input.prompt.includes("专业取舍委托给当前 Agent 自行判断");
      this.reviewSawPmPlanGraphRule = input.prompt.includes("产品/项目拆解任务必须优先返回 ticketGraph 数组");
      return result(
        this.reviewSawHumanFollowupInPrompt && this.reviewSawDelegationRule && !this.reviewSawPmPlanGraphRule
          ? { decision: "continue", reason: "human 已回答阻塞问题，可以让 PM 继续拆解" }
          : { decision: "need_more_info", reason: "resume-review prompt 缺少本轮 human 回复或分类规则" }
      );
    }
    if (input.role === "pm" && !this.pmBlockedOnce) {
      this.pmBlockedOnce = true;
      return result({
        status: "await_human_authorization",
        reason: "需要 human 确认是否按 FC 坦克98 1:1 复刻重新规划"
      });
    }
    if (input.role === "pm") {
      const latest = input.context?.latestHumanFollowup as { message?: string } | undefined;
      this.pmExecutedAfterHumanReply = true;
      this.pmSawLatestHumanReplyDuringExecution = latest?.message === "1.是；2.和原版一样；3.都可以";
      return result({
        plan: "按 human 回复重新拆解",
        ticketGraph: [
          {
            key: "dev_rebuild",
            type: "implementation",
            brief: "按 FC 坦克98 1:1 复刻实现核心玩法",
            expectedArtifact: "可运行的游戏文件",
            targetRole: "dev"
          },
          {
            key: "qa_rebuild",
            type: "qa",
            brief: "验证 FC 坦克98 复刻玩法",
            expectedArtifact: "质量检查结论",
            targetRole: "qa",
            dependsOn: ["dev_rebuild"]
          }
        ]
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
    if (input.role === "pm") return defaultTicketGraphResult();
    if (input.role === "architect") return result({ architecture: "small", needsSpecialist: false });
    if (input.role === "dev" || input.role === "specialist") return implementationResult();
    if (input.role === "qa") {
      if (input.context?.humanFollowup === "我已经人工测试了，没有问题，可以验收。") {
        return result({ human_action: "manual_test_passed", reason: "human 明确报告人工测试通过" });
      }
      if (input.context?.humanFollowup === "页面打不开，这是路径不对吗？") {
        return result({ human_action: "need_more_info", reason: "human 在询问页面无法打开的问题，不是验收结论" });
      }
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
    if (input.role === "pm") return defaultTicketGraphResult();
    if (input.role === "architect") return result({ architecture: "small", needsSpecialist: false });
    if (input.role === "dev" || input.role === "specialist") return implementationResult();
    if (input.role === "qa") {
      this.qaCalls += 1;
      if (this.qaCalls === 1) {
        return result({
          passed: false,
          reason: "静态检查发现阻塞验收的缺陷，需要开发先返工。",
          defects: [
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
    if (input.role === "pm") return defaultTicketGraphResult();
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
    if (input.role === "pm") return defaultTicketGraphResult();
    if (input.role === "architect") return result({ architecture: "small", needsSpecialist: false });
    if (input.role === "dev") {
      this.devCalls += 1;
      if (this.devCalls === 1) {
        return result({
          status: "blocked",
          target_ticket_type: "pm_plan",
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

class DevReturnsUnroutedRequirementTextProvider implements ProviderRunner {
  private devCalls = 0;

  async runWithRetry(input: AgentTurnInput): Promise<AgentTurnResult> {
    if (input.role === "pm") return defaultTicketGraphResult();
    if (input.role === "architect") return result({ architecture: "small", needsSpecialist: false });
    if (input.role === "dev") {
      this.devCalls += 1;
      if (this.devCalls === 1) {
        return result({
          status: "blocked",
          reason: "需求和验收标准冲突：这句话里出现 PM 和范围，但没有结构化 target_ticket_type。"
        });
      }
      return implementationResult();
    }
    if (input.role === "qa") return result({ passed: true, report: "Pass" });
    if (input.assignmentType === "boss_acceptance") return result({ accepted: true, summary: "验收通过" });
    return result({ ok: true });
  }
}

class PmFindsMissingImplementationArtifactProvider implements ProviderRunner {
  private pmCalls = 0;

  async runWithRetry(input: AgentTurnInput): Promise<AgentTurnResult> {
    if (input.role === "pm") {
      this.pmCalls += 1;
      if (this.pmCalls === 1) {
        return result({
          status: "blocked",
          reason: "项目目录缺少 index.html、地图配置和源码文件，无法定位需要修改的实现文件。"
        });
      }
      return result({ plan: "PM should not be retried for missing implementation artifacts" });
    }
    if (input.role === "architect") return result({ architecture: "small", needsSpecialist: false });
    if (input.role === "dev") return implementationResult();
    if (input.role === "qa") return result({ passed: true, report: "Pass" });
    if (input.assignmentType === "boss_acceptance") return result({ accepted: true, summary: "验收通过" });
    return result({ ok: true });
  }
}

class PmNeedsClarificationProvider implements ProviderRunner {
  async runWithRetry(input: AgentTurnInput): Promise<AgentTurnResult> {
    if (input.role === "pm") {
      return result({
        status: "need_clarification",
        clarification_required: true,
        reason: "当前需求过于模糊，无法拆解出可执行的工单DAG。需要先明确范围、功能和验收标准。"
      });
    }
    if (input.role === "architect") return result({ architecture: "small", needsSpecialist: false });
    if (input.role === "dev") return implementationResult();
    if (input.role === "qa") return result({ passed: true, report: "Pass" });
    if (input.assignmentType === "boss_acceptance") return result({ accepted: true, summary: "验收通过" });
    return result({ ok: true });
  }
}

class SlowDevProvider implements ProviderRunner {
  async runWithRetry(input: AgentTurnInput): Promise<AgentTurnResult> {
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (input.role === "pm") return defaultTicketGraphResult();
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

function defaultTicketGraphResult(includeArchitect = true): AgentTurnResult {
  const ticketGraph = includeArchitect
    ? [
        {
          key: "architecture",
          type: "architect_plan",
          brief: "判断架构方案、技术路径和能力缺口",
          expectedArtifact: "技术方案",
          targetRole: "architect"
        },
        {
          key: "implementation",
          type: "implementation",
          brief: "按计划开发并产出交付物",
          expectedArtifact: "真实项目文件或可运行交付物",
          targetRole: "dev",
          dependsOn: ["architecture"]
        },
        {
          key: "qa",
          type: "qa",
          brief: "验证实现并给出通过或失败结论",
          expectedArtifact: "质量检查结论",
          targetRole: "qa",
          dependsOn: ["implementation"]
        },
        {
          key: "acceptance",
          type: "boss_acceptance",
          brief: "验收已通过质量检查的交付物",
          expectedArtifact: "验收结论",
          targetRole: "boss",
          dependsOn: ["qa"]
        }
      ]
    : [
        {
          key: "implementation",
          type: "implementation",
          brief: "按计划开发并产出交付物",
          expectedArtifact: "真实项目文件或可运行交付物",
          targetRole: "dev"
        },
        {
          key: "qa",
          type: "qa",
          brief: "验证实现并给出通过或失败结论",
          expectedArtifact: "质量检查结论",
          targetRole: "qa",
          dependsOn: ["implementation"]
        },
        {
          key: "acceptance",
          type: "boss_acceptance",
          brief: "验收已通过质量检查的交付物",
          expectedArtifact: "验收结论",
          targetRole: "boss",
          dependsOn: ["qa"]
        }
      ];
  return result({
    plan: "PM 明确创建 ticket DAG。",
    ticketGraph
  });
}

function implementationResult(): AgentTurnResult {
  return result({
    artifact: "AUTOAGENT_RESULT.md",
    toolIntents: [{ tool: "writeFile", path: "AUTOAGENT_RESULT.md", content: "done\n" }]
  });
}
