import { createHash } from "node:crypto";
import { cp, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { ActiveReleasePointer, EvolutionArtifactKind, EvolutionScope, EvolutionScopePromotionProposal, VersionedEvolutionRef } from "../../shared/contracts/evolution.js";
import { HttpError } from "../errors.js";
import { readJson, writeJson } from "../storage/json.js";
import { globalEvolutionLayerRoot, workspaceEvolutionActiveReleaseFile, workspaceEvolutionReleaseFile } from "../storage/paths.js";
import { ScopePromotionStore } from "./scope-promotion-store.js";

interface ReleaseManifest {
  schemaVersion: 1;
  release: VersionedEvolutionRef;
  stage: "canary" | "production";
  candidateId: string;
  candidateHash: string;
  candidateKind: EvolutionArtifactKind;
  target: string;
  artifactRef: string;
  artifactManifestRef?: string;
  artifactManifestHash?: string;
  evaluationId: string;
  telemetryId?: string;
  scope: EvolutionScope;
  promotionId: string;
  runtimeActive: boolean;
  validationPassed: boolean;
  validationChecks: Array<{ name: string; passed: boolean; message: string }>;
  scopePromotionProposalId?: string;
  originReleaseRef?: VersionedEvolutionRef;
}

export interface SharedReleasePublication { layerRoot: string; manifest: ReleaseManifest; pointer: ActiveReleasePointer }

/** Publishes an approved immutable local Release into a private Agent or Company layer. */
export class SharedEvolutionReleaseRegistry {
  constructor(
    private readonly homeDir: string,
    private readonly companyId: string,
    private readonly proposals = new ScopePromotionStore(homeDir, companyId),
    private readonly now: () => Date = () => new Date(),
  ) {}

  async publishApproved(proposalId: string, sourceWorkspaceRoot: string): Promise<SharedReleasePublication> {
    const proposal = await this.proposals.get(proposalId);
    if (proposal.companyId !== this.companyId || proposal.status !== "approved") throw new HttpError(409, "Only an approved same-company scope promotion can publish a shared release", "SCOPE_PROMOTION_NOT_APPROVED");
    if (!(["agent", "company"] as const).includes(proposal.targetScope.ownerLevel as "agent" | "company")) throw new HttpError(400, "Only Agent and Company scopes use the shared release registry", "INVALID_SHARED_RELEASE_SCOPE");
    const ownerLevel = proposal.targetScope.ownerLevel as "agent" | "company";
    const ownerId = ownerLevel === "agent" ? proposal.targetScope.profileId! : this.companyId;
    if (!ownerId) throw new HttpError(400, "Shared release owner is missing", "INVALID_SHARED_RELEASE_SCOPE");
    const source = await readJson<ReleaseManifest | undefined>(workspaceEvolutionReleaseFile(sourceWorkspaceRoot, proposal.originReleaseRef.id), undefined);
    verifySource(source, proposal);
    const scope: EvolutionScope = {
      workspaceId: proposal.origin.workspaceId ?? source!.scope.workspaceId,
      ownerLevel,
      ...(ownerLevel === "agent" ? { profileId: ownerId } : {}),
      ...(proposal.targetScope.roles ? { roles: proposal.targetScope.roles } : {}),
      ...(proposal.targetScope.taskTypes ? { taskTypes: proposal.targetScope.taskTypes } : {}),
    };
    const layerRoot = globalEvolutionLayerRoot(this.homeDir, ownerLevel, ownerId);
    const sourceArtifacts = safeEvolutionPath(sourceWorkspaceRoot, path.join("artifacts", source!.candidateHash));
    const destinationArtifacts = safeEvolutionPath(layerRoot, path.join("artifacts", source!.candidateHash));
    await mkdir(path.dirname(destinationArtifacts), { recursive: true });
    await cp(sourceArtifacts, destinationArtifacts, { recursive: true, force: false, errorOnExist: false });
    const artifact = await readFile(safeEvolutionPath(layerRoot, source!.artifactRef), "utf8");
    if (hash(artifact) !== source!.candidateHash) throw new Error("Shared release artifact failed immutable content verification");
    let artifactManifestHash = source!.artifactManifestHash;
    if (source!.artifactManifestRef) {
      const manifestFile = safeEvolutionPath(layerRoot, source!.artifactManifestRef);
      const scannerManifest = JSON.parse(await readFile(manifestFile, "utf8")) as Record<string, unknown>;
      scannerManifest.scope = structuredClone(scope);
      artifactManifestHash = hash(canonical(scannerManifest));
      await writeJson(manifestFile, scannerManifest);
    }
    const release: VersionedEvolutionRef = { id: `shared_${hash(`${proposal.proposalId}:${proposal.originReleaseRef.id}`).slice(0, 32)}`, version: proposal.originReleaseRef.version, contentHash: source!.candidateHash };
    const manifest: ReleaseManifest = {
      ...structuredClone(source!), release, stage: "production", scope, promotionId: proposal.proposalId,
      runtimeActive: true, ...(artifactManifestHash ? { artifactManifestHash } : {}),
      scopePromotionProposalId: proposal.proposalId, originReleaseRef: structuredClone(proposal.originReleaseRef),
    };
    await writeJson(workspaceEvolutionReleaseFile(layerRoot, release.id), manifest);
    const pointerFile = workspaceEvolutionActiveReleaseFile(layerRoot, "production", hash(canonical({ target: manifest.target, scope })));
    const current = await readJson<ActiveReleasePointer | undefined>(pointerFile, undefined);
    const alreadyCurrent = current?.active && current.release?.id === release.id && current.release.contentHash === release.contentHash;
    const pointer: ActiveReleasePointer = alreadyCurrent ? current : {
      schemaVersion: 1, target: manifest.target, stage: "production", scope, generation: (current?.generation ?? 0) + 1,
      release, ...(current?.release ? { previousRelease: current.release } : {}), promotionId: proposal.proposalId,
      active: true, updatedAt: this.now().toISOString(),
    };
    if (!alreadyCurrent) await writeJson(pointerFile, pointer);
    return { layerRoot, manifest, pointer };
  }
}

function verifySource(source: ReleaseManifest | undefined, proposal: EvolutionScopePromotionProposal): asserts source is ReleaseManifest {
  if (!source || source.schemaVersion !== 1 || source.stage !== "production" || !source.runtimeActive || !source.validationPassed
    || source.release.id !== proposal.originReleaseRef.id || source.release.version !== proposal.originReleaseRef.version
    || source.release.contentHash !== proposal.originReleaseRef.contentHash || source.candidateHash !== proposal.originReleaseRef.contentHash) {
    throw new HttpError(409, "Scope promotion origin Release is missing or not an active validated immutable release", "INVALID_SCOPE_PROMOTION_ORIGIN");
  }
}
function safeEvolutionPath(root: string, relative: string): string {
  const evolutionRoot = path.resolve(root, ".autoagent", "evolution"); const resolved = path.resolve(evolutionRoot, relative);
  if (resolved !== evolutionRoot && !resolved.startsWith(`${evolutionRoot}${path.sep}`)) throw new Error("Shared release path escaped its evolution root");
  return resolved;
}
function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`; return JSON.stringify(value); }
