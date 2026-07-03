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
  rawJson: string;
}

export function buildTicketInspectorItems(tickets: Ticket[] | undefined): TicketInspectorItem[] {
  return (tickets ?? []).map((ticket) => {
    const resultView = summarizeTicketSummary(ticket);
    return {
      id: ticket.id,
      title: `${ticket.targetRole ? roleLabel(ticket.targetRole) : "团队"}：${assignmentLabel(ticket.type)}`,
      status: ticket.status,
      statusLabel: ticketStatusLabel(ticket.status),
      brief: ticket.brief,
      expectedArtifact: ticket.expectedArtifact,
      resultSummary: resultView.summary,
      resultLines: resultView.lines,
      rawJson: JSON.stringify(ticket, null, 2)
    };
  });
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
