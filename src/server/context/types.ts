import type { AgentSessionMessage } from "../storage/session-store.js";

export interface ContextSectionReport {
  name: string;
  originalChars: number;
  injectedChars: number;
  estimatedTokens: number;
  truncated: boolean;
}

export interface ContextCheckpoint {
  id: string;
  reason: string;
  summary: string;
  replacementHistory: AgentSessionMessage[];
  originalChars: number;
  summaryChars: number;
  createdAt: string;
}

export interface ContextSummary {
  text: string;
  updatedAt: string;
}

export interface ContextReport {
  originalSessionChars: number;
  injectedChars: number;
  estimatedTokens: number;
  sections: ContextSectionReport[];
  compaction?: {
    compacted: boolean;
    checkpointId?: string;
    reason?: string;
    originalChars?: number;
    summaryChars?: number;
    replacementHistoryMessages?: number;
  };
}

export interface AgentContextState {
  id: string;
  workspaceAgentId: string;
  taskRunId: string;
  summary?: ContextSummary;
  checkpoints: ContextCheckpoint[];
  lastAssembled?: ContextReport;
  updatedAt: string;
}

export interface WorkspaceAgentMemory {
  workspaceAgentId: string;
  durableFacts: string[];
  projectConventions: string[];
  knownCommands: string[];
  recentLessons: string[];
  updatedAt: string;
}
