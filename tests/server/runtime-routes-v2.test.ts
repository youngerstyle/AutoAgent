import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootstrapServer } from "../../src/server/bootstrap.js";
import { RuntimeHost } from "../../src/server/runtime/runtime-host.js";
import type { RuntimeHostRegistry } from "../../src/server/runtime/runtime-host-registry.js";

describe("V2 runtime public routes", () => {
  let registry: RuntimeHostRegistry | undefined;
  afterEach(async () => { await registry?.stopAll(); });

  it("starts a ticket-agent task and sends a private message only to the selected Agent", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "autoagent-v2-api-home-"));
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-v2-api-ws-"));
    const app = await bootstrapServer({ port: 0, autoAgentHome: home, useMockProvider: true, providerRetryCount: 0 });
    registry = app.locals.runtimeHostRegistry as RuntimeHostRegistry;
    const workspaceResponse = await request(app).post("/api/workspaces").send({
      name: "V2",
      rootPath: root,
      policyProfile: "development",
    }).expect(201);
    const workspaceId = workspaceResponse.body.workspace.id as string;
    const profiles = await request(app).get("/api/agent-profiles").expect(200);
    for (const profile of profiles.body.profiles.filter((item: { id: string }) => item.id !== "prof_boss")) {
      await request(app).post(`/api/workspaces/${workspaceId}/agents`).send({ profileId: profile.id }).expect(201);
    }
    const started = await request(app).post(`/api/workspaces/${workspaceId}/tasks`).send({ goal: "构建演示" }).expect(201);
    const taskId = started.body.snapshot.activeTask.id as string;
    const architect = (await request(app).get(`/api/workspaces/${workspaceId}/agents`).expect(200)).body.agents
      .find((agent: { roleInWorkspace: string }) => agent.roleInWorkspace === "architect");

    expect(started.body.snapshot.assignments).toEqual([]);
    const staffed = await pollSnapshot(app, workspaceId, (value) => value.tickets.length > 0);
    expect(staffed.tickets.length).toBeGreaterThan(0);

    const messageResponse = await request(app)
      .post(`/api/workspaces/${workspaceId}/tasks/${taskId}/agents/${architect.id}/messages`)
      .send({ message: "请独立评估风险" });
    if (messageResponse.status !== 201) {
      throw new Error(`Private message failed (${messageResponse.status}): ${JSON.stringify(messageResponse.body)}`);
    }
    expect(messageResponse.body.snapshot.agentThreads[architect.id].some((event: { kind: string }) => event.kind === "human_message")).toBe(true);
    const snapshot = await pollSnapshot(app, workspaceId, (value) => value.agentThreads[architect.id].some((event: { kind: string }) => event.kind === "agent_message"));
    expect(snapshot.agentThreads[architect.id].some((event: { kind: string }) => event.kind === "agent_message")).toBe(true);
  });

  it("creates only one RuntimeHost when the same workspace is opened concurrently", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "autoagent-v2-host-home-"));
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-v2-host-ws-"));
    const app = await bootstrapServer({ port: 0, autoAgentHome: home, useMockProvider: true, providerRetryCount: 0 });
    registry = app.locals.runtimeHostRegistry as RuntimeHostRegistry;
    const workspaceResponse = await request(app).post("/api/workspaces").send({
      name: "Concurrent host",
      rootPath: root,
      policyProfile: "development",
    }).expect(201);
    const workspaceId = workspaceResponse.body.workspace.id as string;
    const hydrate = vi.spyOn(RuntimeHost.prototype, "hydrate");

    const snapshots = await Promise.all(
      Array.from({ length: 12 }, () => registry!.snapshotByWorkspace(workspaceId)),
    );

    expect(snapshots).toHaveLength(12);
    expect(hydrate).toHaveBeenCalledTimes(1);
  });

  it("stops and unregisters a RuntimeHost before deleting its workspace", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "autoagent-v2-delete-home-"));
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-v2-delete-ws-"));
    const app = await bootstrapServer({ port: 0, autoAgentHome: home, useMockProvider: true, providerRetryCount: 0 });
    registry = app.locals.runtimeHostRegistry as RuntimeHostRegistry;
    const workspaceResponse = await request(app).post("/api/workspaces").send({
      name: "Disposable host",
      rootPath: root,
      policyProfile: "development",
    }).expect(201);
    const workspaceId = workspaceResponse.body.workspace.id as string;
    await registry.snapshotByWorkspace(workspaceId);
    const stop = vi.spyOn(RuntimeHost.prototype, "stop");

    await request(app)
      .delete(`/api/workspaces/${workspaceId}`)
      .send({ deleteLocalFolder: false })
      .expect(200);

    expect(stop).toHaveBeenCalledTimes(1);
    await request(app).get(`/api/workspaces/${workspaceId}/snapshot`).expect(404);
  });
});

async function pollSnapshot(app: Parameters<typeof request>[0], workspaceId: string, ready: (snapshot: any) => boolean) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = await request(app).get(`/api/workspaces/${workspaceId}/snapshot`);
    if (response.status !== 200) {
      throw new Error(`Snapshot failed (${response.status}): ${JSON.stringify(response.body)}`);
    }
    const snapshot = response.body.snapshot;
    if (ready(snapshot)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for asynchronous Agent response");
}
