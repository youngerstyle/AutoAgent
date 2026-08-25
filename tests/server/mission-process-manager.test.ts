import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentEngine } from "../../src/server/agent-engine/agent-engine.js";
import { AgentStore } from "../../src/server/agent-engine/agent-store.js";
import { MissionGoalResolutionPort } from "../../src/server/mission-process/mission-goal-resolution-port.js";
import { correctionTargetMissionCriterionIds, MissionProcessManager, MissionTerminalError, validateTeamAssignments } from "../../src/server/mission-process/mission-process-manager.js";
import { MissionStore, type MissionAggregate } from "../../src/server/mission-process/mission-store.js";
import { createMinimalTeamPlanDefinition } from "../../src/server/product/plan-template.js";
import { TicketEngine } from "../../src/server/tickets/ticket-engine.js";
import { TicketStore } from "../../src/server/tickets/ticket-store.js";
import { createPlanPolicy, PlanPolicyStore } from "../../src/server/tickets/plan-policy-store.js";
import type { TeamBinding } from "../../src/shared/contracts/mission-control.js";
import type { AgentGoal, GoalResolutionPort } from "../../src/shared/contracts/agent-engine.js";
import type { MissionTicketOutcome } from "../../src/server/mission-process/ticket-agent-adapter.js";

describe("MissionProcessManager", () => {
  it("exposes delivery scope but never assurance or settlement Tickets as correction targets", () => {
    expect(correctionTargetMissionCriterionIds({
      missionContribution: { missionCriterionIds: ["criterion-delivery", "criterion-shared"] },
    })).toEqual([
      "criterion-delivery",
      "criterion-shared",
    ]);
    expect(correctionTargetMissionCriterionIds({
      missionContribution: { missionCriterionIds: ["criterion-delivery"] },
      assurance: { missionCriterionIds: ["criterion-delivery"] },
    })).toEqual([]);
    expect(correctionTargetMissionCriterionIds({
      missionContribution: { missionCriterionIds: ["criterion-delivery"] },
      permissions: { settleMission: true },
    })).toEqual([]);
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

  it("makes concurrent duplicate Mission starts resolve to one durable Plan", async () => {
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

    const [first, second] = await Promise.all([
      fixture.manager.startMission(request),
      fixture.manager.startMission(request),
    ]);

    expect(first.record.planId).toBe(second.record.planId);
    expect(first.record.objective).toBe("build");
    expect(await fixture.ticketStore.listPlanIds()).toEqual([first.record.planId]);
  });

  it("turns exhausted convergence budget into a durable planner-owned block", async () => {
    const fixture = await createFixture();
    fixture.team.members.find((member) => member.agentId === "dev")!.capabilities.push("delivery:implement");
    fixture.team.members.find((member) => member.agentId === "qa")!.capabilities.push("delivery:verify");
    const definition = createMinimalTeamPlanDefinition(fixture.policy.ref, "build");
    definition.convergenceLimits = { maxTickets: definition.initialChange.additions.length, maxAcceptedAmendments: 1 };
    await fixture.manager.startMission({
      missionId: "mission-a",
      objective: "build",
      requestedByPrincipalId: "human",
      ownerPrincipalId: "principal-boss",
      teamBinding: fixture.team,
      resolvedStart: { planDefinition: definition, teamBindingId: fixture.team.teamBindingId },
    });

    let mission = await fixture.manager.tick();
    const intakeLink = mission.links.find((link) => link.agentId === "boss" && link.status === "running")!;
    const boss = fixture.engines.get("boss")!;
    const intakeGoal = (await boss.getGoal(intakeLink.agentGoalId!))!;
    await boss.proposeGoalResolution({
      proposalId: "budget-intake", goalId: intakeGoal.spec.id, expectedGoalVersion: intakeGoal.version,
      resolvingGoalVersion: intakeGoal.version + 1, status: "completed", summary: "需求已确认", evidence: [],
      criterionResults: satisfied(intakeGoal), residualRisks: [], domainOutcome: baselineOutcome(), createdAt: NOW,
    });
    await fixture.manager.tick();

    mission = await fixture.manager.tick();
    const planningLink = mission.links.find((link) => link.agentId === "pm" && link.status === "running")!;
    const pm = fixture.engines.get("pm")!;
    const planningGoal = (await pm.getGoal(planningLink.agentGoalId!))!;
    await pm.proposeGoalResolution({
      proposalId: "budget-planning", goalId: planningGoal.spec.id, expectedGoalVersion: planningGoal.version,
      resolvingGoalVersion: planningGoal.version + 1, status: "completed", summary: "计划已形成", evidence: [],
      criterionResults: satisfied(planningGoal), residualRisks: [],
      domainOutcome: {
        intent: {
          rationale: "形成一个可验证交付",
          todos: [{ kind: "implementation", title: "开发", objective: "实现交付", successCriteria: ["产物可运行"] }],
        },
      },
      createdAt: NOW,
    });

    mission = await fixture.manager.tick();
    const blockedLink = mission.links.find((link) => link.dispatchId === planningLink.dispatchId)!;
    const blockedTicket = await fixture.tickets.getTicket(planningLink.ticketId);
    const blockedGoal = await pm.getGoal(planningLink.agentGoalId!);
    const plan = await fixture.tickets.getPlan(mission.record.planId);

    if (blockedLink.status !== "blocked") {
      throw new Error(`Expected convergence block: ${JSON.stringify({ link: blockedLink, ticket: blockedTicket, goal: blockedGoal, plan })}`);
    }

    expect(blockedLink).toMatchObject({ status: "blocked", authority: { kind: "blocked_owner" } });
    expect(blockedTicket).toMatchObject({
      status: "blocked",
      attempts: [expect.objectContaining({
        status: "blocked",
        requiredInput: expect.objectContaining({
          kind: "agent_recovery",
          description: expect.stringContaining("budget is exhausted"),
        }),
      })],
    });
    expect(blockedGoal).toMatchObject({ status: "paused" });
    expect(plan.graph.ticketIds).toHaveLength(definition.initialChange.additions.length);
    expect(plan.convergence).toMatchObject({ acceptedAmendments: 0 });

    const recovered = await fixture.manager.recover();
    expect(recovered.links.find((link) => link.dispatchId === planningLink.dispatchId)).toMatchObject({ status: "blocked" });
    expect(await pm.getGoal(planningLink.agentGoalId!)).toMatchObject({ status: "paused" });
  });

  it("never reopens a completed Mission or reuses its completed Plan", async () => {
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
    const firstPlan = await fixture.tickets.getPlan(first.record.planId);
    const firstTicketId = firstPlan?.graph.ticketIds[0];
    if (!firstTicketId) throw new Error("Expected the started Plan to contain a Ticket");
    const current = await fixture.missionStore.read();
    if (!current) throw new Error("Expected a persisted Mission");
    await fixture.missionStore.transact(current.version, (aggregate) => ({
      ...aggregate,
      version: aggregate.version + 1,
      record: {
        ...aggregate.record,
        status: "completed" as const,
        linkedAt: NOW,
        baseline: {
          baselineId: "baseline-1",
          version: 1,
          objective: "build",
          criteria: [],
          constraints: [],
          assumptions: [],
          exclusions: [],
          establishedByTicketId: firstTicketId,
          establishedAt: NOW,
        },
        settlement: {
          baselineVersion: 1,
          acceptedByTicketId: firstTicketId,
          acceptedByPrincipalId: "principal-boss",
          summary: "accepted",
          criterionResults: [],
          residualRisks: [],
          settledAt: NOW,
        },
      },
    }));

    await expect(fixture.manager.startMission(request)).rejects.toBeInstanceOf(MissionTerminalError);
    expect(await fixture.ticketStore.listPlanIds()).toEqual([first.record.planId]);
    expect((await fixture.missionStore.read())?.record.status).toBe("completed");
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

  it("dispatches independent ready Tickets concurrently to distinct persistent Agents", async () => {
    const fixture = await createFixture();
    const secondDeveloper = { agentId: "dev-2", principalId: "principal-dev-2", capabilities: ["implementation"], enabledTools: [] };
    fixture.team.members.push(secondDeveloper);
    fixture.engines.set("dev-2", new AgentEngine<MissionTicketOutcome>(
      new AgentStore(fixture.root, "dev-2"),
      new MissionGoalResolutionPort(() => undefined, "dev-2", () => new Date(NOW)),
      { now: () => new Date(NOW) },
    ));
    const definition = createMinimalTeamPlanDefinition(fixture.policy.ref, "build");
    definition.initialChange = {
      additions: [{ clientRef: "frontend", principalId: "principal-dev" }, { clientRef: "backend", principalId: "principal-dev-2" }].map((item) => ({
        clientRef: item.clientRef,
        title: item.clientRef,
        objective: `deliver ${item.clientRef}`,
        successCriteria: [`${item.clientRef} delivered`],
        assignment: { principalId: item.principalId, requiredCapabilities: ["implementation"] },
        outputContract: { schemaRef: `${item.clientRef}-v1` },
      })),
      dependencyAdditions: [],
      cancelTicketIds: [],
      requiredTerminalRefs: [{ clientRef: "frontend" }, { clientRef: "backend" }],
    };
    await fixture.manager.startMission({
      missionId: "mission-a", objective: "build", requestedByPrincipalId: "human", ownerPrincipalId: "principal-boss",
      teamBinding: fixture.team,
      resolvedStart: { planDefinition: definition, teamBindingId: fixture.team.teamBindingId },
    });

    const mission = await fixture.manager.tick();

    expect(mission.links.filter((link) => link.status === "running").map((link) => link.agentId).sort())
      .toEqual(["dev", "dev-2"]);
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
      outputContract: { schemaRef: "plan-intent-v1" },
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
    expect(missionInstruction).toMatchObject({ content: expect.not.stringContaining('"currentPlan"') });
    expect(missionInstruction).toMatchObject({ content: expect.stringContaining('"missionBaseline"') });
    expect(missionInstruction).toMatchObject({ content: expect.stringContaining('"successCriteria"') });
    expect(missionInstruction).toMatchObject({ content: expect.stringContaining('TodoList') });
    expect(missionInstruction).toMatchObject({
      content: expect.stringContaining('"currentWork"'),
    });
    expect(missionInstruction).toMatchObject({
      content: expect.not.stringContaining('"handoffLineage"'),
    });
    expect(missionInstruction).toMatchObject({
      content: expect.stringContaining('"objective":"build the agreed product"'),
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
          amendmentTemplate: { title: "plan revision", successCriteria: ["revision is valid"], outputContract: { schemaRef: "plan-intent-v1" } },
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

  it("durably reassigns a stalled Agent and resumes after interruption between claim release and Goal cancellation", async () => {
    const fixture = await createFixture();
    const replacement = {
      agentId: "boss-standby",
      principalId: "principal-boss-standby",
      capabilities: ["mission:intake", "delivery:accept"],
      enabledTools: [],
    };
    fixture.team.members.push(replacement);
    fixture.engines.set(
      replacement.agentId,
      new AgentEngine<MissionTicketOutcome>(
        new AgentStore(fixture.root, replacement.agentId),
        new MissionGoalResolutionPort(() => undefined, replacement.agentId, () => new Date(NOW)),
        { now: () => new Date(NOW) },
      ),
    );
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
    const oldLink = before.links.find((link) => link.agentId === "boss" && link.status === "running")!;
    const oldGoal = await fixture.engines.get("boss")!.getGoal(oldLink.agentGoalId!);
    const originalRelease = fixture.tickets.releaseClaim.bind(fixture.tickets);
    let interrupted = false;
    fixture.tickets.releaseClaim = async (input) => {
      const released = await originalRelease(input);
      if (!interrupted) {
        interrupted = true;
        throw new Error("simulated reassignment interruption");
      }
      return released;
    };

    await expect(fixture.manager.reassignStalledAgent({
      agentId: "boss",
      turnId: "stall-turn",
      reason: "no_progress",
    })).rejects.toThrow("simulated reassignment interruption");
    expect(await fixture.manager.current()).toMatchObject({
      links: [expect.objectContaining({
        dispatchId: oldLink.dispatchId,
        status: "recovering",
        reassignment: expect.objectContaining({
          fromAgentId: "boss",
          toAgentId: "boss-standby",
        }),
      })],
    });

    fixture.tickets.releaseClaim = originalRelease;
    const recovered = await fixture.manager.recover();
    const replacementLink = recovered.links.find((link) => link.agentId === "boss-standby" && link.status === "running")!;
    const ticket = await fixture.tickets.getTicket(oldLink.ticketId);
    const replacementThread = await fixture.engines.get("boss-standby")!.getThread(replacementLink.agentThreadId!);
    const replacementPayloads = await fixture.engines.get("boss-standby")!.getPayloads(replacementThread.items.map((item) => item.payloadRef));
    const instruction = [...replacementPayloads.values()].find((value) => (
      typeof value === "object" && value !== null && "senderPrincipalId" in value
      && value.senderPrincipalId === "mission-process"
    )) as { content: string };

    expect(recovered.links.find((link) => link.dispatchId === oldLink.dispatchId)).toMatchObject({
      status: "cancelled",
      reassignment: expect.objectContaining({ readyTicketVersion: expect.any(Number) }),
    });
    expect(await fixture.engines.get("boss")!.getGoal(oldGoal!.spec.id)).toMatchObject({ status: "cancelled" });
    expect(ticket).toMatchObject({
      status: "running",
      attempts: [
        expect.objectContaining({ status: "released", reason: "agent_unavailable" }),
        expect.objectContaining({ status: "running", principalId: "principal-boss-standby" }),
      ],
    });
    expect(instruction.content).toContain('"recoveryHandoff"');
    expect(instruction.content).toContain('"fromAgentId":"boss"');
    expect(instruction.content).toContain('"toAgentId":"boss-standby"');
  });

  it("gives a persistent Agent one clean Attempt restart when no compatible standby exists", async () => {
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
    const first = before.links.find((link) => link.agentId === "boss" && link.status === "running")!;

    const restarted = await fixture.manager.reassignStalledAgent({
      agentId: "boss",
      turnId: "first-stall",
      reason: "no_progress",
    });
    const second = restarted.aggregate.links.find((link) => (
      link.agentId === "boss" && link.dispatchId !== first.dispatchId
    ))!;
    expect(restarted.reassigned).toBe(true);
    expect(restarted.aggregate.links.find((link) => link.dispatchId === first.dispatchId)).toMatchObject({
      status: "cancelled",
      reassignment: expect.objectContaining({ fromAgentId: "boss", toAgentId: "boss", recoverySequence: 1 }),
    });
    expect(second).toMatchObject({
      status: "running",
      reassignment: expect.objectContaining({ fromAgentId: "boss", toAgentId: "boss", recoverySequence: 1 }),
    });
    expect(second.agentThreadId).toBe(first.agentThreadId);
    expect(second.agentGoalId).not.toBe(first.agentGoalId);

    const exhausted = await fixture.manager.reassignStalledAgent({
      agentId: "boss",
      turnId: "second-stall",
      reason: "no_progress",
    });
    expect(exhausted.reassigned).toBe(false);
    expect(exhausted.aggregate.links).toHaveLength(2);
    expect(exhausted.aggregate.links.find((link) => link.dispatchId === second.dispatchId)).toMatchObject({ status: "running" });
  });

  it("rebuilds Mission, Plan, Ticket and Agent engines from the same durable identities after restart", async () => {
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
    const beforeLink = before.links[0]!;
    const restartedTickets = new TicketEngine(
      new TicketStore(fixture.root, "task-a", "run-a"),
      fixture.policyStore,
      { teamBindingIds: [fixture.team.teamBindingId], now: () => new Date(NOW) },
    );
    const restartedEngines = new Map<string, AgentEngine<MissionTicketOutcome>>();
    for (const member of fixture.team.members) {
      const port = new MissionGoalResolutionPort(() => undefined, member.agentId, () => new Date(NOW));
      restartedEngines.set(member.agentId, new AgentEngine<MissionTicketOutcome>(new AgentStore(fixture.root, member.agentId), port, { now: () => new Date(NOW) }));
    }
    const restartedManager = new MissionProcessManager(
      new MissionStore(fixture.root, "mission-a"),
      restartedTickets,
      { get: (agentId) => restartedEngines.get(agentId)! },
      fixture.team,
      "planner",
      () => new Date(NOW),
    );

    const after = await restartedManager.recover();
    const afterLink = after.links.find((link) => link.dispatchId === beforeLink.dispatchId)!;
    const restoredPlan = await restartedTickets.getPlan(after.record.planId);
    const restoredTicket = await restartedTickets.getTicket(beforeLink.ticketId);
    const beforeClaimId = beforeLink.authority?.kind === "claim" ? beforeLink.authority.claimId : undefined;
    const restoredClaimId = restoredTicket?.activeAuthority?.kind === "claim" ? restoredTicket.activeAuthority.claimId : undefined;

    expect(after.record.planId).toBe(before.record.planId);
    expect(afterLink.agentGoalId).toBe(beforeLink.agentGoalId);
    expect(afterLink.agentThreadId).toBe(beforeLink.agentThreadId);
    expect(restoredPlan?.planId).toBe(before.record.planId);
    expect(restoredClaimId).toBe(beforeClaimId);
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

  it("does not apply a Ticket while the same Agent proposal is still being resolved", async () => {
    let releaseResolution!: () => void;
    const resolutionStarted = new Promise<void>((resolve) => {
      releaseResolution = resolve;
    });
    let resolutionCalls = 0;
    let started = false;
    const resolutionPort: GoalResolutionPort<MissionTicketOutcome> = {
      async resolve() {
        resolutionCalls += 1;
        if (!started) {
          started = true;
          await resolutionStarted;
        }
        return {
          settle: true as const,
          decision: {
            accepted: false as const,
            disposition: "correctable" as const,
            reason: "Agent 结论仍在校验，不能提前提交 Ticket",
          },
        };
      },
    };
    const fixture = await createFixture(undefined, () => resolutionPort);
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
    const proposalPromise = boss.proposeGoalResolution({
      proposalId: "proposal-resolution-gate",
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

    while (!started) await new Promise((resolve) => setTimeout(resolve, 0));
    const tickPromise = fixture.manager.tick();
    releaseResolution();
    await proposalPromise;
    const reconciled = await tickPromise;
    const ticket = await fixture.tickets.getTicket(link.ticketId);

    expect(resolutionCalls).toBeGreaterThanOrEqual(1);
    expect(ticket?.status).not.toBe("completed");
    expect(reconciled.links.find((item) => item.dispatchId === link.dispatchId)).toMatchObject({ status: "running" });
    expect(await boss.getGoal(goal.spec.id)).toMatchObject({ status: "active" });
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

  it("refuses to fake Mission settlement when a terminal link lost its Agent proposal", async () => {
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
      proposalId: "proposal-lost-before-link-reconcile",
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
            lastProposalId: undefined,
            lastCommandId: settledLink.lastCommandId,
            lastDecisionId: settledLink.lastDecisionId,
          }
        : item),
    }));

    await expect(fixture.manager.recover()).rejects.toThrow("persisted Agent Proposal");
    const recoveredSnapshot = await fixture.missionStore.read();
    expect(recoveredSnapshot?.record.status).toBe("linked");
    expect(recoveredSnapshot?.links.find((item) => item.dispatchId === link.dispatchId)?.status).toBe("running");
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
    await fixture.manager.resumeBlockedAgentAfterInput("boss", "human-follow-up-message");
    await boss.controlGoal({
      requestId: "resume-after-human-follow-up",
      goalId: blockedGoal.spec.id,
      expectedGoalVersion: blockedGoal.version,
      action: "resume",
      reason: "human 已提供不可替代的事实",
    });
    const resumedGoal = (await boss.getGoal(goal.spec.id))!;
    expect(await fixture.tickets.getTicket(link.ticketId)).toMatchObject({ status: "running" });

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

  it("preserves completed work and retries the same QA Ticket after independent correction work", async () => {
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
          amendmentTemplate: { title: "计划修订", successCriteria: ["完成修订"], outputContract: { schemaRef: "plan-intent-v1" } },
          initialChange: {
            additions: [
              { clientRef: "dev", title: "开发", objective: "实现功能", successCriteria: ["功能可运行"], assignment: { principalId: "principal-dev" }, outputContract: { schemaRef: "result-v1" }, deliveryIncrement: TEST_INCREMENT },
              { clientRef: "qa", title: "质量检查", objective: "验证功能", successCriteria: ["质量通过"], assignment: { principalId: "principal-qa" }, outputContract: { schemaRef: "result-v1" }, deliveryIncrement: TEST_INCREMENT },
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
    expect(await fixture.tickets.getTicket(qaLink.ticketId)).toMatchObject({
      status: "pending",
      attempts: [{ attemptNumber: 1, status: "returned" }],
    });

    let correctionLink = mission.links.find((item) => item.agentId === "dev" && item.status === "running" && item.ticketId !== devLink.ticketId);
    for (let attempt = 0; !correctionLink && attempt < 12; attempt += 1) {
      mission = await fixture.manager.tick();
      correctionLink = mission.links.find((item) => item.agentId === "dev" && item.status === "running" && item.ticketId !== devLink.ticketId);
    }
    expect(correctionLink).toBeDefined();
    expect(mission.links.some((item) => item.agentId === "pm" && item.status === "running")).toBe(false);
    expect(await fixture.tickets.getWorkItem(correctionLink!.ticketId)).toMatchObject({
      definition: {
        assignment: { principalId: "principal-dev" },
        correction: { targetTicketId: devLink.ticketId, sourceTicketId: qaLink.ticketId },
      },
    });
    const correctionThread = await devEngine.getThread(correctionLink!.agentThreadId!);
    const correctionPayloads = await devEngine.getPayloads(correctionThread.items.map((item) => item.payloadRef));
    expect([...correctionPayloads.values()].some((value) => (
      typeof value === "object"
      && value !== null
      && "content" in value
      && typeof value.content === "string"
      && value.content.includes("碰撞失效")
    ))).toBe(true);
    const correctionGoal = (await devEngine.getGoal(correctionLink!.agentGoalId!))!;
    await devEngine.proposeGoalResolution({ proposalId: "correction-complete", goalId: correctionGoal.spec.id, expectedGoalVersion: correctionGoal.version, resolvingGoalVersion: correctionGoal.version + 1, status: "completed", summary: "缺陷已修复", evidence: [], criterionResults: satisfied(correctionGoal), residualRisks: [], domainOutcome: { result: "fixed" }, createdAt: NOW });
    await fixture.manager.tick();

    mission = await fixture.manager.tick();
    const qaRetry = mission.links.find((item) => item.agentId === "qa" && item.status === "running" && item.ticketId === qaLink.ticketId)!;
    expect(qaRetry.dispatchId).not.toBe(qaLink.dispatchId);
    expect(qaRetry.agentGoalId).not.toBe(qaLink.agentGoalId);
    expect(await fixture.tickets.getTicket(devLink.ticketId)).toMatchObject({ status: "completed", attempts: [{ attemptNumber: 1, status: "completed" }] });
    expect(await fixture.tickets.getTicket(qaLink.ticketId)).toMatchObject({
      status: "running",
      attempts: [{ attemptNumber: 1, status: "returned" }, { attemptNumber: 2, status: "running" }],
    });
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

function anchorResultsWithPrefix(
  criterion: { criterionId: string; verification: { anchors: unknown[] } },
  prefix: string,
) {
  return criterion.verification.anchors.map((_, anchorIndex) => ({
    anchorIndex,
    status: "satisfied" as const,
    evidence: [{ evidenceId: `${prefix}-${criterion.criterionId}` }],
    verificationBasis: {
      summary: "按 Mission baseline 验收锚点判断",
      evidence: [{ evidenceId: `${prefix}-${criterion.criterionId}` }],
    },
    observations: ["工具观察结果与锚点完全一致"],
    deviations: [],
  }));
}

async function createFixture(
  clock = { now: new Date(NOW) },
  resolutionPortFactory?: (member: TeamBinding["members"][number]) => GoalResolutionPort<MissionTicketOutcome>,
) {
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
    const port = resolutionPortFactory?.(member)
      ?? new MissionGoalResolutionPort(() => undefined, member.agentId, () => new Date(clock.now));
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
  return { root, policy, policyStore, team, ticketStore, missionStore, tickets, engines, manager };
}
