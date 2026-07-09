import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createId } from "../../shared/ids.js";
import type { AgentDirectMessage, AgentThreadEvent } from "../../shared/types.js";
import { workspaceAgentThreadFile } from "./paths.js";

type NewAgentThreadEvent = Omit<AgentThreadEvent, "id" | "sequence" | "timestamp"> & {
  id?: string;
  timestamp?: string;
};

const appendQueues = new Map<string, Promise<unknown>>();

export class AgentThreadStore {
  async append(
    workspaceRoot: string,
    workspaceAgentId: string,
    taskRunId: string,
    event: NewAgentThreadEvent
  ): Promise<AgentThreadEvent> {
    const filePath = workspaceAgentThreadFile(workspaceRoot, workspaceAgentId, taskRunId);
    const key = path.resolve(filePath).toLowerCase();
    const previous = appendQueues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.appendNow(filePath, workspaceAgentId, taskRunId, event));
    appendQueues.set(key, next);
    try {
      return await next;
    } finally {
      if (appendQueues.get(key) === next) appendQueues.delete(key);
    }
  }

  private async appendNow(
    filePath: string,
    workspaceAgentId: string,
    taskRunId: string,
    event: NewAgentThreadEvent
  ): Promise<AgentThreadEvent> {
    await mkdir(path.dirname(filePath), { recursive: true });
    const existing = await this.readFile(filePath);
    const fullEvent: AgentThreadEvent = {
      ...event,
      id: event.id ?? createId("ath"),
      workspaceAgentId,
      taskRunId,
      sequence: existing.length + 1,
      timestamp: event.timestamp ?? new Date().toISOString()
    };
    await writeFile(filePath, `${JSON.stringify(fullEvent)}\n`, { encoding: "utf8", flag: "a" });
    return fullEvent;
  }

  async read(workspaceRoot: string, workspaceAgentId: string, taskRunId: string): Promise<AgentThreadEvent[]> {
    const filePath = workspaceAgentThreadFile(workspaceRoot, workspaceAgentId, taskRunId);
    return this.readFile(filePath);
  }

  private async readFile(filePath: string): Promise<AgentThreadEvent[]> {
    try {
      const content = await readFile(filePath, "utf8");
      return content
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as AgentThreadEvent)
        .sort((a, b) => a.sequence - b.sequence);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  projectDirectMessages(events: AgentThreadEvent[]): AgentDirectMessage[] {
    const byHumanEventId = new Map<string, AgentDirectMessage>();
    for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
      if (event.kind === "human_message" && event.source === "human") {
        const message = stringPayload(event.payload, "message");
        if (!message) continue;
        byHumanEventId.set(event.id, {
          id: event.id,
          agentId: event.workspaceAgentId,
          taskId: event.taskId,
          taskRunId: event.taskRunId,
          message,
          createdBy: "human",
          createdAt: event.timestamp
        });
        continue;
      }
      if ((event.kind === "agent_message" || event.kind === "turn_failed") && event.humanMessageId) {
        const direct = byHumanEventId.get(event.humanMessageId);
        if (!direct) continue;
        if (event.kind === "agent_message") {
          direct.handledAt = event.timestamp;
          direct.response = stringPayload(event.payload, "message");
        } else {
          direct.failedAt = event.timestamp;
          direct.error = stringPayload(event.payload, "error") ?? stringPayload(event.payload, "message");
        }
      }
    }
    return [...byHumanEventId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}

function stringPayload(payload: unknown, key: string): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}
