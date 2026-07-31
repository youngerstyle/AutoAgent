import express from "express";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createWorkspaceRouter } from "../../src/server/routes/workspaces";
import { AgentProfileStore } from "../../src/server/agents/profile-store";
import { WorkspaceStore } from "../../src/server/storage/workspace-store";

describe("workspaces route", () => {
  it("removes a workspace from AutoAgent without deleting the local folder by default", async () => {
    const { app, rootPath } = await createFixture();
    await writeFile(path.join(rootPath, "keep.txt"), "still here", "utf8");

    const created = await request(app)
      .post("/api/workspaces")
      .send({ name: "Keep files", rootPath, policyProfile: "development" })
      .expect(201);

    await request(app)
      .delete(`/api/workspaces/${created.body.workspace.id}`)
      .send({ deleteLocalFolder: false })
      .expect(200);

    const listed = await request(app).get("/api/workspaces").expect(200);
    expect(listed.body.workspaces).toHaveLength(0);
    await expect(readFile(path.join(rootPath, "keep.txt"), "utf8")).resolves.toBe("still here");
  });

  it("deletes the local workspace folder only when explicitly requested", async () => {
    const { app, rootPath } = await createFixture();
    await writeFile(path.join(rootPath, "delete-me.txt"), "remove", "utf8");

    const created = await request(app)
      .post("/api/workspaces")
      .send({ name: "Delete files", rootPath, policyProfile: "development" })
      .expect(201);

    await request(app)
      .delete(`/api/workspaces/${created.body.workspace.id}`)
      .send({ deleteLocalFolder: true })
      .expect(200);

    const listed = await request(app).get("/api/workspaces").expect(200);
    expect(listed.body.workspaces).toHaveLength(0);
    await expect(access(rootPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function createFixture() {
  const home = await mkdtemp(path.join(os.tmpdir(), "autoagent-workspaces-route-home-"));
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "autoagent-workspaces-route-ws-"));
  const store = new WorkspaceStore(home);
  const app = express();
  app.use(express.json());
  app.use("/api/workspaces", createWorkspaceRouter(store, new AgentProfileStore(home)));
  return { app, rootPath };
}
