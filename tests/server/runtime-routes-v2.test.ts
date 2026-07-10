import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrapServer } from "../../src/server/bootstrap.js";
import type { RuntimeHostRegistry } from "../../src/server/runtime/runtime-host-registry.js";

describe("V2 runtime public routes", () => {
  let registry: RuntimeHostRegistry | undefined;
  afterEach(() => registry?.stopAll());

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
    const started = await request(app).post(`/api/workspaces/${workspaceId}/tasks`).send({ goal: "构建演示" }).expect(201);
    const taskId = started.body.snapshot.activeTask.id as string;

    expect(started.body.snapshot.assignments).toEqual([]);
    expect(started.body.snapshot.tickets.length).toBeGreaterThan(0);

    const messageResponse = await request(app)
      .post(`/api/workspaces/${workspaceId}/tasks/${taskId}/agents/wa_architect/messages`)
      .send({ message: "请独立评估风险" });
    if (messageResponse.status !== 201) {
      throw new Error(`Private message failed (${messageResponse.status}): ${JSON.stringify(messageResponse.body)}`);
    }
    expect(messageResponse.body.snapshot.agentThreads.wa_architect.some((event: { kind: string }) => event.kind === "human_message")).toBe(true);
    const snapshot = await pollSnapshot(app, workspaceId, (value) => value.agentThreads.wa_architect.some((event: { kind: string }) => event.kind === "agent_message"));
    expect(snapshot.agentThreads.wa_architect.some((event: { kind: string }) => event.kind === "agent_message")).toBe(true);
  });
});

async function pollSnapshot(app: Parameters<typeof request>[0], workspaceId: string, ready: (snapshot: any) => boolean) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const snapshot = (await request(app).get(`/api/workspaces/${workspaceId}/snapshot`).expect(200)).body.snapshot;
    if (ready(snapshot)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for asynchronous Agent response");
}
