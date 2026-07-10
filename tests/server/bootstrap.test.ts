import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { startServer } from "../../src/server/bootstrap.js";
import type { AppConfig } from "../../src/server/config.js";
import {
  DEFAULT_MINIMAL_TEAM_POLICY_CONFIG,
  createMinimalTeamWorkflowPolicy,
} from "../../src/server/tickets/workflow-policy-config.js";
import {
  WorkflowPolicyConflictError,
  WorkflowPolicyStore,
  createWorkflowPolicy,
} from "../../src/server/tickets/workflow-policy-store.js";

describe("server bootstrap", () => {
  it("seeds the immutable minimal-team policy before returning the production app", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "autoagent-bootstrap-"));

    const server = await startServer({ ...config(home), port: 0 });
    try {
      const ref = createMinimalTeamWorkflowPolicy(DEFAULT_MINIMAL_TEAM_POLICY_CONFIG).ref;
      await expect(new WorkflowPolicyStore(home).requirePolicy(ref)).resolves.toBeDefined();
      await request(server).get("/api/health").expect(200);
    } finally {
      server.close();
    }
  });

  it("fails startup when the immutable product policy conflicts", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "autoagent-bootstrap-"));
    const conflicting = createWorkflowPolicy({
      policyId: "minimal-team",
      policyVersion: 1,
      grants: [{ principalId: "different-principal", capabilities: ["workflow:control"] }],
    });
    await new WorkflowPolicyStore(home).seedPolicy(conflicting);

    await expect(startServer({ ...config(home), port: 0 })).rejects.toBeInstanceOf(WorkflowPolicyConflictError);
  });
});

function config(autoAgentHome: string): AppConfig {
  return {
    port: 8787,
    autoAgentHome,
    useMockProvider: true,
    providerRetryCount: 0,
  };
}
