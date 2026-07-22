import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app.js";

describe("workspace image attachments", () => {
  it("stores and serves a workspace-scoped image", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "autoagent-attachment-home-"));
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-attachment-ws-"));
    const app = createApp({ port: 0, autoAgentHome: home, useMockProvider: true, providerRetryCount: 0 });
    const workspace = (await request(app).post("/api/workspaces").send({
      name: "图片测试",
      rootPath: root,
      policyProfile: "development",
    }).expect(201)).body.workspace;
    const png = Buffer.from("89504e470d0a1a0a00000000", "hex");

    const uploaded = await request(app)
      .post(`/api/workspaces/${workspace.id}/attachments`)
      .set("content-type", "image/png")
      .set("x-file-name", encodeURIComponent("截图.png"))
      .send(png)
      .expect(201);

    expect(uploaded.body.attachment).toMatchObject({
      type: "image",
      mimeType: "image/png",
      fileName: "截图.png",
      size: png.length,
    });
    const downloaded = await request(app)
      .get(`/api/workspaces/${workspace.id}/attachments/${uploaded.body.attachment.attachmentId}`)
      .expect(200)
      .expect("content-type", /image\/png/);
    expect(downloaded.body).toEqual(png);
  });

  it("rejects non-image content", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "autoagent-attachment-home-"));
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-attachment-ws-"));
    const app = createApp({ port: 0, autoAgentHome: home, useMockProvider: true, providerRetryCount: 0 });
    const workspace = (await request(app).post("/api/workspaces").send({
      name: "附件边界",
      rootPath: root,
      policyProfile: "development",
    }).expect(201)).body.workspace;

    await request(app)
      .post(`/api/workspaces/${workspace.id}/attachments`)
      .set("content-type", "text/plain")
      .send("not an image")
      .expect(415);
  });

  it("rejects content whose bytes do not match the declared image type", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "autoagent-attachment-home-"));
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-attachment-ws-"));
    const app = createApp({ port: 0, autoAgentHome: home, useMockProvider: true, providerRetryCount: 0 });
    const workspace = (await request(app).post("/api/workspaces").send({
      name: "伪装图片",
      rootPath: root,
      policyProfile: "development",
    }).expect(201)).body.workspace;

    const result = await request(app)
      .post(`/api/workspaces/${workspace.id}/attachments`)
      .set("content-type", "image/png")
      .send(Buffer.from("not really a png"))
      .expect(415);

    expect(result.body.code).toBe("INVALID_ATTACHMENT_CONTENT");
  });
});
