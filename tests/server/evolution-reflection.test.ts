import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EvolutionReflectionWorker } from "../../src/server/evolution/reflection-worker.js";
import { EvolutionSignalStore } from "../../src/server/evolution/evolution-signal-store.js";
import { ExperienceStore } from "../../src/server/evolution/experience-store.js";
import { projectExperience } from "../../src/server/evolution/experience-projector.js";
import { PracticeDraftStore } from "../../src/server/evolution/practice-draft-store.js";
import { ProviderPracticeReflector, type PracticeReflector } from "../../src/server/evolution/practice-reflector.js";
import { AgentStore } from "../../src/server/agent-engine/agent-store.js";
import { AgentEngine } from "../../src/server/agent-engine/agent-engine.js";
import { AgentTraceStore } from "../../src/server/agent-engine/trace-store.js";
import { PlatformEvolutionObservationAdapter, isLearningEligibleRuntimeTask } from "../../src/server/evolution-adapters/platform-observation-adapter.js";
import { PlatformEvolutionSourceVerifier } from "../../src/server/evolution-adapters/platform-source-verifier.js";
import type { Workspace } from "../../src/shared/types.js";
import type { ProviderRegistry } from "../../src/server/providers/provider-registry.js";
import { EMPTY_EVOLUTION_OBSERVATION_PORT } from "../../src/server/evolution/observation-port.js";

describe("Evolution fast reflection", () => {
  it("does not treat paired qualification tasks as independent learning experience", () => {
    expect(isLearningEligibleRuntimeTask({ evolutionTrial: undefined } as any)).toBe(true);
    expect(isLearningEligibleRuntimeTask({ evolutionTrial: { trialId: "trial-a" } } as any)).toBe(false);
  });

  it("turns an explicit attribution into an agent-project PracticeDraft without activating an asset", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-reflection-"));
    const now = () => new Date("2026-08-15T01:00:00.000Z");
    const experience = new ExperienceStore("workspace-a", root);
    const projected = projectExperience({
      commandId: "corrected-episode", workspaceId: "workspace-a", taskId: "task-a", taskRunId: "run-a",
      ticket: { ticketId: "ticket-a", attemptId: "attempt-a", status: "failed", startedAt: "2026-08-15T00:00:00.000Z", updatedAt: "2026-08-15T00:10:00.000Z" },
      goal: { goalId: "goal-a", agentId: "workspace-agent-a", profileId: "profile-a", status: "failed" },
      sourceRefs: [{ kind: "human_feedback", ref: "feedback-a", workspaceId: "workspace-a", profileId: "profile-a" }],
      failures: [{ component: "workflow", symptom: "Participants started with different document versions", cause: "The authoritative document was not briefed before collaborative execution", sourceRefs: [{ kind: "human_feedback", ref: "feedback-a", workspaceId: "workspace-a", profileId: "profile-a" }] }],
    }, now);
    projected.attributions[0]!.counterEvidenceRefs = [{ kind: "evidence", ref: "counter-a", workspaceId: "workspace-a" }];
    await experience.record("corrected-episode", projected);
    const signals = new EvolutionSignalStore("workspace-a", root, now);
    const signal = await signals.enqueue({ commandId: "signal-a", trigger: "user_correction", priority: 1, profileId: "profile-a", episodeId: projected.episode.episodeId, sourceRefs: projected.episode.sourceRefs, salience: 1, novelty: 0, occurredAt: projected.episode.endedAt });
    const drafts = new PracticeDraftStore("workspace-a", root, now);
    const worker = new EvolutionReflectionWorker("workspace-a", root, signals, experience, drafts);

    const result = await worker.runNext("reflection-worker");

    expect(result).toMatchObject({ signalId: signal.signalId, drafts: [expect.objectContaining({
      statement: "The authoritative document was not briefed before collaborative execution",
      trigger: "Participants started with different document versions",
      applicability: { ownerLevel: "agent_project", workspaceId: "workspace-a", profileId: "profile-a" },
      contraindications: ["evidence:counter-a"], status: "draft",
    })] });
    expect((await signals.list())[0]).toMatchObject({ status: "succeeded" });
    expect(await worker.runNext("reflection-worker")).toBeUndefined();
    expect(await drafts.list()).toHaveLength(1);
  });

  it("uses a configured Provider reflector to learn an open observed method from a successful Episode", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-provider-reflection-")); const now = () => new Date("2026-08-15T01:00:00.000Z");
    const experience = new ExperienceStore("workspace-a", root); const projected = projectExperience({
      commandId: "successful-method", workspaceId: "workspace-a", taskId: "task-a", taskRunId: "run-a",
      ticket: { ticketId: "ticket-a", attemptId: "attempt-a", status: "completed", startedAt: "2026-08-15T00:00:00.000Z", updatedAt: "2026-08-15T00:10:00.000Z" },
      goal: { goalId: "goal-a", agentId: "agent-a", profileId: "profile-a", status: "completed" }, sourceRefs: [{ kind: "ticket", ref: "ticket-a", workspaceId: "workspace-a", profileId: "profile-a" }],
    }, now); await experience.record("successful-method", projected);
    const signals = new EvolutionSignalStore("workspace-a", root, now); const signal = await signals.enqueue({ commandId: "signal-success", trigger: "novel_success", priority: 2,
      profileId: "profile-a", episodeId: projected.episode.episodeId, sourceRefs: projected.episode.sourceRefs, salience: 1, novelty: 1, occurredAt: projected.episode.endedAt });
    const drafts = new PracticeDraftStore("workspace-a", root, now); const reflector: PracticeReflector = { available: async () => true, reflect: async () => [{
      statement: "Shared understanding before execution improves coordination", trigger: "A multi-Agent project starts from an authoritative document",
      procedure: "Brief the document to every participant, collect acknowledgement, then begin execution", expectedOutcome: [{ metric: "task_success_rate", direction: "increase", minimumDelta: 0.01 }],
      observedComponents: ["workflow"], contraindications: ["Do not brief superseded document revisions"],
    }] };
    const result = await new EvolutionReflectionWorker("workspace-a", root, signals, experience, drafts, undefined, now, reflector).runNext("provider-reflection");
    expect(result).toMatchObject({ signalId: signal.signalId, drafts: [expect.objectContaining({ procedure: "Brief the document to every participant, collect acknowledgement, then begin execution" })] });
  });

  it("gives the reflector a redacted causal timeline from the platform adapter", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-reflection-timeline-"));
    const workspace: Workspace = { id: "workspace-a", name: "Company", rootPath: root, policyProfile: "development", createdAt: "2026-08-15T00:00:00.000Z" };
    const agentId = "agent-qa"; const profileId = "profile-qa"; const store = new AgentStore(root, agentId); const engine = new AgentEngine(store);
    const thread = await engine.ensureThread({ agentId, scopeId: "task-a", idempotencyKey: "thread-a" });
    await engine.startGoal({ agentId, threadId: thread.threadId, idempotencyKey: "goal-a", spec: {
      id: "goal-a", threadId: thread.threadId, objective: "Verify the existing artifact", successCriteria: ["Produce auditable evidence"], contextRefs: [], createdAt: "2026-08-15T00:00:00.000Z",
    } });
    await new AgentTraceStore(root, agentId).append({ traceId: "trace-error", agentId, threadId: thread.threadId, goalId: "goal-a", turnId: "turn-a", kind: "error", createdAt: "2026-08-15T00:01:00.000Z", data: { status: "provider_retry_wait", reason: "provider_error", message: "Authorization: Bearer secret-token" } });
    await engine.sendMessage({ messageId: "feedback-a", turnId: "turn-b", threadId: thread.threadId, goalId: "goal-a", senderPrincipalId: "human", deliveryKind: "turn", content: "Read the existing artifact, check each acceptance criterion, and do not loop without evidence.", createdAt: "2026-08-15T00:02:00.000Z" });
    const projected = projectExperience({ commandId: "episode-a", workspaceId: workspace.id, taskId: "task-a", taskRunId: "run-a",
      ticket: { ticketId: "ticket-a", attemptId: "attempt-a", status: "completed", startedAt: "2026-08-15T00:00:00.000Z", updatedAt: "2026-08-15T00:03:00.000Z" },
      goal: { goalId: "goal-a", agentId, profileId, status: "completed" }, sourceRefs: [{ kind: "ticket", ref: "ticket-a", workspaceId: workspace.id, taskId: "task-a", taskRunId: "run-a", agentId, profileId }],
    });
    await new ExperienceStore(workspace.id, root).record("episode-a", projected);
    const signals = new EvolutionSignalStore(workspace.id, root); const signal = await signals.enqueue({ commandId: "signal-a", trigger: "terminal_outcome", priority: 3, profileId,
      episodeId: projected.episode.episodeId, sourceRefs: projected.episode.sourceRefs, salience: 0.25, novelty: 0, occurredAt: projected.episode.endedAt });
    let receivedFacts: Awaited<ReturnType<PlatformEvolutionObservationAdapter["collectReflectionFacts"]>> = [];
    const reflector: PracticeReflector = { available: async () => true, reflect: async (_episode, facts) => { receivedFacts = facts; return [{
      statement: "Re-ground stalled QA in the current artifact and acceptance criteria", trigger: "QA has repeated errors or turns without auditable progress",
      procedure: "Read the existing artifact, verify each criterion, and report evidence or a concrete blocker", expectedOutcome: [{ metric: "task_success_rate", direction: "increase" }], observedComponents: ["workflow"], contraindications: [],
    }]; } };
    const adapter = new PlatformEvolutionObservationAdapter(workspace);
    const result = await new EvolutionReflectionWorker(workspace.id, root, signals, undefined, undefined, undefined, undefined, reflector, adapter).runNext("worker-a");
    expect(result?.drafts).toHaveLength(1);
    expect(receivedFacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "error", summary: expect.stringContaining("[REDACTED]") }),
      expect.objectContaining({ kind: "human_intervention", summary: expect.stringContaining("acceptance criterion") }),
      expect.objectContaining({ kind: "execution_pattern", summary: expect.stringContaining("1 errors") }),
      expect.objectContaining({ kind: "outcome", summary: expect.stringContaining("succeeded") }),
    ]));
    expect(await new PlatformEvolutionSourceVerifier(workspace.id, root).verify({ kind: "human_feedback", ref: "feedback-a", workspaceId: workspace.id, agentId })).toBe(true);
    expect((await signals.list()).find((item) => item.signalId === signal.signalId)?.status).toBe("succeeded");
  });

  it("runs process reflection alongside typed errors and deduplicates repeated attributions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-reflection-mixed-")); const now = () => new Date("2026-08-15T01:00:00.000Z");
    const projected = projectExperience({ commandId: "mixed", workspaceId: "workspace-a", taskId: "task-a", taskRunId: "run-a",
      ticket: { ticketId: "ticket-a", attemptId: "attempt-a", status: "completed", startedAt: "2026-08-15T00:00:00.000Z", updatedAt: "2026-08-15T00:10:00.000Z" },
      goal: { goalId: "goal-a", agentId: "agent-a", profileId: "profile-a", status: "completed" },
      sourceRefs: [{ kind: "ticket", ref: "ticket-a", workspaceId: "workspace-a" }], failures: [
        { component: "provider", symptom: "provider_retry_wait", cause: "Connection error", sourceRefs: [{ kind: "trace", ref: "trace-a", workspaceId: "workspace-a" }] },
        { component: "provider", symptom: "provider_retry_wait", cause: "Connection error", sourceRefs: [{ kind: "trace", ref: "trace-b", workspaceId: "workspace-a" }] },
      ],
    }, now);
    expect(projected.attributions).toHaveLength(1);
    expect(projected.attributions[0]?.sourceRefs.map((item) => item.ref).sort()).toEqual(["trace-a", "trace-b"]);
    const experience = new ExperienceStore("workspace-a", root); await experience.record("mixed", projected);
    const signals = new EvolutionSignalStore("workspace-a", root, now); await signals.enqueue({ commandId: "signal-mixed", trigger: "user_correction", priority: 1, profileId: "profile-a",
      episodeId: projected.episode.episodeId, sourceRefs: projected.episode.sourceRefs, salience: 1, novelty: 0.5, occurredAt: projected.episode.endedAt });
    let reflected = false; const reflector: PracticeReflector = { available: async () => true, reflect: async () => { reflected = true; return [{ statement: "Re-ground after stalled execution", trigger: "A reviewer has no auditable progress", procedure: "Inspect the existing artifact and verify criteria one by one", expectedOutcome: [{ metric: "task_success_rate", direction: "increase" }], observedComponents: ["workflow"], contraindications: [] }]; } };
    const observations = { ...EMPTY_EVOLUTION_OBSERVATION_PORT, collectReflectionFacts: async () => [{ kind: "human_intervention" as const, actor: "human" as const, occurredAt: "2026-08-15T00:05:00.000Z", summary: "Inspect the existing artifact", sourceRef: { kind: "human_feedback" as const, ref: "feedback-a", workspaceId: "workspace-a", agentId: "agent-a" } }] };
    const result = await new EvolutionReflectionWorker("workspace-a", root, signals, experience, undefined, undefined, now, reflector, observations).runNext("worker");
    expect(reflected).toBe(true);
    expect(result?.drafts).toEqual([
      expect.objectContaining({ observedComponents: ["workflow"], sourceRefs: expect.arrayContaining([expect.objectContaining({ kind: "human_feedback", ref: "feedback-a" })]) }),
    ]);
  });

  it("repairs one schema-invalid Provider response instead of losing the reflection signal", async () => {
    let calls = 0;
    const providers = {
      modelConfigs: async () => [{ id: "model-a", name: "Model", provider: "openai", model: "model-a", contextWindowTokens: 1000, supportsReasoning: false, supportsImages: false, thinkingLevel: "off", isDefault: true, createdAt: "2026-08-15T00:00:00.000Z", updatedAt: "2026-08-15T00:00:00.000Z" }],
      runModelTurnWithRetry: async (input: { history: Array<{ type: string; content?: string }> }) => {
        calls += 1;
        if (calls === 1) return { items: [{ type: "assistant_message" as const, content: '[{"statement":"Learn","trigger":"Stall","procedure":"Recover","expectedOutcome":[{"metric":"success","direction":"increase"}],"observedComponents":["workflow"],"guardrails":"verify later","contraindications":[]}]' }] };
        expect(input.history.at(-1)?.content).toContain("failed validation");
        return { items: [{ type: "assistant_message" as const, content: '[{"statement":"Learn","trigger":"Stall","procedure":"Recover","expectedOutcome":[{"metric":"task_success_rate","direction":"increase"}],"observedComponents":["workflow"],"guardrails":[],"contraindications":[]}]' }] };
      },
    } as unknown as ProviderRegistry;
    const result = await new ProviderPracticeReflector(providers).reflect({ episodeId: "episode-a", workspaceId: "workspace-a", taskId: "task-a", taskRunId: "run-a", ticketId: "ticket-a", attemptId: "attempt-a", goalId: "goal-a", agentId: "agent-a", profileId: "profile-a", outcome: "succeeded", sourceRefs: [{ kind: "ticket", ref: "ticket-a", workspaceId: "workspace-a" }], startedAt: "2026-08-15T00:00:00.000Z", endedAt: "2026-08-15T00:01:00.000Z", contentHash: "a".repeat(64) }, []);
    expect(calls).toBe(2);
    expect(result).toEqual([expect.objectContaining({ expectedOutcome: [{ metric: "task_success_rate", direction: "increase" }], guardrails: [] })]);
  });
});
