import type { ExperienceEpisode, EvolutionSignalTrigger } from "../../shared/contracts/evolution.js";
import { readJson, writeJson } from "../storage/json.js";
import { workspaceEvolutionSignalCursorFile } from "../storage/paths.js";
import { ExperienceStore } from "./experience-store.js";
import { EvolutionSignalStore } from "./evolution-signal-store.js";

interface SignalCursor { lastEpisodeId?: string }

export class EvolutionSignalIngestor {
  constructor(
    private readonly workspaceId: string,
    private readonly workspaceRoot: string,
    private readonly experience = new ExperienceStore(workspaceId, workspaceRoot),
    private readonly signals = new EvolutionSignalStore(workspaceId, workspaceRoot),
  ) {}

  async ingest(limit = 100): Promise<{ inspectedEpisodes: number; enqueuedSignals: number; cursor?: string }> {
    const cursorFile = workspaceEvolutionSignalCursorFile(this.workspaceRoot);
    const cursor = await readJson<SignalCursor>(cursorFile, {});
    const page = await this.experience.readEpisodePage(cursor.lastEpisodeId, limit);
    let enqueuedSignals = 0;
    for (const episode of page.episodes) {
      const trigger = triggerFor(episode);
      await this.signals.enqueue({
        commandId: `episode:${episode.episodeId}:${trigger}`,
        trigger,
        priority: trigger === "user_correction" ? 1 : episode.outcome === "failed" || episode.outcome === "returned" ? 2 : 3,
        profileId: episode.profileId,
        episodeId: episode.episodeId,
        sourceRefs: episode.sourceRefs,
        salience: trigger === "user_correction" ? 1 : episode.outcome === "succeeded" ? 0.25 : 0.75,
        novelty: 0,
        occurredAt: episode.endedAt,
      });
      enqueuedSignals += 1;
    }
    if (page.nextCursor) await writeJson(cursorFile, { lastEpisodeId: page.nextCursor });
    return { inspectedEpisodes: page.episodes.length, enqueuedSignals, ...(page.nextCursor ? { cursor: page.nextCursor } : {}) };
  }
}

function triggerFor(episode: ExperienceEpisode): EvolutionSignalTrigger {
  return episode.sourceRefs.some((ref) => ref.kind === "human_feedback") ? "user_correction" : "terminal_outcome";
}
