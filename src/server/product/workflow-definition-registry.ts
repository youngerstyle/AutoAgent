import type {
  ResolvedMissionStartBundle,
  WorkflowDefinitionRegistryPort,
} from "../../shared/contracts/mission-control.js";
import type { WorkflowPolicyRef } from "../../shared/contracts/ticket-engine.js";
import {
  createMinimalTeamWorkflowDefinition,
  DEFAULT_WORKFLOW_TEMPLATE_ID,
  DEFAULT_WORKFLOW_TEMPLATE_VERSION,
} from "./workflow-template.js";

export class WorkflowDefinitionRegistry implements WorkflowDefinitionRegistryPort {
  constructor(private readonly policyRef: WorkflowPolicyRef) {}

  async resolve(input: {
    templateId: string;
    templateVersion?: number;
    teamBindingId: string;
    objective: string;
  }): Promise<ResolvedMissionStartBundle> {
    if (input.templateId !== DEFAULT_WORKFLOW_TEMPLATE_ID) throw new Error("Workflow template does not exist");
    if (input.templateVersion !== undefined && input.templateVersion !== DEFAULT_WORKFLOW_TEMPLATE_VERSION) {
      throw new Error("Workflow template version does not exist");
    }
    return {
      workflowDefinition: createMinimalTeamWorkflowDefinition(this.policyRef, input.objective),
      teamBindingId: input.teamBindingId,
    };
  }
}
