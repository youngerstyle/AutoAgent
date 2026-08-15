import type { EvolutionSourceRef } from "../../shared/contracts/evolution.js";
import type { Workspace } from "../../shared/types.js";
import { ExperienceStore } from "./experience-store.js";
import { MemoryLifecycleStore } from "./memory-lifecycle-store.js";
import type { EvolutionObservationPort } from "./observation-port.js";

export interface MemoryUsageReconcileResult {
  inspectedEpisodes: number;
  correlatedEpisodes: number;
  recordedUsages: number;
}

export class MemoryUsageReconciler {
  constructor(private readonly workspace: Workspace, private readonly observations: EvolutionObservationPort) {}

  async reconcile(): Promise<MemoryUsageReconcileResult> {
    const episodes = await new ExperienceStore(this.workspace.id, this.workspace.rootPath).listEpisodes();
    const usages = await this.observations.collectMemoryUsage(episodes);
    const lifecycle = new MemoryLifecycleStore(this.workspace.id, this.workspace.rootPath);
    let correlatedEpisodes = usages.length;
    let recordedUsages = 0;
    for (const usage of usages) {
      for (const loaded of usage.loadedMemories) {
        const before = await lifecycle.get(loaded.releaseId);
        if (!before) continue;
        const after = await lifecycle.recordUsage({
          commandId: `memory-usage:${usage.episodeId}:${loaded.releaseId}`, releaseId: loaded.releaseId,
          episodeId: usage.episodeId, outcome: usage.outcome,
          sourceRefs: uniqueRefs([...usage.sourceRefs, loaded.traceRef]), occurredAt: usage.occurredAt,
        });
        if (after.useCount > before.useCount) recordedUsages += 1;
      }
    }
    return { inspectedEpisodes: episodes.length, correlatedEpisodes, recordedUsages };
  }
}

function uniqueRefs(refs: EvolutionSourceRef[]): EvolutionSourceRef[] {
  return [...new Map(refs.map((ref) => [`${ref.kind}:${ref.workspaceId}:${ref.ref}`, structuredClone(ref)])).values()];
}
