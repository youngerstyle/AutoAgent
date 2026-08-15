import type { Workspace } from "../../shared/types.js";
import { projectExperience } from "./experience-projector.js";
import { ExperienceStore } from "./experience-store.js";
import { MemoryUsageReconciler } from "./memory-usage-reconciler.js";
import type { EvolutionObservationPort } from "./observation-port.js";

export interface ExperienceReconcileResult {
  inspectedTickets: number;
  recordedEpisodes: number;
  skippedTickets: number;
  memoryUsagesRecorded?: number;
}

export class ExperienceReconciler {
  constructor(private readonly workspace: Workspace, private readonly observations: EvolutionObservationPort, private readonly now: () => Date = () => new Date()) {}

  async reconcile(): Promise<ExperienceReconcileResult> {
    const experience = new ExperienceStore(this.workspace.id, this.workspace.rootPath);
    const batch = await this.observations.collectEpisodeFacts();
    let recordedEpisodes = 0;
    for (const facts of batch.facts) {
      await experience.record(facts.commandId, projectExperience(facts, this.now));
      recordedEpisodes += 1;
    }
    const memoryUsage = await new MemoryUsageReconciler(this.workspace, this.observations).reconcile();
    return { inspectedTickets: batch.inspectedWorkItems, recordedEpisodes, skippedTickets: batch.skippedWorkItems, memoryUsagesRecorded: memoryUsage.recordedUsages };
  }
}
