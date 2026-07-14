import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { seedMinimalTeamPlanPolicy } from "../../src/server/tickets/plan-policy-config.js";
import { PlanPolicyStore } from "../../src/server/tickets/plan-policy-store.js";

describe("plan policy product configuration", () => {
  it("seeds the versioned minimal-team policy from explicit principal and team bindings", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-plan-policy-config-"));
    const store = new PlanPolicyStore(root);

    const ref = await seedMinimalTeamPlanPolicy(store, {
      plannerPrincipalId: "planner-1",
      teamBindingId: "team-1",
    });

    expect(ref).toMatchObject({ policyId: "minimal-team", policyVersion: 3 });
    await expect(store.capabilitiesFor(ref, {
      principalId: "planner-1",
      teamBindingIds: ["team-1"],
    })).resolves.toEqual([
      "blocked_ownership:transfer",
      "plan:amend",
      "plan:control",
      "plan:create",
      "ticket:claim",
    ]);
    await expect(store.capabilitiesFor(ref, {
      principalId: "worker-1",
      teamBindingIds: ["team-1"],
    })).resolves.toEqual(["ticket:claim"]);
  });
});
