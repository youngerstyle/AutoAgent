import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import { RuntimeHostStore } from "../../src/server/runtime/runtime-host-store.js";

describe("agents route", () => {
  beforeEach(async () => {
    process.env.NODE_ENV = "test";
    process.env.AUTOAGENT_HOME = await mkdtemp(path.join(os.tmpdir(), "autoagent-agents-home-"));
  });

  async function createWorkspace(app: ReturnType<typeof createApp>) {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), "autoagent-agents-ws-"));
    const created = await request(app)
      .post("/api/workspaces")
      .send({ name: "Agents", rootPath, policyProfile: "development" })
      .expect(201);
    return { rootPath, workspaceId: created.body.workspace.id as string };
  }

  it("keeps a new project empty until talent is explicitly added", async () => {
    const app = createApp();
    const { workspaceId } = await createWorkspace(app);

    const first = await request(app).get(`/api/workspaces/${workspaceId}/agents`).expect(200);
    const second = await request(app).get(`/api/workspaces/${workspaceId}/agents`).expect(200);

    expect(first.body.agents).toEqual([]);
    expect(second.body.agents).toEqual([]);
  });

  it("accepts a goal in an empty project and delegates staffing to the organization owner", async () => {
    const app = createApp();
    const { workspaceId } = await createWorkspace(app);

    const response = await request(app)
      .post(`/api/workspaces/${workspaceId}/tasks`)
      .send({ goal: "构建可运行产品" })
      .expect(201);

    expect(response.body.snapshot.activeTask.goal).toBe("构建可运行产品");
    expect(response.body.snapshot.tickets).toEqual([]);
    expect(response.body.snapshot.agents).toContainEqual(expect.objectContaining({
      capabilities: expect.arrayContaining(["team:staff"]),
      currentStep: "根据目标组建项目团队",
    }));
  });

  it("creates talent and instantiates it independently in a project", async () => {
    const app = createApp();
    const { rootPath, workspaceId } = await createWorkspace(app);
    const createdProfile = await request(app)
      .post("/api/agent-profiles")
      .send({
        name: "前端设计工程师",
        role: "specialist",
        soul: "重视视觉秩序与交互反馈。",
        identity: "负责前端体验设计与实现。",
        agentMd: "# 交付\n提供可运行、可验证的前端。",
        capabilities: ["delivery:implement", "ui:design"],
        defaultProvider: "openai",
        defaultModel: "gpt-test",
        defaultSkills: ["agent-browser"],
        defaultPolicy: {
          canReadWorkspace: true,
          canWriteWorkspace: true,
          canExecuteCommands: true,
          enabledTools: ["readFile", "writeFile", "browser"],
          allowHostAccess: false,
        },
      })
      .expect(201);

    const added = await request(app)
      .post(`/api/workspaces/${workspaceId}/agents`)
      .send({ profileId: createdProfile.body.profile.id })
      .expect(201);

    expect(added.body.agent.name).toBe("前端设计工程师");
    expect(added.body.agent.roleInWorkspace).toBe("specialist");
    expect(added.body.agent.capabilities).toEqual(["delivery:implement", "ui:design"]);
    const raw = JSON.parse(await readFile(path.join(rootPath, ".autoagent", "agents", added.body.agent.id, "agent.json"), "utf8"));
    expect(raw.profileId).toBe(createdProfile.body.profile.id);
    expect(raw.provider).toBe("openai");
    expect(raw.model).toBe("gpt-test");
  });

  it("supports multiple people in the same role and resolves metadata by profile id", async () => {
    const app = createApp();
    const { workspaceId } = await createWorkspace(app);
    const profiles = await request(app).get("/api/agent-profiles").expect(200);
    const originalDev = profiles.body.profiles.find((profile: { role: string }) => profile.role === "dev");
    const secondDev = await request(app)
      .post("/api/agent-profiles")
      .send({
        ...originalDev,
        id: undefined,
        name: "TypeScript 开发",
        identity: "负责 TypeScript 工程开发。",
      })
      .expect(201);

    await request(app).post(`/api/workspaces/${workspaceId}/agents`).send({ profileId: originalDev.id }).expect(201);
    await request(app).post(`/api/workspaces/${workspaceId}/agents`).send({ profileId: secondDev.body.profile.id }).expect(201);

    const listed = await request(app).get(`/api/workspaces/${workspaceId}/agents`).expect(200);
    expect(listed.body.agents.map((agent: { name: string }) => agent.name).sort()).toEqual(["TypeScript 开发", "开发"].sort());
  });

  it("rejects duplicate membership and can remove a project instance without deleting talent", async () => {
    const app = createApp();
    const { workspaceId } = await createWorkspace(app);
    const profiles = await request(app).get("/api/agent-profiles").expect(200);
    const dev = profiles.body.profiles.find((profile: { role: string }) => profile.role === "dev");
    const added = await request(app).post(`/api/workspaces/${workspaceId}/agents`).send({ profileId: dev.id }).expect(201);

    await request(app).post(`/api/workspaces/${workspaceId}/agents`).send({ profileId: dev.id }).expect(409);
    await request(app).delete(`/api/workspaces/${workspaceId}/agents/${added.body.agent.id}`).expect(200);

    expect((await request(app).get(`/api/workspaces/${workspaceId}/agents`).expect(200)).body.agents).toEqual([]);
    expect((await request(app).get("/api/agent-profiles").expect(200)).body.profiles.some((profile: { id: string }) => profile.id === dev.id)).toBe(true);
  });

  it("freezes project membership while a mission is active", async () => {
    const app = createApp();
    const { rootPath, workspaceId } = await createWorkspace(app);
    const profiles = await request(app).get("/api/agent-profiles").expect(200);
    const dev = profiles.body.profiles.find((profile: { role: string }) => profile.role === "dev");
    const qa = profiles.body.profiles.find((profile: { role: string }) => profile.role === "qa");
    const added = await request(app).post(`/api/workspaces/${workspaceId}/agents`).send({ profileId: dev.id }).expect(201);

    const now = new Date().toISOString();
    await new RuntimeHostStore(rootPath).save({
      taskId: "task-active",
      runId: "run-active",
      missionId: "mission-active",
      title: "Active",
      objective: "Keep the team binding stable",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });

    await request(app).post(`/api/workspaces/${workspaceId}/agents`).send({ profileId: qa.id }).expect(409);
    await request(app).delete(`/api/workspaces/${workspaceId}/agents/${added.body.agent.id}`).expect(409);
  });

  it("updates and persists an explicitly added project agent", async () => {
    const app = createApp();
    const { rootPath, workspaceId } = await createWorkspace(app);
    const profiles = await request(app).get("/api/agent-profiles").expect(200);
    const devProfile = profiles.body.profiles.find((profile: { role: string }) => profile.role === "dev");
    const added = await request(app).post(`/api/workspaces/${workspaceId}/agents`).send({ profileId: devProfile.id }).expect(201);

    const updated = await request(app)
      .patch(`/api/workspaces/${workspaceId}/agents/${added.body.agent.id}`)
      .send({
        provider: "openai",
        model: "gpt-test",
        skillOverrides: ["agent-browser", "agent-browser", " chrome-devtools "],
        policyOverride: {
          canReadWorkspace: true,
          canWriteWorkspace: true,
          canExecuteCommands: false,
          enabledTools: ["readFile"],
          allowHostAccess: false,
        },
      })
      .expect(200);

    expect(updated.body.agent.provider).toBe("openai");
    expect(updated.body.agent.skillOverrides).toEqual(["agent-browser", "chrome-devtools"]);
    const raw = JSON.parse(await readFile(path.join(rootPath, ".autoagent", "agents", added.body.agent.id, "agent.json"), "utf8"));
    expect(raw.model).toBe("gpt-test");
    expect(raw.policyOverride.enabledTools).toEqual(["readFile"]);

    await request(app)
      .patch(`/api/workspaces/${workspaceId}/agents/${added.body.agent.id}`)
      .send({ skillOverrides: "agent-browser" })
      .expect(400);
  });
});
