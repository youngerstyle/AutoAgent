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
