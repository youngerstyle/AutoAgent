import { readFile } from "node:fs/promises";
import type { ExperienceEpisode, EvolutionSignalTrigger, ReleaseTelemetry } from "../../shared/contracts/evolution.js";
import type { Workspace } from "../../shared/types.js";
import { readJson, writeJson } from "../storage/json.js";
import { workspaceEvolutionSignalCursorFile, workspaceEvolutionTelemetryFile } from "../storage/paths.js";
import { AgentStore } from "../agent-engine/agent-store.js";
import { listWorkspaceAgents } from "../agents/roster.js";
import { ExperienceStore } from "./experience-store.js";
import { EvolutionSignalStore } from "./evolution-signal-store.js";
import { EvolutionPhaseJobStore } from "./phase-job-store.js";

interface SignalCursor { lastEpisodeId?: string; lastTelemetryId?: string; agentThreadSequences?: Record<string, number> }

export class EvolutionSignalIngestor {
  constructor(
    private readonly workspaceId: string,
    private readonly workspaceRoot: string,
    private readonly experience = new ExperienceStore(workspaceId, workspaceRoot),
    private readonly signals = new EvolutionSignalStore(workspaceId, workspaceRoot),
    private readonly phaseJobs = new EvolutionPhaseJobStore(workspaceId, workspaceRoot),
    private readonly now: () => Date = () => new Date(),
    private readonly workspace?: Workspace,
  ) {}

  async ingest(limit = 100): Promise<{ inspectedEpisodes: number; enqueuedSignals: number; cursor?: string }> {
    const cursorFile = workspaceEvolutionSignalCursorFile(this.workspaceRoot);
    const cursor = await readJson<SignalCursor>(cursorFile, {});
    const page = await this.experience.readEpisodePage(cursor.lastEpisodeId, limit);
    const allEpisodes = await this.experience.listEpisodes();
    let enqueuedSignals = 0;
    for (const episode of page.episodes) {
      const trigger = triggerFor(episode, allEpisodes);
      await this.enqueueWithReflection({ commandId: `episode:${episode.episodeId}:${trigger}`, trigger,
        priority: trigger === "user_correction" ? 1 : trigger === "recovered_failure" || episode.outcome === "failed" || episode.outcome === "returned" ? 2 : 3,
        profileId: episode.profileId, episodeId: episode.episodeId, sourceRefs: episode.sourceRefs,
        salience: trigger === "user_correction" || trigger === "recovered_failure" ? 1 : episode.outcome === "succeeded" ? 0.25 : 0.75, novelty: trigger === "recovered_failure" ? 0.5 : 0, occurredAt: episode.endedAt });
      enqueuedSignals += 1;
    }
    const telemetry = await readTelemetry(workspaceEvolutionTelemetryFile(this.workspaceRoot));
    const telemetryStart = cursor.lastTelemetryId ? telemetry.findIndex((item) => item.telemetryId === cursor.lastTelemetryId) + 1 : 0;
    for (const item of telemetry.slice(Math.max(0, telemetryStart), Math.max(0, telemetryStart) + limit)) {
      const refs = uniqueRefs(item.samples.flatMap((sample) => sample.evidenceRefs));
      await this.enqueueWithReflection({ commandId: `effect:${item.telemetryId}`, trigger: "effect_observation", priority: item.decision === "fail" ? 0 : 3,
        sourceRefs: refs, salience: item.decision === "fail" ? 1 : 0.5, novelty: 0, occurredAt: item.endedAt });
      cursor.lastTelemetryId = item.telemetryId; enqueuedSignals += 1;
    }
    if (this.workspace) {
      const sequences = { ...(cursor.agentThreadSequences ?? {}) };
      for (const agent of await listWorkspaceAgents(this.workspace)) {
        const aggregate = await new AgentStore(this.workspaceRoot, agent.id).read(); let maximum = sequences[agent.id] ?? 0;
        for (const thread of aggregate.threads) for (const item of thread.items.filter((value) => value.kind === "compaction" && value.sequence > (sequences[agent.id] ?? 0)).sort((a, b) => a.sequence - b.sequence)) {
          await this.enqueueWithReflection({ commandId: `compaction:${agent.id}:${thread.threadId}:${item.itemId}`, trigger: "context_compaction", priority: 4,
            profileId: agent.profileId, sourceRefs: [{ kind: "trace", ref: `${thread.threadId}:${item.itemId}`, workspaceId: this.workspaceId, agentId: agent.id, profileId: agent.profileId }],
            salience: 0.2, novelty: 0, occurredAt: item.createdAt });
          maximum = Math.max(maximum, item.sequence); enqueuedSignals += 1;
        }
        sequences[agent.id] = maximum;
      }
      cursor.agentThreadSequences = sequences;
    }
    if (page.nextCursor) cursor.lastEpisodeId = page.nextCursor;
    if (page.nextCursor || cursor.lastTelemetryId || cursor.agentThreadSequences) await writeJson(cursorFile, cursor);
    return { inspectedEpisodes: page.episodes.length, enqueuedSignals, ...(page.nextCursor ? { cursor: page.nextCursor } : {}) };
  }

  private async enqueueWithReflection(input: Parameters<EvolutionSignalStore["enqueue"]>[0]): Promise<void> {
    const signal = await this.signals.enqueue(input); const highSalience = signal.priority <= 2 || signal.salience >= 0.8;
    await this.phaseJobs.enqueue({ commandId: `reflection:${signal.signalId}`, kind: "reflection", priority: signal.priority, profileId: signal.profileId,
      sourceSignalId: signal.signalId, sourceDraftRefs: [], scheduleReason: highSalience ? "high_salience" : "maintenance",
      availableAt: highSalience ? this.now().toISOString() : new Date(this.now().getTime() + 5 * 60_000).toISOString() });
  }
}

function triggerFor(episode: ExperienceEpisode, all: ExperienceEpisode[]): EvolutionSignalTrigger {
  if (episode.sourceRefs.some((ref) => ref.kind === "human_feedback")) return "user_correction";
  if (episode.outcome === "succeeded" && all.some((prior) => prior.profileId === episode.profileId && prior.ticketId === episode.ticketId
    && Date.parse(prior.endedAt) < Date.parse(episode.endedAt) && ["failed", "returned"].includes(prior.outcome))) return "recovered_failure";
  return "terminal_outcome";
}
async function readTelemetry(file: string): Promise<ReleaseTelemetry[]> { try { return (await readFile(file, "utf8")).split(/\r?\n/).filter(Boolean).map((line) => (JSON.parse(line) as { telemetry: ReleaseTelemetry }).telemetry); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; } }
function uniqueRefs<T extends { kind: string; ref: string; workspaceId: string }>(refs: T[]): T[] { return [...new Map(refs.map((ref) => [`${ref.kind}:${ref.workspaceId}:${ref.ref}`, ref])).values()]; }
