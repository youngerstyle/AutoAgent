import { assignmentLabel, displayText, roleLabel } from "../../shared/labels.js";
import type { AutoAgentEvent, LoopDebugEntry, LoopDebugLog, Task, TaskRun, Workspace } from "../../shared/types.js";
import { LoopTraceStore, type LoopTraceRecord } from "../storage/loop-trace-store.js";

export async function buildLoopDebugLog(input: {
  workspace: Workspace;
  task?: Task;
  taskRun?: TaskRun;
  events: AutoAgentEvent[];
}): Promise<LoopDebugLog> {
  const entries = [
    ...input.events.map(flowEventEntry),
    ...await loopTraceEntries(input.workspace, input.task?.id, input.taskRun?.id)
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

async function loopTraceEntries(workspace: Workspace, taskId: string | undefined, taskRunId: string | undefined): Promise<LoopDebugEntry[]> {
  if (!taskId || !taskRunId) return [];
  const records = await new LoopTraceStore().read(workspace.rootPath, taskId, taskRunId);
  return records.map(traceRecordEntry);
}

function traceRecordEntry(record: LoopTraceRecord): LoopDebugEntry {
  return {
    id: record.id,
    kind: record.kind,
    timestamp: record.timestamp,
    sequence: record.sequence,
    actor: record.actor,
    title: record.title,
    content: record.content,
    detail: record.detail ?? detailForTraceRecord(record),
    metadata: {
      agentId: record.agentId,
      ...record.metadata
    }
  };
}

function detailForTraceRecord(record: LoopTraceRecord): string | undefined {
  const contextReport = contextReportFromMetadata(record.metadata);
  if (record.kind === "prompt" && contextReport) {
    const compacted = contextReport.compaction?.compacted ? "，已压缩" : "";
    return `上下文 ${contextReport.injectedChars} 字，原始 session ${contextReport.originalSessionChars} 字，约 ${contextReport.estimatedTokens} tokens${compacted}`;
  }
  if (record.kind !== "tool") return undefined;
  const tool = typeof record.metadata?.tool === "string" ? record.metadata.tool : undefined;
  return tool ? `tool: ${tool}` : undefined;
}

function contextReportFromMetadata(metadata: Record<string, unknown> | undefined): {
  injectedChars: number;
  originalSessionChars: number;
  estimatedTokens: number;
  compaction?: { compacted?: boolean };
} | undefined {
  const report = metadata?.contextReport;
  if (!report || typeof report !== "object") return undefined;
  const record = report as Record<string, unknown>;
  if (typeof record.injectedChars !== "number" || typeof record.originalSessionChars !== "number" || typeof record.estimatedTokens !== "number") {
    return undefined;
  }
  const compaction = record.compaction && typeof record.compaction === "object"
    ? record.compaction as { compacted?: boolean }
    : undefined;
  return {
    injectedChars: record.injectedChars,
    originalSessionChars: record.originalSessionChars,
    estimatedTokens: record.estimatedTokens,
    compaction
  };
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
