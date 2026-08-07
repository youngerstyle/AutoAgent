import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer } from "../dist/server/server/bootstrap.js";

// Exercise the service-wide scheduler with several independent workspaces.
// This is intentionally a real server run; the Mock Provider only makes the
// model result deterministic so the test does not depend on a paid gateway.
const home = await mkdtemp(path.join(os.tmpdir(), "autoagent-runtime-soak-home-"));
const roots = await Promise.all(
  Array.from({ length: 8 }, async (_value, index) => {
    const root = path.join(home, `workspace-${index + 1}`);
    await mkdir(root, { recursive: true });
    return root;
  }),
);
let server;
let preserved = true;
const previous = {
  autoAgentHome: process.env.AUTOAGENT_HOME,
  holdGoal: process.env.AUTOAGENT_MOCK_HOLD_GOAL_ONCE_MS,
};

try {
  process.env.AUTOAGENT_HOME = home;
  process.env.AUTOAGENT_MOCK_HOLD_GOAL_ONCE_MS = "1500";
  server = await startServer({
    port: 0,
    autoAgentHome: home,
    useMockProvider: true,
    providerRetryCount: 0,
    runtimeRestoreConcurrency: 2,
    runtimeExecutionConcurrency: 2,
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const workspaces = await Promise.all(roots.map((root, index) => requestJson(`${baseUrl}/api/workspaces`, {
    method: "POST",
    body: { name: `Runtime soak ${index + 1}`, rootPath: root, policyProfile: "development" },
  })));
  const workspaceIds = workspaces.map((item) => item.workspace.id);
  const started = await Promise.all(workspaceIds.map((workspaceId, index) => requestJson(`${baseUrl}/api/workspaces/${workspaceId}/tasks`, {
    method: "POST",
    body: {
      title: `Runtime soak task ${index + 1}`,
      goal: "Produce a small verifiable delivery and finish the complete team workflow.",
    },
  })));
  const taskIds = started.map((item) => item.snapshot.activeTask.id);

  const completed = await waitUntil(async () => {
    const snapshots = await Promise.all(workspaceIds.map((id) => getSnapshot(baseUrl, id)));
    return snapshots.every((snapshot) => snapshot.status === "completed") ? snapshots : undefined;
  }, 120_000, "runtime soak tasks did not all complete");
  assert.equal(new Set(taskIds).size, taskIds.length, "duplicate task ids were created");
  assert.ok(completed.every((snapshot) => snapshot.tickets.length > 0), "a workspace completed without Tickets");
  assert.ok(completed.every((snapshot) => uniqueTicketIds(snapshot)), "duplicate Ticket ids in a workspace");

  await closeServer(server);
  server = await startServer({
    port: 0,
    autoAgentHome: home,
    useMockProvider: true,
    providerRetryCount: 0,
    runtimeRestoreConcurrency: 2,
    runtimeExecutionConcurrency: 2,
  });
  const restoredBaseUrl = `http://127.0.0.1:${server.address().port}`;
  const health = await waitUntil(async () => {
    const response = await requestJson(`${restoredBaseUrl}/api/health`);
    return response.ready && Number.isInteger(response.runtimeHosts?.restoredWorkspaceCount) ? response : undefined;
  }, 20_000, "service did not become ready after restart");
  const restored = await Promise.all(workspaceIds.map((id) => getSnapshot(restoredBaseUrl, id)));
  assert.equal(health.runtimeHosts.restoredWorkspaceCount, 0, "terminal work was re-entered into scheduling");
  assert.equal(restored.length, workspaceIds.length, "not every workspace remained readable after restart");
  assert.ok(restored.every((snapshot) => snapshot.status === "completed"), "restored terminal work re-entered scheduling");
  assert.ok(restored.every((snapshot) => uniqueTicketIds(snapshot)), "restored workspace contains duplicate Ticket ids");

  const reportFile = path.join(home, "runtime-soak-report.json");
  await writeFile(reportFile, JSON.stringify({
    passed: true,
    workspaceCount: workspaceIds.length,
    taskIds,
    completedWorkspaceCount: completed.length,
    restoredWorkspaceCount: health.runtimeHosts.restoredWorkspaceCount,
    restoredStatuses: restored.map((snapshot) => snapshot.status),
    reportFile,
  }, null, 2), "utf8");
  console.log(JSON.stringify({
    passed: true,
    workspaceCount: workspaceIds.length,
    completedWorkspaceCount: completed.length,
    restoredWorkspaceCount: health.runtimeHosts.restoredWorkspaceCount,
    reportFile,
  }));
  preserved = false;
} finally {
  if (server) await closeServer(server).catch(() => undefined);
  if (previous.autoAgentHome === undefined) delete process.env.AUTOAGENT_HOME;
  else process.env.AUTOAGENT_HOME = previous.autoAgentHome;
  if (previous.holdGoal === undefined) delete process.env.AUTOAGENT_MOCK_HOLD_GOAL_ONCE_MS;
  else process.env.AUTOAGENT_MOCK_HOLD_GOAL_ONCE_MS = previous.holdGoal;
  if (!preserved) await rm(home, { recursive: true, force: true });
  else console.error(`runtime soak artifacts preserved at ${home}`);
}

async function getSnapshot(baseUrl, workspaceId) {
  return (await requestJson(`${baseUrl}/api/workspaces/${workspaceId}/snapshot`)).snapshot;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers: { "content-type": "application/json" },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const body = await response.json();
  assert.equal(response.ok, true, JSON.stringify(body));
  return body;
}

async function waitUntil(read, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = await read();
    if (latest) return latest;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${message}: ${JSON.stringify(latest)}`);
}

function uniqueTicketIds(snapshot) {
  return new Set(snapshot.tickets.map((ticket) => ticket.id)).size === snapshot.tickets.length;
}

async function closeServer(value) {
  await value.stopRuntimeHosts?.();
  value.closeAllConnections?.();
  await new Promise((resolve, reject) => value.close((error) => error ? reject(error) : resolve()));
  await value.releaseInstanceLock?.();
}
