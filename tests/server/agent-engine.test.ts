import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
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
import { agentEngineLegacyAggregateFile, agentEngineRolloutFile } from "../../src/server/storage/paths.js";

const T0 = "2026-07-10T00:00:00.000Z";
const T1 = "2026-07-10T00:01:00.000Z";

describe("AgentEngine", () => {
  it("persists thread history as an append-only rollout instead of rewriting an agent aggregate", async () => {
    const fixture = await createFixture();
    const thread = await fixture.engine.ensureThread({
      agentId: "dev",
      scopeId: "append-only",
      idempotencyKey: "append-only",
    });
    await fixture.engine.sendMessage({
      messageId: "append-1",
      threadId: thread.threadId,
      senderPrincipalId: "human",
      content: "第一条消息",
      createdAt: T0,
    });
    const rollout = agentEngineRolloutFile(fixture.root, "dev");
    const before = await readFile(rollout, "utf8");

    await fixture.engine.appendModelItem({
      itemId: "append-2",
      threadId: thread.threadId,
      content: "第二条消息",
      createdAt: T1,
    });
    const after = await readFile(rollout, "utf8");

    expect(after.startsWith(before)).toBe(true);
    expect(after.slice(before.length).trim().split("\n")).toHaveLength(1);
    expect(after).not.toContain('"schemaVersion":2');
    expect(after.trim().split("\n").every((line) => JSON.parse(line).type === "agent_store_commit")).toBe(true);

    const restarted = new AgentEngine(new AgentStore(fixture.root, "dev"));
    expect((await restarted.getThread(thread.threadId)).items.map((item) => item.itemId))
      .toEqual(["append-1", "append-2"]);
  });

  it("recovers valid rollout items around a malformed JSONL record", async () => {
    const fixture = await createFixture();
    const thread = await fixture.engine.ensureThread({
      agentId: "dev",
      scopeId: "recover-rollout",
      idempotencyKey: "recover-rollout",
    });
    await fixture.engine.sendMessage({
      messageId: "before-malformed",
      threadId: thread.threadId,
      senderPrincipalId: "human",
      content: "损坏记录之前",
      createdAt: T0,
    });

    await fixture.engine.appendModelItem({
      itemId: "after-malformed",
      threadId: thread.threadId,
      content: "损坏记录之后",
      createdAt: T1,
    });
    const rollout = agentEngineRolloutFile(fixture.root, "dev");
    const validLines = (await readFile(rollout, "utf8")).trimEnd().split("\n");
    validLines.splice(validLines.length - 1, 0, "{this is not json}");
    await writeFile(rollout, `${validLines.join("\n")}\n`, "utf8");

    const restarted = new AgentEngine(new AgentStore(fixture.root, "dev"));
    expect((await restarted.getThread(thread.threadId)).items.map((item) => item.itemId))
      .toEqual(["before-malformed", "after-malformed"]);
  });

  it("migrates a legacy aggregate into a rollout without invalidating durable event cursors", async () => {
    const fixture = await createFixture();
    const thread = await fixture.engine.ensureThread({
      agentId: "dev",
      scopeId: "legacy-migration",
      idempotencyKey: "legacy-migration",
    });
    await fixture.engine.sendMessage({
      messageId: "legacy-message",
      threadId: thread.threadId,
      senderPrincipalId: "human",
      content: "保留历史与游标",
      createdAt: T0,
    });
    const page = await fixture.engine.readEvents({ agentId: "dev", limit: 100 });
    const aggregate = await fixture.store.read();
    const rollout = agentEngineRolloutFile(fixture.root, "dev");
    const legacyFile = agentEngineLegacyAggregateFile(fixture.root, "dev");
    await mkdir(path.dirname(legacyFile), { recursive: true });
    await writeFile(legacyFile, JSON.stringify(aggregate), "utf8");
    await rm(path.dirname(rollout), { recursive: true, force: true });

    const restartedStore = new AgentStore(fixture.root, "dev");
    const restartedEngine = new AgentEngine(restartedStore);
    const afterMigration = await restartedEngine.readEvents({
      agentId: "dev",
      after: page.nextCursor,
      limit: 100,
    });

    expect(afterMigration.events).toEqual([]);
    expect((await restartedEngine.getThread(thread.threadId)).items.map((item) => item.itemId))
      .toEqual(["legacy-message"]);
    expect(JSON.parse((await readFile(rollout, "utf8")).trim())).toMatchObject({
      type: "agent_store_snapshot",
      aggregate: { agentId: "dev", aggregateVersion: aggregate.aggregateVersion },
    });
  });

  it("does not clone the complete Agent projection when appending one rollout item", async () => {
    const fixture = await createFixture();
    const thread = await fixture.engine.ensureThread({
      agentId: "dev",
      scopeId: "incremental-memory",
      idempotencyKey: "incremental-memory",
    });
    const nativeStructuredClone = globalThis.structuredClone;
    let aggregateClones = 0;
    vi.stubGlobal("structuredClone", (value: unknown, options?: StructuredSerializeOptions) => {
      if (value && typeof value === "object" && (value as { schemaVersion?: unknown }).schemaVersion === 2
        && Array.isArray((value as { threads?: unknown }).threads)) {
        aggregateClones += 1;
      }
      return nativeStructuredClone(value, options);
    });
    try {
      await fixture.engine.appendModelItem({
        itemId: "incremental-item",
        threadId: thread.threadId,
        content: "只追加这一条",
        createdAt: T0,
      });
    } finally {
      vi.unstubAllGlobals();
    }

    expect(aggregateClones).toBe(0);
  });

  it("marks a goal usage-limited and requires an explicit resume", async () => {
    const fixture = await activeGoalFixture(new RetryPort());
    const limited = await fixture.engine.controlGoal({
      requestId: "usage-limit",
      goalId: fixture.goal.spec.id,
      expectedGoalVersion: fixture.goal.version,
      action: "limit_usage" as never,
      reason: "token window reached",
    });
    expect(limited.status).toBe("usage_limited");

    const resumed = await fixture.engine.controlGoal({
      requestId: "resume-after-usage-limit",
      goalId: limited.spec.id,
      expectedGoalVersion: limited.version,
      action: "resume",
      reason: "human explicitly continued",
    });
    expect(resumed.status).toBe("active");
  });

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

  it("rejects compaction boundaries beyond thread facts and stale checkpoint replacement", async () => {
    const fixture = await createFixture();
    const thread = await fixture.engine.ensureThread({
      agentId: "dev",
      scopeId: "workspace-a",
      idempotencyKey: "compaction-thread",
    });
    await fixture.engine.sendMessage({
      messageId: "message-before-compaction",
      threadId: thread.threadId,
      senderPrincipalId: "human",
      content: "先处理当前事实",
      createdAt: T0,
    });

    await expect(fixture.engine.appendCompaction({
      itemId: "checkpoint-beyond-tail",
      threadId: thread.threadId,
      replacedThroughSequence: 2,
      replacementHistory: [{ type: "user_message", content: "越界摘要" }],
      originalItemCount: 1,
      createdAt: T1,
    })).rejects.toThrow("Compaction boundary exceeds thread facts");

    await fixture.engine.appendCompaction({
      itemId: "checkpoint-1",
      threadId: thread.threadId,
      replacedThroughSequence: 1,
      replacementHistory: [{ type: "user_message", content: "第一版摘要" }],
      originalItemCount: 1,
      createdAt: T1,
    });
    await fixture.engine.sendMessage({
      messageId: "message-after-compaction",
      threadId: thread.threadId,
      senderPrincipalId: "human",
      content: "新的事实",
      createdAt: "2026-07-10T00:02:00.000Z",
    });
    await fixture.engine.appendCompaction({
      itemId: "checkpoint-2",
      threadId: thread.threadId,
      replacedThroughSequence: 3,
      replacementHistory: [{ type: "user_message", content: "第二版摘要" }],
      originalItemCount: 2,
      createdAt: "2026-07-10T00:03:00.000Z",
    });

    await expect(fixture.engine.appendCompaction({
      itemId: "checkpoint-stale",
      threadId: thread.threadId,
      replacedThroughSequence: 1,
      replacementHistory: [{ type: "user_message", content: "过期摘要" }],
      originalItemCount: 1,
      createdAt: "2026-07-10T00:04:00.000Z",
    })).rejects.toThrow("Compaction boundary is stale");
  });

  it("reads a complete UI projection from one aggregate snapshot", async () => {
    const fixture = await activeGoalFixture(new RetryPort());
    await fixture.engine.appendModelItem({
      itemId: "model-projection",
      threadId: fixture.goal.spec.threadId,
      goalId: fixture.goal.spec.id,
      content: "处理中",
      createdAt: T1,
    });
    const read = vi.spyOn(fixture.store, "read");

    const projection = await fixture.engine.getProjection("a", fixture.goal.spec.id);

    expect(read).toHaveBeenCalledTimes(1);
    expect(projection.thread?.threadId).toBe(fixture.goal.spec.threadId);
    expect(projection.goal?.spec.id).toBe(fixture.goal.spec.id);
    expect(projection.payloads.size).toBeGreaterThan(0);
  });

  it("projects only the newest requested thread window without deleting history", async () => {
    const fixture = await createFixture();
    const thread = await fixture.engine.ensureThread({ agentId: "dev", scopeId: "window", idempotencyKey: "window" });
    for (let index = 1; index <= 5; index += 1) {
      await fixture.engine.appendModelItem({ itemId: `model-${index}`, threadId: thread.threadId, content: String(index), createdAt: T1 });
    }

    const projection = await fixture.engine.getProjection("window", undefined, 2);

    expect(projection.thread?.items.map((item) => item.itemId)).toEqual(["model-4", "model-5"]);
    expect((await fixture.engine.getThread(thread.threadId)).items).toHaveLength(5);
    expect(projection.payloads.size).toBe(2);
  });

  it("recognizes an unclosed running turn as recoverable after process interruption", async () => {
    const fixture = await activeGoalFixture(new RetryPort());
    await fixture.engine.appendToolItem({
      itemId: "interrupted-turn:started",
      turnId: "interrupted-turn",
      threadId: fixture.goal.spec.threadId,
      goalId: fixture.goal.spec.id,
      kind: "control",
      value: { turnId: "interrupted-turn", status: "running" },
      createdAt: T1,
    });
    await fixture.engine.appendToolItem({
      itemId: "interrupted-turn:tool",
      turnId: "interrupted-turn",
      threadId: fixture.goal.spec.threadId,
      goalId: fixture.goal.spec.id,
      kind: "tool",
      value: {
        type: "tool_call",
        callId: "call-1",
        name: "readFile",
        arguments: { path: "README.md" },
      },
      createdAt: T1,
    });

    expect(await fixture.engine.executionReadiness(fixture.goal.spec.id)).toEqual({
      ready: true,
      reason: "interrupted_turn",
    });
  });

  it("continues an explicitly resumed goal after an execution block", async () => {
    const fixture = await activeGoalFixture(new RetryPort());
    await fixture.engine.appendModelItem({
      itemId: "blocked-turn:model",
      turnId: "blocked-turn",
      threadId: fixture.goal.spec.threadId,
      goalId: fixture.goal.spec.id,
      content: "work in progress",
      createdAt: T1,
    });
    await fixture.engine.appendToolItem({
      itemId: "blocked-turn:control",
      turnId: "blocked-turn",
      threadId: fixture.goal.spec.threadId,
      goalId: fixture.goal.spec.id,
      kind: "control",
      value: {
        turnId: "blocked-turn",
        status: "execution_blocked",
        reason: "provider_error",
      },
      createdAt: T1,
    });

    expect(await fixture.engine.executionReadiness(fixture.goal.spec.id)).toEqual({
      ready: true,
      reason: "interrupted_turn",
    });
  });

  it("continues from the newest goal version after discarding a stale turn", async () => {
    const fixture = await activeGoalFixture(new RetryPort());
    await fixture.engine.appendModelItem({
      itemId: "stale-turn:model",
      turnId: "stale-turn",
      threadId: fixture.goal.spec.threadId,
      goalId: fixture.goal.spec.id,
      content: "outdated result",
      createdAt: T1,
    });
    await fixture.engine.appendToolItem({
      itemId: "stale-turn:discarded",
      turnId: "stale-turn",
      threadId: fixture.goal.spec.threadId,
      goalId: fixture.goal.spec.id,
      kind: "control",
      value: {
        status: "stale_goal",
        expectedGoalVersion: 2,
        actualGoalVersion: 3,
      },
      createdAt: T1,
    });

    expect(await fixture.engine.executionReadiness(fixture.goal.spec.id)).toEqual({
      ready: true,
      reason: "goal_version_updated",
    });
  });

  it("treats every host correction as ordered input even when its reason repeats", async () => {
    const fixture = await activeGoalFixture(new RetryPort());
    const appendModel = (itemId: string) => fixture.engine.appendModelItem({
      itemId,
      turnId: itemId,
      threadId: fixture.goal.spec.threadId,
      goalId: fixture.goal.spec.id,
      content: "revised proposal",
      createdAt: T1,
    });
    const appendCorrection = (itemId: string) => fixture.engine.appendToolItem({
      itemId,
      turnId: itemId,
      threadId: fixture.goal.spec.threadId,
      goalId: fixture.goal.spec.id,
      kind: "control" as const,
      value: {
        type: "goal_resolution_decision",
        status: "correctable",
        goalId: fixture.goal.spec.id,
        decision: { accepted: false, disposition: "correctable", reason: "criterion coverage is incomplete" },
      },
      createdAt: T1,
    });

    await appendModel("attempt-1");
    await appendCorrection("correction-1");
    await appendModel("attempt-2");
    await appendCorrection("correction-2");

    expect(await fixture.engine.executionReadiness(fixture.goal.spec.id)).toEqual({
      ready: true,
      reason: "host_correction",
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

  it("rejects settlement until a queued human turn for the same Goal is consumed", async () => {
    const port = new AcceptAllPort();
    const fixture = await activeGoalFixture(port);
    await fixture.engine.appendToolItem({
      itemId: "active-turn:started",
      turnId: "active-turn",
      threadId: fixture.goal.spec.threadId,
      goalId: fixture.goal.spec.id,
      kind: "control",
      value: { turnId: "active-turn", status: "running" },
      createdAt: T1,
    });
    await fixture.engine.sendMessage({
      messageId: "human-during-active-turn",
      turnId: "queued-human-turn",
      threadId: fixture.goal.spec.threadId,
      goalId: fixture.goal.spec.id,
      senderPrincipalId: "human",
      deliveryKind: "turn",
      content: "真实浏览器发现阻断问题，请纳入当前结论",
      createdAt: T1,
    });

    const rejected = await fixture.engine.proposeGoalResolution({
      ...proposalFor(fixture.goal),
      turnId: "active-turn",
    });

    expect(port.resolveCalls).toBe(0);
    expect(rejected.goal.status).toBe("active");
    expect(rejected.attempt).toMatchObject({
      settle: true,
      decision: {
        accepted: false,
        disposition: "correctable",
      },
    });
    expect(await fixture.engine.hasPendingHumanTurn(fixture.goal.spec.id, "active-turn")).toBe(true);

    await fixture.engine.appendToolItem({
      itemId: "queued-human-turn:started",
      turnId: "queued-human-turn",
      threadId: fixture.goal.spec.threadId,
      goalId: fixture.goal.spec.id,
      kind: "control",
      value: {
        turnId: "queued-human-turn",
        triggerMessageId: "human-during-active-turn",
        status: "running",
      },
      createdAt: T1,
    });
    const currentGoal = (await fixture.engine.getGoal(fixture.goal.spec.id))!;
    const accepted = await fixture.engine.proposeGoalResolution({
      ...proposalFor(currentGoal),
      proposalId: "proposal-after-human-turn",
      turnId: "queued-human-turn",
    });

    expect(port.resolveCalls).toBe(1);
    expect(accepted.goal.status).toBe("completed");
  });

  it("publishes external settlement only after the resolution port accepts responsibility", async () => {
    const port = new DeferredRetryPort();
    const fixture = await activeGoalFixture(port);
    const proposal = proposalFor(fixture.goal);
    const pending = fixture.engine.proposeGoalResolution(proposal);
    await port.entered;

    const beforeValidation = await fixture.engine.readEvents({ agentId: "dev", limit: 100 });
    expect(beforeValidation.events.map((event) => event.payload.type)).toContain("GoalProposalCreated");
    expect(beforeValidation.events.map((event) => event.payload.type)).not.toContain("GoalSettlementRequested");

    port.release();
    await pending;
    const afterValidation = await fixture.engine.readEvents({ agentId: "dev", limit: 100 });
    expect(afterValidation.events.map((event) => event.payload.type)).toContain("GoalSettlementRequested");
  });

  it("settles the same proposal idempotently when concurrent ticks submit one decision", async () => {
    const fixture = await activeGoalFixture(new RetryPort());
    const proposal = proposalFor(fixture.goal);
    const resolving = (await fixture.engine.proposeGoalResolution(proposal)).goal;
    const input = {
      decisionId: "concurrent-decision",
      proposalId: proposal.proposalId,
      expectedGoalVersion: resolving.version,
      decision: { accepted: true as const, committedState: "completed" as const },
    };

    const [first, second] = await Promise.all([
      fixture.engine.settleProposal(input),
      fixture.engine.settleProposal(input),
    ]);

    expect(first).toMatchObject({ applied: true, goal: { status: "completed" } });
    expect(second).toEqual(first);
    expect((await fixture.store.read()).decisions.filter((item) => item.decisionId === input.decisionId)).toHaveLength(1);
    await expect(new AgentStore(fixture.root, "dev").read()).resolves.toMatchObject({
      goals: [expect.objectContaining({ status: "completed" })],
    });
  });

  it("does not let a stale resolution proposal overwrite a concurrent Goal control", async () => {
    const fixture = await activeGoalFixture(new RetryPort());
    const originalTransact = fixture.store.transact.bind(fixture.store);
    let releaseFirst!: () => void;
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const released = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let blockNextTransaction = true;
    vi.spyOn(fixture.store, "transact").mockImplementation(async (mutate) => {
      if (blockNextTransaction) {
        blockNextTransaction = false;
        markEntered();
        await released;
      }
      return originalTransact(mutate);
    });

    const proposal = proposalFor(fixture.goal);
    const pendingProposal = fixture.engine.proposeGoalResolution(proposal);
    await entered;
    const paused = await fixture.engine.controlGoal({
      requestId: "pause-during-proposal",
      goalId: fixture.goal.spec.id,
      expectedGoalVersion: fixture.goal.version,
      action: "pause",
      reason: "operator pause",
    });
    releaseFirst();

    await expect(pendingProposal).rejects.toMatchObject({ code: "version_conflict" });
    expect(await fixture.engine.getGoal(fixture.goal.spec.id)).toEqual(paused);
    const events = await fixture.engine.readEvents({ agentId: "dev", limit: 100 });
    const goalVersions = events.events
      .filter((event) => event.aggregateId === fixture.goal.spec.id)
      .map((event) => event.aggregateVersion);
    expect(goalVersions).toEqual([...goalVersions].sort((a, b) => a - b));
    await expect(new AgentStore(fixture.root, "dev").read()).resolves.toMatchObject({
      goals: [expect.objectContaining({ version: paused.version, status: "paused" })],
    });
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

  it("cancels a goal when the host reports stale authority", async () => {
    const fixture = await activeGoalFixture(new RetryPort());
    const proposal = proposalFor(fixture.goal);
    const resolving = (await fixture.engine.proposeGoalResolution(proposal)).goal;
    const settled = await fixture.engine.settleProposal({
      decisionId: "stale-decision",
      proposalId: proposal.proposalId,
      expectedGoalVersion: resolving.version,
      decision: { accepted: false, disposition: "stale_claim", reason: "claim expired" },
    });

    expect(settled).toMatchObject({ applied: true, goal: { status: "cancelled" } });
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
    const updatedThread = await fixture.engine.getThread(thread.threadId);
    const decisionItem = updatedThread.items.at(-1)!;
    expect(decisionItem.kind).toBe("control");
    expect(await fixture.engine.getPayload(decisionItem.payloadRef)).toMatchObject({
      type: "goal_resolution_decision",
      status: "correctable",
      decision: { reason: "artifact is required" },
    });
  });

  it("does not let a custom resolution port bypass success-criterion coverage", async () => {
    const port = new AcceptAllPort();
    const fixture = await activeGoalFixture(port);
    const proposal = {
      ...proposalFor(fixture.goal),
      criterionResults: [],
    };

    const result = await fixture.engine.proposeGoalResolution(proposal);

    expect(port.resolveCalls).toBe(0);
    expect(result.attempt).toMatchObject({
      settle: true,
      decision: {
        accepted: false,
        disposition: "correctable",
        reason: "完成报告必须逐项回应全部 1 条成功标准",
      },
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

class DeferredRetryPort implements GoalResolutionPort {
  private signalEntered!: () => void;
  private signalRelease!: () => void;
  readonly entered = new Promise<void>((resolve) => { this.signalEntered = resolve; });
  private readonly released = new Promise<void>((resolve) => { this.signalRelease = resolve; });

  release(): void {
    this.signalRelease();
  }

  async resolve<TStatus extends GoalResolutionStatus>(
    _goal: AgentGoal,
    _proposal: GoalResolutionProposal<TStatus>,
  ): Promise<GoalResolutionAttemptResult<TStatus>> {
    this.signalEntered();
    await this.released;
    return { settle: false, pending: "retry_later", reason: "external settlement", retryAfter: T1 };
  }
}

class AcceptAllPort implements GoalResolutionPort {
  resolveCalls = 0;

  async resolve<TStatus extends GoalResolutionStatus>(
    _goal: AgentGoal,
    proposal: GoalResolutionProposal<TStatus>,
  ): Promise<GoalResolutionAttemptResult<TStatus>> {
    this.resolveCalls += 1;
    return { settle: true, decision: { accepted: true, committedState: proposal.status } };
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
    evidence: [{ evidenceId: "ev-main-ts" }],
    criterionResults: [{ criterionIndex: 0, status: "satisfied", evidence: [{ evidenceId: "ev-main-ts" }] }],
    residualRisks: [],
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
