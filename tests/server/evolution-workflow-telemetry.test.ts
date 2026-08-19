import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { MissionLink, MissionRecord } from "../../src/shared/contracts/mission-control.js";
import type { PlanId } from "../../src/shared/contracts/ticket-engine.js";
import type { Workspace } from "../../src/shared/types.js";
import { PlatformEvolutionObservationAdapter } from "../../src/server/evolution-adapters/platform-observation-adapter.js";
import { MissionStore } from "../../src/server/mission-process/mission-store.js";
import { RuntimeHostStore } from "../../src/server/runtime/runtime-host-store.js";

describe("Workflow Canary telemetry boundary", () => {
  it("projects selected and control task assignments into verifiable Evol telemetry", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-workflow-telemetry-"));
    const workspace: Workspace = { id: "workspace-a", name: "Workflow telemetry", rootPath: root, policyProfile: "development", createdAt: "2026-08-19T00:00:00.000Z" };
    await seedTask(root, "selected-task", "selected-goal", true);
    await seedTask(root, "control-task", "control-goal", false);
    const adapter = new PlatformEvolutionObservationAdapter(workspace);

    const telemetry = await adapter.collectRuntimeTelemetry("agent-dev");
    expect(telemetry).toEqual(expect.arrayContaining([
      expect.objectContaining({ traceId: "workflow-task:selected-task:agent-dev:selected-goal", goalId: "selected-goal", assignments: [expect.objectContaining({ promotionId: "promotion-a", releaseId: "release-a", selected: true })] }),
      expect.objectContaining({ traceId: "workflow-task:control-task:agent-dev:control-goal", goalId: "control-goal", assignments: [expect.objectContaining({ promotionId: "promotion-a", releaseId: "release-a", selected: false })] }),
    ]));
    for (const item of telemetry) {
      const assignment = item.assignments[0]!;
      expect(await adapter.verifyRuntimeAssignment({ agentId: item.agentId, traceId: item.traceId, promotionId: assignment.promotionId, releaseId: assignment.releaseId, selected: assignment.selected })).toBe(true);
    }
    expect(await adapter.verifyRuntimeAssignment({ agentId: "agent-dev", traceId: "workflow-task:selected-task:agent-dev:selected-goal", promotionId: "promotion-a", releaseId: "release-a", selected: false })).toBe(false);
  });
});

async function seedTask(root: string, taskId: string, goalId: string, selected: boolean): Promise<void> {
  const missionId = `mission-${taskId}`;
  const planId = (selected ? "178f1785-71a8-4a87-b799-8184b86eb227" : "278f1785-71a8-4a87-b799-8184b86eb228") as PlanId;
  const record: MissionRecord = {
    missionId, objective: "Exercise the canary workflow", planId, planCreateCommandId: `create-${taskId}`,
    ownerPrincipalId: "principal-owner", status: "starting",
    teamBinding: { teamBindingId: `team-${taskId}`, version: 1, contentHash: `team-hash-${taskId}`, members: [
      { agentId: "agent-dev", principalId: "principal-dev", capabilities: ["delivery:implement"], enabledTools: [] },
    ] },
  };
  const mission = new MissionStore(root, missionId);
  await mission.create(record);
  const link = {
    dispatchId: `dispatch-${taskId}`, missionId, planId, ticketId: `ticket-${taskId}`, ticketVersion: 1,
    attemptId: `attempt-${taskId}`, agentId: "agent-dev", agentPrincipalId: "principal-dev", claimRequestId: `claim-request-${taskId}`,
    goalStartKey: `goal-start-${taskId}`, updatedAt: "2026-08-19T00:01:00.000Z", status: "starting",
    authority: { kind: "claim", claimId: `claim-${taskId}`, fencingToken: 1 }, agentThreadId: `thread-${taskId}`, agentGoalId: goalId,
  } as MissionLink;
  await mission.transact(1, (current) => ({ ...current, version: 2, links: [link] }));
  await new RuntimeHostStore(root).save({
    taskId, runId: `run-${taskId}`, missionId, title: taskId, objective: record.objective, status: "completed",
    workflowSnapshot: {
      source: selected ? "evolution" : "builtin", target: "minimal-team", definitionId: "minimal-team", definitionVersion: selected ? 2 : 1,
      generation: selected ? 2 : 1, releaseRef: { id: selected ? "release-a" : "builtin:minimal-team", version: "1", contentHash: selected ? "candidate-hash" : "builtin-hash" },
      snapshotHash: `${taskId}-snapshot`, stage: selected ? "canary" : "production",
      canaryAssignment: { target: "minimal-team", promotionId: "promotion-a", releaseId: "release-a", selected },
    },
    createdAt: "2026-08-19T00:00:00.000Z", updatedAt: "2026-08-19T00:02:00.000Z",
  });
}
