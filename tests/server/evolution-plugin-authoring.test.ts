import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EvidenceLedger } from "../../src/server/agent-engine/evidence-ledger.js";
import { EvolutionStore } from "../../src/server/evolution/evolution-store.js";
import { platformEvolutionStore } from "../../src/server/evolution-adapters/platform-source-verifier.js";
import { PluginAuthoringJobStore } from "../../src/server/evolution/plugin-authoring-job-store.js";
import { PluginAuthoringWorker, type PluginArtifactAuthor } from "../../src/server/evolution/plugin-authoring-worker.js";
import { PracticeBindingCompiler } from "../../src/server/evolution/practice-binding-compiler.js";
import { PracticeBindingStore } from "../../src/server/evolution/practice-binding-store.js";
import { PracticeStore } from "../../src/server/evolution/practice-store.js";

describe("Provider-authored local Plugin evolution", () => {
  it("turns a tool-level Practice into a scanned critical-risk Candidate without activating it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-plugin-author-")); const now = () => new Date("2026-08-15T08:00:00.000Z");
    await new EvidenceLedger(root).append({ evidenceId: "tool-practice-evidence", agentId: "agent-a", threadId: "thread-a", goalId: "goal-a", turnId: "turn-a", toolCallId: "call-a", toolName: "observer", kind: "tool", capture: { status: "recorded" }, observation: { status: "observed", result: {} }, workspaceRoot: root, createdAt: now().toISOString(), input: {} });
    const practices = new PracticeStore("workspace-a", root, now);
    const practice = await practices.createCandidate({ commandId: "tool-practice", statement: "Normalize the project checklist before validation", trigger: "A checklist arrives in inconsistent shapes", procedure: "Accept a checklist object and return a normalized deterministic representation.", expectedOutcome: [{ metric: "task_success_rate", direction: "increase", minimumDelta: 0.01 }], observedComponents: ["tool"], applicability: { ownerLevel: "agent_project", workspaceId: "workspace-a", profileId: "profile-a" }, contraindications: [], sourceDraftRefs: ["draft-a", "draft-b"], sourceEpisodeRefs: ["episode-a", "episode-b"], sourceRefs: [{ kind: "evidence", ref: "tool-practice-evidence", workspaceId: "workspace-a", profileId: "profile-a" }] });
    const bindings = new PracticeBindingStore(root, now); const candidates = platformEvolutionStore("workspace-a", root, now);
    await new PracticeBindingCompiler("workspace-a", practices, bindings, candidates).compile();
    expect(await bindings.list()).toMatchObject([{ kind: "plugin", status: "proposed", practiceRef: { id: practice.practiceId } }]);
    const result = await new PluginAuthoringWorker("workspace-a", root, new FixtureAuthor(), now, candidates).run();
    expect(result).toEqual({ jobsInspected: 1, candidatesCreated: 1 });
    const candidate = (await candidates.list())[0]!;
    expect(candidate).toMatchObject({ kind: "plugin", riskLevel: "critical", status: "validated", practiceRef: { id: practice.practiceId }, validation: { passed: true, pluginScanner: { decision: "pass" } } });
    expect((await bindings.list())[0]).toMatchObject({ status: "candidate_created", candidateRef: { id: candidate.candidateId, contentHash: candidate.contentHash } });
    expect((await new PluginAuthoringJobStore(root, now).list())[0]).toMatchObject({ status: "succeeded", candidateId: candidate.candidateId, attempts: 1 });
    expect(await candidates.list()).toHaveLength(1);
  });

  it("keeps the durable job pending when no real Provider is configured", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-plugin-author-offline-")); const jobs = new PluginAuthoringJobStore(root);
    await jobs.enqueue("enqueue", "binding-a", "practice-a", 1);
    const result = await new PluginAuthoringWorker("workspace-a", root, { available: async () => false, author: async () => { throw new Error("must not run"); } }).run();
    expect(result.candidatesCreated).toBe(0);
    expect((await jobs.list())[0]).toMatchObject({ status: "pending", attempts: 0 });
  });
});

class FixtureAuthor implements PluginArtifactAuthor {
  async available(): Promise<boolean> { return true; }
  async author(_practice: unknown, target: string): Promise<string> { return JSON.stringify({ schemaVersion: 1, manifest: { id: target, version: "1.0.0", kind: "plugin", apiVersion: "autoagent.plugin/v1", entrypoint: "index.mjs", description: "Normalize checklist input according to the learned Practice.", permissions: { workspaceRead: [] }, contributions: { tools: [{ name: "normalize_checklist", description: "Normalize a checklist object.", inputSchema: { type: "object", additionalProperties: false, properties: { items: { type: "array", items: { type: "string" } } }, required: ["items"] } }], guardrails: [] }, lifecycle: { activation: "onDemand", invokeTimeoutMs: 2000 } }, files: [{ path: "index.mjs", content: "export default { async health(){ return {ok:true}; }, async invokeTool({name,input}){ if(name !== 'normalize_checklist') throw new Error('unknown tool'); return {items:[...input.items].map(String).sort()}; } };\n" }] }); }
}
