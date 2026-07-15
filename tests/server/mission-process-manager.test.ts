import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentEngine } from "../../src/server/agent-engine/agent-engine.js";
import { AgentStore } from "../../src/server/agent-engine/agent-store.js";
import { MissionGoalResolutionPort } from "../../src/server/mission-process/mission-goal-resolution-port.js";
import { MissionProcessManager } from "../../src/server/mission-process/mission-process-manager.js";
import { MissionStore } from "../../src/server/mission-process/mission-store.js";
import { createMinimalTeamPlanDefinition } from "../../src/server/product/plan-template.js";
import { TicketEngine } from "../../src/server/tickets/ticket-engine.js";
import { TicketStore } from "../../src/server/tickets/ticket-store.js";
import { createPlanPolicy, PlanPolicyStore } from "../../src/server/tickets/plan-policy-store.js";
import type { TeamBinding } from "../../src/shared/contracts/mission-control.js";
import type { MissionTicketOutcome } from "../../src/server/mission-process/ticket-agent-adapter.js";

describe("MissionProcessManager", () => {
  it("reuses the one durable Plan when the same Mission start is replayed", async () => {
    const fixture = await createFixture();
    const request = {
      missionId: "mission-a",
      objective: "build",
      requestedByPrincipalId: "human",
      resolvedStart: {
        planDefinition: createMinimalTeamPlanDefinition(fixture.policy.ref, "build"),
        teamBindingId: fixture.team.teamBindingId,
      },
    } as const;

    const first = await fixture.manager.startMission(request);
    const second = await fixture.manager.startMission(request);

    expect(second.record.planId).toBe(first.record.planId);
    expect(second.record.objective).toBe("build");
    expect(await fixture.ticketStore.listPlanIds()).toEqual([first.record.planId]);
  });

  it("links TicketReady to one Agent Goal and explicit Goal proposal back to Ticket", async () => {
    const fixture = await createFixture();
    await fixture.manager.startMission({
      missionId: "mission-a",
      objective: "build",
      requestedByPrincipalId: "human",
      resolvedStart: {
        planDefinition: createMinimalTeamPlanDefinition(fixture.policy.ref, "build"),
        teamBindingId: fixture.team.teamBindingId,
      },
    });
    let mission = await fixture.manager.tick();
    const intakeLink = mission.links.find((link) => link.agentId === "boss")!;
    expect(intakeLink).toMatchObject({ status: "running", agentId: "boss" });

    const boss = fixture.engines.get("boss")!;
    const goal = await boss.getGoal(intakeLink.agentGoalId!);
    const outcome: MissionTicketOutcome = { brief: "accepted" };
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
    const planningLink = mission.links.find((link) => link.agentId === "pm")!;
    expect(planningLink).toMatchObject({ status: "running" });
    const pm = fixture.engines.get("pm")!;
    const planningThread = await pm.getThread(planningLink.agentThreadId!);
    const planningPayloads = await pm.getPayloads(planningThread.items.map((item) => item.payloadRef));
    const missionInstruction = [...planningPayloads.values()].find((value) => (
      typeof value === "object"
      && value !== null
      && "senderPrincipalId" in value
      && value.senderPrincipalId === "mission-process"
    ));
    expect(missionInstruction).toMatchObject({
      content: expect.stringContaining('"missionObjective":"build"'),
    });
    expect(missionInstruction).toMatchObject({
      content: expect.stringContaining('"summary":"需求已接收"'),
    });
    expect(missionInstruction).toMatchObject({
      content: expect.stringContaining('"output":{"brief":"accepted"}'),
    });
    expect(missionInstruction).toMatchObject({
      content: expect.not.stringContaining("proposal-intake"),
    });
  });

  it("recovers a persisted running link without creating a second claim or goal", async () => {
    const fixture = await createFixture();
    await fixture.manager.startMission({
      missionId: "mission-a",
      objective: "build",
      requestedByPrincipalId: "human",
      resolvedStart: {
        planDefinition: createMinimalTeamPlanDefinition(fixture.policy.ref, "build"),
        teamBindingId: fixture.team.teamBindingId,
      },
    });
    const before = await fixture.manager.tick();
    const after = await fixture.manager.recover();

    expect(after.links).toHaveLength(before.links.length);
    expect(after.links[0]?.agentGoalId).toBe(before.links[0]?.agentGoalId);
  });

  it("finishes settlement from the durable Ticket result after interruption without another Agent turn", async () => {
    const fixture = await createFixture();
    await fixture.manager.startMission({
      missionId: "mission-a",
      objective: "build",
      requestedByPrincipalId: "human",
      resolvedStart: {
        planDefinition: createMinimalTeamPlanDefinition(fixture.policy.ref, "build"),
        teamBindingId: fixture.team.teamBindingId,
      },
    });
    const mission = await fixture.manager.tick();
    const link = mission.links[0]!;
    const boss = fixture.engines.get("boss")!;
    const goal = (await boss.getGoal(link.agentGoalId!))!;
    const originalSettle = boss.settleProposal.bind(boss);
    let interrupted = false;
    boss.settleProposal = async (input) => {
      if (!interrupted) {
        interrupted = true;
        const current = (await boss.getGoal(goal.spec.id))!;
        await boss.controlGoal({
          requestId: "pause-between-ticket-and-goal",
          goalId: current.spec.id,
          expectedGoalVersion: current.version,
          action: "pause",
          reason: "simulated process interruption",
        });
        throw new Error("simulated process interruption");
      }
      return originalSettle(input);
    };

    await expect(boss.proposeGoalResolution({
      proposalId: "proposal-interrupted-after-ticket",
      goalId: goal.spec.id,
      expectedGoalVersion: goal.version,
      resolvingGoalVersion: goal.version + 1,
      status: "completed",
      summary: "需求已接收",
      evidence: [],
      domainOutcome: { accepted: true },
      createdAt: NOW,
    })).resolves.toMatchObject({ attempt: { pending: "retry_later" } });
    await expect(fixture.manager.tick()).rejects.toThrow("simulated process interruption");
    boss.settleProposal = originalSettle;

    const recovered = await fixture.manager.recover();

    expect(recovered.links.find((item) => item.dispatchId === link.dispatchId)).toMatchObject({ status: "settled" });
    expect(await boss.getGoal(goal.spec.id)).toMatchObject({ status: "completed" });
  });

  it("does not treat a claim lease renewal as a Ticket state-version conflict", async () => {
    const fixture = await createFixture();
    await fixture.manager.startMission({
      missionId: "mission-a",
      objective: "build",
      requestedByPrincipalId: "human",
      resolvedStart: {
        planDefinition: createMinimalTeamPlanDefinition(fixture.policy.ref, "build"),
        teamBindingId: fixture.team.teamBindingId,
      },
    });
    const mission = await fixture.manager.tick();
    const link = mission.links[0]!;
    const boss = fixture.engines.get("boss")!;
    const goal = (await boss.getGoal(link.agentGoalId!))!;
    if (link.authority?.kind !== "claim") throw new Error("Expected a claimed mission link");
    await fixture.tickets.renewClaim({
      requestId: "external-renewal-before-settlement",
      claimId: link.authority.claimId,
      fencingToken: link.authority.fencingToken,
      extendByMs: 30 * 60_000,
    });
    await boss.proposeGoalResolution({
      proposalId: "proposal-after-ticket-version-change",
      goalId: goal.spec.id,
      expectedGoalVersion: goal.version,
      resolvingGoalVersion: goal.version + 1,
      status: "completed",
      summary: "需求已接收",
      evidence: [],
      domainOutcome: { accepted: true },
      createdAt: NOW,
    });

    const settled = await fixture.manager.tick();
    expect(settled.links.find((item) => item.dispatchId === link.dispatchId)).toMatchObject({ status: "settled" });
    expect(await boss.getGoal(goal.spec.id)).toMatchObject({ status: "completed" });
  });

  it("reconciles a resolving link after an Agent goal version conflict without restart or another turn", async () => {
    const fixture = await createFixture();
    await fixture.manager.startMission({
      missionId: "mission-a",
      objective: "build",
      requestedByPrincipalId: "human",
      resolvedStart: {
        planDefinition: createMinimalTeamPlanDefinition(fixture.policy.ref, "build"),
        teamBindingId: fixture.team.teamBindingId,
      },
    });
    const mission = await fixture.manager.tick();
    const link = mission.links[0]!;
    const boss = fixture.engines.get("boss")!;
    const goal = (await boss.getGoal(link.agentGoalId!))!;
    const originalSettle = boss.settleProposal.bind(boss);
    let allowSettlement = false;
    boss.settleProposal = async (input) => allowSettlement
      ? originalSettle(input)
      : { applied: false, code: "version_conflict", goal: (await boss.getGoal(goal.spec.id))! };
    await boss.proposeGoalResolution({
      proposalId: "proposal-agent-version-conflict",
      goalId: goal.spec.id,
      expectedGoalVersion: goal.version,
      resolvingGoalVersion: goal.version + 1,
      status: "completed",
      summary: "需求已接收",
      evidence: [],
      domainOutcome: { accepted: true },
      createdAt: NOW,
    });

    const conflicted = await fixture.manager.tick();
    expect(conflicted.links.find((item) => item.dispatchId === link.dispatchId)).toMatchObject({ status: "resolving" });
    allowSettlement = true;

    const settled = await fixture.manager.tick();
    expect(settled.links.find((item) => item.dispatchId === link.dispatchId)).toMatchObject({ status: "settled" });
    expect(await boss.getGoal(goal.spec.id)).toMatchObject({ status: "completed" });
  });

  it("renews a running claim before expiry without creating a second dispatch", async () => {
    const clock = { now: new Date(NOW) };
    const fixture = await createFixture(clock);
    await fixture.manager.startMission({
      missionId: "mission-a",
      objective: "build",
      requestedByPrincipalId: "human",
      resolvedStart: {
        planDefinition: createMinimalTeamPlanDefinition(fixture.policy.ref, "build"),
        teamBindingId: fixture.team.teamBindingId,
      },
    });
    const before = await fixture.manager.tick();
    const original = before.links[0]!;
    clock.now = new Date(Date.parse(NOW) + 21 * 60_000);

    const after = await fixture.manager.tick();
    const renewed = after.links[0]!;

    expect(after.links).toHaveLength(1);
    expect(renewed.dispatchId).toBe(original.dispatchId);
    expect(renewed.ticketVersion).toBe(original.ticketVersion);
    expect(Date.parse(renewed.claimLeaseUntil!)).toBeGreaterThan(Date.parse(original.claimLeaseUntil!));
  });

  it("keeps a malformed Agent outcome correctable without poisoning Mission ticks", async () => {
    const fixture = await createFixture();
    await fixture.manager.startMission({
      missionId: "mission-a",
      objective: "build",
      requestedByPrincipalId: "human",
      resolvedStart: {
        planDefinition: createMinimalTeamPlanDefinition(fixture.policy.ref, "build"),
        teamBindingId: fixture.team.teamBindingId,
      },
    });
    const mission = await fixture.manager.tick();
    const link = mission.links[0]!;
    const boss = fixture.engines.get("boss")!;
    const goal = (await boss.getGoal(link.agentGoalId!))!;
    const attempt = await boss.proposeGoalResolution({
      proposalId: "malformed-proposal",
      goalId: goal.spec.id,
      expectedGoalVersion: goal.version,
      resolvingGoalVersion: goal.version + 1,
      status: "completed",
      summary: "bad shape",
      evidence: [],
      domainOutcome: undefined as never,
      createdAt: NOW,
    });

    expect(attempt.goal.status).toBe("active");
    await expect(fixture.manager.tick()).resolves.toMatchObject({
      links: [expect.objectContaining({ status: "running" })],
    });
  });

  it("recovers a blocked planning Goal without treating missing change data as a team assignment", async () => {
    const fixture = await createFixture();
    await fixture.manager.startMission({
      missionId: "mission-a",
      objective: "build",
      requestedByPrincipalId: "human",
      resolvedStart: {
        planDefinition: createMinimalTeamPlanDefinition(fixture.policy.ref, "build"),
        teamBindingId: fixture.team.teamBindingId,
      },
    });
    let mission = await fixture.manager.tick();
    const intakeLink = mission.links.find((link) => link.agentId === "boss")!;
    const boss = fixture.engines.get("boss")!;
    const intakeGoal = (await boss.getGoal(intakeLink.agentGoalId!))!;
    await boss.proposeGoalResolution({
      proposalId: "complete-intake-before-planning-block",
      goalId: intakeGoal.spec.id,
      expectedGoalVersion: intakeGoal.version,
      resolvingGoalVersion: intakeGoal.version + 1,
      status: "completed",
      summary: "需求已接收",
      evidence: [],
      domainOutcome: { accepted: true },
      createdAt: NOW,
    });
    await fixture.manager.tick();
    mission = await fixture.manager.tick();
    const planningLink = mission.links.find((link) => link.agentId === "pm" && link.status === "running")!;
    const pm = fixture.engines.get("pm")!;
    const planningGoal = (await pm.getGoal(planningLink.agentGoalId!))!;
    await pm.proposeGoalResolution({
      proposalId: "blocked-planning-without-change",
      goalId: planningGoal.spec.id,
      expectedGoalVersion: planningGoal.version,
      resolvingGoalVersion: planningGoal.version + 1,
      status: "blocked",
      summary: "缺少不可替代输入",
      evidence: [],
      domainOutcome: undefined as never,
      createdAt: NOW,
    });

    await expect(fixture.manager.recover()).resolves.toMatchObject({
      links: expect.arrayContaining([expect.objectContaining({ agentId: "pm" })]),
    });
  });

  it("settles one QA attempt, runs correction, then starts a new attempt for the same QA Ticket", async () => {
    const fixture = await createFixture();
    await fixture.manager.startMission({
      missionId: "mission-a",
      objective: "build and verify",
      requestedByPrincipalId: "human",
      resolvedStart: {
        planDefinition: {
          definitionId: "correction-flow",
          definitionVersion: 1,
          policyRef: fixture.policy.ref,
          plannerAssignment: { principalId: "principal-pm" },
          initialChange: {
            additions: [
              { clientRef: "dev", title: "开发", objective: "实现功能", successCriteria: ["功能可运行"], assignment: { principalId: "principal-dev" }, outputContract: { schemaRef: "result-v1" } },
              { clientRef: "qa", title: "质量检查", objective: "验证功能", successCriteria: ["质量通过"], assignment: { principalId: "principal-qa" }, outputContract: { schemaRef: "result-v1" } },
            ],
            dependencyAdditions: [{ from: { clientRef: "dev" }, to: { clientRef: "qa" } }],
            cancelTicketIds: [],
            requiredTerminalRefs: [{ clientRef: "qa" }],
          },
        },
        teamBindingId: fixture.team.teamBindingId,
      },
    });

    let mission = await fixture.manager.tick();
    const devLink = mission.links.find((item) => item.agentId === "dev" && item.status === "running")!;
    const devEngine = fixture.engines.get("dev")!;
    const devGoal = (await devEngine.getGoal(devLink.agentGoalId!))!;
    await devEngine.proposeGoalResolution({ proposalId: "dev-complete", goalId: devGoal.spec.id, expectedGoalVersion: devGoal.version, resolvingGoalVersion: devGoal.version + 1, status: "completed", summary: "开发完成", evidence: [], domainOutcome: { result: "artifact" }, createdAt: NOW });
    await fixture.manager.tick();

    mission = await fixture.manager.tick();
    const qaLink = mission.links.find((item) => item.agentId === "qa" && item.status === "running")!;
    const qaEngine = fixture.engines.get("qa")!;
    const qaGoal = (await qaEngine.getGoal(qaLink.agentGoalId!))!;
    await qaEngine.proposeGoalResolution({
      proposalId: "qa-needs-correction", goalId: qaGoal.spec.id, expectedGoalVersion: qaGoal.version, resolvingGoalVersion: qaGoal.version + 1,
      status: "completed", summary: "发现缺陷", evidence: [],
      domainOutcome: { disposition: "correction_required", targetTicketId: devLink.ticketId, reason: "碰撞失效" }, createdAt: NOW,
    });
    mission = await fixture.manager.tick();
    expect(mission.links.find((item) => item.dispatchId === qaLink.dispatchId)).toMatchObject({ status: "settled" });
    expect(await fixture.tickets.getTicket(qaLink.ticketId)).toMatchObject({ status: "pending" });

    mission = await fixture.manager.tick();
    const correctionLink = mission.links.find((item) => item.agentId === "dev" && item.status === "running" && item.ticketId !== devLink.ticketId)!;
    const correctionGoal = (await devEngine.getGoal(correctionLink.agentGoalId!))!;
    await devEngine.proposeGoalResolution({ proposalId: "correction-complete", goalId: correctionGoal.spec.id, expectedGoalVersion: correctionGoal.version, resolvingGoalVersion: correctionGoal.version + 1, status: "completed", summary: "缺陷已修复", evidence: [], domainOutcome: { result: "fixed" }, createdAt: NOW });
    await fixture.manager.tick();

    mission = await fixture.manager.tick();
    const qaRetry = mission.links.find((item) => item.agentId === "qa" && item.status === "running" && item.ticketId === qaLink.ticketId)!;
    expect(qaRetry.dispatchId).not.toBe(qaLink.dispatchId);
    expect(qaRetry.agentGoalId).not.toBe(qaLink.agentGoalId);
    expect(qaRetry.ticketVersion).toBeGreaterThan(qaLink.ticketVersion);
  });
});

const NOW = "2026-07-10T00:00:00.000Z";

async function createFixture(clock = { now: new Date(NOW) }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-mission-manager-"));
  const policyStore = new PlanPolicyStore(root);
  const policy = createPlanPolicy({
    policyId: "mission-policy",
    policyVersion: 1,
    grants: [
      { principalId: "planner", capabilities: ["plan:create", "plan:amend", "plan:control"] },
      { teamBindingId: "team-a", capabilities: ["ticket:claim"] },
    ],
  });
  await policyStore.seedPolicy(policy);
  const ticketStore = new TicketStore(root, "task-a", "run-a");
  const tickets = new TicketEngine(ticketStore, policyStore, { teamBindingIds: ["team-a"], now: () => new Date(clock.now) });
  const team: TeamBinding = {
    teamBindingId: "team-a",
    version: 1,
    contentHash: "team-hash",
    members: [
      { agentId: "boss", principalId: "principal-boss", capabilities: ["mission:intake"] },
      { agentId: "pm", principalId: "principal-pm", capabilities: ["plan:plan"] },
      { agentId: "dev", principalId: "principal-dev", capabilities: ["implementation"] },
      { agentId: "qa", principalId: "principal-qa", capabilities: ["quality:verify"] },
    ],
  };
  const engines = new Map<string, AgentEngine<MissionTicketOutcome>>();
  for (const member of team.members) {
    const port = new MissionGoalResolutionPort(() => undefined, member.agentId, () => new Date(clock.now));
    engines.set(member.agentId, new AgentEngine<MissionTicketOutcome>(new AgentStore(root, member.agentId), port, { now: () => new Date(clock.now) }));
  }
  const manager = new MissionProcessManager(
    new MissionStore(root, "mission-a"),
    tickets,
    { get: (agentId) => engines.get(agentId)! },
    team,
    "planner",
    () => new Date(clock.now),
  );
  return { root, policy, team, ticketStore, tickets, engines, manager };
}
