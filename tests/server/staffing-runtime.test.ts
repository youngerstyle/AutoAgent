import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentProfileStore } from "../../src/server/agents/profile-store.js";
import { ensureProjectOwner, listWorkspaceAgents } from "../../src/server/agents/roster.js";
import { ProviderRegistry } from "../../src/server/providers/provider-registry.js";
import { ProviderError } from "../../src/server/providers/types.js";
import { RuntimeHost } from "../../src/server/runtime/runtime-host.js";
import { DEFAULT_MINIMAL_TEAM_POLICY_CONFIG, seedMinimalTeamPlanPolicy } from "../../src/server/tickets/plan-policy-config.js";
import { PlanPolicyStore } from "../../src/server/tickets/plan-policy-store.js";
import { parseTeamStaffingOutcome } from "../../src/shared/contracts/staffing.js";
import type { Workspace } from "../../src/shared/types.js";
import { StaffingCoordinator, validateStaffingOutcomeAgainstTalentPool } from "../../src/server/staffing/staffing-coordinator.js";
import { StaffingRequestStore, type StaffingRequestRecord } from "../../src/server/staffing/staffing-request-store.js";

describe("automatic project staffing", () => {
  it("rejects recruitment when an existing talent-pool profile already covers the requested capabilities", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "autoagent-staffing-talent-pool-home-"));
    const profiles = await new AgentProfileStore(home).list();
    const pm = profiles.find((profile) => profile.id === "prof_pm")!;
    const redundant = parseTeamStaffingOutcome({
      status: "recruitment_required",
      members: [],
      recruitmentRequests: [{ capabilities: [...pm.capabilities], reason: "需要 PM" }],
    });

    expect(() => validateStaffingOutcomeAgainstTalentPool(redundant, profiles, ["mission:intake", "plan:plan", "delivery:accept"]))
      .toThrow("从 talentPool 选择对应 profileId");

    const genuineGap = parseTeamStaffingOutcome({
      status: "recruitment_required",
      members: [],
      recruitmentRequests: [{ capabilities: ["production:kubernetes"], reason: "现有人才没有生产集群能力" }],
    });
    expect(() => validateStaffingOutcomeAgainstTalentPool(genuineGap, profiles, ["mission:intake", "plan:plan", "delivery:accept"]))
      .not.toThrow();
  });

  it("requires each staffing member to declare auditable capability coverage", () => {
    const parsed = parseTeamStaffingOutcome({
      status: "staffed",
      members: [member("prof_dev", "Implement the delivery")],
      recruitmentRequests: [],
    });
    expect(parsed.members[0]?.capabilityCoverage).toEqual([
      "delivery:implement",
      "代码阅读",
      "工具执行",
    ]);
    expect(() => parseTeamStaffingOutcome({
      status: "staffed",
      members: [{
        profileId: "prof_dev",
        responsibility: "Implement the delivery",
        rationale: "Selected for delivery",
      }],
      recruitmentRequests: [],
    })).toThrow("capabilityCoverage");
  });

  it("shows one staffing owner when the same profile already has a project instance", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "autoagent-staffing-owner-home-"));
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-staffing-owner-ws-"));
    const workspace: Workspace = {
      id: "workspace-staffing-owner",
      name: "Staffing owner workspace",
      rootPath: root,
      policyProfile: "development",
      createdAt: new Date().toISOString(),
    };
    const profiles = new AgentProfileStore(home);
    const owner = await ensureProjectOwner(workspace, await profiles.list());
    const providers = new ProviderRegistry({ homeDir: home, retryCount: 0 });
    const policyStore = new PlanPolicyStore(home);
    const policyRef = await seedMinimalTeamPlanPolicy(policyStore, DEFAULT_MINIMAL_TEAM_POLICY_CONFIG);
    const host = new RuntimeHost(workspace, profiles, providers, policyStore, policyRef, {
      intervalMs: 60_000,
    });

    await host.createTask({
      taskId: "task-staffing-owner",
      title: "Build product",
      objective: "Build and verify a usable product",
    });

    const snapshot = await host.snapshot();
    const owners = snapshot.agents.filter((agent) => agent.profileId === "prof_boss");
    expect(owners).toHaveLength(1);
    expect(owners[0]).toMatchObject({
      id: owner.id,
      status: "waiting",
    });
    await host.stop();
  });

  it("lets the staffing Agent choose talent before Mission creation", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "autoagent-staffing-home-"));
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-staffing-ws-"));
    const workspace: Workspace = {
      id: "workspace-staffing",
      name: "Staffing workspace",
      rootPath: root,
      policyProfile: "development",
      createdAt: new Date().toISOString(),
    };
    const profiles = new AgentProfileStore(home);
    await ensureProjectOwner(workspace, await profiles.list());
    const providers = new ProviderRegistry({ homeDir: home, retryCount: 0 });
    const policyStore = new PlanPolicyStore(home);
    const policyRef = await seedMinimalTeamPlanPolicy(policyStore, DEFAULT_MINIMAL_TEAM_POLICY_CONFIG);
    const seenToolSets: string[][] = [];
    const seenModelInputs: Array<{ instructions: string; history: unknown[] }> = [];
    providers.get = async () => ({
      name: "mock",
      async runModelTurn(input) {
        seenToolSets.push(input.tools.map((tool) => tool.name));
        seenModelInputs.push({ instructions: input.instructions, history: input.history });
        if (input.tools.some((tool) => tool.name === "staff_project")) {
          return {
            items: [{
              type: "tool_call" as const,
              callId: "staff-project",
              name: "staff_project",
              arguments: {
                status: "staffed",
                members: [
                  member("prof_boss", "Own the objective and acceptance"),
                  member("prof_pm", "Plan the work"),
                  member("prof_dev", "Implement the delivery"),
                  member("prof_qa", "Verify the delivery"),
                ],
                recruitmentRequests: [],
              },
            }],
          };
        }
        return { items: [{ type: "assistant_message" as const, content: "Mission received" }] };
      },
    });
    const host = new RuntimeHost(workspace, profiles, providers, policyStore, policyRef, {
      intervalMs: 60_000,
    });

    expect((await listWorkspaceAgents(workspace)).map((agent) => agent.profileId)).toEqual(["prof_boss"]);
    await host.createTask({
      taskId: "task-staffing",
      title: "Build product",
      objective: "Build and verify a usable product",
    });
    expect(host.context("task-staffing")).toBeUndefined();

    await host.tick();

    const context = host.context("task-staffing");
    expect(context).toBeDefined();
    expect(seenToolSets[0]).toContain("staff_project");
    expect(seenToolSets[0]).not.toContain("goal_resolution");
    const firstModelInput = seenModelInputs[0]!;
    const firstInput = JSON.stringify(firstModelInput);
    const contextItem = firstModelInput.history
      .map((item) => item as { type?: string; content?: string })
      .find((item) => item.type === "user_message" && item.content?.startsWith("{\"type\":\"project_context\""));
    expect(firstInput).toContain("Build and verify a usable product");
    expect(JSON.parse(contextItem!.content!)).toMatchObject({
      type: "project_context",
      missionStartContract: {
        requiredCapabilities: ["mission:intake", "plan:plan", "delivery:accept"],
        staffingDecision: {
          meaning: expect.stringContaining("完整交付"),
          memberCoverage: expect.stringContaining("capabilityCoverage"),
          missingCapability: expect.stringContaining("recruitment_required"),
        },
      },
      currentTeam: expect.any(Array),
      talentPool: expect.any(Array),
    });
    expect(firstModelInput.instructions).not.toContain("Build and verify a usable product");
    expect(firstModelInput.instructions).not.toContain("project_context");
    expect(firstInput).not.toContain("你正在以组织负责人的身份组建项目团队");
    expect(firstInput).not.toContain("请根据目标复杂度自行裁剪团队");
    expect(firstInput).not.toContain("确定后调用 staff_project");
    const workspaceAgents = await listWorkspaceAgents(workspace);
    expect(workspaceAgents.map((agent) => agent.profileId).sort()).toEqual([
      "prof_boss",
      "prof_dev",
      "prof_pm",
      "prof_qa",
    ]);
    const mission = await context!.manager.current();
    expect(mission.record.ownerPrincipalId).toBe(
      `principal:${workspaceAgents.find((agent) => agent.profileId === "prof_boss")!.id}`,
    );
    expect(mission.record.teamBinding.members).toHaveLength(4);

    await host.createTask({
      taskId: "task-paused-staffing",
      title: "Paused staffing",
      objective: "Do not form a team while paused",
    });
    await host.pauseTask("task-paused-staffing");
    await host.tick();
    expect(host.context("task-paused-staffing")).toBeUndefined();
    await host.resumeTask("task-paused-staffing");
    await host.tick();
    expect(host.context("task-paused-staffing")).toBeDefined();

    await host.createTask({
      taskId: "task-cancelled-staffing",
      title: "Cancelled staffing",
      objective: "Do not form a team after cancellation",
    });
    await host.cancelTask("task-cancelled-staffing", "cancel before staffing");
    await host.tick();
    expect(host.context("task-cancelled-staffing")).toBeUndefined();
    expect(await host.listTasks()).toContainEqual(expect.objectContaining({
      taskId: "task-cancelled-staffing",
      status: "cancelled",
    }));
    await host.stop();
  });

  it("blocks visibly after the staffing Provider exhausts its retry budget", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "autoagent-staffing-provider-home-"));
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-staffing-provider-ws-"));
    const workspace: Workspace = {
      id: "workspace-staffing-provider",
      name: "Staffing provider failure",
      rootPath: root,
      policyProfile: "development",
      createdAt: new Date().toISOString(),
    };
    const profiles = new AgentProfileStore(home);
    await ensureProjectOwner(workspace, await profiles.list());
    const providers = new ProviderRegistry({ homeDir: home, retryCount: 0 });
    providers.get = async () => ({
      name: "mock",
      async runModelTurn() {
        throw new ProviderError("Connection error.", true, "CONNECTION_ERROR");
      },
    });
    const policyStore = new PlanPolicyStore(home);
    const policyRef = await seedMinimalTeamPlanPolicy(policyStore, DEFAULT_MINIMAL_TEAM_POLICY_CONFIG);
    let now = new Date("2026-08-11T00:00:00.000Z");
    const host = new RuntimeHost(workspace, profiles, providers, policyStore, policyRef, {
      intervalMs: 60_000,
      now: () => now,
      staffingProviderFailureLimit: 2,
      staffingProviderRetryBaseMs: 1,
      staffingProviderRetryMaxMs: 1,
    });

    await host.createTask({ taskId: "task-provider-failure", title: "Build", objective: "Build a product" });
    await host.tick();
    expect((await host.snapshot()).status).toBe("running");
    now = new Date(now.getTime() + 1);
    await host.tick();

    const snapshot = await host.snapshot();
    expect(snapshot.status).toBe("blocked");
    expect(snapshot.currentStep).toContain("模型服务连续失败 2 次");
    expect(snapshot.agents.find((agent) => agent.roleInWorkspace === "boss")?.status).toBe("blocked");
    await host.stop();
  });

  it("retries the same blocked staffing Goal after an explicit task resume", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "autoagent-staffing-resume-home-"));
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-staffing-resume-ws-"));
    const workspace: Workspace = {
      id: "workspace-staffing-resume",
      name: "Staffing resume",
      rootPath: root,
      policyProfile: "development",
      createdAt: new Date().toISOString(),
    };
    const profiles = new AgentProfileStore(home);
    await ensureProjectOwner(workspace, await profiles.list());
    const providers = new ProviderRegistry({ homeDir: home, retryCount: 0 });
    let providerAvailable = false;
    providers.get = async () => ({
      name: "mock",
      async runModelTurn(input) {
        if (!providerAvailable) throw new ProviderError("Connection error.", true, "CONNECTION_ERROR");
        return {
          items: [{
            type: "tool_call" as const,
            callId: "staff-after-resume",
            name: "staff_project",
            arguments: {
              status: "staffed",
              members: [
                member("prof_boss", "Own acceptance"),
                member("prof_pm", "Plan the work"),
                member("prof_dev", "Implement the work"),
                member("prof_qa", "Verify the work"),
              ],
              recruitmentRequests: [],
            },
          }],
        };
      },
    });
    const policyStore = new PlanPolicyStore(home);
    const policyRef = await seedMinimalTeamPlanPolicy(policyStore, DEFAULT_MINIMAL_TEAM_POLICY_CONFIG);
    const host = new RuntimeHost(workspace, profiles, providers, policyStore, policyRef, {
      intervalMs: 60_000,
      staffingProviderFailureLimit: 1,
    });

    await host.createTask({ taskId: "task-staffing-resume", title: "Build", objective: "Build a product" });
    await host.tick();
    expect((await host.snapshot()).status).toBe("blocked");

    providerAvailable = true;
    await host.resumeTask("task-staffing-resume");
    await host.tick();

    expect(host.context("task-staffing-resume")).toBeDefined();
    expect((await host.snapshot()).status).toBe("running");
    await host.stop();
  });

  it("freezes the staffing context payload so a retry cannot conflict when project history changes", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "autoagent-staffing-frozen-home-"));
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-staffing-frozen-ws-"));
    const workspace: Workspace = { id: "workspace-staffing-frozen", name: "Frozen staffing", rootPath: root, policyProfile: "development", createdAt: "2026-08-19T00:00:00.000Z" };
    const profiles = new AgentProfileStore(home);
    await ensureProjectOwner(workspace, await profiles.list());
    const providers = new ProviderRegistry({ homeDir: home, retryCount: 0 });
    let providerCalls = 0;
    providers.get = async () => ({
      name: "mock",
      async runModelTurn() {
        providerCalls += 1;
        if (providerCalls === 1) return { items: [{ type: "assistant_message" as const, content: "Reviewing the frozen context." }] };
        return { items: [{ type: "tool_call" as const, callId: "staff-frozen", name: "staff_project", arguments: {
          status: "staffed", members: [member("prof_boss", "Own acceptance"), member("prof_pm", "Plan"), member("prof_dev", "Implement"), member("prof_qa", "Verify")], recruitmentRequests: [],
        } }] };
      },
    });
    let historyLabel = "before-retry";
    let now = new Date("2026-08-19T00:00:00.000Z");
    const coordinator = new StaffingCoordinator(
      workspace, profiles, providers, ["mission:intake", "plan:plan", "delivery:accept"],
      async () => [{ taskId: "history", title: historyLabel, objective: historyLabel, status: "completed", createdAt: now.toISOString(), updatedAt: now.toISOString() }],
      () => now, { maxProviderFailures: 3, baseDelayMs: 1, maxDelayMs: 1 },
    );
    await coordinator.create("task-frozen", "Deliver a project");
    expect((await coordinator.runOnce("task-frozen")).request.status).toBe("running");
    const frozen = (await new StaffingRequestStore(root).getByTask("task-frozen"))!.contextMessage!;
    expect(frozen).toContain("before-retry");

    historyLabel = "after-retry";
    now = new Date(now.getTime() + 1);
    expect((await coordinator.runOnce("task-frozen")).outcome?.status).toBe("staffed");
    expect((await new StaffingRequestStore(root).getByTask("task-frozen"))!.contextMessage).toBe(frozen);
    expect(frozen).not.toContain("after-retry");
  });

  it("serializes concurrent saves from separate Store instances without losing staffing requests", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-staffing-concurrent-ws-"));
    const requests = Array.from({ length: 24 }, (_, index): StaffingRequestRecord => ({
      staffingRequestId: `staff-${index}`,
      taskId: `task-${index}`,
      workspaceId: "workspace-concurrent",
      objective: `objective-${index}`,
      staffingProfileId: "prof_boss",
      staffingAgentId: "wa_boss",
      status: "pending",
      createdAt: "2026-08-19T00:00:00.000Z",
      updatedAt: "2026-08-19T00:00:00.000Z",
    }));

    await Promise.all(requests.map((request) => new StaffingRequestStore(root).save(request)));

    expect((await new StaffingRequestStore(root).list()).map((request) => request.taskId).sort())
      .toEqual(requests.map((request) => request.taskId).sort());
  });
});

function member(profileId: string, responsibility: string) {
  return {
    profileId,
    responsibility,
    rationale: `Selected for ${responsibility}`,
    capabilityCoverage: profileId === "prof_boss"
      ? ["team:staff", "mission:intake", "delivery:accept"]
      : profileId === "prof_pm"
        ? ["plan:plan"]
        : profileId === "prof_dev"
          ? ["delivery:implement", "代码阅读", "工具执行"]
          : ["delivery:verify", "测试计划", "验收证据"],
  };
}
