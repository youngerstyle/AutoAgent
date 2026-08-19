import type { EvolutionPlatformPort } from "../runtime/evolution-platform-port.js";
import { EvolutionActivationStore } from "../evolution/activation-store.js";
import { evolutionAgentProfileForSession } from "../evolution/runtime-projection.js";
import { productionEvolutionWorkflow, trialEvolutionWorkflow, workflowSnapshotHash } from "../evolution/workflow-projection.js";
import type { OrganizationMemorySource, SharedEvolutionLayerSource } from "../../shared/contracts/evolution-runtime.js";
import { EvolutionAgentRuntimeAdapter } from "./agent-runtime-adapter.js";

export class EvolutionPlatformRuntimeAdapter implements EvolutionPlatformPort {
  readonly agentRuntime: EvolutionAgentRuntimeAdapter;

  constructor(
    private readonly workspaceRoot: string,
    private readonly workspaceId: string,
    private readonly options: {
      now?: () => Date;
      organizationMemorySources?: () => Promise<OrganizationMemorySource[]>;
      sharedEvolutionLayerSources?: (profileId: string) => Promise<SharedEvolutionLayerSource[]>;
    } = {},
  ) {
    this.agentRuntime = new EvolutionAgentRuntimeAdapter(workspaceRoot, workspaceId, options);
  }

  async resolveWorkflow(input: Parameters<EvolutionPlatformPort["resolveWorkflow"]>[0]) {
    if (input.trial) return trialEvolutionWorkflow(this.workspaceRoot, this.workspaceId, input.target, input.policyRef, input.trial);
    return productionEvolutionWorkflow(this.workspaceRoot, this.workspaceId, input.target, input.policyRef, {
      profileId: input.profileId,
      sharedReleaseSources: input.profileId ? await this.options.sharedEvolutionLayerSources?.(input.profileId) ?? [] : [],
    });
  }

  workflowSnapshotHash = workflowSnapshotHash;

  async observeWorkflow(input: Parameters<EvolutionPlatformPort["observeWorkflow"]>[0]): Promise<void> {
    if (input.workflow.stage === "trial") return;
    await new EvolutionActivationStore(input.workflow.sourceRoot, this.options.now).observe({
      assetKind: "workflow", target: input.workflow.target,
      releaseRef: { id: input.workflow.releaseId, version: input.workflow.releaseVersion, contentHash: input.workflow.contentHash },
      desiredGeneration: input.workflow.generation, actualGeneration: input.workflow.generation,
      runtimeKind: "task", runtimeRef: input.runtimeRef, runtimeSnapshotHash: input.snapshotHash,
      ownerLevel: input.workflow.ownerLevel, traceRef: input.traceRef,
    });
  }

  async resolveAgentProfile(input: Parameters<EvolutionPlatformPort["resolveAgentProfile"]>[0]) {
    return (await evolutionAgentProfileForSession(this.workspaceRoot, this.workspaceId, input.profile, input.agent, {
      assignmentKey: input.assignmentKey, taskType: input.taskType, tools: input.tools,
    }))?.profile;
  }
}
