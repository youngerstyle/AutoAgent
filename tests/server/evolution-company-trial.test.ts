import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ScopePromotionStore } from "../../src/server/evolution/scope-promotion-store.js";
import { CompanyTrialReleaseRegistry } from "../../src/server/evolution/company-trial-registry.js";
import { CompanyTrialStore } from "../../src/server/evolution/company-trial-store.js";
import { EvolutionActivationStore } from "../../src/server/evolution/activation-store.js";
import { isCanaryAssignment, runtimeEvolutionProjection } from "../../src/server/evolution/runtime-projection.js";
import type { AgentProfile, WorkspaceAgent } from "../../src/shared/types.js";
import type { CompanyTrialObservation, EvaluationObservation } from "../../src/shared/contracts/evolution.js";
import { AgentTraceStore } from "../../src/server/agent-engine/trace-store.js";
import { EvidenceLedger } from "../../src/server/agent-engine/evidence-ledger.js";
import { CompanyTrialEvidenceStore } from "../../src/server/evolution/company-trial-evidence-store.js";
import { ExperienceStore } from "../../src/server/evolution/experience-store.js";
import { CompanyTrialReconciler } from "../../src/server/evolution/company-trial-reconciler.js";
import { CompanyIdentityStore } from "../../src/server/storage/company-identity-store.js";

describe("cross-project company trial", () => {
  it("deploys a reviewed Project practice only to another project's selected Agent with recorded control assignment", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "autoagent-company-trial-home-"));
    const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "autoagent-company-trial-source-"));
    const targetRoot = await mkdtemp(path.join(os.tmpdir(), "autoagent-company-trial-target-"));
    const content = "# Trial memory\n\nBrief the authoritative document before execution.";
    const release = { id: "project-release-a", version: "1", contentHash: createHash("sha256").update(content).digest("hex") };
    await writeOrigin(sourceRoot, release, content);
    const now = () => new Date("2026-08-15T07:00:00.000Z");
    const companyId = (await new CompanyIdentityStore(home, now).getOrCreate()).companyId;
    const proposals = new ScopePromotionStore(home, companyId, now, async (input) => ({ verifierId: "test", verifiedAt: now().toISOString(), originRootId: "workspace-a", inheritanceProofCount: input.inheritanceProofRefs.length, effectWindowCount: input.effectWindowRefs.length }));
    const proposal = await proposals.propose({
      commandId: "propose-company", companyId, origin: { ownerLevel: "project", workspaceId: "workspace-a" }, targetScope: { ownerLevel: "company" },
      originReleaseRef: release, practiceRef: { id: "practice-a", version: "1", contentHash: "b".repeat(64) }, inheritanceProofRefs: ["proof-a"], effectWindowRefs: ["effect-a"], generalizationRisks: ["Team topology may differ"],
    });
    await proposals.transition("review-company", proposal.proposalId, "reviewed", { type: "human", id: "owner" });
    const trials = new CompanyTrialStore(home, companyId, now);
    const trial = await new CompanyTrialReleaseRegistry(home, companyId, proposals, trials, now).deploy({
      commandId: "deploy-trial", proposalId: proposal.proposalId, sourceRoot, targetWorkspaceId: "workspace-b", targetWorkspaceRoot: targetRoot, targetProfileId: "profile-b", targetAgentId: "workspace-b-profile-b", percentage: 20, salt: "stable-trial-salt",
    });
    expect(trial).toMatchObject({ status: "deployed", source: { workspaceId: "workspace-a" }, target: { workspaceId: "workspace-b", profileId: "profile-b" }, assignment: { percentage: 20 } });
    expect(await trials.list(proposal.proposalId)).toEqual([trial]);
    expect(await proposals.get(proposal.proposalId)).toMatchObject({ status: "trial", trialRefs: [trial.trialId] });
    const selectedKey = findKey(trial.assignment, true); const controlKey = findKey(trial.assignment, false);
    const selected = await runtimeEvolutionProjection(targetRoot, "workspace-b", profile("profile-b"), agent("workspace-b", "profile-b"), { assignmentKey: selectedKey });
    const control = await runtimeEvolutionProjection(targetRoot, "workspace-b", profile("profile-b"), agent("workspace-b", "profile-b"), { assignmentKey: controlKey });
    expect(selected.memories).toEqual([expect.objectContaining({ content, ownerLevel: "agent_project", releaseId: trial.trialReleaseRef.id })]);
    expect(selected.canaryAssignments).toEqual([expect.objectContaining({ promotionId: trial.trialId, selected: true })]);
    expect(control.memories).toEqual([]);
    expect(control.canaryAssignments).toEqual([expect.objectContaining({ promotionId: trial.trialId, selected: false })]);
    const wrongAgent = await runtimeEvolutionProjection(targetRoot, "workspace-b", profile("profile-c"), agent("workspace-b", "profile-c"), { assignmentKey: selectedKey });
    expect(wrongAgent.memories).toEqual([]);
    const activationStore = new EvolutionActivationStore(targetRoot, now);
    expect((await activationStore.list())[0]).toMatchObject({ promotionId: trial.trialId, stage: "canary", scope: { workspaceId: "workspace-b", profileId: "profile-b" } });
    const observations: CompanyTrialObservation[] = [];
    const keys = [...keysFor(trial.assignment, true, 5), ...keysFor(trial.assignment, false, 5)];
    for (const [index, assignmentKey] of keys.entries()) {
      const arm = isCanaryAssignment(trial.assignment, assignmentKey) ? "selected" as const : "control" as const;
      const [threadId, goalId] = assignmentKey.split(":") as [string, string];
      const traceId = `trial-trace-${index}`; const turnId = `trial-turn-${index}`; const evidenceId = `trial-fact-${index}`;
      await new AgentTraceStore(targetRoot, "workspace-b-profile-b").append({ traceId, agentId: "workspace-b-profile-b", threadId, goalId, turnId, kind: "context", createdAt: now().toISOString(), data: { evolutionCanaryAssignments: [{ target: "practice.memory.briefing", promotionId: trial.trialId, releaseId: trial.trialReleaseRef.id, selected: arm === "selected" }], evolutionSnapshotHash: selected.snapshotHash } });
      await new EvidenceLedger(targetRoot).append({ evidenceId, agentId: "workspace-b-profile-b", threadId, goalId, turnId, toolCallId: `call-${index}`, toolName: "trial-observer", kind: "tool", capture: { status: "recorded" }, observation: { status: "observed", result: { arm } }, workspaceRoot: targetRoot, createdAt: now().toISOString(), input: { assignmentKey } });
      const traceRef = { kind: "trace" as const, ref: traceId, workspaceId: "workspace-b", agentId: "workspace-b-profile-b", profileId: "profile-b" };
      const proof = arm === "selected" ? await activationStore.observe({ assetKind: "memory", target: "practice.memory.briefing", ownerLevel: "agent_project", releaseRef: trial.trialReleaseRef, desiredGeneration: 1, actualGeneration: 1, runtimeKind: "turn", runtimeRef: turnId, runtimeSnapshotHash: selected.snapshotHash, traceRef }) : undefined;
      observations.push({ observationId: `observation-${index}`, assignmentKey, arm, traceRef, ...(proof ? { inheritanceProofRef: proof.proofId } : {}), evidenceRefs: [{ kind: "evidence", ref: evidenceId, workspaceId: "workspace-b", agentId: "workspace-b-profile-b", profileId: "profile-b" }], result: observation(arm === "selected") });
      await new ExperienceStore("workspace-b", targetRoot).record(`experience-${index}`, { episode: { episodeId: `episode-${index}`, workspaceId: "workspace-b", taskId: `task-${index}`, taskRunId: `run-${index}`, ticketId: `ticket-${index}`, attemptId: `attempt-${index}`, goalId, agentId: "workspace-b-profile-b", profileId: "profile-b", outcome: arm === "selected" ? "succeeded" : "failed", sourceRefs: [{ kind: "evidence", ref: evidenceId, workspaceId: "workspace-b", agentId: "workspace-b-profile-b", profileId: "profile-b" }], startedAt: "2026-08-15T06:59:00.000Z", endedAt: "2026-08-15T07:00:00.000Z", contentHash: createHash("sha256").update(`episode-${index}`).digest("hex") }, attributions: [] });
    }
    const evidenceStore = new CompanyTrialEvidenceStore(home, companyId, trials, proposals, now);
    await expect(evidenceStore.record({ commandId: "insufficient", trialId: trial.trialId, targetWorkspaceRoot: targetRoot, observations: observations.slice(0, 4), startedAt: "2026-08-15T05:00:00.000Z", endedAt: "2026-08-15T07:00:00.000Z" })).rejects.toMatchObject({ code: "INVALID_COMPANY_TRIAL_EVIDENCE" });
    expect(await new CompanyTrialReconciler(home, { id: "workspace-b", name: "B", rootPath: targetRoot, policyProfile: "production", createdAt: now().toISOString() }, now).reconcile()).toEqual({ evidenceRecorded: 1 });
    const evidence = (await evidenceStore.list(proposal.proposalId))[0]!;
    expect(evidence).toMatchObject({ decision: "pass", selectedSampleSize: 5, controlSampleSize: 5, trialReleaseRef: trial.trialReleaseRef });
    expect(await trials.get(trial.trialId)).toMatchObject({ status: "evidence_ready" });
    expect((await activationStore.list())[0]).toMatchObject({ status: "rolled_back", proofCount: 5 });
    expect((await runtimeEvolutionProjection(targetRoot, "workspace-b", profile("profile-b"), agent("workspace-b", "profile-b"), { assignmentKey: selectedKey })).memories).toEqual([]);
    expect(await proposals.get(proposal.proposalId)).toMatchObject({ status: "trial", trialEvidenceRefs: [evidence.evidenceId] });
    expect(await proposals.transition("approve-after-real-trial", proposal.proposalId, "approved", { type: "human", id: "owner" })).toMatchObject({ status: "approved" });
  });

  it("rejects the source project and source Agent as a company trial target", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "autoagent-company-trial-invalid-"));
    const store = new CompanyTrialStore(home, "company-a");
    const base = { commandId: "invalid", companyId: "company-a", proposalId: "proposal-a", practiceRef: { id: "p", version: "1", contentHash: "a".repeat(64) }, originReleaseRef: { id: "r", version: "1", contentHash: "b".repeat(64) }, trialReleaseRef: { id: "t", version: "1", contentHash: "b".repeat(64) }, assignment: { unit: "runtime_assignment" as const, percentage: 20, salt: "salt", minimumSamplesPerArm: 5 } };
    await expect(store.deploy({ ...base, source: { ownerLevel: "agent", workspaceId: "workspace-a", profileId: "profile-a" }, target: { workspaceId: "workspace-a", profileId: "profile-b", agentId: "agent-b" } })).rejects.toMatchObject({ code: "INVALID_COMPANY_TRIAL" });
    await expect(store.deploy({ ...base, commandId: "invalid-agent", source: { ownerLevel: "agent", workspaceId: "workspace-a", profileId: "profile-a" }, target: { workspaceId: "workspace-b", profileId: "profile-a", agentId: "agent-a" } })).rejects.toMatchObject({ code: "INVALID_COMPANY_TRIAL" });
  });
});

function findKey(rollout: { percentage: number; salt: string }, selected: boolean): string { for (let i = 0; i < 1000; i += 1) { const key = `task-${i}`; if (isCanaryAssignment(rollout, key) === selected) return key; } throw new Error("assignment key not found"); }
function keysFor(rollout: { percentage: number; salt: string }, selected: boolean, count: number): string[] { const keys: string[] = []; const arm = selected ? "selected" : "control"; for (let i = 0; i < 10_000 && keys.length < count; i += 1) { const key = `${arm}-thread-${i}:${arm}-goal-${i}`; if (isCanaryAssignment(rollout, key) === selected) keys.push(key); } if (keys.length !== count) throw new Error("assignment keys not found"); return keys; }
function observation(selected: boolean): EvaluationObservation { return { success: selected, qualityScore: selected ? 0.9 : 0.7, costUsd: 0, costMeasured: true, latencyMs: 10, toolFailures: 0, policyViolations: 0, safetyViolations: 0 }; }
function profile(id: string): AgentProfile { return { id, name: id, role: "dev", capabilities: [], defaultProvider: "mock", defaultModel: "mock", defaultPolicy: {} }; }
function agent(workspaceId: string, profileId: string): WorkspaceAgent { return { id: `${workspaceId}-${profileId}`, workspaceId, profileId, roleInWorkspace: "dev", agentDir: `agents/${profileId}`, status: "idle" }; }
async function writeOrigin(root: string, release: { id: string; version: string; contentHash: string }, content: string): Promise<void> { const evolution = path.join(root, ".autoagent", "evolution"); const artifactRef = path.join("artifacts", release.contentHash, "artifact.txt"); await mkdir(path.dirname(path.join(evolution, artifactRef)), { recursive: true }); await writeFile(path.join(evolution, artifactRef), content, "utf8"); await mkdir(path.join(evolution, "releases", release.id), { recursive: true }); await writeFile(path.join(evolution, "releases", release.id, "manifest.json"), JSON.stringify({ schemaVersion: 1, release, stage: "production", candidateId: "candidate-a", candidateHash: release.contentHash, candidateKind: "memory", target: "practice.memory.briefing", artifactRef, evaluationId: "evaluation-a", scope: { workspaceId: "workspace-a", ownerLevel: "project" }, promotionId: "promotion-a", runtimeActive: true, validationPassed: true, validationChecks: [{ name: "memory_safety", passed: true, message: "safe" }] }), "utf8"); }
