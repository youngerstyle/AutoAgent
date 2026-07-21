import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentEngine } from "../../src/server/agent-engine/agent-engine.js";
import { AgentStore } from "../../src/server/agent-engine/agent-store.js";
import { MissionGoalResolutionPort } from "../../src/server/mission-process/mission-goal-resolution-port.js";
import { MissionProcessManager, validateTeamAssignments } from "../../src/server/mission-process/mission-process-manager.js";
import { MissionStore } from "../../src/server/mission-process/mission-store.js";
import { createMinimalTeamPlanDefinition } from "../../src/server/product/plan-template.js";
import { TicketEngine } from "../../src/server/tickets/ticket-engine.js";
import { TicketStore } from "../../src/server/tickets/ticket-store.js";
import { createPlanPolicy, PlanPolicyStore } from "../../src/server/tickets/plan-policy-store.js";
import type { TeamBinding } from "../../src/shared/contracts/mission-control.js";
import type { AgentGoal } from "../../src/shared/contracts/agent-engine.js";
import type { MissionTicketOutcome } from "../../src/server/mission-process/ticket-agent-adapter.js";

describe("MissionProcessManager", () => {
  it("requires every required terminal to carry explicit Mission settlement authority", async () => {
    const team: TeamBinding = {
      teamBindingId: "team",
      version: 1,
      contentHash: "hash",
      deliveryPolicy: { requiredTerminalCapabilities: ["delivery:accept"] },
      members: [{ agentId: "approver", principalId: "principal-approver", capabilities: ["delivery:accept"] }],
    };
    const withoutAuthority: MissionTicketOutcome = {
      result: {},
      change: {
        additions: [{ clientRef: "accept", title: "accept", objective: "accept", successCriteria: ["accepted"], assignment: { principalId: "principal-approver" }, outputContract: { schemaRef: "acceptance-v1" } }],
        dependencyAdditions: [], cancelTicketIds: [], requiredTerminalRefs: [{ clientRef: "accept" }],
      },
    };
    const withAuthority = structuredClone(withoutAuthority) as any;
    withAuthority.change.additions[0].permissions = { settleMission: true };
    const teamWithoutTerminalCapabilities: TeamBinding = {
      ...team,
      deliveryPolicy: undefined,
    };

    await expect(validateTeamAssignments(withoutAuthority, "plan-change-set-v3", team)).resolves.toContain("settleMission");
    await expect(validateTeamAssignments(withoutAuthority, "plan-change-set-v3", teamWithoutTerminalCapabilities)).resolves.toContain("settleMission");
    await expect(validateTeamAssignments(withAuthority, "plan-change-set-v3", team)).resolves.toBeUndefined();
    await expect(validateTeamAssignments(withAuthority, "plan-change-set-v3", teamWithoutTerminalCapabilities)).resolves.toBeUndefined();
  });

  it("enforces the configured terminal delivery capability without naming a role", async () => {
    const team: TeamBinding = {
      teamBindingId: "team",
      version: 1,
      contentHash: "hash",
      deliveryPolicy: { requiredTerminalCapabilities: ["delivery:accept"] },
      members: [
        { agentId: "builder", principalId: "principal-builder", capabilities: ["delivery:implement"] },
        { agentId: "reviewer", principalId: "principal-reviewer", capabilities: ["delivery:verify"] },
        { agentId: "approver", principalId: "principal-approver", capabilities: ["delivery:accept"] },
      ],
    };
    const withoutAcceptance = {
      change: {
        additions: [
          { clientRef: "build", assignment: { requiredCapabilities: ["delivery:implement"] } },
          { clientRef: "review", assignment: { requiredCapabilities: ["delivery:verify"] }, permissions: { settleMission: true } },
        ],
        requiredTerminalRefs: [{ clientRef: "review" }],
      },
    };
    const withAcceptance = {
      change: {
        additions: [
          ...withoutAcceptance.change.additions,
          { clientRef: "accept", assignment: { principalId: "principal-approver" }, permissions: { settleMission: true } },
        ],
        requiredTerminalRefs: [{ clientRef: "accept" }],
      },
    };

    await expect(validateTeamAssignments({ change: {
      additions: withoutAcceptance.change.additions,
      requiredTerminalRefs: [],
    } }, "plan-change-set-v3", team)).resolves.toContain("至少一个可验收终点");
    await expect(validateTeamAssignments(withoutAcceptance, "plan-change-set-v3", team)).resolves.toContain("delivery:accept");
    await expect(validateTeamAssignments(withAcceptance, "plan-change-set-v3", team)).resolves.toBeUndefined();
  });

  it("reuses the one durable Plan when the same Mission start is replayed", async () => {
    const fixture = await createFixture();
    const request = {
      missionId: "mission-a",
      objective: "build",
      requestedByPrincipalId: "human",
      ownerPrincipalId: "principal-boss",
      teamBinding: fixture.team,
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

  it("leaves an unassignable Ticket ready instead of silently dispatching it to the planner", async () => {
    const fixture = await createFixture();
    const definition = createMinimalTeamPlanDefinition(fixture.policy.ref, "build");
    definition.initialChange.additions[0]!.assignment = { requiredCapabilities: ["missing:capability"] };
    await fixture.manager.startMission({
      missionId: "mission-a",
      objective: "build",
      requestedByPrincipalId: "human",
      ownerPrincipalId: "principal-boss",
      teamBinding: fixture.team,
      resolvedStart: { planDefinition: definition, teamBindingId: fixture.team.teamBindingId },
    });

    const mission = await fixture.manager.tick();
    const plan = await fixture.tickets.getPlan(mission.record.planId);
    const firstTicket = await fixture.tickets.getTicket(plan.graph.ticketIds[0]!);

    expect(firstTicket?.status).toBe("ready");
    expect(mission.links).toEqual([]);
    expect(await fixture.engines.get("pm")!.getThreadForAgent("pm", "mission-a")).toBeUndefined();
  });

  it("rejects a changed TeamBinding when an existing Mission is reopened", async () => {
    const fixture = await createFixture();
    const request = {
      missionId: "mission-a",
      objective: "build",
      requestedByPrincipalId: "human",
      ownerPrincipalId: "principal-boss",
      teamBinding: fixture.team,
      resolvedStart: { planDefinition: createMinimalTeamPlanDefinition(fixture.policy.ref, "build"), teamBindingId: fixture.team.teamBindingId },
    } as const;
    await fixture.manager.startMission(request);
    const changedTeam = { ...fixture.team, contentHash: "changed-team-hash" };
    const changedManager = new MissionProcessManager(
      fixture.missionStore,
      fixture.tickets,
      { get: (agentId) => fixture.engines.get(agentId)! },
      changedTeam,
      "planner",
    );

    await expect(changedManager.startMission({ ...request, teamBinding: changedTeam }))
      .rejects.toThrow("Persisted TeamBinding does not match runtime TeamBinding");
  });

  it("links TicketReady to one Agent Goal and explicit Goal proposal back to Ticket", async () => {
    const fixture = await createFixture();
    await fixture.manager.startMission({
      missionId: "mission-a",
      objective: "build",
      requestedByPrincipalId: "human",
      ownerPrincipalId: "principal-boss",
      teamBinding: fixture.team,
      resolvedStart: {
        planDefinition: createMinimalTeamPlanDefinition(fixture.policy.ref, "build"),
        teamBindingId: fixture.team.teamBindingId,
      },
    });
    let mission = await fixture.manager.tick();
    const intakeLink = mission.links.find((link) => link.agentId === "boss")!;
    expect(intakeLink).toMatchObject({ status: "running", agentId: "boss" });

    const boss = fixture.engines.get("boss")!;
    const intakeThread = await boss.getThread(intakeLink.agentThreadId!);
    const intakePayloads = await boss.getPayloads(intakeThread.items.map((item) => item.payloadRef));
    expect([...intakePayloads.values()]).toContainEqual(expect.objectContaining({
      senderPrincipalId: "human",
      content: "build",
    }));
    const goal = await boss.getGoal(intakeLink.agentGoalId!);
    const outcome: MissionTicketOutcome = baselineOutcome();
    await boss.proposeGoalResolution({
      proposalId: "proposal-intake",
      goalId: goal!.spec.id,
      expectedGoalVersion: goal!.version,
      resolvingGoalVersion: goal!.version + 1,
      status: "completed",
      summary: "需求已接收",
      evidence: [],
      criterionResults: satisfied(goal!),
      residualRisks: [],
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
    expect(missionInstruction).toMatchObject({ content: expect.not.stringContaining('"missionObjective"') });
    expect(missionInstruction).toMatchObject({ content: expect.not.stringContaining('"build"') });
    expect(missionInstruction).toMatchObject({ content: expect.stringContaining('"currentPlan"') });
    expect(missionInstruction).toMatchObject({ content: expect.stringContaining('"missionBaseline"') });
    expect(missionInstruction).toMatchObject({ content: expect.stringContaining('"successCriteria"') });
    expect(missionInstruction).toMatchObject({ content: expect.stringContaining('"outputContract"') });
    expect(missionInstruction).toMatchObject({
      content: expect.stringContaining('"summary":"需求已接收"'),
    });
    expect(missionInstruction).toMatchObject({
      content: expect.stringContaining('"objective":"build the agreed product"'),
    });
    expect(missionInstruction).toMatchObject({
      content: expect.not.stringContaining("proposal-intake"),
    });
  });

  it("does not complete a Mission until an authorized Ticket settles the current baseline", async () => {
    const fixture = await createFixture();
    await fixture.manager.startMission({
      missionId: "mission-a",
      objective: "deliver the complete agreed product",
      requestedByPrincipalId: "human",
      ownerPrincipalId: "principal-boss",
      teamBinding: fixture.team,
      resolvedStart: {
        planDefinition: {
          definitionId: "baseline-settlement-flow",
          definitionVersion: 1,
          policyRef: fixture.policy.ref,
          plannerAssignment: { principalId: "principal-pm" },
          amendmentTemplate: { title: "plan revision", successCriteria: ["revision is valid"], outputContract: { schemaRef: "plan-change-set-v3" } },
          initialChange: {
            additions: [
              {
                clientRef: "intake", title: "baseline", objective: "establish baseline", successCriteria: ["baseline recorded"],
                assignment: { principalId: "principal-boss" }, outputContract: { schemaRef: "mission-baseline-v1" },
                contextPolicy: { includeOriginalRequest: true, establishesMissionBaseline: true },
              },
              {
                clientRef: "accept", title: "acceptance", objective: "accept against baseline", successCriteria: ["acceptance decided"],
                assignment: { principalId: "principal-boss" }, outputContract: { schemaRef: "acceptance-v1" },
                permissions: { settleMission: true },
              },
            ],
            dependencyAdditions: [{ from: { clientRef: "intake" }, to: { clientRef: "accept" } }],
            cancelTicketIds: [], requiredTerminalRefs: [{ clientRef: "accept" }],
          },
        },
        teamBindingId: fixture.team.teamBindingId,
      },
    });

    let mission = await fixture.manager.tick();
    const boss = fixture.engines.get("boss")!;
    const intake = mission.links.find((item) => item.status === "running")!;
    const intakeGoal = (await boss.getGoal(intake.agentGoalId!))!;
    await boss.proposeGoalResolution({
      proposalId: "baseline-proposal", goalId: intakeGoal.spec.id, expectedGoalVersion: intakeGoal.version, resolvingGoalVersion: intakeGoal.version + 1,
      status: "completed", summary: "baseline established", evidence: [], criterionResults: satisfied(intakeGoal), residualRisks: [],
      domainOutcome: baselineOutcome(), createdAt: NOW,
    });
    mission = await fixture.manager.tick();
    expect(mission.record).toMatchObject({ status: "linked", baseline: { version: 1, objective: "build the agreed product" } });

    mission = await fixture.manager.tick();
    const acceptance = mission.links.find((item) => item.status === "running")!;
    const acceptanceGoal = (await boss.getGoal(acceptance.agentGoalId!))!;
    await boss.proposeGoalResolution({
      proposalId: "incomplete-acceptance", goalId: acceptanceGoal.spec.id, expectedGoalVersion: acceptanceGoal.version, resolvingGoalVersion: acceptanceGoal.version + 1,
      status: "completed", summary: "accepted without baseline proof", evidence: [], criterionResults: satisfied(acceptanceGoal), residualRisks: [],
      domainOutcome: { result: "accepted" }, createdAt: NOW,
    });
    mission = await fixture.manager.tick();
    expect(mission.record.status).toBe("linked");
    expect(mission.links.find((item) => item.dispatchId === acceptance.dispatchId)).toMatchObject({ status: "running" });

    const retriedGoal = (await boss.getGoal(acceptance.agentGoalId!))!;
    const baseline = mission.record.baseline!;
    await boss.proposeGoalResolution({
      proposalId: "complete-acceptance", goalId: retriedGoal.spec.id, expectedGoalVersion: retriedGoal.version, resolvingGoalVersion: retriedGoal.version + 1,
      status: "completed", summary: "accepted against baseline", evidence: [], criterionResults: satisfied(retriedGoal), residualRisks: [],
      domainOutcome: {
        missionResolution: {
          baselineVersion: baseline.version,
          summary: "all baseline criteria accepted",
          criterionResults: baseline.criteria.map((item) => ({
            criterionId: item.criterionId,
            status: "satisfied",
            evidence: [{ kind: "test", ref: `acceptance://${item.criterionId}` }],
          })),
          residualRisks: [],
        },
      },
      createdAt: NOW,
    });
    mission = await fixture.manager.tick();
    expect(mission.record).toMatchObject({
      status: "completed",
      settlement: { acceptedByTicketId: acceptance.ticketId, baselineVersion: 1 },
    });
    expect((await fixture.tickets.getPlan(mission.record.planId)).status).toBe("completed");
  });

  it("delivers the complete accepted ancestor lineage to a downstream Agent", async () => {
    const fixture = await createFixture();
    await fixture.manager.startMission({
      missionId: "mission-a",
      objective: "preserve the original delivery target",
      requestedByPrincipalId: "human",
      ownerPrincipalId: "principal-boss",
      teamBinding: fixture.team,
      resolvedStart: {
        planDefinition: {
          definitionId: "lineage-flow",
          definitionVersion: 1,
          policyRef: fixture.policy.ref,
          plannerAssignment: { principalId: "principal-pm" },
          amendmentTemplate: { title: "plan revision", successCriteria: ["revision is valid"], outputContract: { schemaRef: "plan-change-set-v3" } },
          initialChange: {
            additions: [
              { clientRef: "scope", title: "scope baseline", objective: "record the immutable acceptance baseline", successCriteria: ["baseline remains traceable"], assignment: { principalId: "principal-boss" }, outputContract: { schemaRef: "scope-v1" } },
              { clientRef: "build", title: "implementation", objective: "build from the accepted baseline", successCriteria: ["artifact is produced"], assignment: { principalId: "principal-dev" }, outputContract: { schemaRef: "build-v1" } },
              { clientRef: "review", title: "independent review", objective: "judge the artifact against the project facts", successCriteria: ["decision cites project facts"], assignment: { principalId: "principal-qa" }, outputContract: { schemaRef: "review-v1" } },
            ],
            dependencyAdditions: [
              { from: { clientRef: "scope" }, to: { clientRef: "build" } },
              { from: { clientRef: "build" }, to: { clientRef: "review" } },
            ],
            cancelTicketIds: [],
            requiredTerminalRefs: [{ clientRef: "review" }],
          },
        },
        teamBindingId: fixture.team.teamBindingId,
      },
    });

    let mission = await fixture.manager.tick();
    const scopeLink = mission.links.find((item) => item.agentId === "boss" && item.status === "running")!;
    const boss = fixture.engines.get("boss")!;
    const scopeThread = await boss.getThread(scopeLink.agentThreadId!);
    const scopePayloads = await boss.getPayloads(scopeThread.items.map((item) => item.payloadRef));
    expect([...scopePayloads.values()]).not.toContainEqual(expect.objectContaining({
      senderPrincipalId: "human",
      content: "preserve the original delivery target",
    }));
    const scopeGoal = (await boss.getGoal(scopeLink.agentGoalId!))!;
    await boss.proposeGoalResolution({
      proposalId: "scope-complete", goalId: scopeGoal.spec.id, expectedGoalVersion: scopeGoal.version, resolvingGoalVersion: scopeGoal.version + 1,
      status: "completed", summary: "original baseline accepted", evidence: [], criterionResults: satisfied(scopeGoal), residualRisks: [],
      domainOutcome: { baseline: "full interactive delivery, not a simulation" }, createdAt: NOW,
    });
    await fixture.manager.tick();

    mission = await fixture.manager.tick();
    const buildLink = mission.links.find((item) => item.agentId === "dev" && item.status === "running")!;
    const dev = fixture.engines.get("dev")!;
    const buildGoal = (await dev.getGoal(buildLink.agentGoalId!))!;
    await dev.proposeGoalResolution({
      proposalId: "build-complete", goalId: buildGoal.spec.id, expectedGoalVersion: buildGoal.version, resolvingGoalVersion: buildGoal.version + 1,
      status: "completed", summary: "artifact implemented", evidence: [], criterionResults: satisfied(buildGoal), residualRisks: [],
      domainOutcome: { artifact: "dist/app" }, createdAt: NOW,
    });
    await fixture.manager.tick();

    mission = await fixture.manager.tick();
    const reviewLink = mission.links.find((item) => item.agentId === "qa" && item.status === "running")!;
    const qa = fixture.engines.get("qa")!;
    const reviewThread = await qa.getThread(reviewLink.agentThreadId!);
    const payloads = await qa.getPayloads(reviewThread.items.map((item) => item.payloadRef));
    const instruction = [...payloads.values()].find((value) => (
      typeof value === "object"
      && value !== null
      && "senderPrincipalId" in value
      && value.senderPrincipalId === "mission-process"
    )) as { content: string };

    expect(instruction.content).not.toContain('"missionObjective"');
    expect(instruction.content).not.toContain("preserve the original delivery target");
    expect(instruction.content).toContain('"currentPlan"');
    expect(instruction.content).toContain('"requiredTerminalTicketIds"');
    expect(instruction.content).toContain('"handoffLineage"');
    expect(instruction.content).toContain('"successCriteria":["baseline remains traceable"]');
    expect(instruction.content).toContain('"baseline":"full interactive delivery, not a simulation"');
    expect(instruction.content).toContain('"artifact":"dist/app"');
    expect(instruction.content.indexOf('"title":"scope baseline"')).toBeLessThan(instruction.content.indexOf('"title":"implementation"'));
  });

  it("recovers a persisted running link without creating a second claim or goal", async () => {
    const fixture = await createFixture();
    await fixture.manager.startMission({
      missionId: "mission-a",
      objective: "build",
      requestedByPrincipalId: "human",
      ownerPrincipalId: "principal-boss",
      teamBinding: fixture.team,
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
      ownerPrincipalId: "principal-boss",
      teamBinding: fixture.team,
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
      criterionResults: satisfied(goal),
      residualRisks: [],
      domainOutcome: baselineOutcome(),
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
      ownerPrincipalId: "principal-boss",
      teamBinding: fixture.team,
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
      criterionResults: satisfied(goal),
      residualRisks: [],
      domainOutcome: baselineOutcome(),
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
      ownerPrincipalId: "principal-boss",
      teamBinding: fixture.team,
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
      criterionResults: satisfied(goal),
      residualRisks: [],
      domainOutcome: baselineOutcome(),
      createdAt: NOW,
    });

    const conflicted = await fixture.manager.tick();
    expect(conflicted.links.find((item) => item.dispatchId === link.dispatchId)).toMatchObject({ status: "resolving" });
    allowSettlement = true;

    const settled = await fixture.manager.tick();
    expect(settled.links.find((item) => item.dispatchId === link.dispatchId)).toMatchObject({ status: "settled" });
    expect(await boss.getGoal(goal.spec.id)).toMatchObject({ status: "completed" });
  });

  it("restores a resolving Mission link when a correctable proposal was already consumed", async () => {
    const fixture = await createFixture();
    await fixture.manager.startMission({
      missionId: "mission-a",
      objective: "build",
      requestedByPrincipalId: "human",
      ownerPrincipalId: "principal-boss",
      teamBinding: fixture.team,
      resolvedStart: {
        planDefinition: createMinimalTeamPlanDefinition(fixture.policy.ref, "build"),
        teamBindingId: fixture.team.teamBindingId,
      },
    });
    const mission = await fixture.manager.tick();
    const link = mission.links[0]!;
    if (link.status !== "running") throw new Error("Expected a running Mission link");
    const boss = fixture.engines.get("boss")!;
    const goal = (await boss.getGoal(link.agentGoalId!))!;
    expect(goal).toMatchObject({ status: "active" });
    await fixture.missionStore.transact(mission.version, (current) => ({
      ...current,
      version: current.version + 1,
      links: current.links.map((item) => item.dispatchId === link.dispatchId
        ? { ...link, status: "resolving" as const, lastProposalId: "proposal-consumed-before-link-update" }
        : item),
    }));

    const recovered = await fixture.manager.tick();

    expect(recovered.links.find((item) => item.dispatchId === link.dispatchId)).toMatchObject({ status: "running" });
    expect(await boss.getGoal(goal.spec.id)).toMatchObject({ status: "active" });
  });

  it("renews a running claim before expiry without creating a second dispatch", async () => {
    const clock = { now: new Date(NOW) };
    const fixture = await createFixture(clock);
    await fixture.manager.startMission({
      missionId: "mission-a",
      objective: "build",
      requestedByPrincipalId: "human",
      ownerPrincipalId: "principal-boss",
      teamBinding: fixture.team,
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
      ownerPrincipalId: "principal-boss",
      teamBinding: fixture.team,
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
      criterionResults: satisfied(goal),
      residualRisks: [],
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
      ownerPrincipalId: "principal-boss",
      teamBinding: fixture.team,
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
      criterionResults: satisfied(intakeGoal),
      residualRisks: [],
      domainOutcome: baselineOutcome(),
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
      criterionResults: [],
      residualRisks: [],
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
      ownerPrincipalId: "principal-boss",
      teamBinding: fixture.team,
      resolvedStart: {
        planDefinition: {
          definitionId: "correction-flow",
          definitionVersion: 1,
          policyRef: fixture.policy.ref,
          plannerAssignment: { principalId: "principal-pm" },
          amendmentTemplate: { title: "计划修订", successCriteria: ["完成修订"], outputContract: { schemaRef: "plan-change-set-v3" } },
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
    await devEngine.proposeGoalResolution({ proposalId: "dev-complete", goalId: devGoal.spec.id, expectedGoalVersion: devGoal.version, resolvingGoalVersion: devGoal.version + 1, status: "completed", summary: "开发完成", evidence: [], criterionResults: satisfied(devGoal), residualRisks: [], domainOutcome: { result: "artifact" }, createdAt: NOW });
    await fixture.manager.tick();

    mission = await fixture.manager.tick();
    const qaLink = mission.links.find((item) => item.agentId === "qa" && item.status === "running")!;
    const qaEngine = fixture.engines.get("qa")!;
    const qaGoal = (await qaEngine.getGoal(qaLink.agentGoalId!))!;
    await qaEngine.proposeGoalResolution({
      proposalId: "qa-needs-correction", goalId: qaGoal.spec.id, expectedGoalVersion: qaGoal.version, resolvingGoalVersion: qaGoal.version + 1,
      status: "completed", summary: "发现缺陷", evidence: [],
      criterionResults: qaGoal.spec.successCriteria.map((_criterion, criterionIndex) => ({
        criterionIndex,
        status: "not_satisfied" as const,
        evidence: [],
      })), residualRisks: [],
      domainOutcome: { disposition: "correction_required", targetTicketId: devLink.ticketId, reason: "碰撞失效" }, createdAt: NOW,
    });
    mission = await fixture.manager.tick();
    expect(mission.links.find((item) => item.dispatchId === qaLink.dispatchId)).toMatchObject({ status: "settled" });
    expect(await fixture.tickets.getTicket(qaLink.ticketId)).toMatchObject({ status: "pending" });

    mission = await fixture.manager.tick();
    const correctionLink = mission.links.find((item) => item.agentId === "dev" && item.status === "running" && item.ticketId === devLink.ticketId && item.dispatchId !== devLink.dispatchId)!;
    const correctionGoal = (await devEngine.getGoal(correctionLink.agentGoalId!))!;
    await devEngine.proposeGoalResolution({ proposalId: "correction-complete", goalId: correctionGoal.spec.id, expectedGoalVersion: correctionGoal.version, resolvingGoalVersion: correctionGoal.version + 1, status: "completed", summary: "缺陷已修复", evidence: [], criterionResults: satisfied(correctionGoal), residualRisks: [], domainOutcome: { result: "fixed" }, createdAt: NOW });
    await fixture.manager.tick();

    mission = await fixture.manager.tick();
    const qaRetry = mission.links.find((item) => item.agentId === "qa" && item.status === "running" && item.ticketId === qaLink.ticketId)!;
    expect(qaRetry.dispatchId).not.toBe(qaLink.dispatchId);
    expect(qaRetry.agentGoalId).not.toBe(qaLink.agentGoalId);
    expect(qaRetry.ticketVersion).toBeGreaterThan(qaLink.ticketVersion);
  });
});

const NOW = "2026-07-10T00:00:00.000Z";

function satisfied(goal: AgentGoal) {
  return goal.spec.successCriteria.map((_, criterionIndex) => ({ criterionIndex, status: "satisfied" as const, evidence: [] }));
}
function baselineOutcome(): MissionTicketOutcome {
  return {
    baseline: {
      objective: "build the agreed product",
      successCriteria: ["the agreed product is delivered and verified"],
      constraints: [],
      assumptions: [],
      exclusions: [],
    },
  };
}

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
      { agentId: "boss", principalId: "principal-boss", capabilities: ["mission:intake", "delivery:accept"] },
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
  const missionStore = new MissionStore(root, "mission-a");
  const manager = new MissionProcessManager(
    missionStore,
    tickets,
    { get: (agentId) => engines.get(agentId)! },
    team,
    "planner",
    () => new Date(clock.now),
  );
  return { root, policy, team, ticketStore, missionStore, tickets, engines, manager };
}
