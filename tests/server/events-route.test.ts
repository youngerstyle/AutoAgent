import express from "express";
import { mkdtemp } from "node:fs/promises";
import { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEventRouter } from "../../src/server/routes/events";
import { EventLedger } from "../../src/server/storage/event-ledger";

describe("events route", () => {
  const servers: Array<{ close: () => void }> = [];

  afterEach(() => {
    for (const server of servers.splice(0)) server.close();
  });

  it("streams workspace events over SSE and removes listeners on disconnect", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-sse-"));
    const ledger = new EventLedger();
    const app = express();
    app.use("/api/workspaces/:workspaceId/events", createEventRouter(ledger));
    const server = app.listen(0);
    servers.push(server);
    const port = (server.address() as AddressInfo).port;

    const response = await fetch(`http://127.0.0.1:${port}/api/workspaces/ws_1/events`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(ledger.bus.listenerCount("workspace:ws_1")).toBe(1);

    await ledger.append(root, {
      workspaceId: "ws_1",
      taskId: "task_1",
      taskRunId: "tr_1",
      type: "agent.step_started",
      summary: "Dev is editing",
      payload: { agentId: "wa_dev", step: "Editing" }
    });

    const { chunk, reader } = await readUntil(response, "agent.step_started");
    expect(chunk).toContain("event: autoagent");
    expect(chunk).toContain("Dev is editing");

    await reader.cancel();
    await waitFor(() => ledger.bus.listenerCount("workspace:ws_1") === 0);
  });

  it("replays events after the Last-Event-ID cursor on reconnect", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-sse-replay-"));
    const ledger = new EventLedger();
    const first = await ledger.append(root, {
      workspaceId: "ws_replay",
      taskId: "task_1",
      taskRunId: "tr_1",
      type: "agent.step_started",
      summary: "first event",
      payload: { agentId: "wa_dev" },
    });
    const second = await ledger.append(root, {
      workspaceId: "ws_replay",
      taskId: "task_1",
      taskRunId: "tr_1",
      type: "agent.step_completed",
      summary: "second event",
      payload: { agentId: "wa_dev" },
    });
    const app = express();
    app.use("/api/workspaces/:workspaceId/events", createEventRouter(ledger, async () => root));
    const server = app.listen(0);
    servers.push(server);
    const port = (server.address() as AddressInfo).port;

    const response = await fetch(`http://127.0.0.1:${port}/api/workspaces/ws_replay/events`, {
      headers: { "Last-Event-ID": first.id },
    });
    expect(response.status).toBe(200);
    const { chunk, reader } = await readUntil(response, second.id);
    expect(chunk).toContain(second.id);
    expect(chunk).toContain("second event");
    expect(chunk).not.toContain(first.id);

    await reader.cancel();
    await waitFor(() => ledger.bus.listenerCount("workspace:ws_replay") === 0);
  });

  it("rebuilds the event stream after a server restart without replaying the cursor event", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-sse-restart-"));
    const ledger = new EventLedger();
    const first = await ledger.append(root, {
      workspaceId: "ws_restart",
      taskId: "task_1",
      taskRunId: "tr_1",
      type: "task.created",
      summary: "before restart",
      payload: {},
    });

    const appBeforeRestart = express();
    appBeforeRestart.use("/api/workspaces/:workspaceId/events", createEventRouter(ledger, async () => root));
    const serverBeforeRestart = appBeforeRestart.listen(0);
    const portBeforeRestart = (serverBeforeRestart.address() as AddressInfo).port;
    const firstResponse = await fetch(`http://127.0.0.1:${portBeforeRestart}/api/workspaces/ws_restart/events`, {
      headers: { "Last-Event-ID": "no-prior-event" },
    });
    const firstRead = await readUntil(firstResponse, first.id);
    expect(firstRead.chunk).toContain(first.id);
    await firstRead.reader.cancel();
    await waitFor(() => ledger.bus.listenerCount("workspace:ws_restart") === 0);
    await closeServer(serverBeforeRestart);

    const second = await ledger.append(root, {
      workspaceId: "ws_restart",
      taskId: "task_1",
      taskRunId: "tr_1",
      type: "run.completed",
      summary: "after restart",
      payload: {},
    });

    const appAfterRestart = express();
    appAfterRestart.use("/api/workspaces/:workspaceId/events", createEventRouter(ledger, async () => root));
    const serverAfterRestart = appAfterRestart.listen(0);
    servers.push(serverAfterRestart);
    const portAfterRestart = (serverAfterRestart.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${portAfterRestart}/api/workspaces/ws_restart/events`, {
      headers: { "Last-Event-ID": first.id },
    });
    const { chunk, reader } = await readUntil(response, second.id);
    expect(chunk).toContain(second.id);
    expect(chunk).not.toContain(first.id);
    await reader.cancel();
    await waitFor(() => ledger.bus.listenerCount("workspace:ws_restart") === 0);
  });

  it("does not duplicate events published while replay is in progress", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-sse-buffered-replay-"));
    const ledger = new EventLedger();
    const first = await ledger.append(root, {
      workspaceId: "ws_buffered",
      taskId: "task_1",
      taskRunId: "tr_1",
      type: "task.created",
      summary: "first event",
      payload: {},
    });
    await ledger.append(root, {
      workspaceId: "ws_buffered",
      taskId: "task_1",
      taskRunId: "tr_1",
      type: "agent.step_started",
      summary: "already persisted",
      payload: { agentId: "wa_dev" },
    });

    let resolverCalled = false;
    let releaseResolver!: () => void;
    const replayGate = new Promise<void>((resolve) => {
      releaseResolver = resolve;
    });
    const app = express();
    app.use("/api/workspaces/:workspaceId/events", createEventRouter(ledger, async () => {
      resolverCalled = true;
      await replayGate;
      return root;
    }));
    const server = app.listen(0);
    servers.push(server);
    const port = (server.address() as AddressInfo).port;

    const response = await fetch(`http://127.0.0.1:${port}/api/workspaces/ws_buffered/events`, {
      headers: { "Last-Event-ID": first.id },
    });
    await waitFor(() => resolverCalled);

    const buffered = await ledger.append(root, {
      workspaceId: "ws_buffered",
      taskId: "task_1",
      taskRunId: "tr_1",
      type: "run.completed",
      summary: "published during replay",
      payload: {},
    });
    releaseResolver();

    const { chunk, reader } = await readUntil(response, buffered.id);
    expect(chunk.match(new RegExp(`id: ${buffered.id}\\n`, "g")) ?? []).toHaveLength(1);
    expect(chunk).toContain("published during replay");

    await reader.cancel();
    await waitFor(() => ledger.bus.listenerCount("workspace:ws_buffered") === 0);
  });
});

async function readUntil(response: Response, pattern: string): Promise<{ chunk: string; reader: ReadableStreamDefaultReader<Uint8Array> }> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (let index = 0; index < 10; index += 1) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    if (buffer.includes(pattern)) return { chunk: buffer, reader };
  }
  return { chunk: buffer, reader };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for predicate");
}

async function closeServer(server: ReturnType<typeof express.application.listen>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
