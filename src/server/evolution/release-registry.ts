import { createHash } from "node:crypto";
import type { ActiveReleasePointer, EvolutionCandidate, PromotionRecord } from "../../shared/contracts/evolution.js";
import { readJson, writeJson } from "../storage/json.js";
import { workspaceEvolutionActiveReleaseFile, workspaceEvolutionReleaseFile } from "../storage/paths.js";

interface ReleaseManifest {
  schemaVersion: 1;
  release: PromotionRecord["toRelease"];
  stage: PromotionRecord["stage"];
  candidateId: string;
  candidateHash: string;
  candidateKind: EvolutionCandidate["kind"];
  target: string;
  artifactRef: string;
  artifactManifestRef?: string;
  artifactManifestHash?: string;
  evaluationId: string;
  telemetryId?: string;
  scope: PromotionRecord["scope"];
  promotionId: string;
  runtimeActive: boolean;
  validationPassed: boolean;
  validationChecks: NonNullable<EvolutionCandidate["validation"]>["checks"];
}

export class EvolutionReleaseRegistry {
  constructor(private readonly workspaceRoot: string, private readonly now: () => Date = () => new Date()) {}

  async current(stage: "canary" | "production", candidate: EvolutionCandidate): Promise<ActiveReleasePointer | undefined> {
    const file = workspaceEvolutionActiveReleaseFile(this.workspaceRoot, stage, pointerKey(candidate));
    return readJson<ActiveReleasePointer | undefined>(file, undefined);
  }

  async publish(record: PromotionRecord, candidate: EvolutionCandidate): Promise<void> {
    const manifest: ReleaseManifest = {
      schemaVersion: 1, release: record.toRelease, stage: record.stage, candidateId: candidate.candidateId,
      candidateHash: candidate.contentHash, candidateKind: candidate.kind, target: candidate.target, artifactRef: candidate.artifactRef,
      ...(candidate.validation?.artifactManifestRef ? { artifactManifestRef: candidate.validation.artifactManifestRef } : {}),
      ...(candidate.validation?.artifactManifestHash ? { artifactManifestHash: candidate.validation.artifactManifestHash } : {}),
      evaluationId: record.evaluationId, ...(record.telemetryId ? { telemetryId: record.telemetryId } : {}),
      scope: structuredClone(record.scope), promotionId: record.promotionId, runtimeActive: record.stage !== "shadow",
      validationPassed: candidate.validation?.passed === true, validationChecks: structuredClone(candidate.validation?.checks ?? []),
    };
    await writeJson(workspaceEvolutionReleaseFile(this.workspaceRoot, record.toRelease.id), manifest);
    if (record.stage === "shadow") return;
    const current = await this.current(record.stage, candidate);
    const alreadyProjected = current?.active && current.promotionId === record.promotionId && current.release?.id === record.toRelease.id;
    if (!alreadyProjected) {
      const pointer: ActiveReleasePointer = {
        schemaVersion: 1, target: candidate.target, stage: record.stage, scope: structuredClone(candidate.scope),
        generation: (current?.generation ?? 0) + 1, release: record.toRelease,
        ...(current?.release ? { previousRelease: current.release } : {}),
        promotionId: record.promotionId, active: true, updatedAt: this.now().toISOString(),
        ...(record.stage === "canary" && record.rollout ? { rollout: structuredClone(record.rollout) } : {}),
      };
      await writeJson(workspaceEvolutionActiveReleaseFile(this.workspaceRoot, record.stage, pointerKey(candidate)), pointer);
    }
    if (record.stage === "production") {
      const canary = await this.current("canary", candidate);
      if (canary?.active && canary.promotionId === record.sourcePromotionId) {
        await writeJson(workspaceEvolutionActiveReleaseFile(this.workspaceRoot, "canary", pointerKey(candidate)), {
          ...canary, generation: canary.generation + 1, previousRelease: canary.release,
          release: undefined, promotionId: undefined, active: false, updatedAt: this.now().toISOString(),
        } satisfies ActiveReleasePointer);
      }
    }
  }

  async rollback(record: PromotionRecord, candidate: EvolutionCandidate): Promise<void> {
    if (record.stage === "shadow") return;
    const current = await this.current(record.stage, candidate);
    if (!current || current.promotionId !== record.promotionId) return;
    const restore = record.stage === "production" ? record.fromRelease : undefined;
    const pointer: ActiveReleasePointer = {
      schemaVersion: 1, target: candidate.target, stage: record.stage, scope: structuredClone(candidate.scope),
      generation: current.generation + 1, ...(restore ? { release: restore } : {}),
      previousRelease: record.toRelease, active: Boolean(restore), updatedAt: this.now().toISOString(),
    };
    await writeJson(workspaceEvolutionActiveReleaseFile(this.workspaceRoot, record.stage, pointerKey(candidate)), pointer);
  }
}

function pointerKey(candidate: EvolutionCandidate): string {
  return createHash("sha256").update(canonical({ target: candidate.target, scope: candidate.scope }), "utf8").digest("hex");
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
