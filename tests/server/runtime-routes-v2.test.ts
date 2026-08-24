import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootstrapServer } from "../../src/server/bootstrap.js";
import { RuntimeHost } from "../../src/server/runtime/runtime-host.js";
import type { RuntimeHostRegistry } from "../../src/server/runtime/runtime-host-registry.js";
import { RuntimeHostStore } from "../../src/server/runtime/runtime-host-store.js";
import { TrialWorkspaceIsolationManager, trialIsolationBaseRoot, type TrialExecutionWorkspace } from "../../src/server/evolution-adapters/trial-workspace-isolation.js";

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

  it("stores paired-trial Runtime state in a physical arm workspace while retaining the logical workspace id", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "autoagent-v2-trial-home-"));
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-v2-trial-ws-"));
    await writeFile(path.join(root, "project.txt"), "frozen source", "utf8");
    const app = await bootstrapServer({ port: 0, autoAgentHome: home, useMockProvider: true, providerRetryCount: 0 });
    registry = app.locals.runtimeHostRegistry as RuntimeHostRegistry;
    const workspaceResponse = await request(app).post("/api/workspaces").send({
      name: "Isolated trial",
      rootPath: root,
      policyProfile: "development",
    }).expect(201);
    const workspaceId = workspaceResponse.body.workspace.id as string;
    const isolation = new TrialWorkspaceIsolationManager(root, { baseRoot: trialIsolationBaseRoot(home, root) });
    const execution = (await isolation.prepare("trial-runtime-isolation", 1, [{ caseId: "target" }])).get("target")!.baseline;
    expect(path.resolve(execution.rootPath).startsWith(`${path.resolve(root)}${path.sep}`)).toBe(false);
    const internals = registry as unknown as {
      startEvolutionTrialRuntimeTask(input: {
        workspaceId: string; taskId: string; title: string; objective: string; execution: TrialExecutionWorkspace;
        trial: { trialId: string; caseId: string; group: "target"; assertions: string[]; variant: "baseline"; candidateId: string; candidateHash: string; baselineRef: { id: string; version: string; contentHash: string } };
      }): Promise<void>;
      releaseEvolutionTrialRuntimeTask(input: { workspaceId: string; taskId: string; execution: TrialExecutionWorkspace }): Promise<void>;
      trialHosts: Map<string, RuntimeHost>;
    };
    const taskId = "trial-task-isolated-runtime";
    const startInput: Parameters<typeof internals.startEvolutionTrialRuntimeTask>[0] = {
      workspaceId, taskId, title: "isolated baseline", objective: "inspect the frozen project",
      execution,
      trial: {
        trialId: "trial-runtime-isolation", caseId: "target", group: "target", assertions: ["project remains readable"],
        variant: "baseline", candidateId: "candidate-a", candidateHash: "a".repeat(64),
        baselineRef: { id: "builtin:minimal-team", version: "1", contentHash: "b".repeat(64) },
      },
    };
    await internals.startEvolutionTrialRuntimeTask(startInput);

    expect(await new RuntimeHostStore(root).get(taskId)).toBeUndefined();
    expect(await new RuntimeHostStore(execution.rootPath).get(taskId)).toMatchObject({ taskId, evolutionTrial: { trialId: "trial-runtime-isolation" } });
    expect(await readFile(path.join(execution.rootPath, "project.txt"), "utf8")).toBe("frozen source");
    expect(internals.trialHosts.size).toBe(1);

    await internals.releaseEvolutionTrialRuntimeTask({ workspaceId, taskId, execution });
    expect(internals.trialHosts.size).toBe(0);
    await internals.startEvolutionTrialRuntimeTask(startInput);
    expect(internals.trialHosts.size).toBe(1);
    expect((await new RuntimeHostStore(execution.rootPath).list()).filter((item) => item.taskId === taskId)).toHaveLength(1);
    await internals.releaseEvolutionTrialRuntimeTask({ workspaceId, taskId, execution });
    await isolation.cleanupGeneration("trial-runtime-isolation", 1);
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
