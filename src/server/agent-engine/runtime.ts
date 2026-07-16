import type { AgentGoal } from "../../shared/contracts/agent-engine.js";
import type { AgentProfile, WorkspaceAgent } from "../../shared/types.js";
import type { EffectivePolicy } from "../policy/policy.js";

export interface AgentExecutionSliceInput {
  threadId: string;
  turnId?: string;
  triggerMessageId?: string;
  goalId?: string;
  profile: AgentProfile;
  agent: WorkspaceAgent;
  policy: EffectivePolicy;
  provider: AgentProfile["defaultProvider"];
  model: string;
  contextWindowTokens?: number;
}

export interface AgentExecutionSliceResult {
  turnId: string;
  status: "yielded" | "waiting" | "resolution_proposed" | "execution_blocked";
  toolCalls: number;
  goal?: AgentGoal;
  blockReason?: "provider_error" | "provider_protocol" | "usage_limit" | "no_progress";
}

export interface AgentExecutionRuntime {
  runSlice(input: AgentExecutionSliceInput): Promise<AgentExecutionSliceResult>;
  dispose?(): void | Promise<void>;
}
