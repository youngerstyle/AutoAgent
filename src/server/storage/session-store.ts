import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { ProviderUsage } from "../providers/types.js";
import { workspaceAgentSessionsDir } from "./paths.js";
import { readJson, writeJson } from "./json.js";

export interface AgentSessionMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface AgentSession {
  id: string;
  workspaceAgentId: string;
  messages: AgentSessionMessage[];
  usage?: ProviderUsage;
  updatedAt: string;
}

export class SessionStore {
  async read(workspaceRoot: string, workspaceAgentId: string, sessionId: string): Promise<AgentSession> {
    const filePath = this.sessionFile(workspaceRoot, workspaceAgentId, sessionId);
    return readJson<AgentSession>(filePath, {
      id: sessionId,
      workspaceAgentId,
      messages: [],
      updatedAt: new Date().toISOString()
    });
  }

  async appendTurn(
    workspaceRoot: string,
    workspaceAgentId: string,
    sessionId: string,
    turn: {
      user: string;
      assistant: string;
      usage?: ProviderUsage;
      toolResults?: Array<Record<string, unknown>>;
      userMetadata?: Record<string, unknown>;
    }
  ): Promise<AgentSession> {
    const session = await this.read(workspaceRoot, workspaceAgentId, sessionId);
    const timestamp = new Date().toISOString();
    session.messages.push({ role: "user", content: turn.user, timestamp, metadata: turn.userMetadata });
    session.messages.push({ role: "assistant", content: turn.assistant, timestamp, metadata: { usage: turn.usage } });
    for (const toolResult of turn.toolResults ?? []) {
      const compactToolResult = compactToolResultForSession(toolResult);
      session.messages.push({
        role: "tool",
        content: JSON.stringify(compactToolResult),
        timestamp,
        metadata: { tool: toolResult.tool, compacted: JSON.stringify(compactToolResult).length !== JSON.stringify(toolResult).length }
      });
    }
    session.usage = mergeUsage(session.usage, turn.usage);
    session.updatedAt = timestamp;
    await writeJson(this.sessionFile(workspaceRoot, workspaceAgentId, sessionId), session);
    return session;
  }

  async ensureAgentSessionsDir(workspaceRoot: string, workspaceAgentId: string): Promise<string> {
    const dir = workspaceAgentSessionsDir(workspaceRoot, workspaceAgentId);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  private sessionFile(workspaceRoot: string, workspaceAgentId: string, sessionId: string): string {
    return path.join(workspaceAgentSessionsDir(workspaceRoot, workspaceAgentId), `${sessionId}.json`);
  }
}

const SESSION_TOOL_STRING_CHARS = 1_500;

function compactToolResultForSession(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.length <= SESSION_TOOL_STRING_CHARS) return value;
    return `${value.slice(0, SESSION_TOOL_STRING_CHARS)}\n...[session 工具结果摘要，原始长度 ${value.length} 字符；完整结果见 loop trace]`;
  }
  if (Array.isArray(value)) return value.map(compactToolResultForSession);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, compactToolResultForSession(item)]));
  }
  return value;
}

function mergeUsage(current: ProviderUsage | undefined, next: ProviderUsage | undefined): ProviderUsage | undefined {
  if (!current && !next) return undefined;
  return {
    inputTokens: (current?.inputTokens ?? 0) + (next?.inputTokens ?? 0),
    outputTokens: (current?.outputTokens ?? 0) + (next?.outputTokens ?? 0),
    totalTokens: (current?.totalTokens ?? 0) + (next?.totalTokens ?? 0)
  };
}
