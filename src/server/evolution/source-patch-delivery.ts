import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { EvolutionCandidate, EvolutionSourcePatchArtifact, PromotionRecord } from "../../shared/contracts/evolution.js";
import type { EvolutionDeliveryProviders, EvolutionProviderAttestation, SourcePatchDeliveryRecord, SourcePatchDeliveryStatus } from "./delivery-providers.js";
import { EvolutionActivationStore } from "./activation-store.js";
import { SourcePatchDeliveryStore } from "./source-delivery-store.js";

export class SourcePatchDeliveryPipeline {
  private readonly store: SourcePatchDeliveryStore;
  constructor(
    private readonly workspaceRoot: string,
    private readonly providers: EvolutionDeliveryProviders,
    private readonly now: () => Date = () => new Date(),
  ) { this.store = new SourcePatchDeliveryStore(workspaceRoot); }

  async deliver(commandId: string, candidate: EvolutionCandidate, promotion: PromotionRecord): Promise<SourcePatchDeliveryRecord> {
    assertEligible(candidate, promotion);
    const artifact = await this.readArtifact(candidate);
    const deliveryId = stableId("delivery", candidate.candidateId, promotion.promotionId, candidate.contentHash);
    const existing = await this.store.get(deliveryId);
    if (existing?.status === "verified") {
      await this.reconcileActivation(existing, candidate, promotion);
      return existing;
    }
    if (existing?.status === "failed" && existing.commandId === commandId) throw Object.assign(new Error(existing.error), { delivery: existing });
    let record: SourcePatchDeliveryRecord = existing ?? {
      deliveryId, commandId, candidateId: candidate.candidateId, promotionId: promotion.promotionId,
      status: "requested", attestations: [], createdAt: this.now().toISOString(), updatedAt: this.now().toISOString(),
    };
    const resumeStatus = record.status === "failed" ? record.lastSuccessfulStatus : record.status;
    if (record.status === "failed" && resumeStatus) record = { ...record, status: resumeStatus };
    try {
      if (!record.preparedChange) {
        const currentRevision = await this.providers.scm.currentRevision(artifact.repositoryId);
        if (currentRevision !== artifact.baseCommit) throw new Error(`SCM base changed: expected ${artifact.baseCommit}, received ${currentRevision}`);
        const prepared = await this.providers.scm.prepareChange({ candidateId: candidate.candidateId, contentHash: candidate.contentHash, artifact });
        if (prepared.baseCommit !== artifact.baseCommit || prepared.repositoryId !== artifact.repositoryId) throw new Error("SCM prepared change does not match the MutationSet base");
        record = await this.advance(commandId, record, "prepared", { preparedChange: prepared });
      }
      const prepared = record.preparedChange!;

      if (rank(record.status) < rank("checks_passed")) {
        const checks = await this.providers.scm.requiredChecks(prepared, artifact.requiredChecks);
        requireAttestations(checks, artifact.requiredChecks, "required checks");
        record = await this.advance(commandId, record, "checks_passed", { attestations: [...record.attestations, ...checks] });
      }

      if (rank(record.status) < rank("reviewed")) {
        const review = await this.providers.scm.review(prepared);
        requirePassed(review, "independent review");
        record = await this.advance(commandId, record, "reviewed", { attestations: [...record.attestations, review] });
      }

      if (rank(record.status) < rank("merged")) {
        const merged = await this.providers.scm.merge(prepared);
        requirePassed(merged.attestation, "merge");
        record = await this.advance(commandId, record, "merged", { sourceCommit: merged.mergeCommit, attestations: [...record.attestations, merged.attestation] });
      }
      const sourceCommit = record.sourceCommit!;

      if (rank(record.status) < rank("built")) {
        const built = await this.providers.build.build({ sourceCommit, candidateRef: candidate.mutationSet!.candidateRef });
        requirePassed(built.attestation, "build");
        record = await this.advance(commandId, record, "built", { buildArtifactRef: built.artifactRef, attestations: [...record.attestations, built.attestation] });
      }

      if (rank(record.status) < rank("canary_deployed")) {
        const previousDeployment = await this.providers.deployment.currentProduction();
        const deployed = await this.providers.deployment.deployCanary({ artifactRef: record.buildArtifactRef!, ...(previousDeployment ? { previousDeployment } : {}) });
        requirePassed(deployed.attestation, "canary deployment");
        record = await this.advance(commandId, record, "canary_deployed", { deploymentRef: deployed.deploymentRef, ...(previousDeployment ? { previousDeployment } : {}), attestations: [...record.attestations, deployed.attestation] });
      }

      if (rank(record.status) < rank("production_deployed")) {
        const production = await this.providers.deployment.promoteProduction(record.deploymentRef!);
        requirePassed(production, "production promotion");
        record = await this.advance(commandId, record, "production_deployed", { attestations: [...record.attestations, production] });
      }

      const actual = await this.providers.deployment.actualRevision(record.deploymentRef!);
      requirePassed(actual.attestation, "runtime revision observation");
      if (actual.sourceCommit !== sourceCommit) throw new Error(`Deployment source mismatch: expected ${sourceCommit}, received ${actual.sourceCommit}`);
      record = await this.advance(commandId, record, "verified", { attestations: [...record.attestations, actual.attestation] });
      await this.reconcileActivation(record, candidate, promotion, actual.runtimeSnapshotHash);
      return record;
    } catch (error) {
      const failed = await this.advance(commandId, record, "failed", {
        lastSuccessfulStatus: record.status === "failed" ? record.lastSuccessfulStatus : record.status as Exclude<SourcePatchDeliveryStatus, "failed">,
        error: error instanceof Error ? error.message : String(error),
      });
      throw Object.assign(new Error(failed.error), { delivery: failed });
    }
  }

  async rollback(commandId: string, deliveryId: string): Promise<SourcePatchDeliveryRecord> {
    const current = await this.store.get(deliveryId);
    if (!current) throw new Error("Source Patch delivery not found");
    if (current.status === "rolled_back") return current;
    if (!current.previousDeployment) throw new Error("Source Patch delivery has no previous deployment to restore");
    const attestation = await this.providers.deployment.rollback(current.previousDeployment);
    requirePassed(attestation, "deployment rollback");
    const actual = await this.providers.deployment.actualRevision(current.previousDeployment);
    requirePassed(actual.attestation, "rollback runtime revision observation");
    const record = await this.advance(commandId, current, "rolled_back", { attestations: [...current.attestations, attestation, actual.attestation] });
    await new EvolutionActivationStore(this.workspaceRoot, this.now).recordPromotionRollback(current.promotionId, `source-delivery-rollback:${deliveryId}`);
    return record;
  }

  private async readArtifact(candidate: EvolutionCandidate): Promise<EvolutionSourcePatchArtifact> {
    const base = path.resolve(this.workspaceRoot, ".autoagent", "evolution");
    const file = path.resolve(base, candidate.artifactRef);
    if (!file.startsWith(`${base}${path.sep}`)) throw new Error("Source Patch artifact escaped evolution storage");
    const content = await readFile(file, "utf8");
    if (hash(content) !== candidate.contentHash) throw new Error("Source Patch artifact hash mismatch");
    return JSON.parse(content) as EvolutionSourcePatchArtifact;
  }

  private advance(commandId: string, current: SourcePatchDeliveryRecord, status: SourcePatchDeliveryStatus, updates: Partial<SourcePatchDeliveryRecord>) {
    const record = { ...current, ...structuredClone(updates), status, updatedAt: this.now().toISOString() };
    if (status !== "failed") { delete record.error; delete record.lastSuccessfulStatus; }
    return this.store.append(`${commandId}:${status}`, record);
  }

  private async reconcileActivation(record: SourcePatchDeliveryRecord, candidate: EvolutionCandidate, promotion: PromotionRecord, knownSnapshotHash?: string): Promise<void> {
    if (!record.deploymentRef || !record.sourceCommit) throw new Error("Verified Source Patch delivery is missing deployment provenance");
    const actual = knownSnapshotHash ? undefined : await this.providers.deployment.actualRevision(record.deploymentRef);
    if (actual) { requirePassed(actual.attestation, "runtime revision reconciliation"); if (actual.sourceCommit !== record.sourceCommit) throw new Error("Runtime revision changed after Source Patch verification"); }
    const activation = new EvolutionActivationStore(this.workspaceRoot, this.now);
    const existing = (await activation.list()).find((item) => item.promotionId === promotion.promotionId);
    const generations = (await activation.list()).filter((item) => item.assetKind === "source_patch" && item.target === candidate.target).map((item) => item.desiredGeneration);
    const generation = existing?.desiredGeneration ?? (generations.length ? Math.max(...generations) + 1 : 1);
    await activation.recordPointerChanged(promotion, candidate, generation, candidate.mutationSet?.rollbackRef);
    await activation.observe({
      assetKind: "source_patch", target: candidate.target, releaseRef: promotion.toRelease,
      desiredGeneration: generation, actualGeneration: generation, runtimeKind: "deployment", runtimeRef: record.deploymentRef.id,
      runtimeSnapshotHash: knownSnapshotHash ?? actual!.runtimeSnapshotHash,
      traceRef: { kind: "evidence", ref: `source-delivery:${record.deliveryId}`, workspaceId: candidate.scope.workspaceId },
    });
  }
}

function assertEligible(candidate: EvolutionCandidate, promotion: PromotionRecord): void {
  if (candidate.kind !== "source_patch" || candidate.riskLevel !== "critical" || candidate.validation?.passed !== true
    || !candidate.validation.checks.every((check) => check.passed) || candidate.mutationSet?.activationBoundary !== "next_deployment") throw new Error("Source Patch Candidate is not validated for delivery");
  if (promotion.candidateId !== candidate.candidateId || promotion.stage !== "production" || promotion.status !== "active"
    || promotion.approvedBy.type !== "human") throw new Error("Source Patch delivery requires an active human-approved production promotion");
}
function requirePassed(attestation: EvolutionProviderAttestation, label: string): void {
  if (!attestation || attestation.status !== "passed" || !attestation.provider || !attestation.subject || !attestation.revision || !attestation.evidenceRef) throw new Error(`${label} attestation did not pass`);
}
function requireAttestations(attestations: EvolutionProviderAttestation[], required: string[], label: string): void {
  if (attestations.length !== required.length) throw new Error(`${label} are incomplete`);
  attestations.forEach((item) => requirePassed(item, label));
  const subjects = new Set(attestations.map((item) => item.subject));
  if (required.some((name) => !subjects.has(name))) throw new Error(`${label} do not cover the declared gates`);
}
function stableId(prefix: string, ...parts: string[]): string { return `${prefix}_${hash(parts.join("\0")).slice(0, 24)}`; }
function rank(status: SourcePatchDeliveryStatus): number {
  return ["requested", "prepared", "checks_passed", "reviewed", "merged", "built", "canary_deployed", "production_deployed", "verified", "rolled_back"].indexOf(status);
}
function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
