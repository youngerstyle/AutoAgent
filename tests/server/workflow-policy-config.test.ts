import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { seedMinimalTeamWorkflowPolicy } from "../../src/server/tickets/workflow-policy-config.js";
import { WorkflowPolicyStore } from "../../src/server/tickets/workflow-policy-store.js";

describe("workflow policy product configuration", () => {
  it("seeds the versioned minimal-team policy from explicit principal and team bindings", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-workflow-policy-config-"));
    const store = new WorkflowPolicyStore(root);

    const ref = await seedMinimalTeamWorkflowPolicy(store, {
      plannerPrincipalId: "planner-1",
      teamBindingId: "team-1",
    });

    expect(ref).toMatchObject({ policyId: "minimal-team", policyVersion: 2 });
    await expect(store.capabilitiesFor(ref, {
      principalId: "planner-1",
      teamBindingIds: ["team-1"],
    })).resolves.toEqual([
      "blocked_ownership:transfer",
      "ticket:claim",
      "ticket_graph:amend",
      "ticket_graph:create",
      "workflow:control",
    ]);
    await expect(store.capabilitiesFor(ref, {
      principalId: "worker-1",
      teamBindingIds: ["team-1"],
    })).resolves.toEqual(["ticket:claim"]);
  });
});
