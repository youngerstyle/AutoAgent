import { readdir } from "node:fs/promises";
import path from "node:path";
import { assignmentLabel, displayText, roleLabel } from "../../shared/labels.js";
import type { AutoAgentEvent, LoopDebugEntry, LoopDebugLog, Task, TaskRun, Workspace, WorkspaceAgent } from "../../shared/types.js";
import { readJson } from "../storage/json.js";
import { workspaceAgentDir, workspaceAgentFile, workspaceAgentSessionsDir, workspaceAutoAgentDir } from "../storage/paths.js";
import type { AgentSession, AgentSessionMessage } from "../storage/session-store.js";

export async function buildLoopDebugLog(input: {
  workspace: Workspace;
  task?: Task;
  taskRun?: TaskRun;
  events: AutoAgentEvent[];
}): Promise<LoopDebugLog> {
  const entries = [
    ...input.events.map(flowEventEntry),
    ...await agentSessionEntries(input.workspace, input.taskRun?.id)
  ].sort((a, b) => {
    const byTime = a.timestamp.localeCompare(b.timestamp);
    if (byTime !== 0) return byTime;
    return (a.sequence ?? 0) - (b.sequence ?? 0);
  });

  return {
    task: input.task,
    taskRun: input.taskRun,
    entries
  };
}

function flowEventEntry(event: AutoAgentEvent): LoopDebugEntry {
  return {
    id: event.id,
    kind: "flow",
    timestamp: event.timestamp,
    sequence: event.sequence,
    actor: actorForEvent(event),
    title: compactTitle(displayText(event.summary) ?? event.summary),
    content: JSON.stringify(event.payload ?? {}, null, 2),
    detail: event.type,
    metadata: {
      eventType: event.type,
      actorId: event.actorId
    }
  };
}

async function agentSessionEntries(workspace: Workspace, taskRunId: string | undefined): Promise<LoopDebugEntry[]> {
  if (!taskRunId) return [];
  const agentsRoot = path.join(workspaceAutoAgentDir(workspace.rootPath), "agents");
  try {
    const entries = await readdir(agentsRoot, { withFileTypes: true });
    const nested = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
      const agent = await readJson<WorkspaceAgent | undefined>(workspaceAgentFile(workspace.rootPath, entry.name), undefined);
      if (!agent) return [];
      const session = await readJson<AgentSession | undefined>(
        path.join(workspaceAgentSessionsDir(workspace.rootPath, agent.id), `${taskRunId}.json`),
        undefined
      );
      if (!session) return [];
      return session.messages.map((message, index) => sessionMessageEntry(agent, message, index));
    }));
    return nested.flat();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function sessionMessageEntry(agent: WorkspaceAgent, message: AgentSessionMessage, index: number): LoopDebugEntry {
  const actor = roleLabel(agent.roleInWorkspace);
  return {
    id: `${agent.id}-${message.timestamp}-${index}`,
    kind: kindForSessionRole(message.role),
    timestamp: message.timestamp,
    actor,
    title: titleForSessionMessage(message),
    content: message.content,
    detail: detailForSessionMessage(message),
    metadata: {
      agentId: agent.id,
      role: agent.roleInWorkspace,
      ...message.metadata
    }
  };
}

function kindForSessionRole(role: AgentSessionMessage["role"]): LoopDebugEntry["kind"] {
  if (role === "user") return "prompt";
  if (role === "assistant") return "llm";
  return "tool";
}

function titleForSessionMessage(message: AgentSessionMessage): string {
  if (message.role === "user") return "Prompt";
  if (message.role === "assistant") return "LLM 返回";
  return "工具结果";
}

function detailForSessionMessage(message: AgentSessionMessage): string | undefined {
  if (message.role !== "tool") return undefined;
  const tool = typeof message.metadata?.tool === "string" ? message.metadata.tool : undefined;
  return tool ? `tool: ${tool}` : undefined;
}

function actorForEvent(event: AutoAgentEvent): string {
  if (event.type === "task.phase_changed") return "任务阶段";
  if (event.type.startsWith("provider.")) return actorFromSummary(event.summary) || "模型";
  if (event.type.startsWith("tool.")) return "工具";
  const assignment = assignmentTypeFromPayload(event.payload);
  if (assignment) return assignmentLabel(assignment);
  return actorFromSummary(event.summary) || "Flow";
}

function assignmentTypeFromPayload(payload: Record<string, unknown>): Parameters<typeof assignmentLabel>[0] | undefined {
  const assignment = payload.assignment;
  if (!assignment || typeof assignment !== "object") return undefined;
  const type = (assignment as Record<string, unknown>).type;
  return typeof type === "string" ? type as Parameters<typeof assignmentLabel>[0] : undefined;
}

function actorFromSummary(summary: string): string {
  const readable = displayText(summary) ?? summary;
  const match = readable.match(/^(.+?)(?:正在|开始|已完成|执行失败|：|:)/);
  return match?.[1]?.trim() ?? "";
}

function compactTitle(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 120 ? `${normalized.slice(0, 120)}...` : normalized;
}
