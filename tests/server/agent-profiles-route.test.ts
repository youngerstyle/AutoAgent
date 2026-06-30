import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";

describe("agent profiles route", () => {
  beforeEach(async () => {
    process.env.NODE_ENV = "test";
    process.env.AUTOAGENT_HOME = await mkdtemp(path.join(os.tmpdir(), "autoagent-profiles-home-"));
  });

  it("persists editable global identity and soul separately from workspace overrides", async () => {
    const app = createApp();
    const listed = await request(app).get("/api/agent-profiles").expect(200);
    const dev = listed.body.profiles.find((profile: { role: string }) => profile.role === "dev");

    const updated = await request(app)
      .patch(`/api/agent-profiles/${dev.id}`)
      .send({
        name: "全栈工程师",
        identity: "负责把任务变成可运行变更",
        soul: "先理解上下文，再小步交付，所有结论都要有验证证据。",
        loopDefinition: ["读需求", "读项目", "修改代码", "运行验证", "交付说明"]
      })
      .expect(200);

    expect(updated.body.profile).toMatchObject({
      name: "全栈工程师",
      identity: "负责把任务变成可运行变更",
      soul: "先理解上下文，再小步交付，所有结论都要有验证证据。"
    });
    expect(updated.body.profile.loopDefinition).toBeUndefined();

    const relisted = await request(app).get("/api/agent-profiles").expect(200);
    const relistedDev = relisted.body.profiles.find((profile: { id: string }) => profile.id === dev.id);
    expect(relistedDev.soul).toContain("验证证据");
    expect(relistedDev.loopDefinition).toBeUndefined();

    const policyUpdated = await request(app)
      .patch(`/api/agent-profiles/${dev.id}`)
      .send({ defaultPolicy: { canWriteWorkspace: false } })
      .expect(200);
    expect(policyUpdated.body.profile.defaultPolicy).toMatchObject({
      canReadWorkspace: true,
      canWriteWorkspace: false,
      canExecuteCommands: true
    });

    const rootPath = await mkdtemp(path.join(os.tmpdir(), "autoagent-profile-ws-"));
    const created = await request(app)
      .post("/api/workspaces")
      .send({ name: "Project", rootPath, policyProfile: "development" })
      .expect(201);
    const workspaceId = created.body.workspace.id as string;
    const agents = await request(app).get(`/api/workspaces/${workspaceId}/agents`).expect(200);
    const workspaceDev = agents.body.agents.find((agent: { roleInWorkspace: string }) => agent.roleInWorkspace === "dev");
    const raw = JSON.parse(await readFile(path.join(rootPath, ".autoagent", "agents", workspaceDev.id, "agent.json"), "utf8"));

    expect(raw.soul).toBeUndefined();
    expect(raw.loopDefinition).toBeUndefined();
  });
});
