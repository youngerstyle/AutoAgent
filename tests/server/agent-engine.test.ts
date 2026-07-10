import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type {
  AgentGoal,
  GoalResolutionAttemptResult,
  GoalResolutionPort,
  GoalResolutionProposal,
  GoalResolutionStatus,
} from "../../src/shared/contracts/agent-engine.js";
import {
  AcceptingGoalResolutionPort,
  AgentEngine,
  AgentEngineConflictError,
} from "../../src/server/agent-engine/agent-engine.js";
import { AgentStore, AgentStoreCursorError } from "../../src/server/agent-engine/agent-store.js";

const T0 = "2026-07-10T00:00:00.000Z";
const T1 = "2026-07-10T00:01:00.000Z";

describe("AgentEngine", () => {
  it("persists an ordinary chronological conversation across restart", async () => {
    const fixture = await createFixture();
    const thread = await fixture.engine.ensureThread({
      agentId: "dev",
      scopeId: "workspace-a",
      idempotencyKey: "thread-a",
    });

    await fixture.engine.sendMessage({
      messageId: "message-1",
      threadId: thread.threadId,
      senderPrincipalId: "human",
      content: "继续修复",
      createdAt: T0,
    });
    await fixture.engine.appendModelItem({
      itemId: "model-1",
      threadId: thread.threadId,
      content: "我先检查错误。",
      createdAt: T1,
    });

    const restarted = new AgentEngine(new AgentStore(fixture.root, "dev"));
    expect((await restarted.getThread(thread.threadId)).items).toEqual([
      expect.objectContaining({ itemId: "message-1", kind: "message", sequence: 1 }),
      expect.objectContaining({ itemId: "model-1", kind: "model", sequence: 2 }),
    ]);
    expect(await new AgentStore(fixture.root, "dev").payload("message:message-1")).toMatchObject({
      content: "继续修复",
    });
  });

  it("makes duplicate appends no-ops and rejects conflicting reuse", async () => {
    const fixture = await createFixture();
    const thread = await fixture.engine.ensureThread({
      agentId: "dev",
      scopeId: "workspace-a",
      idempotencyKey: "thread-a",
    });
    const input = {
      itemId: "model-1",
      threadId: thread.threadId,
      content: "done",
      createdAt: T0,
    };
    await fixture.engine.appendModelItem(input);
    const before = await fixture.store.read();
    await fixture.engine.appendModelItem(input);
    const after = await fixture.store.read();

    expect(after.aggregateVersion).toBe(before.aggregateVersion);
    expect(after.outbox).toHaveLength(before.outbox.length);
    await expect(fixture.engine.appendModelItem({ ...input, content: "different" }))
      .rejects.toBeInstanceOf(AgentEngineConflictError);
  });

  it("starts, pauses, resumes, proposes and explicitly settles a goal", async () => {
    const fixture = await createFixture({
      now: () => new Date(T1),
      resolutionPort: new RetryPort(),
    });
    const thread = await fixture.engine.ensureThread({
      agentId: "dev",
      scopeId: "workspace-a",
      idempotencyKey: "thread-a",
    });
    const goal = await fixture.engine.startGoal({
      agentId: "dev",
      threadId: thread.threadId,
      idempotencyKey: "goal-start-a",
      spec: {
        id: "goal-a",
        threadId: thread.threadId,
        objective: "修复跨域错误",
        successCriteria: ["页面可以加载"],
        contextRefs: [],
        createdAt: T0,
      },
    });
    const paused = await fixture.engine.controlGoal({
      requestId: "pause-a",
      goalId: goal.spec.id,
      expectedGoalVersion: goal.version,
      action: "pause",
      reason: "人工暂停",
    });
    const resumed = await fixture.engine.controlGoal({
      requestId: "resume-a",
      goalId: goal.spec.id,
      expectedGoalVersion: paused.version,
      action: "resume",
      reason: "继续",
    });
    const proposal = proposalFor(resumed);
    const attempted = await fixture.engine.proposeGoalResolution(proposal);

    expect(attempted.goal).toMatchObject({ status: "resolving", activeProposalId: proposal.proposalId });
    expect(attempted.attempt).toMatchObject({ settle: false, pending: "retry_later" });

    const settled = await fixture.engine.settleProposal({
      decisionId: "decision-a",
      proposalId: proposal.proposalId,
      expectedGoalVersion: attempted.goal.version,
      decision: { accepted: true, committedState: "completed" },
    });
    expect(settled).toMatchObject({ applied: true, goal: { status: "completed" } });

    const restarted = new AgentEngine(new AgentStore(fixture.root, "dev"));
    expect(await restarted.getGoal("goal-a")).toMatchObject({ status: "completed" });
  });

  it("keeps a resolving proposal while paused and resumes resolution", async () => {
    const fixture = await activeGoalFixture(new RetryPort());
    const proposal = proposalFor(fixture.goal);
    const resolving = (await fixture.engine.proposeGoalResolution(proposal)).goal;
    const paused = await fixture.engine.controlGoal({
      requestId: "pause-resolving",
      goalId: resolving.spec.id,
      expectedGoalVersion: resolving.version,
      action: "pause",
      reason: "暂停宿主",
    });
    const resumed = await fixture.engine.controlGoal({
      requestId: "resume-resolving",
      goalId: paused.spec.id,
      expectedGoalVersion: paused.version,
      action: "resume",
      reason: "恢复宿主",
    });

    expect(paused.activeProposalId).toBe(proposal.proposalId);
    expect(resumed).toMatchObject({ status: "resolving", activeProposalId: proposal.proposalId });
  });

  it("partitions event cursors by agent", async () => {
    const fixture = await createFixture();
    await fixture.engine.ensureThread({ agentId: "dev", scopeId: "a", idempotencyKey: "a" });
    const page = await fixture.engine.readEvents({ agentId: "dev", limit: 10 });

    await expect(fixture.engine.readEvents({
      agentId: "dev",
      after: { ...page.nextCursor, partitionId: "qa" as "dev" },
      limit: 10,
    })).rejects.toBeInstanceOf(AgentStoreCursorError);
  });

  it("rejects an explicit completion that violates the declared output contract", async () => {
    const fixture = await createFixture({
      resolutionPort: new AcceptingGoalResolutionPort({
        validate: (_schemaRef, value) => value && typeof value === "object" && "artifact" in value
          ? { valid: true }
          : { valid: false, reason: "artifact is required" },
      }),
    });
    const thread = await fixture.engine.ensureThread({ agentId: "dev", scopeId: "a", idempotencyKey: "a" });
    const goal = await fixture.engine.startGoal({
      agentId: "dev",
      threadId: thread.threadId,
      idempotencyKey: "contract-goal",
      spec: {
        id: "contract-goal",
        threadId: thread.threadId,
        objective: "deliver",
        successCriteria: ["artifact"],
        contextRefs: [],
        outputContract: { schemaRef: "artifact-v1" },
        createdAt: T0,
      },
    });
    const proposal = { ...proposalFor(goal), goalId: goal.spec.id, domainOutcome: { note: "missing" } };
    const result = await fixture.engine.proposeGoalResolution(proposal);

    expect(result.attempt).toMatchObject({
      settle: true,
      decision: { accepted: false, disposition: "correctable", reason: "artifact is required" },
    });
    expect(result.goal.status).toBe("active");
  });
});

class RetryPort implements GoalResolutionPort {
  async resolve<TStatus extends GoalResolutionStatus>(
    _goal: AgentGoal,
    _proposal: GoalResolutionProposal<TStatus>,
  ): Promise<GoalResolutionAttemptResult<TStatus>> {
    return { settle: false, pending: "retry_later", reason: "host unavailable", retryAfter: T1 };
  }
}

function proposalFor(goal: AgentGoal): GoalResolutionProposal<"completed"> {
  return {
    proposalId: "proposal-a",
    goalId: goal.spec.id,
    expectedGoalVersion: goal.version,
    resolvingGoalVersion: goal.version + 1,
    status: "completed",
    summary: "修复完成",
    evidence: [{ kind: "file", ref: "src/main.ts" }],
    createdAt: T1,
  };
}

async function activeGoalFixture(resolutionPort: GoalResolutionPort) {
  const fixture = await createFixture({ resolutionPort });
  const thread = await fixture.engine.ensureThread({ agentId: "dev", scopeId: "a", idempotencyKey: "a" });
  const goal = await fixture.engine.startGoal({
    agentId: "dev",
    threadId: thread.threadId,
    idempotencyKey: "goal-a",
    spec: {
      id: "goal-a",
      threadId: thread.threadId,
      objective: "deliver",
      successCriteria: ["tested"],
      contextRefs: [],
      createdAt: T0,
    },
  });
  return { ...fixture, goal };
}

async function createFixture(options: {
  now?: () => Date;
  resolutionPort?: GoalResolutionPort;
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-agent-engine-"));
  const store = new AgentStore(root, "dev");
  const engine = new AgentEngine(store, options.resolutionPort, { now: options.now });
  return { root, store, engine };
}
