import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-process-recovery-ws-"));
const home = await mkdtemp(path.join(os.tmpdir(), "autoagent-process-recovery-home-"));
const port = await reservePort();
const env = {
  ...process.env,
  AUTOAGENT_HOME: home,
  AUTOAGENT_PROVIDER: "mock",
  AUTOAGENT_PROVIDER_RETRIES: "0",
  AUTOAGENT_MOCK_HOLD_GOAL_ONCE_MS: "120000",
  PORT: String(port),
};

let first = spawnServer(env);
try {
  await waitForHealth(port, first);
  const workspace = await postJson(`/api/workspaces`, {
    name: "进程恢复验收",
    rootPath: root,
    policyProfile: "development",
  });
  const workspaceId = workspace.workspace.id;
  const started = await postJson(`/api/workspaces/${workspaceId}/tasks`, {
    title: "进程崩溃恢复",
    goal: "验证服务异常退出后仍能继续完成一个真实任务",
  });
  const taskId = started.snapshot.activeTask.id;
  await waitUntil(async () => {
    const snapshot = await getJson(`/api/workspaces/${workspaceId}/snapshot`);
    return Boolean(snapshot.snapshot.mission?.missionId && snapshot.snapshot.status === "running");
  }, 20_000, "Mission 未在进程终止前进入运行态");

  // The mock provider has persisted its once-only marker and is holding the
  // first Goal turn. Killing the process simulates an actual crash window.
  await waitForFile(path.join(home, ".mock-goal-hold-consumed"), 20_000);
  const beforeCrash = await getJson(`/api/workspaces/${workspaceId}/snapshot`);
  if (beforeCrash.snapshot.activeTask.id !== taskId) throw new Error("崩溃前任务 ID 不一致");
  first.kill();
  await waitForExit(first);

  first = spawnServer(env);
  await waitForHealth(port, first);
  const restored = await waitUntil(async () => {
    const snapshot = await getJson(`/api/workspaces/${workspaceId}/snapshot`);
    return snapshot.snapshot.status === "completed" ? snapshot : undefined;
  }, 60_000, "服务重启后任务没有自然恢复到完成");
  const finalSnapshot = restored;
  const taskRuns = finalSnapshot.snapshot.tickets ?? [];
  const mission = finalSnapshot.snapshot.mission;
  if (finalSnapshot.snapshot.activeTask.id !== taskId) throw new Error("恢复后任务 ID 发生变化");
  if (!mission?.missionId || !mission.planId) throw new Error("恢复后缺少 Mission/Plan 身份");
  if (new Set(taskRuns.map((ticket) => ticket.id)).size !== taskRuns.length) throw new Error("恢复后出现重复 Ticket");
  if (taskRuns.length === 0 || taskRuns.some((ticket) => ticket.status !== "completed")) {
    throw new Error(`恢复后 Ticket 未全部完成: ${JSON.stringify(taskRuns)}`);
  }
  const report = {
    passed: true,
    generatedAt: new Date().toISOString(),
    scenario: "process_crash_before_mission_settlement",
    taskId,
    missionId: mission.missionId,
    planId: mission.planId,
    ticketCount: taskRuns.length,
    status: finalSnapshot.snapshot.status,
  };
  const reportFile = path.join(os.tmpdir(), "autoagent-process-recovery-report.json");
  await writeFile(reportFile, JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify({ ...report, reportFile }, null, 2));
} finally {
  first.kill();
  await waitForExit(first).catch(() => undefined);
  await rm(home, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
}

function spawnServer(serverEnv) {
  const child = spawn(process.execPath, [path.resolve("dist/server/server/index.js")], {
    cwd: path.resolve("."),
    env: serverEnv,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.output = { stdout: "", stderr: "" };
  child.stdout.on("data", (chunk) => {
    child.output.stdout = `${child.output.stdout}${chunk}`.slice(-4_000);
    process.stderr.write(`[server] ${chunk}`);
  });
  child.stderr.on("data", (chunk) => {
    child.output.stderr = `${child.output.stderr}${chunk}`.slice(-4_000);
    process.stderr.write(`[server:error] ${chunk}`);
  });
  return child;
}

async function reservePort() {
  const { createServer } = await import("node:net");
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForHealth(port, child) {
  await waitUntil(async () => {
    if (child.exitCode !== null) {
      throw new Error(`服务进程提前退出：exitCode=${child.exitCode}, signal=${child.signalCode ?? "none"}\nstdout:\n${child.output.stdout}\nstderr:\n${child.output.stderr}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      const body = await response.json();
      return response.ok && body.ready === true;
    } catch {
      return false;
    }
  }, 20_000, `服务没有启动；进程状态 exitCode=${child.exitCode ?? "running"}, signal=${child.signalCode ?? "none"}\nstdout:\n${child.output.stdout}\nstderr:\n${child.output.stderr}`);
}

async function waitForFile(file, timeoutMs) {
  await waitUntil(async () => {
    try { await import("node:fs/promises").then(({ access }) => access(file)); return true; } catch { return false; }
  }, timeoutMs, `未发现持久化边界文件: ${file}`);
}

async function waitUntil(read, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(message);
}

async function waitForExit(child) {
  if (child.exitCode !== null) return;
  await new Promise((resolve) => child.once("exit", resolve));
}

async function getJson(route) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`);
  const body = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function postJson(route, payload) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(body)}`);
  return body;
}
