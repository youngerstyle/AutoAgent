import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer } from "../dist/server/server/bootstrap.js";

const home = await mkdtemp(path.join(os.tmpdir(), "autoagent-mission-provider-recovery-"));
const runtimeHome = path.join(home, "home");
const workspaceRoot = path.join(home, "workspace");
const previous = {
  autoAgentHome: process.env.AUTOAGENT_HOME,
  transientFailures: process.env.AUTOAGENT_MOCK_TRANSIENT_FAILURES,
};
let server;

try {
  // This is a test-only provider-boundary fault, not a production routing rule.
  process.env.AUTOAGENT_HOME = runtimeHome;
  process.env.AUTOAGENT_MOCK_TRANSIENT_FAILURES = "2";
  server = await startServer({
    port: 0,
    autoAgentHome: runtimeHome,
    useMockProvider: true,
    providerRetryCount: 2,
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const workspace = await requestJson(`${baseUrl}/api/workspaces`, {
    method: "POST",
    body: { name: "网关故障恢复验收", rootPath: workspaceRoot, policyProfile: "development" },
  });
  const workspaceId = workspace.workspace.id;
  const started = await requestJson(`${baseUrl}/api/workspaces/${workspaceId}/tasks`, {
    method: "POST",
    body: {
      title: "网关故障恢复验收",
      goal: "完成一个可追踪的 Mission，并证明模型服务临时失败后仍继续同一个任务，不重复创建 Ticket。",
    },
  });
  const taskId = started.snapshot.activeTask.id;
  const snapshot = await waitForTerminal(baseUrl, workspaceId, 90_000);
  assert.equal(snapshot.activeTask.id, taskId);
  assert.equal(snapshot.status, "completed", `Mission 未完成：${JSON.stringify(snapshot)}`);
  assert.equal(snapshot.phase, "completed");

  const ticketIds = snapshot.tickets.map((ticket) => ticket.id);
  assert.equal(new Set(ticketIds).size, ticketIds.length, "网关重试后出现重复 Ticket");
  assert.ok(snapshot.tickets.length > 0, "Mission 没有产生 Ticket");
  assert.ok(snapshot.tickets.every((ticket) => ticket.status === "completed"), "存在未完成 Ticket");
  const faultState = JSON.parse(await readFile(path.join(runtimeHome, ".mock-transient-provider-failures.json"), "utf8"));
  assert.equal(faultState.failedAttempts, 2, "没有实际经过两次上游临时失败");
  assert.equal(faultState.remaining, 0);

  console.log(JSON.stringify({
    passed: true,
    workspaceId,
    taskId,
    finalStatus: snapshot.status,
    planId: snapshot.mission?.planId,
    ticketCount: snapshot.tickets.length,
    transientGatewayFailures: faultState.failedAttempts,
    duplicateTicketIds: false,
  }));
} finally {
  if (server) await closeServer(server).catch(() => undefined);
  if (previous.autoAgentHome === undefined) delete process.env.AUTOAGENT_HOME;
  else process.env.AUTOAGENT_HOME = previous.autoAgentHome;
  if (previous.transientFailures === undefined) delete process.env.AUTOAGENT_MOCK_TRANSIENT_FAILURES;
  else process.env.AUTOAGENT_MOCK_TRANSIENT_FAILURES = previous.transientFailures;
  await rm(home, { recursive: true, force: true });
}

async function waitForTerminal(baseUrl, workspaceId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = await requestJson(`${baseUrl}/api/workspaces/${workspaceId}/snapshot`).then((body) => body.snapshot);
    if (["completed", "failed", "paused", "interrupted"].includes(latest.status)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Mission 未在 ${timeoutMs}ms 内结束：${JSON.stringify(latest)}`);
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

async function closeServer(value) {
  // Stop the application runtime before removing its persisted workspace.
  // Closing HTTP connections alone does not stop an in-flight RuntimeHost tick.
  await value.stopRuntimeHosts?.();
  value.closeAllConnections?.();
  await new Promise((resolve, reject) => {
    value.close((error) => error ? reject(error) : resolve());
  });
  await value.releaseInstanceLock?.();
}
