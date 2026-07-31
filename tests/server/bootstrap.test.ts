import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { bootstrapServer, startServer } from "../../src/server/bootstrap.js";
import type { AppConfig } from "../../src/server/config.js";
import {
  DEFAULT_MINIMAL_TEAM_POLICY_CONFIG,
  createMinimalTeamPlanPolicy,
} from "../../src/server/tickets/plan-policy-config.js";
import {
  PlanPolicyConflictError,
  PlanPolicyStore,
  createPlanPolicy,
} from "../../src/server/tickets/plan-policy-store.js";
import { WorkspaceStore } from "../../src/server/storage/workspace-store.js";
import { RuntimeHostRegistry } from "../../src/server/runtime/runtime-host-registry.js";

describe("server bootstrap", () => {
  it("seeds the immutable minimal-team policy before returning the production app", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "autoagent-bootstrap-"));

    const server = await startServer({ ...config(home), port: 0 });
    try {
      const ref = createMinimalTeamPlanPolicy(DEFAULT_MINIMAL_TEAM_POLICY_CONFIG).ref;
      await expect(new PlanPolicyStore(home).requirePolicy(ref)).resolves.toBeDefined();
      await request(server).get("/api/health").expect(200);
    } finally {
      server.close();
    }
  });

  it("fails startup when the immutable product policy conflicts", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "autoagent-bootstrap-"));
    const conflicting = createPlanPolicy({
      policyId: "minimal-team",
      policyVersion: 3,
      grants: [{ principalId: "different-principal", capabilities: ["plan:control"] }],
    });
    await new PlanPolicyStore(home).seedPolicy(conflicting);

    await expect(startServer({ ...config(home), port: 0 })).rejects.toBeInstanceOf(PlanPolicyConflictError);
  });

  it("listens before historical runtime host restoration finishes", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "autoagent-bootstrap-nonblocking-"));
    const restore = vi
      .spyOn(RuntimeHostRegistry.prototype, "startAll")
      .mockImplementation(() => new Promise<never>(() => undefined));

    const server = await startServer({ ...config(home), port: 0 });
    try {
      await request(server)
        .get("/api/health")
        .expect(200)
        .expect(({ body }) => {
          expect(body).toMatchObject({
            ok: true,
            runtimeHosts: { status: "restoring" },
          });
        });
    } finally {
      server.close();
      restore.mockRestore();
    }
  });

  it("reports invalid workspaces without failing restoration for healthy workspaces", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "autoagent-bootstrap-isolation-"));
    const restore = vi
      .spyOn(RuntimeHostRegistry.prototype, "startAll")
      .mockResolvedValue({
        restoredWorkspaceIds: ["workspace-healthy"],
        failedWorkspaces: [{ workspaceId: "workspace-invalid", error: "Goal version must advance by exactly one" }],
      });
    try {
      const app = await bootstrapServer(config(home));
      await request(app)
        .get("/api/health")
        .expect(200)
        .expect(({ body }) => {
          expect(body).toMatchObject({
            ok: true,
            runtimeHosts: {
              status: "degraded",
              restoredWorkspaceCount: 1,
              failedWorkspaces: [{ workspaceId: "workspace-invalid" }],
            },
          });
        });
    } finally {
      restore.mockRestore();
    }
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
      const policyRef = createMinimalTeamPlanPolicy(DEFAULT_MINIMAL_TEAM_POLICY_CONFIG).ref;
      await expect(new PlanPolicyStore(homeA).requirePolicy(policyRef)).resolves.toBeDefined();
      await expect(new PlanPolicyStore(homeB).getPolicy(policyRef)).resolves.toBeUndefined();
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
