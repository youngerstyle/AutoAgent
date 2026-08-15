import type { EvolutionSourceRef } from "../../shared/contracts/evolution.js";
import type { RuntimeEvolutionWorkflow } from "../../shared/contracts/evolution-runtime.js";
import type { PlanDefinition, PlanPolicyRef } from "../../shared/contracts/ticket-engine.js";
import type { AgentProfile, WorkspaceAgent } from "../../shared/types.js";
import { DISABLED_AGENT_EVOLUTION_RUNTIME, type AgentEvolutionRuntimePort } from "../agent-engine/evolution-runtime-port.js";

export interface EvolutionPlatformPort {
  readonly agentRuntime: AgentEvolutionRuntimePort;
  resolveWorkflow(input: { target: string; policyRef: PlanPolicyRef; profileId?: string }): Promise<RuntimeEvolutionWorkflow | undefined>;
  workflowSnapshotHash(definition: PlanDefinition): string;
  observeWorkflow(input: { workflow: RuntimeEvolutionWorkflow; runtimeRef: string; snapshotHash: string; traceRef: EvolutionSourceRef }): Promise<void>;
  resolveAgentProfile(input: { profile: AgentProfile; agent: WorkspaceAgent; assignmentKey: string; taskType?: string; tools: string[] }): Promise<AgentProfile | undefined>;
}

export const DISABLED_EVOLUTION_PLATFORM_PORT: EvolutionPlatformPort = {
  agentRuntime: DISABLED_AGENT_EVOLUTION_RUNTIME,
  async resolveWorkflow() { return undefined; },
  workflowSnapshotHash(definition) { return createHash("sha256").update(canonical(definition), "utf8").digest("hex"); },
  async observeWorkflow() {},
  async resolveAgentProfile() { return undefined; },
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
import { createHash } from "node:crypto";
