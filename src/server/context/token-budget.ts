import type { ContextSectionReport } from "./types.js";

export interface TruncatedText {
  text: string;
  originalChars: number;
  injectedChars: number;
  estimatedTokens: number;
  truncated: boolean;
}

export interface ContextBudget {
  maxInputTokens: number;
  reservedOutputTokens: number;
  staticPromptTokens: number;
  ticketTokens: number;
  memoryTokens: number;
  sessionSummaryTokens: number;
  recentTurnTokens: number;
  toolObservationTokens: number;
  dynamicContextTokens: number;
  maxRecentSessionGroups: number;
  compactionTriggerRatio: number;
}

export const DEFAULT_CONTEXT_BUDGET: ContextBudget = {
  maxInputTokens: 64_000,
  reservedOutputTokens: 4_000,
  staticPromptTokens: 12_000,
  ticketTokens: 8_000,
  memoryTokens: 4_000,
  sessionSummaryTokens: 8_000,
  recentTurnTokens: 12_000,
  toolObservationTokens: 12_000,
  dynamicContextTokens: 8_000,
  maxRecentSessionGroups: 3,
  compactionTriggerRatio: 0.75
};

const CHARS_PER_TOKEN = 4;

export function estimateTokens(value: string): number {
  return Math.ceil(value.length / CHARS_PER_TOKEN);
}

export function truncateToTokenBudget(value: string, maxTokens: number, label: string): TruncatedText {
  const originalChars = value.length;
  const maxChars = Math.max(0, maxTokens * CHARS_PER_TOKEN);
  if (value.length <= maxChars) {
    return {
      text: value,
      originalChars,
      injectedChars: value.length,
      estimatedTokens: estimateTokens(value),
      truncated: false
    };
  }

  const marker = `\n...[${label}截断，原始长度 ${originalChars} 字符]`;
  const keepChars = Math.max(0, maxChars - marker.length);
  const text = `${value.slice(0, keepChars)}${marker}`;
  return {
    text,
    originalChars,
    injectedChars: text.length,
    estimatedTokens: estimateTokens(text),
    truncated: true
  };
}

export function sectionReport(name: string, value: TruncatedText): ContextSectionReport {
  return {
    name,
    originalChars: value.originalChars,
    injectedChars: value.injectedChars,
    estimatedTokens: value.estimatedTokens,
    truncated: value.truncated
  };
}
