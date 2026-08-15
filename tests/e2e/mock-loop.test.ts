import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import type { RuntimeHostRegistry } from "../../src/server/runtime/runtime-host-registry.js";
import { WorkspaceStore } from "../../src/server/storage/workspace-store.js";
import { EvolutionCoordinator } from "../../src/server/evolution/evolution-coordinator.js";
import { PlatformEvolutionObservationAdapter } from "../../src/server/evolution-adapters/platform-observation-adapter.js";
import { PlatformEvolutionSourceVerifier } from "../../src/server/evolution-adapters/platform-source-verifier.js";
import { ExperienceStore } from "../../src/server/evolution/experience-store.js";
import { EvolutionSignalStore } from "../../src/server/evolution/evolution-signal-store.js";

describe("mock team loop E2E", () => {
  let registry: RuntimeHostRegistry | undefined;
  afterEach(async () => { await registry?.stopAll(); });

  it("creates a workspace and completes one Mission Plan through public routes", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "autoagent-e2e-home-"));
    const app = createApp({ port: 0, autoAgentHome: home, useMockProvider: true, providerRetryCount: 0 });
    registry = app.locals.runtimeHostRegistry as RuntimeHostRegistry;
    const rootPath = await mkdtemp(path.join(os.tmpdir(), "autoagent-e2e-ws-"));

    const created = await request(app)
      .post("/api/workspaces")
      .send({ name: "E2E", rootPath, policyProfile: "development" })
      .expect(201);
    const workspaceId = created.body.workspace.id as string;
    const profiles = await request(app).get("/api/agent-profiles").expect(200);
    for (const profile of profiles.body.profiles.filter((item: { id: string }) => item.id !== "prof_boss")) {
      await request(app)
        .post(`/api/workspaces/${workspaceId}/agents`)
        .send({ profileId: profile.id })
        .expect(201);
    }

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
    type TicketView = { id: string; type: string; status: string; targetAgentId?: string; dependsOnTicketIds: string[] };
    const tickets = snapshot.tickets as TicketView[];
    expect(tickets).toHaveLength(5);
    expect(tickets.every((ticket) => ticket.type === "work" && ticket.status === "completed" && ticket.targetAgentId)).toBe(true);
    for (let index = 1; index < tickets.length; index += 1) {
      expect(tickets[index].dependsOnTicketIds).toEqual([tickets[index - 1].id]);
    }
    expect(Object.values(snapshot.agentThreads).flat().length).toBeGreaterThan(0);

    // Freeze the operational side, then prove Evol consumes the same durable
    // Mission/Ticket/Agent facts through its anti-corruption adapter.
    await registry.stopAll();
    registry = undefined;
    const workspaces = new WorkspaceStore(home);
    const coordinator = new EvolutionCoordinator(workspaces, {
      observationPort: (workspace) => new PlatformEvolutionObservationAdapter(workspace),
      sourceVerificationPort: (workspace) => new PlatformEvolutionSourceVerifier(workspace.id, workspace.rootPath),
      maintenanceIntervalMs: 10_000,
      workerId: "four-framework-e2e",
    });
    await coordinator.runOnce();

    const episodes = await new ExperienceStore(workspaceId, rootPath).listEpisodes();
    expect(episodes).toHaveLength(tickets.length);
    expect(new Set(episodes.map((episode) => episode.ticketId))).toEqual(new Set(tickets.map((ticket) => ticket.id)));
    expect(episodes.every((episode) => episode.outcome === "succeeded" && episode.agentId && episode.goalId)).toBe(true);
    expect(episodes.every((episode) => episode.sourceRefs.some((ref) => ref.kind === "mission" && ref.ref === snapshot.mission.missionId))).toBe(true);
    expect(episodes.every((episode) => episode.sourceRefs.some((ref) => ref.kind === "ticket" && ref.ref === episode.ticketId))).toBe(true);

    const signals = await new EvolutionSignalStore(workspaceId, rootPath).list();
    expect(signals).toHaveLength(episodes.length);
    expect(signals.every((signal) => signal.trigger === "terminal_outcome" && signal.episodeId)).toBe(true);
  }, 120_000);
});

async function pollSnapshot(app: ReturnType<typeof createApp>, workspaceId: string) {
  let snapshot;
  const deadline = Date.now() + 90_000;
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
