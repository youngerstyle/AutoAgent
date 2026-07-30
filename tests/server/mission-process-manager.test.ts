import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentEngine } from "../../src/server/agent-engine/agent-engine.js";
import { AgentStore } from "../../src/server/agent-engine/agent-store.js";
import { MissionGoalResolutionPort } from "../../src/server/mission-process/mission-goal-resolution-port.js";
import { correctionTargetMissionCriterionIds, MissionProcessManager, validateTeamAssignments } from "../../src/server/mission-process/mission-process-manager.js";
import { MissionStore } from "../../src/server/mission-process/mission-store.js";
import { createMinimalTeamPlanDefinition } from "../../src/server/product/plan-template.js";
import { TicketEngine } from "../../src/server/tickets/ticket-engine.js";
import { TicketStore } from "../../src/server/tickets/ticket-store.js";
import { createPlanPolicy, PlanPolicyStore } from "../../src/server/tickets/plan-policy-store.js";
import type { TeamBinding } from "../../src/shared/contracts/mission-control.js";
import type { AgentGoal } from "../../src/shared/contracts/agent-engine.js";
import type { MissionTicketOutcome } from "../../src/server/mission-process/ticket-agent-adapter.js";

describe("MissionProcessManager", () => {
  it("preserves both delivery and assurance scope when exposing correction targets", () => {
    expect(correctionTargetMissionCriterionIds({
      missionContribution: { missionCriterionIds: ["criterion-delivery", "criterion-shared"] },
      assurance: { missionCriterionIds: ["criterion-presentation", "criterion-shared", "criterion-legal"] },
    })).toEqual([
      "criterion-delivery",
      "criterion-shared",
      "criterion-presentation",
      "criterion-legal",
    ]);
  });

  it("requires every required terminal to carry explicit Mission settlement authority", async () => {
    const team: TeamBinding = {
      teamBindingId: "team",
      version: 1,
      contentHash: "hash",
      deliveryPolicy: { requiredTerminalCapabilities: ["delivery:accept"] },
      members: [{ agentId: "approver", principalId: "principal-approver", capabilities: ["delivery:accept"], enabledTools: [] }],
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
        { agentId: "builder", principalId: "principal-builder", capabilities: ["delivery:implement"], enabledTools: [] },
        { agentId: "reviewer", principalId: "principal-reviewer", capabilities: ["delivery:verify"], enabledTools: [] },
        { agentId: "approver", principalId: "principal-approver", capabilities: ["delivery:accept"], enabledTools: [] },
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

  it("rejects a Ticket whose selected member lacks one of its declared tools", async () => {
    const team: TeamBinding = {
      teamBindingId: "team",
      version: 1,
      contentHash: "hash",
      members: [
        { agentId: "architect", principalId: "principal-architect", capabilities: ["research"], enabledTools: ["readFile"] },
        { agentId: "researcher", principalId: "principal-researcher", capabilities: ["research"], enabledTools: ["readFile", "browser"] },
      ],
    };
    const outcome = {
      change: {
        additions: [{
          clientRef: "baseline",
          assignment: {
            principalId: "principal-architect",
            requiredCapabilities: ["research"],
            requiredTools: ["browser"],
          },
        }],
        requiredTerminalRefs: [{ clientRef: "baseline" }],
      },
    } as MissionTicketOutcome;

    await expect(validateTeamAssignments(outcome, "plan-change-set-v3", team))
      .resolves.toContain("要求工具：browser");
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

  it("keeps a second ready Ticket queued while its target Agent already has active work", async () => {
    const fixture = await createFixture();
    const definition = createMinimalTeamPlanDefinition(fixture.policy.ref, "build");
    definition.initialChange = {
      additions: ["first", "second"].map((clientRef) => ({
        clientRef,
        title: clientRef,
        objective: `deliver ${clientRef}`,
        successCriteria: [`${clientRef} delivered`],
        assignment: { principalId: "principal-dev", requiredCapabilities: ["implementation"] },
        outputContract: { schemaRef: `${clientRef}-v1` },
      })),
      dependencyAdditions: [],
      cancelTicketIds: [],
      requiredTerminalRefs: [{ clientRef: "first" }, { clientRef: "second" }],
    };
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
    const tickets = await Promise.all(plan.graph.ticketIds.map((ticketId) => fixture.tickets.getTicket(ticketId)));

    expect(mission.links.filter((link) => link.agentId === "dev" && link.status === "running")).toHaveLength(1);
    expect(tickets.map((ticket) => ticket?.status).sort()).toEqual(["ready", "running"]);
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
    const initialPlan = await fixture.tickets.getPlan(mission.record.planId);
    const initialPlanningWork = await fixture.tickets.getWorkItem(initialPlan.graph.ticketIds[1]!);
    expect(initialPlanningWork?.definition).toMatchObject({
      title: "计划拆解",
      successCriteria: expect.arrayContaining(["新增实际执行工单，形成完成 Mission 所需的真实交付链"]),
      outputContract: { schemaRef: "plan-change-set-v3" },
      contextPolicy: {
        includeOriginalRequest: true,
        requiresMissionBaseline: true,
      },
    });
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
    expect(mission.record.baseline).toBeDefined();
    const settledPlanningWork = await fixture.tickets.getWorkItem(initialPlan.graph.ticketIds[1]!);
    expect(settledPlanningWork?.definition).toEqual(initialPlanningWork?.definition);
    expect(await boss.getGoal(goal!.spec.id)).toMatchObject({ status: "completed" });

    mission = await fixture.manager.tick();
    expect(mission.record.baseline).toBeDefined();
    const planningLink = mission.links.find((link) => link.agentId === "pm")!;
    expect(planningLink).toMatchObject({ status: "running" });
    const pm = fixture.engines.get("pm")!;
    const planningThread = await pm.getThread(planningLink.agentThreadId!);
    const planningPayloads = await pm.getPayloads(planningThread.items.map((item) => item.payloadRef));
    const missionMessages = [...planningPayloads.values()].filter((value) => (
      typeof value === "object"
      && value !== null
      && "senderPrincipalId" in value
      && value.senderPrincipalId === "mission-process"
    ));
    expect(missionMessages).toHaveLength(1);
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
      content: expect.stringContaining('"currentTicket":{"ticketId"'),
    });
    expect(missionInstruction).toMatchObject({
      content: expect.stringContaining('"handoffLineage":[{"ticketId"'),
    });
    expect(missionInstruction).toMatchObject({
      content: expect.stringContaining('"summary":"需求已接收"'),
    });
    expect(missionInstruction).toMatchObject({
      content: expect.stringContaining('"objective":"build the agreed product"'),
    });
    expect(missionInstruction).toMatchObject({
      content: expect.not.stringContaining("proposal-intake"),
    });
    const sourceRequest = [...planningPayloads.values()].find((value) => (
      typeof value === "object"
      && value !== null
      && "senderPrincipalId" in value
      && value.senderPrincipalId === "human"
    ));
    expect(sourceRequest).toMatchObject({
      deliveryKind: "context",
      content: "build",
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
        planDefinition: createMinimalTeamPlanDefinition(fixture.policy.ref, "deliver the complete agreed product"),
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
    const planning = mission.links.find((item) => item.agentId === "pm" && item.status === "running")!;
    const pm = fixture.engines.get("pm")!;
    const planningGoal = (await pm.getGoal(planning.agentGoalId!))!;
    const baseline = mission.record.baseline!;
    await pm.proposeGoalResolution({
      proposalId: "plan-assured-delivery", goalId: planningGoal.spec.id, expectedGoalVersion: planningGoal.version, resolvingGoalVersion: planningGoal.version + 1,
      status: "completed", summary: "planned verified settlement", evidence: [], criterionResults: satisfied(planningGoal), residualRisks: [],
      domainOutcome: {
        result: planningResult("verified delivery chain"),
        change: {
          additions: [
            {
              clientRef: "work", title: "delivery", objective: "deliver against baseline", successCriteria: ["baseline delivery produced"],
              assignment: { principalId: "principal-boss" }, outputContract: { schemaRef: "result-v1" },
              missionContribution: { missionCriterionIds: baseline.criteria.map((item) => item.criterionId) },
              deliveryIncrement: TEST_INCREMENT,
            },
            {
              clientRef: "assure", title: "assurance", objective: "verify against baseline", successCriteria: ["baseline criteria verified"],
              assignment: { principalId: "principal-boss" }, outputContract: { schemaRef: "mission-assurance-v1" },
              assurance: { missionCriterionIds: baseline.criteria.map((item) => item.criterionId) },
              deliveryIncrement: TEST_INCREMENT,
            },
            {
              clientRef: "accept", title: "acceptance", objective: "accept against verified baseline", successCriteria: ["acceptance decided"],
              assignment: { principalId: "principal-boss" }, outputContract: { schemaRef: "acceptance-v1" },
              permissions: { settleMission: true },
            },
          ],
          dependencyAdditions: [
            { from: { ticketId: planning.ticketId }, to: { clientRef: "work" } },
            { from: { clientRef: "work" }, to: { clientRef: "assure" } },
            { from: { clientRef: "assure" }, to: { clientRef: "accept" } },
          ],
          cancelTicketIds: [], requiredTerminalRefs: [{ clientRef: "accept" }],
        },
      },
      createdAt: NOW,
    });
    mission = await fixture.manager.tick();
    const awaitRunning = async (title: string) => {
      for (let attempt = 0; attempt < 12; attempt += 1) {
        mission = await fixture.manager.tick();
        for (const candidate of mission.links.filter((item) => item.status === "running")) {
          const work = await fixture.tickets.getWorkItem(candidate.ticketId);
          if (work?.definition.title === title) return candidate;
        }
      }
      const state = await Promise.all(mission.links.map(async (item) => ({
        status: item.status,
        title: (await fixture.tickets.getWorkItem(item.ticketId))?.definition.title,
        ticketId: item.ticketId,
      })));
      throw new Error(`Timed out waiting for running Ticket ${title}: ${JSON.stringify(state)}`);
    };

    const delivery = await awaitRunning("delivery");
    const deliveryGoal = (await boss.getGoal(delivery.agentGoalId!))!;
    expect(deliveryGoal.spec.successCriteria).toEqual(["baseline delivery produced"]);
    const deliveryThread = await boss.getThread(delivery.agentThreadId!);
    const deliveryPayloads = await boss.getPayloads(deliveryThread.items.map((item) => item.payloadRef));
    expect([...deliveryPayloads.values()]).toContainEqual(expect.objectContaining({
      senderPrincipalId: "mission-process",
      content: expect.stringContaining('"missionBaseline"'),
    }));
    await boss.proposeGoalResolution({
      proposalId: "delivery-proposal", goalId: deliveryGoal.spec.id, expectedGoalVersion: deliveryGoal.version, resolvingGoalVersion: deliveryGoal.version + 1,
      status: "completed", summary: "baseline delivery produced", evidence: [], criterionResults: satisfied(deliveryGoal), residualRisks: [],
      domainOutcome: { result: "delivered" }, createdAt: NOW,
    });
    mission = await fixture.manager.tick();
    const settledDeliveryGoal = await boss.getGoal(deliveryGoal.spec.id);
    const settledDeliveryThread = await boss.getThread(delivery.agentThreadId!);
    const settledDeliveryPayloads = await boss.getPayloads(settledDeliveryThread.items.map((item) => item.payloadRef));
    expect(settledDeliveryGoal, JSON.stringify([...settledDeliveryPayloads.values()].slice(-6))).toMatchObject({ status: "completed" });
    const assurance = await awaitRunning("assurance");
    const assuranceGoal = (await boss.getGoal(assurance.agentGoalId!))!;
    await boss.proposeGoalResolution({
      proposalId: "assurance-proposal", goalId: assuranceGoal.spec.id, expectedGoalVersion: assuranceGoal.version, resolvingGoalVersion: assuranceGoal.version + 1,
      status: "completed", summary: "baseline independently verified", evidence: [], criterionResults: satisfied(assuranceGoal), residualRisks: [],
      domainOutcome: {
        assuranceReport: {
          baselineVersion: baseline.version,
          criterionResults: baseline.criteria.map((item) => ({
            criterionId: item.criterionId,
            status: "satisfied",
            evidence: [{ evidenceId: `ev-acceptance-${item.criterionId}` }],
            anchorResults: anchorResults(item),
          })),
        },
      },
      createdAt: NOW,
    });
    mission = await fixture.manager.tick();
    const acceptance = await awaitRunning("acceptance");
    const acceptanceGoal = (await boss.getGoal(acceptance.agentGoalId!))!;
    const acceptanceThread = await boss.getThread(acceptance.agentThreadId!);
    const acceptancePayloads = await boss.getPayloads(acceptanceThread.items.map((item) => item.payloadRef));
    const settlementInstruction = [...acceptancePayloads.values()].find((value) => (
      typeof value === "object"
      && value !== null
      && "senderPrincipalId" in value
      && value.senderPrincipalId === "mission-process"
      && "content" in value
      && typeof value.content === "string"
      && value.content.includes("权威验收证据矩阵")
    ));
    expect(settlementInstruction).toMatchObject({
      content: expect.stringContaining(String(assurance.ticketId)),
    });
    expect(settlementInstruction).toMatchObject({
      content: expect.stringContaining(`ev-acceptance-${baseline.criteria[0]!.criterionId}`),
    });
    await boss.proposeGoalResolution({
      proposalId: "incomplete-acceptance", goalId: acceptanceGoal.spec.id, expectedGoalVersion: acceptanceGoal.version, resolvingGoalVersion: acceptanceGoal.version + 1,
      status: "completed", summary: "accepted without baseline proof", evidence: [], criterionResults: satisfied(acceptanceGoal), residualRisks: [],
      domainOutcome: { result: "accepted" }, createdAt: NOW,
    });
    mission = await fixture.manager.tick();
    expect(mission.record.status).toBe("linked");
    expect(mission.links.find((item) => item.dispatchId === acceptance.dispatchId)).toMatchObject({ status: "running" });

    const correctionGoal = (await boss.getGoal(acceptance.agentGoalId!))!;
    await boss.proposeGoalResolution({
      proposalId: "acceptance-requests-correction", goalId: correctionGoal.spec.id, expectedGoalVersion: correctionGoal.version, resolvingGoalVersion: correctionGoal.version + 1,
      status: "completed", summary: "upstream assurance must be repeated", evidence: [], criterionResults: satisfied(correctionGoal), residualRisks: [],
      domainOutcome: {
        disposition: "correction_required",
        targetTicketId: assurance.ticketId,
        reason: "verification evidence must be refreshed",
      },
      createdAt: NOW,
    });
    mission = await fixture.manager.tick();
    expect(mission.record.status).toBe("linked");

    const amendment = await awaitRunning("计划修订");
    const amendmentEngine = fixture.engines.get("pm")!;
    const amendmentGoal = (await amendmentEngine.getGoal(amendment.agentGoalId!))!;
    await amendmentEngine.proposeGoalResolution({
      proposalId: "plan-fresh-assurance", goalId: amendmentGoal.spec.id, expectedGoalVersion: amendmentGoal.version, resolvingGoalVersion: amendmentGoal.version + 1,
      status: "completed", summary: "append fresh assurance and acceptance", evidence: [], criterionResults: satisfied(amendmentGoal), residualRisks: [],
      domainOutcome: {
        result: {
          summary: "fresh verification planned",
          deliveryStrategy: {
            mode: "single_increment",
            rationale: "复用当前 Plan 已有交付增量补充验证",
            increments: [],
          },
        },
        change: {
          additions: [
            {
              clientRef: "assure-fresh", title: "assurance retry", objective: "repeat verification against baseline",
              successCriteria: ["baseline criteria verified again"], assignment: { principalId: "principal-boss" },
              outputContract: { schemaRef: "mission-assurance-v1" },
              assurance: { missionCriterionIds: baseline.criteria.map((item) => item.criterionId) },
              deliveryIncrement: { incrementId: TEST_INCREMENT.incrementId },
            },
            {
              clientRef: "accept-fresh", title: "acceptance retry", objective: "accept fresh assurance",
              successCriteria: ["acceptance decided again"], assignment: { principalId: "principal-boss" },
              outputContract: { schemaRef: "acceptance-v1" }, permissions: { settleMission: true },
            },
          ],
          dependencyAdditions: [
            { from: { ticketId: amendment.ticketId }, to: { clientRef: "assure-fresh" } },
            { from: { ticketId: delivery.ticketId }, to: { clientRef: "assure-fresh" } },
            { from: { clientRef: "assure-fresh" }, to: { clientRef: "accept-fresh" } },
          ],
          cancelTicketIds: [],
          requiredTerminalRefs: [{ clientRef: "accept-fresh" }],
        },
      },
      createdAt: NOW,
    });
    await fixture.manager.tick();
    const assuranceRetry = await awaitRunning("assurance retry");
    const assuranceRetryGoal = (await boss.getGoal(assuranceRetry.agentGoalId!))!;
    await boss.proposeGoalResolution({
      proposalId: "assurance-retry", goalId: assuranceRetryGoal.spec.id, expectedGoalVersion: assuranceRetryGoal.version, resolvingGoalVersion: assuranceRetryGoal.version + 1,
      status: "completed", summary: "baseline verification repeated", evidence: [], criterionResults: satisfied(assuranceRetryGoal), residualRisks: [],
      domainOutcome: {
        assuranceReport: {
          baselineVersion: baseline.version,
          criterionResults: baseline.criteria.map((item) => ({
            criterionId: item.criterionId,
            status: "satisfied",
            evidence: [{ evidenceId: `ev-acceptance-${item.criterionId}` }],
            anchorResults: anchorResults(item),
          })),
        },
      },
      createdAt: NOW,
    });
    mission = await fixture.manager.tick();
    const acceptanceRetry = await awaitRunning("acceptance retry");
    const retriedGoal = (await boss.getGoal(acceptanceRetry.agentGoalId!))!;
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
            assuranceTicketIds: [assuranceRetry.ticketId],
          })),
          residualRisks: [],
        },
      },
      createdAt: NOW,
    });
    mission = await fixture.manager.tick();
    mission = await fixture.manager.tick();
    expect(mission.record).toMatchObject({
      status: "completed",
      settlement: {
        acceptedByTicketId: acceptanceRetry.ticketId,
        baselineVersion: 1,
        criterionResults: baseline.criteria.map((item) => ({
          criterionId: item.criterionId,
          evidence: [{ evidenceId: `ev-acceptance-${item.criterionId}` }],
          anchorResults: anchorResults(item),
        })),
      },
    });
    expect((await fixture.tickets.getPlan(mission.record.planId)).status).toBe("completed");
  }, 60_000);

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

  it("reconciles a stale running Mission link after its Ticket already committed", async () => {
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
    const running = await fixture.manager.tick();
    const link = running.links[0]!;
    if (link.status !== "running") throw new Error("Expected a running Mission link");
    const boss = fixture.engines.get("boss")!;
    const goal = (await boss.getGoal(link.agentGoalId!))!;
    await boss.proposeGoalResolution({
      proposalId: "proposal-terminal-before-link",
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
    const settledLink = settled.links.find((item) => item.dispatchId === link.dispatchId)!;
    await fixture.missionStore.transact(settled.version, (current) => ({
      ...current,
      version: current.version + 1,
      links: current.links.map((item) => item.dispatchId === link.dispatchId
        ? {
            ...link,
            status: "running" as const,
            lastProposalId: settledLink.lastProposalId,
            lastCommandId: settledLink.lastCommandId,
            lastDecisionId: settledLink.lastDecisionId,
          }
        : item),
    }));

    const committedTicket = await fixture.tickets.getTicket(link.ticketId);
    const recovered = await fixture.manager.recover();

    expect(recovered.links.find((item) => item.dispatchId === link.dispatchId)).toMatchObject({
      status: "settled",
      finalTicketVersion: committedTicket!.version,
    });
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

  it("does not commit a Ticket while a newer human turn for the Goal is pending", async () => {
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
    await boss.proposeGoalResolution({
      proposalId: "proposal-before-human-turn",
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
      turnId: "turn-before-human-message",
    });
    boss.hasPendingHumanTurn = async () => true;

    const guarded = await fixture.manager.tick();
    const guardedLink = guarded.links.find((item) => item.dispatchId === link.dispatchId);

    expect(guardedLink).toMatchObject({ status: "running" });
    const guardedGoal = await boss.getGoal(goal.spec.id);
    expect(guardedGoal).toMatchObject({ status: "active" });
    expect(guardedGoal).not.toHaveProperty("activeProposalId");
    const ticket = await fixture.tickets.getTicket(link.ticketId);
    expect(ticket?.status).not.toBe("completed");
  });

  it("settles a resolving Goal before projecting an already blocked Ticket onto its Mission link", async () => {
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
    const goal = (await boss.getGoal(link.agentGoalId))!;
    await boss.proposeGoalResolution({
      proposalId: "block-before-human-follow-up",
      goalId: goal.spec.id,
      expectedGoalVersion: goal.version,
      resolvingGoalVersion: goal.version + 1,
      status: "blocked",
      summary: "需要 human 提供不可替代的事实",
      evidence: [],
      criterionResults: goal.spec.successCriteria.map((_, criterionIndex) => ({
        criterionIndex,
        status: "not_verified",
        evidence: [],
      })),
      residualRisks: [],
      humanInputRequest: {
        kind: "manual_test",
        description: "请完成真实交互测试",
        details: { steps: ["打开产物", "反馈结果"] },
      },
      createdAt: NOW,
    });
    expect((await fixture.manager.tick()).links.find((item) => item.dispatchId === link.dispatchId))
      .toMatchObject({ status: "blocked" });
    const blockedGoal = (await boss.getGoal(goal.spec.id))!;
    expect(blockedGoal).toMatchObject({ status: "blocked" });
    await boss.controlGoal({
      requestId: "resume-after-human-follow-up",
      goalId: blockedGoal.spec.id,
      expectedGoalVersion: blockedGoal.version,
      action: "resume",
      reason: "human 已提供不可替代的事实",
    });
    await fixture.manager.resumeBlockedAgent("boss");
    const resumedGoal = (await boss.getGoal(goal.spec.id))!;

    await boss.proposeGoalResolution({
      proposalId: "proposal-after-human-follow-up",
      goalId: resumedGoal.spec.id,
      expectedGoalVersion: resumedGoal.version,
      resolvingGoalVersion: resumedGoal.version + 1,
      status: "completed",
      summary: "human 已提供结果，需求接收完成",
      evidence: [],
      criterionResults: satisfied(goal),
      residualRisks: [],
      domainOutcome: baselineOutcome(),
      createdAt: NOW,
    });

    const settled = await fixture.manager.tick();

    expect(settled.links.find((item) => item.dispatchId === link.dispatchId)).toMatchObject({ status: "settled" });
    expect(await boss.getGoal(goal.spec.id)).toMatchObject({ status: "completed" });
    expect(await fixture.tickets.getTicket(link.ticketId)).toMatchObject({ status: "completed" });
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

    expect(attempt.goal.status).toBe("resolving");
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

  it("preserves old QA and DEV attempts while PM appends fresh correction and verification Tickets", async () => {
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
    expect(await fixture.tickets.getTicket(qaLink.ticketId)).toMatchObject({ status: "returned" });

    mission = await fixture.manager.tick();
    const amendmentLink = mission.links.find((item) => item.agentId === "pm" && item.status === "running")!;
    const pmEngine = fixture.engines.get("pm")!;
    const amendmentGoal = (await pmEngine.getGoal(amendmentLink.agentGoalId!))!;
    await pmEngine.proposeGoalResolution({
      proposalId: "append-correction-work", goalId: amendmentGoal.spec.id, expectedGoalVersion: amendmentGoal.version, resolvingGoalVersion: amendmentGoal.version + 1,
      status: "completed", summary: "追加新的修复和复验工单", evidence: [], criterionResults: satisfied(amendmentGoal), residualRisks: [],
      domainOutcome: {
        result: planningResult("correction planned"),
        change: {
          additions: [
            { clientRef: "fix", title: "修复碰撞", objective: "修复碰撞失效", successCriteria: ["碰撞恢复"], assignment: { principalId: "principal-dev" }, outputContract: { schemaRef: "result-v1" }, deliveryIncrement: TEST_INCREMENT },
            { clientRef: "recheck", title: "重新质量检查", objective: "复验碰撞", successCriteria: ["碰撞质量通过"], assignment: { principalId: "principal-qa" }, outputContract: { schemaRef: "result-v1" }, deliveryIncrement: TEST_INCREMENT },
            { clientRef: "accept", title: "重新验收", objective: "验收修复结果", successCriteria: ["修复结果可接受"], assignment: { principalId: "principal-boss" }, outputContract: { schemaRef: "result-v1" }, permissions: { settleMission: true } },
          ],
          dependencyAdditions: [
            { from: { ticketId: amendmentLink.ticketId }, to: { clientRef: "fix" } },
            { from: { clientRef: "fix" }, to: { clientRef: "recheck" } },
            { from: { clientRef: "recheck" }, to: { clientRef: "accept" } },
          ],
          cancelTicketIds: [],
          requiredTerminalRefs: [{ clientRef: "accept" }],
        },
      },
      createdAt: NOW,
    });
    await fixture.manager.tick();

    mission = await fixture.manager.tick();
    const correctionLink = mission.links.find((item) => item.agentId === "dev" && item.status === "running" && item.ticketId !== devLink.ticketId)!;
    const correctionGoal = (await devEngine.getGoal(correctionLink.agentGoalId!))!;
    await devEngine.proposeGoalResolution({ proposalId: "correction-complete", goalId: correctionGoal.spec.id, expectedGoalVersion: correctionGoal.version, resolvingGoalVersion: correctionGoal.version + 1, status: "completed", summary: "缺陷已修复", evidence: [], criterionResults: satisfied(correctionGoal), residualRisks: [], domainOutcome: { result: "fixed" }, createdAt: NOW });
    await fixture.manager.tick();

    mission = await fixture.manager.tick();
    const qaRetry = mission.links.find((item) => item.agentId === "qa" && item.status === "running" && item.ticketId !== qaLink.ticketId)!;
    expect(qaRetry.dispatchId).not.toBe(qaLink.dispatchId);
    expect(qaRetry.agentGoalId).not.toBe(qaLink.agentGoalId);
    expect(await fixture.tickets.getTicket(devLink.ticketId)).toMatchObject({ status: "completed", attempts: [{ attemptNumber: 1, status: "completed" }] });
    expect(await fixture.tickets.getTicket(qaLink.ticketId)).toMatchObject({ status: "returned", attempts: [{ attemptNumber: 1, status: "returned" }] });
  });
});

const NOW = "2026-07-10T00:00:00.000Z";

function satisfied(goal: AgentGoal) {
  return goal.spec.successCriteria.map((_, criterionIndex) => ({ criterionIndex, status: "satisfied" as const, evidence: [] }));
}
function baselineOutcome(): MissionTicketOutcome {
  return {
    objective: "build the agreed product",
    criteria: [{
      text: "the agreed product is delivered and verified",
      anchors: [{ observableOutcome: "the agreed product is observable", evidenceRequirements: ["traceable tool evidence"] }],
    }],
    constraints: [],
    assumptions: [],
    exclusions: [],
  };
}

const TEST_INCREMENT = {
  incrementId: "increment-1",
  sequence: 1,
  title: "可验证交付",
  objective: "形成可运行并经独立验证的交付",
};

function planningResult(summary: string) {
  return {
    summary,
    deliveryStrategy: {
      mode: "single_increment" as const,
      rationale: "测试场景可在一个可验证增量内完成",
      increments: [TEST_INCREMENT],
    },
  };
}

function anchorResults(criterion: { criterionId: string; verification: { anchors: unknown[] } }) {
  return criterion.verification.anchors.map((_, anchorIndex) => ({
    anchorIndex,
    status: "satisfied" as const,
    evidence: [{ evidenceId: `ev-acceptance-${criterion.criterionId}` }],
    verificationBasis: {
      summary: "按 Mission baseline 验收锚点判断",
      evidence: [{ evidenceId: `ev-acceptance-${criterion.criterionId}` }],
    },
    observations: ["工具观察结果与锚点完全一致"],
    deviations: [],
  }));
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
      { agentId: "boss", principalId: "principal-boss", capabilities: ["mission:intake", "delivery:accept"], enabledTools: [] },
      { agentId: "pm", principalId: "principal-pm", capabilities: ["plan:plan"], enabledTools: [] },
      { agentId: "dev", principalId: "principal-dev", capabilities: ["implementation"], enabledTools: [] },
      { agentId: "qa", principalId: "principal-qa", capabilities: ["quality:verify"], enabledTools: [] },
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
