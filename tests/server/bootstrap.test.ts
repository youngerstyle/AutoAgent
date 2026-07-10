import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { bootstrapServer, startServer } from "../../src/server/bootstrap.js";
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
import { WorkspaceStore } from "../../src/server/storage/workspace-store.js";

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
      policyVersion: 2,
      grants: [{ principalId: "different-principal", capabilities: ["workflow:control"] }],
    });
    await new WorkflowPolicyStore(home).seedPolicy(conflicting);

    await expect(startServer({ ...config(home), port: 0 })).rejects.toBeInstanceOf(WorkflowPolicyConflictError);
  });

  it("uses the explicit bootstrap config for both policy and API storage", async () => {
    const homeA = await mkdtemp(path.join(os.tmpdir(), "autoagent-bootstrap-a-"));
    const homeB = await mkdtemp(path.join(os.tmpdir(), "autoagent-bootstrap-b-"));
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "autoagent-bootstrap-workspace-"));
    const previousHome = process.env.AUTOAGENT_HOME;
    process.env.AUTOAGENT_HOME = homeB;

    try {
      const app = await bootstrapServer(config(homeA));
      await request(app)
        .post("/api/workspaces")
        .send({ name: "Config A", rootPath: workspaceRoot, policyProfile: "development" })
        .expect(201);
      const listed = await request(app).get("/api/workspaces").expect(200);
      expect(listed.body.workspaces).toHaveLength(1);

      await expect(new WorkspaceStore(homeA).list()).resolves.toHaveLength(1);
      await expect(new WorkspaceStore(homeB).list()).resolves.toEqual([]);
      const policyRef = createMinimalTeamWorkflowPolicy(DEFAULT_MINIMAL_TEAM_POLICY_CONFIG).ref;
      await expect(new WorkflowPolicyStore(homeA).requirePolicy(policyRef)).resolves.toBeDefined();
      await expect(new WorkflowPolicyStore(homeB).getPolicy(policyRef)).resolves.toBeUndefined();
    } finally {
      if (previousHome === undefined) delete process.env.AUTOAGENT_HOME;
      else process.env.AUTOAGENT_HOME = previousHome;
    }
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
