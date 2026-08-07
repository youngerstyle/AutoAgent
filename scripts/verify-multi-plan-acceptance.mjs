import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer } from "../dist/server/server/bootstrap.js";

// This is a real Mission Control/Ticket Engine run against the real server and
// a deterministic Mock Provider. The provider injects one domain conclusion:
// the final acceptance asks for a Plan revision. It does not inject a route or
// mutate Ticket state; the normal Agent -> Mission Control -> Ticket Engine
// protocol must create and execute the new Plan version.
const home = await mkdtemp(path.join(os.tmpdir(), "autoagent-multi-plan-acceptance-"));
const runtimeHome = path.join(home, "home");
const workspaceRoot = path.join(home, "workspace");
const previous = {
  autoAgentHome: process.env.AUTOAGENT_HOME,
  forcePlanChange: process.env.AUTOAGENT_MOCK_FORCE_PLAN_CHANGE_ONCE,
};
let server;

try {
  process.env.AUTOAGENT_HOME = runtimeHome;
  process.env.AUTOAGENT_MOCK_FORCE_PLAN_CHANGE_ONCE = "1";
  server = await startServer({
    port: 0,
    autoAgentHome: runtimeHome,
    useMockProvider: true,
    providerRetryCount: 0,
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const workspace = await requestJson(`${baseUrl}/api/workspaces`, {
    method: "POST",
    body: { name: "多版本计划验收", rootPath: workspaceRoot, policyProfile: "development" },
  });
  const workspaceId = workspace.workspace.id;
  const started = await requestJson(`${baseUrl}/api/workspaces/${workspaceId}/tasks`, {
    method: "POST",
    body: {
      title: "多版本计划验收",
      goal: "完成一个可追踪的 Mission，并在最终验收阶段根据 Agent 的事实结论追加一个新的可验证交付增量。",
    },
  });
  const taskId = started.snapshot.activeTask.id;
  const initialPlanVersion = started.snapshot.mission?.planVersion ?? 0;
  const initialTicketCount = started.snapshot.tickets?.length ?? 0;
  const snapshot = await waitForTerminal(baseUrl, workspaceId, 90_000);

  assert.equal(snapshot.activeTask.id, taskId);
  assert.equal(snapshot.status, "completed", `多版本 Mission 未完成：${JSON.stringify(snapshot)}`);
  assert.equal(snapshot.phase, "completed");
  assert.ok((snapshot.mission?.planVersion ?? 0) > initialPlanVersion, "没有产生新的 Plan 版本");
  assert.ok(snapshot.tickets.length > initialTicketCount, "Plan 修订后没有新增 Ticket");
  assert.equal(new Set(snapshot.tickets.map((ticket) => ticket.id)).size, snapshot.tickets.length, "出现重复 Ticket ID");
  assert.ok(
    snapshot.tickets.some((ticket) => ticket.status === "returned"),
    "没有观察到原验收工单保留为历史返回状态",
  );
  assert.ok(
    snapshot.tickets.filter((ticket) => ticket.status === "completed").length >= 5,
    "修订后的新交付链没有全部完成",
  );
  assert.ok(
    snapshot.tickets.some((ticket) => ticket.parentTicketId),
    "没有观察到新增 Ticket 与计划修订来源建立父子关系",
  );

  const reportFile = path.join(workspaceRoot, ".autoagent", "multi-plan-acceptance.json");
  await writeJson(reportFile, {
    passed: true,
    workspaceId,
    taskId,
    initialPlanVersion,
    initialTicketCount,
    finalPlanVersion: snapshot.mission?.planVersion,
    finalStatus: snapshot.status,
    ticketCount: snapshot.tickets.length,
    completedTicketCount: snapshot.tickets.filter((ticket) => ticket.status === "completed").length,
    returnedTicketCount: snapshot.tickets.filter((ticket) => ticket.attempts?.some((attempt) => attempt.status === "returned")).length,
    workspaceRoot,
  });
  console.log(JSON.stringify({
    passed: true,
    workspaceId,
    taskId,
    initialPlanVersion,
    finalPlanVersion: snapshot.mission?.planVersion,
    finalStatus: snapshot.status,
    ticketCount: snapshot.tickets.length,
    reportFile,
  }));
} finally {
  if (server) await closeServer(server).catch(() => undefined);
  if (previous.autoAgentHome === undefined) delete process.env.AUTOAGENT_HOME;
  else process.env.AUTOAGENT_HOME = previous.autoAgentHome;
  if (previous.forcePlanChange === undefined) delete process.env.AUTOAGENT_MOCK_FORCE_PLAN_CHANGE_ONCE;
  else process.env.AUTOAGENT_MOCK_FORCE_PLAN_CHANGE_ONCE = previous.forcePlanChange;
}

async function waitForTerminal(baseUrl, workspaceId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  let lastSignature = "";
  while (Date.now() < deadline) {
    latest = await requestJson(`${baseUrl}/api/workspaces/${workspaceId}/snapshot`).then((body) => body.snapshot);
    const signature = [
      latest.status,
      latest.mission?.planVersion,
      latest.tickets.map((ticket) => `${ticket.brief}:${ticket.status}`).join(","),
    ].join(" | ");
    if (signature !== lastSignature) {
      console.log(`[多版本验收] ${signature}`);
      lastSignature = signature;
    }
    if (["completed", "failed", "paused", "interrupted"].includes(latest.status)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`多版本 Mission 未在 ${timeoutMs}ms 内结束：${JSON.stringify(latest)}`);
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

async function writeJson(file, value) {
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function closeServer(value) {
  value.closeAllConnections?.();
  await new Promise((resolve, reject) => {
    value.close((error) => error ? reject(error) : resolve());
  });
}
