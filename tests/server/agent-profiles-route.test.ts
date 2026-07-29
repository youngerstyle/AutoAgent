import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";

describe("agent profiles route", () => {
  let homeDir: string;

  beforeEach(async () => {
    process.env.NODE_ENV = "test";
    homeDir = await mkdtemp(path.join(os.tmpdir(), "autoagent-profiles-home-"));
    process.env.AUTOAGENT_HOME = homeDir;
  });

  it("seeds real-world agent contracts and migrates old short profiles without losing model defaults", async () => {
    await writeFile(path.join(homeDir, "agent-profiles.json"), JSON.stringify([{
      id: "prof_pm",
      name: "产品/项目",
      role: "pm",
      identity: "负责把模糊目标拆成可执行计划",
      soul: "把模糊需求压成可执行计划，控制范围，减少来回返工。",
      capabilities: ["计划拆解"],
      defaultProvider: "openai",
      defaultModel: "deepseek-v4-flash",
      defaultPolicy: { canReadWorkspace: true, canWriteWorkspace: false, canExecuteCommands: false }
    }], null, 2));

    const app = createApp();
    const listed = await request(app).get("/api/agent-profiles").expect(200);
    const pm = listed.body.profiles.find((profile: { role: string }) => profile.role === "pm");
    const dev = listed.body.profiles.find((profile: { role: string }) => profile.role === "dev");
    const qa = listed.body.profiles.find((profile: { role: string }) => profile.role === "qa");

    expect(pm.defaultProvider).toBe("openai");
    expect(pm.defaultModel).toBe("deepseek-v4-flash");
    expect(pm.identity.length).toBeGreaterThan(80);
    expect(pm.identity).toContain("真实团队");
    expect(pm.soul).toContain("对混乱和返工高度敏感");
    expect(pm.soul).not.toContain("不替开发写实现");
    expect(pm.agentMd).toContain("# 使命");
    expect(pm.agentMd).toContain("交付");
    expect(pm.agentMd).toContain("不得成为计划生成的前置门槛");
    expect(pm.capabilities).toEqual(expect.arrayContaining(["需求澄清", "任务拆解", "变更管理"]));
    expect(pm.capabilities.length).toBeGreaterThanOrEqual(6);
    expect(dev.soul).toContain("可运行变化获得安全感");
    expect(qa.soul).toContain("对模糊通过很敏感");

    const persisted = JSON.parse(await readFile(path.join(homeDir, "agent-profiles.json"), "utf8"));
    const persistedPm = persisted.find((profile: { role: string }) => profile.role === "pm");
    expect(persistedPm.identity).toBe(pm.identity);
    expect(persistedPm.contentVersion).toBe(9);
    expect(persistedPm.capabilities).toContain("plan:plan");
  });

  it("migrates v3 rule-like soul into v4 soul traits while preserving model and agent.md", async () => {
    await writeFile(path.join(homeDir, "agent-profiles.json"), JSON.stringify([{
      id: "prof_dev",
      name: "开发",
      role: "dev",
      contentVersion: 3,
      identity: "工程开发者。负责基于 PM 的工作包和架构师的技术边界，完成最小可验证的代码、配置或脚本变更，并运行本地验证。",
      soul: "先理解现有代码、任务边界和权限策略，再小步实现。优先做可回滚、可验证、可解释的变更；不改无关文件，不绕过权限，不伪造验证，不把推测当事实。遇到需求冲突、测试失败、工具失败或权限不足时，要带着证据反馈给 PM/架构师/老板，而不是沉默推进。",
      agentMd: "# 开发能力手册\n- 已经存在的手册要保留",
      capabilities: ["代码阅读", "实现修改"],
      defaultProvider: "openai",
      defaultModel: "deepseek-v4-flash",
      defaultPolicy: { canReadWorkspace: true, canWriteWorkspace: true, canExecuteCommands: true }
    }], null, 2));

    const app = createApp();
    const listed = await request(app).get("/api/agent-profiles").expect(200);
    const dev = listed.body.profiles.find((profile: { role: string }) => profile.role === "dev");

    expect(dev.contentVersion).toBe(9);
    expect(dev.capabilities).toContain("delivery:implement");
    expect(dev.defaultModel).toBe("deepseek-v4-flash");
    expect(dev.agentMd).toContain("已经存在的手册要保留");
    expect(dev.soul).toContain("可运行变化获得安全感");
    expect(dev.soul).not.toContain("不改无关文件");
  });

  it("adds agent.md to v2 profiles without overwriting edited identity and soul", async () => {
    await writeFile(path.join(homeDir, "agent-profiles.json"), JSON.stringify([{
      id: "prof_dev",
      name: "全栈工程师",
      role: "dev",
      contentVersion: 2,
      identity: "用户改过的开发岗位定义",
      soul: "用户改过的开发灵魂特质",
      capabilities: ["TypeScript", "验证"],
      defaultProvider: "openai",
      defaultModel: "deepseek-v4-flash",
      defaultPolicy: { canReadWorkspace: true, canWriteWorkspace: true, canExecuteCommands: true }
    }], null, 2));

    const app = createApp();
    const listed = await request(app).get("/api/agent-profiles").expect(200);
    const dev = listed.body.profiles.find((profile: { role: string }) => profile.role === "dev");

    expect(dev.identity).toBe("用户改过的开发岗位定义");
    expect(dev.soul).toBe("用户改过的开发灵魂特质");
    expect(dev.capabilities).toEqual(expect.arrayContaining(["delivery:implement", "TypeScript", "验证"]));
    expect(dev.agentMd).toContain("# 使命");
    expect(dev.agentMd).toContain("实现");
    expect(dev.contentVersion).toBe(9);
    expect(dev.capabilities).toContain("delivery:implement");
  });

  it("adds newly introduced image reading to v7 profiles without replacing configured tools", async () => {
    await writeFile(path.join(homeDir, "agent-profiles.json"), JSON.stringify([{
      id: "prof_dev",
      name: "开发",
      role: "dev",
      contentVersion: 7,
      identity: "用户岗位",
      soul: "用户个性",
      agentMd: "用户能力说明",
      capabilities: ["delivery:implement"],
      defaultProvider: "openai",
      defaultModel: "custom-model",
      defaultPolicy: {
        canReadWorkspace: true,
        canWriteWorkspace: true,
        canExecuteCommands: true,
        enabledTools: ["listFiles", "readFile", "writeFile", "shell"]
      }
    }], null, 2));

    const app = createApp();
    const listed = await request(app).get("/api/agent-profiles").expect(200);
    const dev = listed.body.profiles.find((profile: { role: string }) => profile.role === "dev");

    expect(dev.contentVersion).toBe(9);
    expect(dev.defaultSkills).toContain("agent-browser");
    expect(dev.defaultPolicy.enabledTools).toEqual(expect.arrayContaining([
      "listFiles",
      "readFile",
      "readImage",
      "writeFile",
      "shell",
      "browser"
    ]));
  });

  it("migrates v8 browser skills to the dedicated browser tool without role checks", async () => {
    await writeFile(path.join(homeDir, "agent-profiles.json"), JSON.stringify([{
      id: "prof_dev",
      name: "开发",
      role: "dev",
      contentVersion: 8,
      identity: "用户岗位",
      soul: "用户个性",
      agentMd: "用户能力说明",
      capabilities: ["delivery:implement"],
      defaultSkills: ["agent-browser"],
      defaultProvider: "openai",
      defaultModel: "custom-model",
      defaultPolicy: {
        canReadWorkspace: true,
        canWriteWorkspace: true,
        canExecuteCommands: true,
        enabledTools: ["listFiles", "readFile", "writeFile", "shell"]
      }
    }, {
      id: "prof_custom_browser",
      name: "网页研究员",
      role: "specialist",
      contentVersion: 8,
      capabilities: ["网页研究"],
      defaultSkills: ["agent-browser"],
      defaultProvider: "openai",
      defaultModel: "custom-model",
      defaultPolicy: {
        canReadWorkspace: true,
        canWriteWorkspace: false,
        canExecuteCommands: true,
        enabledTools: ["readFile"]
      }
    }], null, 2));

    const app = createApp();
    const listed = await request(app).get("/api/agent-profiles").expect(200);
    const dev = listed.body.profiles.find((profile: { id: string }) => profile.id === "prof_dev");
    const specialist = listed.body.profiles.find((profile: { id: string }) => profile.id === "prof_custom_browser");

    expect(dev.contentVersion).toBe(9);
    expect(dev.defaultPolicy.enabledTools).toContain("browser");
    expect(specialist.defaultPolicy.enabledTools).toContain("browser");

    const persisted = JSON.parse(await readFile(path.join(homeDir, "agent-profiles.json"), "utf8"));
    expect(persisted.find((profile: { id: string }) => profile.id === "prof_dev").defaultPolicy.enabledTools)
      .toContain("browser");
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
        agentMd: "# 开发能力手册\n- 先读代码\n- 再做可验证变更",
        loopDefinition: ["读需求", "读项目", "修改代码", "运行验证", "交付说明"]
      })
      .expect(200);

    expect(updated.body.profile).toMatchObject({
      name: "全栈工程师",
      identity: "负责把任务变成可运行变更",
      soul: "先理解上下文，再小步交付，所有结论都要有验证证据。",
      agentMd: "# 开发能力手册\n- 先读代码\n- 再做可验证变更"
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

  it("persists selected and explicitly cleared default skills", async () => {
    const app = createApp();
    const listed = await request(app).get("/api/agent-profiles").expect(200);
    const pm = listed.body.profiles.find((profile: { role: string }) => profile.role === "pm");

    await request(app)
      .patch(`/api/agent-profiles/${pm.id}`)
      .send({ defaultSkills: ["agent-browser"] })
      .expect(200)
      .expect(({ body }) => {
        expect(body.profile.defaultSkills).toEqual(["agent-browser"]);
        expect(body.profile.defaultPolicy.enabledTools).toContain("browser");
      });

    const selected = await request(app).get("/api/agent-profiles").expect(200);
    expect(selected.body.profiles.find((profile: { id: string }) => profile.id === pm.id).defaultSkills)
      .toEqual(["agent-browser"]);

    await request(app)
      .patch(`/api/agent-profiles/${pm.id}`)
      .send({ defaultSkills: [] })
      .expect(200);

    const cleared = await request(app).get("/api/agent-profiles").expect(200);
    expect(cleared.body.profiles.find((profile: { id: string }) => profile.id === pm.id).defaultSkills)
      .toEqual([]);
  });
});
