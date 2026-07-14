import type { PlanPolicyRef } from "../../shared/contracts/ticket-engine.js";
import {
  createPlanPolicy,
  type PlanPolicyStore,
} from "./plan-policy-store.js";

export interface MinimalTeamPlanPolicyConfig {
  plannerPrincipalId: string;
  teamBindingId: string;
}

export const DEFAULT_MINIMAL_TEAM_POLICY_CONFIG: Readonly<MinimalTeamPlanPolicyConfig> = Object.freeze({
  plannerPrincipalId: "minimal-team-planner",
  teamBindingId: "minimal-team",
});

export function createMinimalTeamPlanPolicy(config: MinimalTeamPlanPolicyConfig) {
  return createPlanPolicy({
    policyId: "minimal-team",
    policyVersion: 3,
    grants: [
      {
        principalId: config.plannerPrincipalId,
        capabilities: [
          "blocked_ownership:transfer",
          "plan:create",
          "plan:amend",
          "plan:control",
        ],
      },
      {
        teamBindingId: config.teamBindingId,
        capabilities: ["ticket:claim"],
      },
    ],
  });
}

export async function seedMinimalTeamPlanPolicy(
  store: Pick<PlanPolicyStore, "seedPolicy">,
  config: MinimalTeamPlanPolicyConfig,
): Promise<PlanPolicyRef> {
  const policy = createMinimalTeamPlanPolicy(config);
  return (await store.seedPolicy(policy)).ref;
}
