import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type {
  EvolutionArtifactKind,
  EvolutionAssetSelectionRecord,
  ExperienceAttribution,
  FailedEvolutionAttemptRef,
} from "../../shared/contracts/evolution.js";
import { workspaceEvolutionAssetSelectionsFile } from "../storage/paths.js";
import type { EvolutionStore } from "./evolution-store.js";
import type { ExperienceStore } from "./experience-store.js";
import type { EvolutionTelemetryStore } from "./telemetry-store.js";

const HIGHER_ASSETS = new Set<EvolutionArtifactKind>(["agent_profile", "workflow", "runtime_config"]);
const ASSET_RANK: Record<EvolutionArtifactKind, number> = {
  memory: 0, prompt: 1, skill: 1, agent_profile: 2, workflow: 2,
  runtime_config: 3, plugin: 4, harness: 4,
};
const queues = new Map<string, Promise<void>>();

export interface AssetSelectionResult {
  inspectedAttributions: number;
  supportedClusters: number;
  selections: EvolutionAssetSelectionRecord[];
}

/**
 * Recommends authoring a higher-risk asset; it never creates a Candidate or
 * changes an active pointer. Escalation requires repeated direct attribution
 * plus authoritative failed telemetry from a less invasive release.
 */
export class EvolutionAssetSelector {
  constructor(
    private readonly workspaceId: string,
    private readonly workspaceRoot: string,
    private readonly experience: Pick<ExperienceStore, "listAttributions">,
    private readonly candidates: Pick<EvolutionStore, "get">,
    private readonly telemetry: Pick<EvolutionTelemetryStore, "get">,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async select(minimumEpisodes = 3): Promise<AssetSelectionResult> {
    if (!Number.isSafeInteger(minimumEpisodes) || minimumEpisodes < 3 || minimumEpisodes > 100) throw new Error("Higher-risk asset selection threshold must be between 3 and 100");
    const attributions = await this.experience.listAttributions();
    const clusters = cluster(attributions.filter((item) => HIGHER_ASSETS.has(item.component as EvolutionArtifactKind) && item.confidence >= 0.8));
    const supported = [...clusters.values()].filter((items) => new Set(items.map((item) => item.episodeId)).size >= minimumEpisodes);
    const selections: EvolutionAssetSelectionRecord[] = [];
    for (const items of supported) selections.push(await this.decide(items));
    return { inspectedAttributions: attributions.length, supportedClusters: supported.length, selections };
  }

  async list(): Promise<EvolutionAssetSelectionRecord[]> {
    return (await readLines<EvolutionAssetSelectionRecord>(workspaceEvolutionAssetSelectionsFile(this.workspaceRoot)))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.selectionId.localeCompare(right.selectionId));
  }

  private async decide(items: ExperienceAttribution[]): Promise<EvolutionAssetSelectionRecord> {
    const representative = items[0]!;
    const selectedKind = representative.component as EvolutionAssetSelectionRecord["selectedKind"];
    if (representative.scope.workspaceId !== this.workspaceId || items.some((item) => item.scope.workspaceId !== this.workspaceId || item.component !== selectedKind)) throw new Error("Asset selection crossed its workspace or asset boundary");
    const episodeIds = [...new Set(items.map((item) => item.episodeId))].sort();
    const attributionIds = items.map((item) => item.attributionId).sort();
    const declared = uniqueAttempts(items.flatMap((item) => item.failedEvolutionAttempts ?? []));
    const verified: FailedEvolutionAttemptRef[] = [];
    for (const attempt of declared) {
      const [observed, candidate] = await Promise.all([this.telemetry.get(attempt.telemetryId), this.candidates.get(attempt.candidateId).catch(() => undefined)]);
      if (!observed || !candidate || observed.decision !== "fail" || observed.candidateId !== attempt.candidateId
        || observed.releaseRef.id !== attempt.releaseRef.id || observed.releaseRef.version !== attempt.releaseRef.version
        || observed.releaseRef.contentHash !== attempt.releaseRef.contentHash || ASSET_RANK[candidate.kind] >= ASSET_RANK[selectedKind]) continue;
      verified.push(structuredClone(attempt));
    }
    const conflicted = items.some((item) => item.counterEvidenceRefs.length > 0);
    const eligible = !conflicted && verified.length > 0;
    const fingerprint = hash(JSON.stringify({ selectedKind, episodeIds, attributionIds, declared }));
    const record: EvolutionAssetSelectionRecord = {
      selectionId: `asset_selection_${fingerprint.slice(0, 32)}`,
      workspaceId: this.workspaceId,
      selectedKind,
      status: eligible ? "eligible_for_authoring" : "insufficient_evidence",
      episodeIds,
      attributionIds,
      verifiedFailedAttempts: verified,
      reason: conflicted
        ? "Counter-evidence exists; no higher-risk asset may be authored."
        : verified.length === 0
          ? "No authoritative failed telemetry from a less invasive evolution release was verified."
          : `Repeated direct ${selectedKind} attribution remains after ${verified.length} verified lower-level release failure(s); authoring may begin, but no Candidate or activation has been created.`,
      createdAt: this.now().toISOString(),
    };
    return this.appendOnce(record);
  }

  private async appendOnce(record: EvolutionAssetSelectionRecord): Promise<EvolutionAssetSelectionRecord> {
    return exclusive(workspaceEvolutionAssetSelectionsFile(this.workspaceRoot), async () => {
      const existing = (await this.list()).find((item) => item.selectionId === record.selectionId);
      if (existing) return existing;
      await mkdir(path.dirname(workspaceEvolutionAssetSelectionsFile(this.workspaceRoot)), { recursive: true });
      await appendFile(workspaceEvolutionAssetSelectionsFile(this.workspaceRoot), `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600, flush: true });
      return structuredClone(record);
    });
  }
}

function cluster(items: ExperienceAttribution[]): Map<string, ExperienceAttribution[]> {
  const values = new Map<string, ExperienceAttribution[]>();
  for (const item of items) {
    const key = `${item.scope.workspaceId}\0${item.component}\0${normalize(item.cause)}`;
    values.set(key, [...(values.get(key) ?? []), item]);
  }
  return values;
}
function uniqueAttempts(items: FailedEvolutionAttemptRef[]): FailedEvolutionAttemptRef[] {
  return [...new Map(items.map((item) => [`${item.telemetryId}:${item.candidateId}:${item.releaseRef.id}:${item.releaseRef.contentHash}`, structuredClone(item)])).values()]
    .sort((left, right) => left.telemetryId.localeCompare(right.telemetryId));
}
function normalize(value: string): string { return value.trim().toLowerCase().replace(/\s+/g, " "); }
function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
async function readLines<T>(file: string): Promise<T[]> {
  try { return (await readFile(file, "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as T); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
function exclusive<T>(file: string, operation: () => Promise<T>): Promise<T> {
  const key = path.resolve(file).toLowerCase();
  const previous = queues.get(key) ?? Promise.resolve();
  const pending = previous.catch(() => undefined).then(operation);
  const settled = pending.then(() => undefined, () => undefined);
  queues.set(key, settled);
  return pending.finally(() => { if (queues.get(key) === settled) queues.delete(key); });
}
