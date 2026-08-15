import { readFile } from "node:fs/promises";
import type { EvolutionCandidate, EvolutionScopePromotionProposal, VersionedEvolutionRef } from "../../shared/contracts/evolution.js";
import { workspaceEvolutionReleaseFile } from "../storage/paths.js";
import { EvolutionStore } from "./evolution-store.js";
import { ScopePromotionStore } from "./scope-promotion-store.js";

interface OriginReleaseManifest {
  schemaVersion: 1;
  release: VersionedEvolutionRef;
  stage: "canary" | "production";
  candidateId: string;
  candidateHash: string;
  scope: EvolutionCandidate["scope"];
  runtimeActive: boolean;
  validationPassed: boolean;
}

export interface ScopePromotionCompilationResult { proposalsInspected: number; candidatesCreated: EvolutionCandidate[] }

/** Re-enters a project scope expansion through the normal Candidate/Evaluation/Release gates. */
export class ScopePromotionCandidateCompiler {
  constructor(
    private readonly workspaceId: string,
    private readonly workspaceRoot: string,
    private readonly proposals: ScopePromotionStore,
    private readonly candidates = new EvolutionStore(workspaceId, workspaceRoot),
  ) {}

  async compileApprovedProjectPromotions(): Promise<ScopePromotionCompilationResult> {
    const proposals = (await this.proposals.list()).filter((proposal) => proposal.status === "approved" && proposal.targetScope.ownerLevel === "project" && proposal.targetScope.workspaceId === this.workspaceId);
    const created: EvolutionCandidate[] = [];
    for (const proposal of proposals) created.push(await this.compile(proposal));
    return { proposalsInspected: proposals.length, candidatesCreated: created };
  }

  private async compile(proposal: EvolutionScopePromotionProposal): Promise<EvolutionCandidate> {
    const manifest = JSON.parse(await readFile(workspaceEvolutionReleaseFile(this.workspaceRoot, proposal.originReleaseRef.id), "utf8")) as OriginReleaseManifest;
    if (manifest.schemaVersion !== 1 || manifest.stage !== "production" || !manifest.runtimeActive || !manifest.validationPassed
      || manifest.release.id !== proposal.originReleaseRef.id || manifest.release.version !== proposal.originReleaseRef.version
      || manifest.release.contentHash !== proposal.originReleaseRef.contentHash || manifest.candidateHash !== proposal.originReleaseRef.contentHash
      || (manifest.scope.ownerLevel ?? "project") !== proposal.origin.ownerLevel
      || manifest.scope.workspaceId !== this.workspaceId || manifest.scope.profileId !== proposal.origin.profileId) throw new Error("Project scope promotion origin Release is invalid");
    const origin = await this.candidates.get(manifest.candidateId);
    if (origin.contentHash !== manifest.candidateHash || origin.kind === "runtime_config") throw new Error("Project scope promotion origin Candidate is invalid");
    return this.candidates.create({
      commandId: `scope-promotion-candidate:${proposal.proposalId}:${origin.contentHash}`,
      kind: origin.kind, target: origin.target,
      title: `Project practice: ${origin.title}`,
      rationale: `Approved scope promotion ${proposal.proposalId} expands a proven agent-project Release to this project. The new immutable Candidate must pass its own validation and evaluation gates.`,
      hypothesis: origin.hypothesis,
      artifactContent: await this.candidates.artifactContent(origin.candidateId),
      sourceRefs: structuredClone(origin.sourceRefs),
      scope: {
        workspaceId: this.workspaceId, ownerLevel: "project",
        ...(proposal.targetScope.roles ? { roles: proposal.targetScope.roles } : {}),
        ...(proposal.targetScope.taskTypes ? { taskTypes: proposal.targetScope.taskTypes } : {}),
        ...(origin.scope.tools ? { tools: origin.scope.tools } : {}),
        ...(origin.scope.providers ? { providers: origin.scope.providers } : {}),
        ...(origin.scope.models ? { models: origin.scope.models } : {}),
      },
      expectedMetrics: structuredClone(origin.expectedMetrics), riskLevel: origin.riskLevel,
      proposedBy: { type: "system", id: "scope-promotion-compiler/v1" }, practiceRef: structuredClone(proposal.practiceRef),
    });
  }
}
