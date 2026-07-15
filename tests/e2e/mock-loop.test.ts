import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import type { RuntimeHostRegistry } from "../../src/server/runtime/runtime-host-registry.js";

describe("mock team loop E2E", () => {
  let registry: RuntimeHostRegistry | undefined;
  afterEach(() => registry?.stopAll());

  it("creates a workspace and completes one Mission Plan through public routes", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "autoagent-e2e-home-"));
    const app = createApp({ port: 0, autoAgentHome: home, useMockProvider: true, providerRetryCount: 0, maxTokensPerAgentGoalWindow: 250_000 });
    registry = app.locals.runtimeHostRegistry as RuntimeHostRegistry;
    const rootPath = await mkdtemp(path.join(os.tmpdir(), "autoagent-e2e-ws-"));

    const created = await request(app)
      .post("/api/workspaces")
      .send({ name: "E2E", rootPath, policyProfile: "development" })
      .expect(201);
    const workspaceId = created.body.workspace.id as string;

    const started = await request(app)
      .post(`/api/workspaces/${workspaceId}/tasks`)
      .send({ goal: "Build auth security checks demo" });
    if (started.status !== 201) throw new Error(`Task start failed (${started.status}): ${JSON.stringify(started.body)}`);

    const snapshot = await pollSnapshot(app, workspaceId);
    expect(snapshot.status).toBe("completed");
    expect(snapshot.phase).toBe("completed");
    expect(snapshot.mission).toMatchObject({
      missionId: expect.any(String),
      planId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
      planStatus: "completed",
      planVersion: expect.any(Number),
    });
    expect(snapshot.agents.map((agent: { roleInWorkspace: string }) => agent.roleInWorkspace)).toEqual(
      expect.arrayContaining(["boss", "pm", "architect", "dev", "qa"])
    );
    expect(snapshot.assignments).toEqual([]);
    expect(snapshot.tickets.map((ticket: { type: string }) => ticket.type)).toEqual(
      expect.arrayContaining(["boss_intake", "pm_plan", "implementation", "qa", "boss_acceptance"])
    );
    type TicketView = { id: string; type: string; dependsOnTicketIds: string[] };
    const ticketByType = new Map<string, TicketView>((snapshot.tickets as TicketView[]).map((ticket) => [ticket.type, ticket]));
    expect(ticketByType.get("pm_plan")?.dependsOnTicketIds).toEqual([ticketByType.get("boss_intake")?.id]);
    expect(ticketByType.get("implementation")?.dependsOnTicketIds).toEqual([ticketByType.get("pm_plan")?.id]);
    expect(ticketByType.get("qa")?.dependsOnTicketIds).toEqual([ticketByType.get("implementation")?.id]);
    expect(ticketByType.get("boss_acceptance")?.dependsOnTicketIds).toEqual([ticketByType.get("qa")?.id]);
    expect(Object.values(snapshot.agentThreads).flat().length).toBeGreaterThan(0);
  });
});

async function pollSnapshot(app: ReturnType<typeof createApp>, workspaceId: string) {
  let snapshot;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const response = await request(app).get(`/api/workspaces/${workspaceId}/snapshot`);
    if (response.status !== 200) throw new Error(`Snapshot failed (${response.status}): ${JSON.stringify(response.body)}`);
    snapshot = response.body.snapshot;
    if (snapshot.status === "completed") return snapshot;
    if (snapshot.status === "failed") return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Task did not finish. Last snapshot: ${JSON.stringify(snapshot)}`);
}
