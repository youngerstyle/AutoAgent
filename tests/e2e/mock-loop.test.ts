import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";

describe("mock team loop E2E", () => {
  beforeEach(async () => {
    process.env.NODE_ENV = "test";
    process.env.AUTOAGENT_HOME = await mkdtemp(path.join(os.tmpdir(), "autoagent-e2e-home-"));
  });

  it("creates a workspace, runs the fixed team, recruits a specialist, and exposes a UI-ready snapshot", async () => {
    const app = createApp();
    const rootPath = await mkdtemp(path.join(os.tmpdir(), "autoagent-e2e-ws-"));

    const created = await request(app)
      .post("/api/workspaces")
      .send({ name: "E2E", rootPath, policyProfile: "development" })
      .expect(201);
    const workspaceId = created.body.workspace.id as string;

    await request(app)
      .post(`/api/workspaces/${workspaceId}/tasks`)
      .send({ goal: "Build auth security checks demo" })
      .expect(201);

    const snapshot = await pollSnapshot(app, workspaceId);
    expect(snapshot.status).toBe("completed");
    expect(snapshot.phase).toBe("completed");
    expect(snapshot.agents.map((agent: { roleInWorkspace: string }) => agent.roleInWorkspace)).toEqual(
      expect.arrayContaining(["boss", "pm", "architect", "dev", "qa", "specialist"])
    );
    expect(snapshot.recentEvents.map((event: { type: string }) => event.type)).toEqual(
      expect.arrayContaining(["task.created", "recruitment.approved", "run.completed"])
    );
    await expect(readFile(path.join(rootPath, "AUTOAGENT_RESULT.md"), "utf8")).resolves.toContain("已完成：");
  });
});

async function pollSnapshot(app: ReturnType<typeof createApp>, workspaceId: string) {
  let snapshot;
  for (let index = 0; index < 40; index += 1) {
    const response = await request(app).get(`/api/workspaces/${workspaceId}/snapshot`).expect(200);
    snapshot = response.body.snapshot;
    const eventTypes = snapshot.recentEvents.map((event: { type: string }) => event.type);
    if (snapshot.status === "completed" && eventTypes.includes("run.completed")) return snapshot;
    if (snapshot.status === "failed" && eventTypes.includes("run.failed")) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Task did not finish. Last snapshot: ${JSON.stringify(snapshot)}`);
}
