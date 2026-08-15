import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { ExperienceAttribution, ExperienceEpisode } from "../../shared/contracts/evolution.js";
import { HttpError } from "../errors.js";
import { workspaceEvolutionAttributionsFile, workspaceEvolutionEpisodesFile } from "../storage/paths.js";
import type { ProjectedExperience } from "./experience-projector.js";

const queues = new Map<string, Promise<void>>();

interface StoredEpisode {
  commandId: string;
  episode: ExperienceEpisode;
}

export class ExperienceStore {
  constructor(private readonly workspaceId: string, private readonly workspaceRoot: string) {}

  async record(commandId: string, projected: ProjectedExperience): Promise<ProjectedExperience> {
    if (!commandId.trim()) throw new HttpError(400, "Experience commandId is required", "INVALID_EXPERIENCE_COMMAND");
    if (projected.episode.workspaceId !== this.workspaceId || projected.attributions.some((item) => item.scope.workspaceId !== this.workspaceId)) {
      throw new HttpError(400, "Experience crossed its workspace boundary", "INVALID_EXPERIENCE_COMMAND");
    }
    return this.exclusive(async () => {
      const stored = await readJsonLines<StoredEpisode>(workspaceEvolutionEpisodesFile(this.workspaceRoot));
      const replay = stored.find((item) => item.commandId === commandId);
      if (replay) {
        if (JSON.stringify(replay.episode) !== JSON.stringify(projected.episode)) throw new HttpError(409, "Experience command idempotency conflict", "EXPERIENCE_CONFLICT");
        const attributions = (await this.listAttributions()).filter((item) => item.episodeId === replay.episode.episodeId);
        return { episode: replay.episode, attributions };
      }
      const sameEpisode = stored.find((item) => item.episode.episodeId === projected.episode.episodeId);
      if (sameEpisode && JSON.stringify(sameEpisode.episode) !== JSON.stringify(projected.episode)) throw new Error("Experience episode identity conflict");
      await appendLine(workspaceEvolutionEpisodesFile(this.workspaceRoot), { commandId, episode: projected.episode });
      for (const attribution of projected.attributions) await appendLine(workspaceEvolutionAttributionsFile(this.workspaceRoot), attribution);
      return structuredClone(projected);
    });
  }

  async listEpisodes(): Promise<ExperienceEpisode[]> {
    return (await readJsonLines<StoredEpisode>(workspaceEvolutionEpisodesFile(this.workspaceRoot)))
      .map((item) => item.episode)
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt) || left.episodeId.localeCompare(right.episodeId));
  }

  async readEpisodePage(afterEpisodeId?: string, limit = 100): Promise<{ episodes: ExperienceEpisode[]; nextCursor?: string }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new HttpError(400, "Experience page limit is invalid", "INVALID_EXPERIENCE_PAGE");
    const stored = await readJsonLines<StoredEpisode>(workspaceEvolutionEpisodesFile(this.workspaceRoot));
    const start = afterEpisodeId ? stored.findIndex((item) => item.episode.episodeId === afterEpisodeId) + 1 : 0;
    const safeStart = afterEpisodeId && start === 0 ? 0 : start;
    const episodes = stored.slice(safeStart, safeStart + limit).map((item) => structuredClone(item.episode));
    return { episodes, ...(episodes.length ? { nextCursor: episodes.at(-1)!.episodeId } : {}) };
  }

  async listAttributions(): Promise<ExperienceAttribution[]> {
    return (await readJsonLines<ExperienceAttribution>(workspaceEvolutionAttributionsFile(this.workspaceRoot)))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.attributionId.localeCompare(right.attributionId));
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const key = workspaceEvolutionEpisodesFile(this.workspaceRoot).toLowerCase();
    const previous = queues.get(key) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(operation);
    const settled = pending.then(() => undefined, () => undefined);
    queues.set(key, settled);
    return pending.finally(() => { if (queues.get(key) === settled) queues.delete(key); });
  }
}

async function appendLine(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600, flush: true });
}

async function readJsonLines<T>(file: string): Promise<T[]> {
  let content: string;
  try { content = await readFile(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  return content.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line) as T; }
    catch (error) { throw new Error(`Experience ledger is corrupt at line ${index + 1}: ${(error as Error).message}`); }
  });
}
