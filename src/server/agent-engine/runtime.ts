import type { AgentGoal } from "../../shared/contracts/agent-engine.js";
import type { AgentProfile, ModelThinkingLevel, WorkspaceAgent } from "../../shared/types.js";
import type { EffectivePolicy } from "../policy/policy.js";

export interface AgentExecutionSliceInput {
  threadId: string;
  turnId?: string;
  triggerMessageId?: string;
  goalId?: string;
  attemptId?: string;
  profile: AgentProfile;
  agent: WorkspaceAgent;
  policy: EffectivePolicy;
  provider: AgentProfile["defaultProvider"];
  model: string;
  contextWindowTokens?: number;
  supportsReasoning?: boolean;
  supportsImages?: boolean;
  thinkingLevel?: ModelThinkingLevel;
  taskType?: string;
  objective?: string;
  constraints?: string[];
}

export interface AgentExecutionSliceResult {
  turnId: string;
  status: "yielded" | "waiting" | "resolution_proposed" | "execution_blocked";
  toolCalls: number;
  goal?: AgentGoal;
  blockReason?: "provider_error" | "provider_protocol" | "usage_limit" | "no_progress";
  blockedMessage?: string;
  providerRetryable?: boolean;
}

export interface AgentExecutionRuntime {
  pendingHumanTurn(threadId: string): Promise<{ turnId: string; triggerMessageId: string } | undefined>;
  runSlice(input: AgentExecutionSliceInput): Promise<AgentExecutionSliceResult>;
  releaseGoalResources?(input: {
    agentId: string;
    threadId: string;
    goalId: string;
    attemptId?: string;
  }): Promise<void>;
  dispose?(): void | Promise<void>;
}
