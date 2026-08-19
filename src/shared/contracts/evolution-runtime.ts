import type { EvolutionOwnerLevel, PluginArtifactManifest } from "./evolution.js";
import type { AgentProfile } from "../types.js";
import type { PlanDefinition } from "./ticket-engine.js";

export interface RuntimeEvolutionSkill {
  name: string; directory: string; releaseId: string; releaseVersion: string; contentHash: string;
  generation: number; stage: "canary" | "production"; ownerLevel: EvolutionOwnerLevel;
}

export interface MemorySelectionExplanation {
  policyVersion: "memory-selection/v1";
  score: number;
  components: { scopeSpecificity: number; effectiveness: number; evidenceConfidence: number; freshness: number; exploration: number };
  evidence: { useCount: number; successfulEpisodeCount: number; failedEpisodeCount: number; effectiveAt: string };
}

export interface RuntimeEvolutionMemory {
  target: string; content: string; releaseId: string; releaseVersion: string; contentHash: string;
  generation: number; stage: "canary" | "production"; ownerLevel: EvolutionOwnerLevel;
  sourceWorkspaceId?: string; layer?: "workspace" | "organization"; selection: MemorySelectionExplanation;
}

export interface RuntimeEvolutionExtension {
  name: string; kind: "plugin" | "harness"; directory: string; entrypoint: string;
  releaseId: string; releaseVersion: string; contentHash: string; generation: number;
  stage: "canary" | "production"; ownerLevel: EvolutionOwnerLevel; manifest: PluginArtifactManifest;
}

export interface RuntimeEvolutionPrompt {
  target: string; content: string; releaseId: string; releaseVersion: string; contentHash: string;
  generation: number; stage: "canary" | "production"; ownerLevel: EvolutionOwnerLevel;
}

export interface RuntimeEvolutionAgentProfile {
  target: string; profile: AgentProfile; releaseId: string; releaseVersion: string; contentHash: string;
  generation: number; stage: "canary" | "production"; ownerLevel: EvolutionOwnerLevel;
}

export interface OrganizationMemorySource { workspaceId: string; workspaceRoot: string; organizationId: string }
export interface SharedEvolutionLayerSource { layerRoot: string; ownerLevel: "agent" | "company"; ownerId: string; companyId: string }

export interface RuntimeEvolutionWorkflow {
  target: string; definition: PlanDefinition; releaseId: string; releaseVersion: string; contentHash: string;
  generation: number; stage: "trial" | "canary" | "production"; ownerLevel: EvolutionOwnerLevel; sourceRoot: string;
}

export interface RuntimeEvolutionWorkflowResolution {
  workflow?: RuntimeEvolutionWorkflow;
  canaryAssignment?: { target: string; promotionId: string; releaseId: string; selected: boolean };
}

export interface RuntimeEvolutionResolvedRelease {
  assetKind: "skill" | "memory" | "plugin" | "harness" | "prompt" | "agent_profile";
  target: string; ownerLevel: EvolutionOwnerLevel;
  releaseRef: { id: string; version: string; contentHash: string };
  generation: number; stage: "canary" | "production"; sourceWorkspaceId?: string;
}

export interface RuntimeEvolutionProjection {
  skills: RuntimeEvolutionSkill[]; memories: RuntimeEvolutionMemory[];
  plugins: RuntimeEvolutionExtension[]; harnesses: RuntimeEvolutionExtension[];
  prompts: RuntimeEvolutionPrompt[]; agentProfiles: RuntimeEvolutionAgentProfile[];
  canaryReleases: Array<{ target: string; releaseId: string; contentHash: string }>;
  canaryAssignments: Array<{ target: string; promotionId: string; releaseId: string; selected: boolean }>;
  organizationConflicts: string[]; resolvedReleases: RuntimeEvolutionResolvedRelease[]; snapshotHash: string;
}

export const EMPTY_RUNTIME_EVOLUTION_PROJECTION: RuntimeEvolutionProjection = {
  skills: [], memories: [], plugins: [], harnesses: [], prompts: [], agentProfiles: [],
  canaryReleases: [], canaryAssignments: [], organizationConflicts: [], resolvedReleases: [],
  snapshotHash: "disabled",
};
