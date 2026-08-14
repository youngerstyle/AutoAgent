import type { EvolutionSourceRef } from "../../shared/contracts/evolution.js";
import type { Workspace } from "../../shared/types.js";
import { AgentStore } from "../agent-engine/agent-store.js";
import { AgentTraceStore } from "../agent-engine/trace-store.js";
import { listWorkspaceAgents } from "../agents/roster.js";
import { ExperienceStore } from "./experience-store.js";
import { MemoryLifecycleStore } from "./memory-lifecycle-store.js";

export interface MemoryUsageReconcileResult {
  inspectedEpisodes: number;
  correlatedEpisodes: number;
  recordedUsages: number;
}

export class MemoryUsageReconciler {
  constructor(private readonly workspace: Workspace) {}

  async reconcile(): Promise<MemoryUsageReconcileResult> {
    const episodes = await new ExperienceStore(this.workspace.id, this.workspace.rootPath).listEpisodes();
    const agents = await listWorkspaceAgents(this.workspace);
    const aggregates = new Map(await Promise.all(agents.map(async (agent) => [agent.id, await new AgentStore(this.workspace.rootPath, agent.id).read()] as const)));
    const lifecycle = new MemoryLifecycleStore(this.workspace.id, this.workspace.rootPath);
    let correlatedEpisodes = 0;
    let recordedUsages = 0;
    for (const episode of episodes) {
      const aggregate = aggregates.get(episode.agentId);
      const goal = aggregate?.goals.find((item) => item.spec.id === episode.goalId);
      if (!goal) continue;
      const traces = await new AgentTraceStore(this.workspace.rootPath, episode.agentId).list(goal.spec.threadId);
      const releases = new Map<string, { releaseId: string; traceId: string }>();
      for (const trace of traces) {
        if (trace.goalId !== episode.goalId || trace.kind !== "context" || !isRecord(trace.data) || !Array.isArray(trace.data.evolutionMemories)) continue;
        for (const item of trace.data.evolutionMemories) {
          if (!isRecord(item) || typeof item.releaseId !== "string" || !item.releaseId) continue;
          releases.set(item.releaseId, { releaseId: item.releaseId, traceId: trace.traceId });
        }
      }
      if (!releases.size) continue;
      correlatedEpisodes += 1;
      for (const release of releases.values()) {
        const before = await lifecycle.get(release.releaseId);
        if (!before) continue;
        const traceRef: EvolutionSourceRef = {
          kind: "trace", ref: release.traceId, workspaceId: this.workspace.id,
          taskId: episode.taskId, taskRunId: episode.taskRunId, agentId: episode.agentId,
        };
        const after = await lifecycle.recordUsage({
          commandId: `memory-usage:${episode.episodeId}:${release.releaseId}`, releaseId: release.releaseId,
          episodeId: episode.episodeId, outcome: episode.outcome,
          sourceRefs: uniqueRefs([...episode.sourceRefs, traceRef]), occurredAt: episode.endedAt,
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
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
