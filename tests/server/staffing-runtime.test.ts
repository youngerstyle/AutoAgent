import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentProfileStore } from "../../src/server/agents/profile-store.js";
import { listWorkspaceAgents } from "../../src/server/agents/roster.js";
import { ProviderRegistry } from "../../src/server/providers/provider-registry.js";
import { RuntimeHost } from "../../src/server/runtime/runtime-host.js";
import { DEFAULT_MINIMAL_TEAM_POLICY_CONFIG, seedMinimalTeamPlanPolicy } from "../../src/server/tickets/plan-policy-config.js";
import { PlanPolicyStore } from "../../src/server/tickets/plan-policy-store.js";
import type { Workspace } from "../../src/shared/types.js";

describe("automatic project staffing", () => {
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
    const providers = new ProviderRegistry({ homeDir: home, retryCount: 0 });
    const policyStore = new PlanPolicyStore(home);
    const policyRef = await seedMinimalTeamPlanPolicy(policyStore, DEFAULT_MINIMAL_TEAM_POLICY_CONFIG);
    const seenToolSets: string[][] = [];
    providers.get = async () => ({
      name: "mock",
      async runModelTurn(input) {
        seenToolSets.push(input.tools.map((tool) => tool.name));
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

    expect(await listWorkspaceAgents(workspace)).toEqual([]);
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
});

function member(profileId: string, responsibility: string) {
  return {
    profileId,
    responsibility,
    rationale: `Selected for ${responsibility}`,
  };
}
