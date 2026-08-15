import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { EvolutionSourceRef } from "../../shared/contracts/evolution.js";
import { EMPTY_RUNTIME_EVOLUTION_PROJECTION, type RuntimeEvolutionProjection } from "../../shared/contracts/evolution-runtime.js";
import type { AgentProfile, WorkspaceAgent } from "../../shared/types.js";
import type { AgentToolRuntime } from "./tool-runtime.js";

export interface EvolutionToolBinding {
  agentId: string;
  threadId: string;
  goalId?: string;
  attemptId?: string;
  turnId?: string;
}

export interface AgentEvolutionRuntimePort {
  fingerprint(profileId: string): Promise<string>;
  project(input: {
    workspaceId: string;
    profile: AgentProfile;
    agent: WorkspaceAgent;
    assignmentKey: string;
    taskType?: string;
    tools: string[];
  }): Promise<RuntimeEvolutionProjection>;
  agentTools(input: { enabled: boolean; agentId: string }): ToolDefinition[];
  mountTools(input: {
    baseTools: ToolDefinition[];
    projection: RuntimeEvolutionProjection;
    toolRuntime: AgentToolRuntime;
    binding: EvolutionToolBinding;
  }): { tools: ToolDefinition[]; evolutionToolNames: string[] };
  observe(input: {
    projection: RuntimeEvolutionProjection;
    turnId: string;
    sessionId: string;
    traceRef: EvolutionSourceRef;
  }): Promise<void>;
}

/** Disabling Evol leaves the Agent Loop operational and changes no core state. */
export const DISABLED_AGENT_EVOLUTION_RUNTIME: AgentEvolutionRuntimePort = {
  async fingerprint() { return "evolution-disabled"; },
  async project() { return structuredClone(EMPTY_RUNTIME_EVOLUTION_PROJECTION); },
  agentTools() { return []; },
  mountTools({ baseTools }) { return { tools: baseTools, evolutionToolNames: [] }; },
  async observe() {},
};
