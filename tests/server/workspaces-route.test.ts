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
  it("keeps concurrent workspace creation in one registry", async () => {
    const { app } = await createFixture();
    const roots = await Promise.all(
      Array.from({ length: 8 }, async (_value, index) => mkdtemp(path.join(os.tmpdir(), `autoagent-concurrent-ws-${index}-`))),
    );

    const created = await Promise.all(roots.map((rootPath, index) => request(app)
      .post("/api/workspaces")
      .send({ name: `Concurrent ${index + 1}`, rootPath, policyProfile: "development" })
      .expect(201)));

    const listed = await request(app).get("/api/workspaces").expect(200);
    expect(new Set(created.map((response) => response.body.workspace.id)).size).toBe(roots.length);
    expect(new Set(listed.body.workspaces.map((workspace: { id: string }) => workspace.id)).size).toBe(roots.length);
    expect(listed.body.workspaces).toHaveLength(roots.length);
  });

  it("keeps one durable workspace identity when the same project folder is opened again", async () => {
    const { app, rootPath } = await createFixture();

    const first = await request(app)
      .post("/api/workspaces")
      .send({ name: "First name", rootPath, policyProfile: "development" })
      .expect(201);
    const second = await request(app)
      .post("/api/workspaces")
      .send({ name: "Second name", rootPath, policyProfile: "development" })
      .expect(201);

    expect(second.body.workspace.id).toBe(first.body.workspace.id);
    expect(second.body.workspace.name).toBe("First name");
    const listed = await request(app).get("/api/workspaces").expect(200);
    expect(listed.body.workspaces).toEqual([first.body.workspace]);
  });

  it("recovers the workspace identity from the project manifest when the global registry is lost", async () => {
    const firstHome = await mkdtemp(path.join(os.tmpdir(), "autoagent-workspaces-first-home-"));
    const secondHome = await mkdtemp(path.join(os.tmpdir(), "autoagent-workspaces-second-home-"));
    const rootPath = await mkdtemp(path.join(os.tmpdir(), "autoagent-workspaces-durable-root-"));
    const firstStore = new WorkspaceStore(firstHome);
    const secondStore = new WorkspaceStore(secondHome);

    const first = await firstStore.create({ name: "Durable project", rootPath, policyProfile: "development" });
    const recovered = await secondStore.create({ name: "Imported project", rootPath, policyProfile: "production" });

    expect(recovered).toEqual(first);
    await expect(secondStore.list()).resolves.toEqual([first]);
  });

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
