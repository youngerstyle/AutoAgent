import type {
  ResolvedMissionStartBundle,
  PlanDefinitionRegistryPort,
} from "../../shared/contracts/mission-control.js";
import type { PlanPolicyRef } from "../../shared/contracts/ticket-engine.js";
import {
  createMinimalTeamPlanDefinition,
  DEFAULT_PLAN_TEMPLATE_ID,
  DEFAULT_PLAN_TEMPLATE_VERSION,
} from "./plan-template.js";

export class PlanDefinitionRegistry implements PlanDefinitionRegistryPort {
  constructor(private readonly policyRef: PlanPolicyRef) {}

  async resolve(input: {
    templateId: string;
    templateVersion?: number;
    teamBindingId: string;
    objective: string;
  }): Promise<ResolvedMissionStartBundle> {
    if (input.templateId !== DEFAULT_PLAN_TEMPLATE_ID) throw new Error("Plan template does not exist");
    if (input.templateVersion !== undefined && input.templateVersion !== DEFAULT_PLAN_TEMPLATE_VERSION) {
      throw new Error("Plan template version does not exist");
    }
    return {
      planDefinition: createMinimalTeamPlanDefinition(this.policyRef, input.objective),
      teamBindingId: input.teamBindingId,
    };
  }
}
