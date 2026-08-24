import { assignmentLabel, roleLabel } from "../shared/labels";
import type { Ticket, TicketStatus } from "../shared/types";

export interface TicketInspectorItem {
  id: string;
  title: string;
  status: TicketStatus;
  statusLabel: string;
  brief: string;
  expectedArtifact: string;
  resultSummary?: string;
  resultLines: string[];
  relationLines: string[];
  executionLines: string[];
  rawJson: string;
}

export function buildTicketInspectorItems(tickets: Ticket[] | undefined): TicketInspectorItem[] {
  const ticketList = tickets ?? [];
  const labelsById = new Map(ticketList.map((ticket) => [ticket.id, ticketReadableName(ticket)]));
  return ticketList.map((ticket) => {
    const resultView = summarizeTicketSummary(ticket);
    return {
      id: ticket.id,
      title: ticketReadableName(ticket),
      status: ticket.status,
      statusLabel: ticketStatusLabel(ticket.status),
      brief: ticket.brief,
      expectedArtifact: ticket.expectedArtifact,
      resultSummary: resultView.summary,
      resultLines: resultView.lines,
      relationLines: ticketRelationLines(ticket, labelsById),
      executionLines: ticketExecutionLines(ticket),
      rawJson: JSON.stringify(ticket, null, 2)
    };
  });
}

function ticketReadableName(ticket: Ticket): string {
  const owner = ticket.targetAgentName ?? (ticket.targetRole ? roleLabel(ticket.targetRole) : "团队");
  return `${owner}：${assignmentLabel(ticket.type)}`;
}

function ticketExecutionLines(ticket: Ticket): string[] {
  const lines: string[] = [];
  if (ticket.targetAgentName && ticket.targetRole) lines.push(`固定成员：${ticket.targetAgentName}（${roleLabel(ticket.targetRole)}）`);
  if (ticket.workstream) lines.push(`工作流：${ticket.workstream}`);
  const execution = ticket.execution;
  if (!execution?.attemptId) return lines;
  lines.push(`Attempt ${ticket.attempt} · ${shortId(execution.attemptId)}`);
  const changed = execution.changedFileCount === undefined ? "" : ` · ${execution.changedFileCount} 个文件`;
  const labels: Record<NonNullable<typeof execution.workspaceStatus>, string> = {
    isolated_active: "隔离执行中，可在重启后继续",
    integrated: `已合入主工作区${changed}`,
    no_changes: "已验证，无文件变更",
    isolated_discarded: `隔离区已清理，未合入${changed}`,
    conflict: "合并冲突，隔离区已保留",
  };
  if (execution.workspaceStatus) lines.push(labels[execution.workspaceStatus]);
  else if (execution.workspaceMode === "shared") lines.push("共享工作区执行");
  return lines;
}

function shortId(value: string): string {
  return value.length > 8 ? value.slice(0, 8) : value;
}

function ticketRelationLines(ticket: Ticket, labelsById: Map<string, string>): string[] {
  const lines: string[] = [];
  if (ticket.parentTicketId) lines.push(`上游：${labelsById.get(ticket.parentTicketId) ?? ticket.parentTicketId}`);
  if (ticket.dependsOnTicketIds?.length) {
    const dependencyLabels = ticket.dependsOnTicketIds.map((id) => labelsById.get(id) ?? id);
    lines.push(`依赖：${dependencyLabels.join("、")}`);
  }
  return lines;
}

function summarizeTicketSummary(ticket: Ticket): { summary?: string; lines: string[] } {
  if (ticket.blocker?.reason) {
    const blockerView = summarizeBlockerReason(ticket.blocker.reason);
    if (blockerView.summary || blockerView.lines.length > 0) return blockerView;
    return { summary: ticket.blocker.reason, lines: [] };
  }
  return summarizeTicketResult(ticket.result);
}

function summarizeTicketResult(result: unknown): { summary?: string; lines: string[] } {
  if (!isRecord(result)) return { lines: [] };
  const plan = Array.isArray(result.plan) ? result.plan : undefined;
  if (plan) {
    const names = plan
      .map((item) => isRecord(item) ? String(item.name ?? item.title ?? "").trim() : "")
      .filter(Boolean);
    return {
      summary: `拆出 ${plan.length} 个子任务`,
      lines: names
    };
  }
  const summary = String(result.summary ?? result.analysis ?? result.status ?? "").trim();
  return {
    summary: summary || undefined,
    lines: []
  };
}

function summarizeBlockerReason(reason: string): { summary?: string; lines: string[] } {
  try {
    const parsed = JSON.parse(reason) as unknown;
    if (!isRecord(parsed)) return { lines: [] };
    const report = isRecord(parsed.report) ? parsed.report : undefined;
    const summary = String(report?.summary ?? parsed.reason ?? parsed.status ?? "").trim();
    const manualTests = report?.required_manual_tests;
    const lines = typeof manualTests === "string" && manualTests.trim() ? [manualTests.trim()] : [];
    return {
      summary: summary || undefined,
      lines
    };
  } catch {
    return { lines: [] };
  }
}

function ticketStatusLabel(status: TicketStatus): string {
  const labels: Record<TicketStatus, string> = {
    pending: "待处理",
    running: "运行中",
    blocked: "受阻",
    completed: "已完成",
    returned: "已打回",
    failed: "失败",
    dead_letter: "死信",
    cancelled: "已取消"
  };
  return labels[status];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
