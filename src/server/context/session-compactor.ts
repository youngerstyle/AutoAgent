import type { AgentSession, AgentSessionMessage } from "../storage/session-store.js";
import { estimateTokens, truncateToTokenBudget } from "./token-budget.js";
import type { ContextCheckpoint } from "./types.js";

export interface CompactionOptions {
  maxRecentGroups: number;
  triggerTokens: number;
  compactToTokens: number;
  reason?: string;
}

export interface CompactionResult {
  compacted: boolean;
  checkpoint?: ContextCheckpoint;
  recentMessages: AgentSessionMessage[];
}

export function compactSessionIfNeeded(session: AgentSession, options: CompactionOptions): CompactionResult {
  const groups = groupSessionMessages(session.messages);
  const activeText = session.messages.map((message) => message.content).join("\n");
  if (estimateTokens(activeText) <= options.triggerTokens || groups.length <= options.maxRecentGroups) {
    return { compacted: false, recentMessages: session.messages };
  }

  const recentGroups = groups.slice(-options.maxRecentGroups);
  const compactedGroups = groups.slice(0, -options.maxRecentGroups);
  const originalCompactedChars = compactedGroups.flat().reduce((sum, message) => sum + message.content.length, 0);
  const rawCompactedText = compactedGroups.map(formatGroupForSummary).join("\n");
  const compressed = truncateToTokenBudget([
    `压缩了 ${compactedGroups.length} 个历史消息组。`,
    rawCompactedText
  ].join("\n"), options.compactToTokens, "会话摘要");
  const createdAt = new Date().toISOString();
  const checkpointId = `ctx_${hashText(rawCompactedText)}`;
  const replacementSummary: AgentSessionMessage = {
    role: "user",
    content: [
      "历史会话已压缩，后续上下文应使用这条压缩摘要替代更早的原始消息。",
      compressed.text
    ].join("\n"),
    timestamp: createdAt,
    metadata: {
      contextCompaction: true,
      checkpointId,
      originalChars: originalCompactedChars,
      summaryChars: compressed.text.length
    }
  };
  const checkpoint: ContextCheckpoint = {
    id: checkpointId,
    reason: options.reason ?? "threshold",
    summary: compressed.text,
    replacementHistory: [replacementSummary, ...recentGroups.flat()],
    originalChars: originalCompactedChars,
    summaryChars: compressed.text.length,
    createdAt
  };

  return {
    compacted: true,
    checkpoint,
    recentMessages: recentGroups.flat()
  };
}

function groupSessionMessages(messages: AgentSessionMessage[]): AgentSessionMessage[][] {
  const groups: AgentSessionMessage[][] = [];
  for (const message of messages) {
    if (message.role === "user" || groups.length === 0) {
      groups.push([message]);
    } else {
      groups[groups.length - 1].push(message);
    }
  }
  return groups;
}

function formatGroupForSummary(group: AgentSessionMessage[], index: number): string {
  const body = group.map(formatMessageForSummary).join("\n");
  return `消息组 ${index + 1}:\n${body}`;
}

function formatMessageForSummary(message: AgentSessionMessage): string {
  const firstLine = message.content.split(/\r?\n/)[0] ?? "";
  const compactContent = message.content.length > firstLine.length
    ? `${firstLine}...[单条消息摘要，原始长度 ${message.content.length} 字符]`
    : firstLine;
  return `${message.role}: ${compactContent}`;
}

function hashText(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}
