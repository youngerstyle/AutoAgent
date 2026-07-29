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
        skillOverrides: ["agent-browser", "agent-browser", " chrome-devtools "],
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
    expect(updated.body.agent.skillOverrides).toEqual(["agent-browser", "chrome-devtools"]);
    const raw = JSON.parse(await readFile(path.join(rootPath, ".autoagent", "agents", dev.id, "agent.json"), "utf8"));
    expect(raw.provider).toBe("openai");
    expect(raw.skillOverrides).toEqual(["agent-browser", "chrome-devtools"]);
    expect(raw.policyOverride.canExecuteCommands).toBe(false);
    expect(raw.policyOverride.enabledTools).toEqual(["readFile"]);

    await request(app)
      .patch(`/api/workspaces/${workspaceId}/agents/${dev.id}`)
      .send({ skillOverrides: null })
      .expect(200);
    const inheritedRaw = JSON.parse(await readFile(path.join(rootPath, ".autoagent", "agents", dev.id, "agent.json"), "utf8"));
    expect(inheritedRaw.skillOverrides).toBeUndefined();
  });

  it("rejects malformed workspace skill overrides", async () => {
    const app = createApp();
    const rootPath = await mkdtemp(path.join(os.tmpdir(), "autoagent-agent-skills-ws-"));
    const created = await request(app)
      .post("/api/workspaces")
      .send({ name: "Agent skills", rootPath, policyProfile: "development" })
      .expect(201);
    const workspaceId = created.body.workspace.id as string;
    const listed = await request(app).get(`/api/workspaces/${workspaceId}/agents`).expect(200);

    await request(app)
      .patch(`/api/workspaces/${workspaceId}/agents/${listed.body.agents[0].id}`)
      .send({ skillOverrides: "agent-browser" })
      .expect(400);
  });

  it("seeds workspace agents from editable global agent profile defaults", async () => {
    const app = createApp();
    const profiles = await request(app).get("/api/agent-profiles").expect(200);
    for (const profile of profiles.body.profiles) {
      await request(app)
        .patch(`/api/agent-profiles/${profile.id}`)
        .send({
          defaultSkills: [],
          defaultProvider: "openai",
          defaultModel: "gpt-default",
          defaultPolicy: {
            ...profile.defaultPolicy,
            enabledTools: ["readFile"]
          }
        })
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
    expect(listed.body.agents.every((agent: { policyOverride: { enabledTools: string[] } }) => agent.policyOverride.enabledTools.join(",") === "readFile")).toBe(true);
  });
});
