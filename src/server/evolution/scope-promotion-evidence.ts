import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { ActiveReleasePointer, EvolutionScopePromotionProposal, ReleaseTelemetry } from "../../shared/contracts/evolution.js";
import { HttpError } from "../errors.js";
import { globalEvolutionLayerRoot, workspaceEvolutionReleaseFile, workspaceEvolutionTelemetryFile } from "../storage/paths.js";
import { readJson } from "../storage/json.js";
import { EvolutionActivationStore } from "./activation-store.js";
import type { ScopePromotionEvidenceVerification, ScopePromotionEvidenceVerifier } from "./scope-promotion-store.js";

type ProposalInput = Pick<EvolutionScopePromotionProposal, "origin" | "originReleaseRef" | "inheritanceProofRefs" | "effectWindowRefs">;
interface EvidenceRoot { id: string; rootPath: string }
interface OriginManifest { schemaVersion: 1; release: EvolutionScopePromotionProposal["originReleaseRef"]; stage: "canary" | "production"; candidateHash: string; scope: { workspaceId: string; ownerLevel?: string; profileId?: string }; runtimeActive: boolean; validationPassed: boolean }

/** Resolves promotion claims against immutable Release, Activation and Telemetry ledgers. */
export class ScopePromotionEvidenceService {
  constructor(private readonly homeDir: string, private readonly companyId: string, private readonly workspaces: EvidenceRoot[], private readonly now: () => Date = () => new Date()) {}

  verifier(): ScopePromotionEvidenceVerifier { return (input) => this.verify(input); }

  async verify(input: ProposalInput): Promise<ScopePromotionEvidenceVerification> {
    const originRoot = this.resolveOriginRoot(input);
    const manifest = await readJson<OriginManifest | undefined>(workspaceEvolutionReleaseFile(originRoot.rootPath, input.originReleaseRef.id), undefined);
    if (!manifest || manifest.schemaVersion !== 1 || manifest.stage !== "production" || !manifest.runtimeActive || !manifest.validationPassed
      || !sameRef(manifest.release, input.originReleaseRef) || manifest.candidateHash !== input.originReleaseRef.contentHash
      || (manifest.scope.ownerLevel ?? "project") !== input.origin.ownerLevel
      || Boolean(input.origin.workspaceId && manifest.scope.workspaceId !== input.origin.workspaceId)
      || Boolean(input.origin.profileId && manifest.scope.profileId !== input.origin.profileId)
      || !(await isActiveProduction(originRoot.rootPath, input.originReleaseRef))) {
      throw invalidEvidence("Promotion origin must be the active validated immutable production Release");
    }

    const roots = uniqueRoots([originRoot, ...this.workspaces]);
    const proofs = (await Promise.all(roots.map(async (root) => new EvolutionActivationStore(root.rootPath).listProofs()))).flat();
    for (const proofId of input.inheritanceProofRefs) {
      const proof = proofs.find((item) => item.proofId === proofId);
      if (!proof || !sameRef(proof.releaseRef, input.originReleaseRef)
        || Boolean(input.origin.profileId && proof.traceRef?.profileId !== input.origin.profileId)) {
        throw invalidEvidence(`Inheritance proof is missing or does not prove this Release: ${proofId}`);
      }
    }

    const telemetry = (await Promise.all(roots.map((root) => readTelemetry(root.rootPath)))).flat();
    for (const telemetryId of input.effectWindowRefs) {
      const effect = telemetry.find((item) => item.telemetryId === telemetryId);
      if (!effect || effect.decision !== "pass" || effect.candidateHash !== input.originReleaseRef.contentHash) {
        throw invalidEvidence(`Effect window is missing, failed, or belongs to another Candidate: ${telemetryId}`);
      }
    }
    return {
      verifierId: "scope-promotion-evidence/v1",
      verifiedAt: this.now().toISOString(),
      originRootId: originRoot.id,
      inheritanceProofCount: input.inheritanceProofRefs.length,
      effectWindowCount: input.effectWindowRefs.length,
    };
  }

  private resolveOriginRoot(input: ProposalInput): EvidenceRoot {
    if (input.origin.ownerLevel === "agent") {
      if (!input.origin.profileId) throw invalidEvidence("Agent promotion origin is missing profile identity");
      return { id: `agent:${input.origin.profileId}`, rootPath: globalEvolutionLayerRoot(this.homeDir, "agent", input.origin.profileId) };
    }
    const workspace = this.workspaces.find((item) => item.id === input.origin.workspaceId);
    if (!workspace) throw invalidEvidence("Promotion origin workspace is not registered in this private company");
    return workspace;
  }
}

async function isActiveProduction(root: string, release: EvolutionScopePromotionProposal["originReleaseRef"]): Promise<boolean> {
  const directory = path.join(root, ".autoagent", "evolution", "active", "production");
  let files: string[];
  try { files = (await readdir(directory)).filter((file) => file.endsWith(".json")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  for (const file of files) {
    const pointer = await readJson<ActiveReleasePointer | undefined>(path.join(directory, file), undefined);
    if (pointer?.active && pointer.stage === "production" && pointer.release && sameRef(pointer.release, release)) return true;
  }
  return false;
}

async function readTelemetry(root: string): Promise<ReleaseTelemetry[]> {
  let raw: string;
  try { raw = await readFile(workspaceEvolutionTelemetryFile(root), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  return raw.split(/\r?\n/).filter(Boolean).map((line) => (JSON.parse(line) as { telemetry: ReleaseTelemetry }).telemetry);
}
function uniqueRoots(roots: EvidenceRoot[]): EvidenceRoot[] { return [...new Map(roots.map((item) => [path.resolve(item.rootPath).toLowerCase(), item])).values()]; }
function sameRef(left: EvolutionScopePromotionProposal["originReleaseRef"], right: EvolutionScopePromotionProposal["originReleaseRef"]): boolean { return left.id === right.id && left.version === right.version && left.contentHash === right.contentHash; }
function invalidEvidence(message: string): HttpError { return new HttpError(409, message, "INVALID_SCOPE_PROMOTION_EVIDENCE"); }
