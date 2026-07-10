import type { WorkflowPolicyRef } from "../../shared/contracts/ticket-engine.js";
import {
  createWorkflowPolicy,
  type WorkflowPolicyStore,
} from "./workflow-policy-store.js";

export interface MinimalTeamWorkflowPolicyConfig {
  plannerPrincipalId: string;
  teamBindingId: string;
}

export async function seedMinimalTeamWorkflowPolicy(
  store: Pick<WorkflowPolicyStore, "seedPolicy">,
  config: MinimalTeamWorkflowPolicyConfig,
): Promise<WorkflowPolicyRef> {
  const policy = createWorkflowPolicy({
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
  return (await store.seedPolicy(policy)).ref;
}
