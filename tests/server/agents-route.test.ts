import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";

describe("agents route", () => {
  beforeEach(async () => {
    process.env.NODE_ENV = "test";
    process.env.AUTOAGENT_HOME = await mkdtemp(path.join(os.tmpdir(), "autoagent-agents-home-"));
  });

  it("seeds, lists, updates, and persists workspace agent configuration", async () => {
    const app = createApp();
    const rootPath = await mkdtemp(path.join(os.tmpdir(), "autoagent-agents-ws-"));
    const created = await request(app)
      .post("/api/workspaces")
      .send({ name: "Agents", rootPath, policyProfile: "development" })
      .expect(201);
    const workspaceId = created.body.workspace.id as string;

    const listed = await request(app).get(`/api/workspaces/${workspaceId}/agents`).expect(200);
    expect(listed.body.agents.map((agent: { roleInWorkspace: string }) => agent.roleInWorkspace)).toEqual([
      "boss",
      "pm",
      "architect",
      "dev",
      "qa"
    ]);
    const dev = listed.body.agents.find((agent: { roleInWorkspace: string }) => agent.roleInWorkspace === "dev");
    expect(dev.provider).toBe("mock");
    expect(dev.model).toBe("mock-dev");

    const updated = await request(app)
      .patch(`/api/workspaces/${workspaceId}/agents/${dev.id}`)
      .send({
        provider: "openai",
        model: "gpt-test",
        policyOverride: {
          canReadWorkspace: true,
          canWriteWorkspace: true,
          canExecuteCommands: false,
          enabledTools: ["readFile"],
          allowHostAccess: false
        }
      })
      .expect(200);

    expect(updated.body.agent.provider).toBe("openai");
    expect(updated.body.agent.model).toBe("gpt-test");
    const raw = JSON.parse(await readFile(path.join(rootPath, ".autoagent", "agents", dev.id, "agent.json"), "utf8"));
    expect(raw.provider).toBe("openai");
    expect(raw.policyOverride.canExecuteCommands).toBe(false);
    expect(raw.policyOverride.enabledTools).toEqual(["readFile"]);
  });

  it("seeds workspace agents from editable global agent profile defaults", async () => {
    const app = createApp();
    const profiles = await request(app).get("/api/agent-profiles").expect(200);
    for (const profile of profiles.body.profiles) {
      await request(app)
        .patch(`/api/agent-profiles/${profile.id}`)
        .send({ defaultProvider: "openai", defaultModel: "gpt-default" })
        .expect(200);
    }

    const rootPath = await mkdtemp(path.join(os.tmpdir(), "autoagent-agents-profile-ws-"));
    const created = await request(app)
      .post("/api/workspaces")
      .send({ name: "Profile defaults", rootPath, policyProfile: "development" })
      .expect(201);
    const workspaceId = created.body.workspace.id as string;

    const listed = await request(app).get(`/api/workspaces/${workspaceId}/agents`).expect(200);

    expect(listed.body.agents).toHaveLength(5);
    expect(listed.body.agents.every((agent: { provider: string; model: string }) => agent.provider === "openai" && agent.model === "gpt-default")).toBe(true);
  });
});
