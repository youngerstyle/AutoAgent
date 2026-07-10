import type { WorkflowPolicyRef } from "../../shared/contracts/ticket-engine.js";
import {
  createWorkflowPolicy,
  type WorkflowPolicyStore,
} from "./workflow-policy-store.js";

export interface MinimalTeamWorkflowPolicyConfig {
  plannerPrincipalId: string;
  teamBindingId: string;
}

export const DEFAULT_MINIMAL_TEAM_POLICY_CONFIG: Readonly<MinimalTeamWorkflowPolicyConfig> = Object.freeze({
  plannerPrincipalId: "minimal-team-planner",
  teamBindingId: "minimal-team",
});

export function createMinimalTeamWorkflowPolicy(config: MinimalTeamWorkflowPolicyConfig) {
  return createWorkflowPolicy({
    policyId: "minimal-team",
    policyVersion: 1,
    grants: [
      {
        principalId: config.plannerPrincipalId,
        capabilities: [
          "blocked_ownership:transfer",
          "ticket_graph:create",
          "workflow:control",
        ],
      },
      {
        teamBindingId: config.teamBindingId,
        capabilities: ["ticket:claim"],
      },
    ],
  });
}

export async function seedMinimalTeamWorkflowPolicy(
  store: Pick<WorkflowPolicyStore, "seedPolicy">,
  config: MinimalTeamWorkflowPolicyConfig,
): Promise<WorkflowPolicyRef> {
  const policy = createMinimalTeamWorkflowPolicy(config);
  return (await store.seedPolicy(policy)).ref;
}
