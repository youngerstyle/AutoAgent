import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { ActiveReleasePointer, CompanyEvolutionTrial, EvolutionArtifactKind, EvolutionScope, VersionedEvolutionRef } from "../../shared/contracts/evolution.js";
import { HttpError } from "../errors.js";
import { readJson, writeJson } from "../storage/json.js";
import { workspaceEvolutionActiveReleaseFile, workspaceEvolutionReleaseFile } from "../storage/paths.js";
import { EvolutionActivationStore } from "./activation-store.js";
import { CompanyTrialStore, companyTrialId } from "./company-trial-store.js";
import { ScopePromotionStore } from "./scope-promotion-store.js";

interface ReleaseManifest {
  schemaVersion: 1; release: VersionedEvolutionRef; stage: "canary" | "production"; candidateId: string; candidateHash: string;
  candidateKind: EvolutionArtifactKind; target: string; artifactRef: string; artifactManifestRef?: string; artifactManifestHash?: string;
  evaluationId: string; telemetryId?: string; scope: EvolutionScope; promotionId: string; runtimeActive: boolean; validationPassed: boolean;
  validationChecks: Array<{ name: string; passed: boolean; message: string }>;
  companyTrialId?: string; scopePromotionProposalId?: string; originReleaseRef?: VersionedEvolutionRef;
}

/** Deploys a reviewed company proposal as a bounded agent-project canary in another project. */
export class CompanyTrialReleaseRegistry {
  constructor(private readonly homeDir: string, private readonly companyId: string, private readonly proposals: ScopePromotionStore, private readonly trials = new CompanyTrialStore(homeDir, companyId), private readonly now: () => Date = () => new Date()) {}

  async deploy(input: { commandId: string; proposalId: string; sourceRoot: string; targetWorkspaceId: string; targetWorkspaceRoot: string; targetProfileId: string; targetAgentId: string; percentage?: number; salt?: string; minimumSamplesPerArm?: number }): Promise<CompanyEvolutionTrial> {
    const proposal = await this.proposals.get(input.proposalId);
    if (proposal.companyId !== this.companyId || proposal.status !== "reviewed" || proposal.targetScope.ownerLevel !== "company") throw new HttpError(409, "Company trial requires a reviewed same-company proposal", "COMPANY_TRIAL_NOT_REVIEWED");
    if (proposal.origin.ownerLevel !== "agent" && proposal.origin.ownerLevel !== "project") throw new HttpError(400, "Company trial origin must already be an Agent or Project Release", "INVALID_COMPANY_TRIAL_ORIGIN");
    if (proposal.origin.workspaceId === input.targetWorkspaceId || (proposal.origin.profileId && proposal.origin.profileId === input.targetProfileId)) throw new HttpError(400, "Company trial must use another project and another Agent", "INVALID_COMPANY_TRIAL");
    const source = await readJson<ReleaseManifest | undefined>(workspaceEvolutionReleaseFile(input.sourceRoot, proposal.originReleaseRef.id), undefined);
    if (!source || source.schemaVersion !== 1 || source.stage !== "production" || !source.runtimeActive || !source.validationPassed || !sameRef(source.release, proposal.originReleaseRef) || source.candidateHash !== proposal.originReleaseRef.contentHash) throw new HttpError(409, "Company trial origin Release is invalid", "INVALID_COMPANY_TRIAL_ORIGIN");
    const trialId = companyTrialId(input.commandId);
    const release: VersionedEvolutionRef = { id: `trial_release_${hash(`${trialId}:${source.release.id}`).slice(0, 32)}`, version: source.release.version, contentHash: source.candidateHash };
    const scope: EvolutionScope = { workspaceId: input.targetWorkspaceId, ownerLevel: "agent_project", profileId: input.targetProfileId, ...(proposal.targetScope.roles ? { roles: proposal.targetScope.roles } : {}), ...(proposal.targetScope.taskTypes ? { taskTypes: proposal.targetScope.taskTypes } : {}) };
    const sourceArtifacts = safeEvolutionPath(input.sourceRoot, path.join("artifacts", source.candidateHash));
    const targetArtifacts = safeEvolutionPath(input.targetWorkspaceRoot, path.join("artifacts", source.candidateHash));
    await mkdir(path.dirname(targetArtifacts), { recursive: true });
    await cp(sourceArtifacts, targetArtifacts, { recursive: true, force: false, errorOnExist: false });
    const artifact = await readFile(safeEvolutionPath(input.targetWorkspaceRoot, source.artifactRef), "utf8");
    if (hash(artifact) !== source.candidateHash) throw new Error("Company trial artifact failed immutable content verification");
    let artifactManifestHash = source.artifactManifestHash;
    if (source.artifactManifestRef) {
      const file = safeEvolutionPath(input.targetWorkspaceRoot, source.artifactManifestRef);
      const scannerManifest = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
      scannerManifest.scope = structuredClone(scope); artifactManifestHash = hash(canonical(scannerManifest)); await writeJson(file, scannerManifest);
    }
    const manifest: ReleaseManifest = { ...structuredClone(source), release, stage: "canary", scope, promotionId: trialId, runtimeActive: true, ...(artifactManifestHash ? { artifactManifestHash } : {}), companyTrialId: trialId, scopePromotionProposalId: proposal.proposalId, originReleaseRef: structuredClone(proposal.originReleaseRef) };
    await writeJson(workspaceEvolutionReleaseFile(input.targetWorkspaceRoot, release.id), manifest);
    const percentage = input.percentage ?? 20; const salt = input.salt?.trim() || hash(trialId).slice(0, 24);
    const pointerFile = workspaceEvolutionActiveReleaseFile(input.targetWorkspaceRoot, "canary", hash(canonical({ target: manifest.target, scope })));
    const current = await readJson<ActiveReleasePointer | undefined>(pointerFile, undefined);
    const pointer: ActiveReleasePointer = current?.active && current.release?.id === release.id ? current : { schemaVersion: 1, target: manifest.target, stage: "canary", scope, generation: (current?.generation ?? 0) + 1, release, ...(current?.release ? { previousRelease: current.release } : {}), promotionId: trialId, active: true, updatedAt: this.now().toISOString(), rollout: { percentage, salt } };
    await writeJson(pointerFile, pointer);
    await new EvolutionActivationStore(input.targetWorkspaceRoot, this.now).recordSharedPointer({ promotionId: trialId, candidateId: manifest.candidateId, assetKind: manifest.candidateKind, target: manifest.target, scope, releaseRef: release, desiredGeneration: pointer.generation, ...(pointer.previousRelease ? { previousRelease: pointer.previousRelease } : {}), stage: "canary" });
    const sourceScope = { ownerLevel: proposal.origin.ownerLevel, ...(proposal.origin.workspaceId ? { workspaceId: proposal.origin.workspaceId } : {}), ...(proposal.origin.profileId ? { profileId: proposal.origin.profileId } : {}) };
    const trial = await this.trials.deploy({ commandId: input.commandId, companyId: this.companyId, proposalId: proposal.proposalId, practiceRef: proposal.practiceRef, originReleaseRef: proposal.originReleaseRef, trialReleaseRef: release, source: sourceScope, target: { workspaceId: input.targetWorkspaceId, profileId: input.targetProfileId, agentId: input.targetAgentId }, assignment: { unit: "runtime_assignment", percentage, salt, minimumSamplesPerArm: input.minimumSamplesPerArm ?? 5 } });
    await this.proposals.attachTrial(`attach:${trial.trialId}`, proposal.proposalId, trial.trialId);
    await this.proposals.transition(`start:${trial.trialId}`, proposal.proposalId, "trial", { type: "system", id: "company-trial-registry/v1" });
    return trial;
  }

  /** Ends the bounded experiment and restores the preceding local canary, if one existed. */
  async close(trialId: string, targetWorkspaceRoot: string): Promise<ActiveReleasePointer> {
    const trial = await this.trials.get(trialId);
    if (!(["evidence_ready", "failed"] as const).includes(trial.status as "evidence_ready" | "failed")) throw new HttpError(409, "Company trial cannot close before its effect window is decided", "COMPANY_TRIAL_CONFLICT");
    const directory = path.join(targetWorkspaceRoot, ".autoagent", "evolution", "active", "canary");
    let files: string[]; try { files = (await readdir(directory)).filter((file) => file.endsWith(".json")); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") files = []; else throw error; }
    for (const file of files) {
      const pointerFile = path.join(directory, file); const current = await readJson<ActiveReleasePointer | undefined>(pointerFile, undefined);
      if (!current || current.promotionId !== trialId || current.release?.id !== trial.trialReleaseRef.id) continue;
      const restoreManifest = current.previousRelease ? await readJson<ReleaseManifest | undefined>(workspaceEvolutionReleaseFile(targetWorkspaceRoot, current.previousRelease.id), undefined) : undefined;
      const pointer: ActiveReleasePointer = { ...current, generation: current.generation + 1, release: current.previousRelease, previousRelease: current.release, promotionId: restoreManifest?.promotionId, active: Boolean(current.previousRelease), updatedAt: this.now().toISOString(), rollout: restoreManifest?.stage === "canary" ? current.rollout : undefined };
      await writeJson(pointerFile, pointer);
      const activations = new EvolutionActivationStore(targetWorkspaceRoot, this.now); await activations.recordPromotionRollback(trialId, `company-trial-close:${trialId}:${pointer.generation}`);
      if (current.previousRelease) await activations.recordRestoration(trialId, current.previousRelease, pointer.generation, `company-trial-restore:${trialId}:${pointer.generation}`);
      return pointer;
    }
    throw new HttpError(404, "Company trial active pointer was not found", "COMPANY_TRIAL_NOT_FOUND");
  }
}

function safeEvolutionPath(root: string, relative: string): string { const base = path.resolve(root, ".autoagent", "evolution"); const resolved = path.resolve(base, relative); if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) throw new Error("Company trial path escaped its evolution root"); return resolved; }
function sameRef(a: VersionedEvolutionRef, b: VersionedEvolutionRef): boolean { return a.id === b.id && a.version === b.version && a.contentHash === b.contentHash; }
function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`; return JSON.stringify(value); }
