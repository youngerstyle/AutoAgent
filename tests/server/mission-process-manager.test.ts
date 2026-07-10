import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentEngine } from "../../src/server/agent-engine/agent-engine.js";
import { AgentStore } from "../../src/server/agent-engine/agent-store.js";
import { MissionGoalResolutionPort } from "../../src/server/mission-process/mission-goal-resolution-port.js";
import { MissionProcessManager } from "../../src/server/mission-process/mission-process-manager.js";
import { MissionStore } from "../../src/server/mission-process/mission-store.js";
import { createMinimalTeamWorkflowDefinition } from "../../src/server/product/workflow-template.js";
import { TicketEngine } from "../../src/server/tickets/ticket-engine.js";
import { TicketStore } from "../../src/server/tickets/ticket-store.js";
import { createWorkflowPolicy, WorkflowPolicyStore } from "../../src/server/tickets/workflow-policy-store.js";
import type { TeamBinding } from "../../src/shared/contracts/mission-control.js";
import type { MissionTicketOutcome } from "../../src/server/mission-process/ticket-agent-adapter.js";

describe("MissionProcessManager", () => {
  it("links TicketReady to one Agent Goal and explicit Goal proposal back to Ticket", async () => {
    const fixture = await createFixture();
    await fixture.manager.startMission({
      missionId: "mission-a",
      objective: "build",
      requestedByPrincipalId: "human",
      resolvedStart: {
        workflowDefinition: createMinimalTeamWorkflowDefinition(fixture.policy.ref),
        teamBindingId: fixture.team.teamBindingId,
      },
    });
    let mission = await fixture.manager.tick();
    const intakeLink = mission.links.find((link) => link.agentId === "boss")!;
    expect(intakeLink).toMatchObject({ status: "running", agentId: "boss" });

    const boss = fixture.engines.get("boss")!;
    const goal = await boss.getGoal(intakeLink.agentGoalId!);
    const outcome: MissionTicketOutcome = { kind: "complete", result: { brief: "accepted" } };
    await boss.proposeGoalResolution({
      proposalId: "proposal-intake",
      goalId: goal!.spec.id,
      expectedGoalVersion: goal!.version,
      resolvingGoalVersion: goal!.version + 1,
      status: "completed",
      summary: "需求已接收",
      evidence: [],
      domainOutcome: outcome,
      createdAt: NOW,
    });

    mission = await fixture.manager.tick();
    expect(mission.links.find((link) => link.dispatchId === intakeLink.dispatchId)?.status).toBe("settled");
    expect(await boss.getGoal(goal!.spec.id)).toMatchObject({ status: "completed" });

    mission = await fixture.manager.tick();
    expect(mission.links.find((link) => link.agentId === "pm")).toMatchObject({ status: "running" });
  });

  it("recovers a persisted running link without creating a second claim or goal", async () => {
    const fixture = await createFixture();
    await fixture.manager.startMission({
      missionId: "mission-a",
      objective: "build",
      requestedByPrincipalId: "human",
      resolvedStart: {
        workflowDefinition: createMinimalTeamWorkflowDefinition(fixture.policy.ref),
        teamBindingId: fixture.team.teamBindingId,
      },
    });
    const before = await fixture.manager.tick();
    const after = await fixture.manager.recover();

    expect(after.links).toHaveLength(before.links.length);
    expect(after.links[0]?.agentGoalId).toBe(before.links[0]?.agentGoalId);
  });
});

const NOW = "2026-07-10T00:00:00.000Z";

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-mission-manager-"));
  const policyStore = new WorkflowPolicyStore(root);
  const policy = createWorkflowPolicy({
    policyId: "mission-policy",
    policyVersion: 1,
    grants: [
      { principalId: "planner", capabilities: ["ticket_graph:create", "ticket_graph:amend", "workflow:control"] },
      { teamBindingId: "team-a", capabilities: ["ticket:claim"] },
    ],
  });
  await policyStore.seedPolicy(policy);
  const ticketStore = new TicketStore(root, "task-a", "run-a");
  const tickets = new TicketEngine(ticketStore, policyStore, { teamBindingIds: ["team-a"], now: () => new Date(NOW) });
  const team: TeamBinding = {
    teamBindingId: "team-a",
    version: 1,
    contentHash: "team-hash",
    members: [
      { agentId: "boss", principalId: "principal-boss", capabilities: ["mission:intake"] },
      { agentId: "pm", principalId: "principal-pm", capabilities: ["workflow:plan"] },
    ],
  };
  const engines = new Map<string, AgentEngine<MissionTicketOutcome>>();
  for (const member of team.members) {
    const port = new MissionGoalResolutionPort(() => undefined, member.agentId, () => new Date(NOW));
    engines.set(member.agentId, new AgentEngine<MissionTicketOutcome>(new AgentStore(root, member.agentId), port, { now: () => new Date(NOW) }));
  }
  const manager = new MissionProcessManager(
    new MissionStore(root, "mission-a"),
    tickets,
    { get: (agentId) => engines.get(agentId)! },
    team,
    "planner",
    () => new Date(NOW),
  );
  return { root, policy, team, tickets, engines, manager };
}
