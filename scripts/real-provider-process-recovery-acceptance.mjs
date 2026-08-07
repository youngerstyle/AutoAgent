import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const projectRoot = path.resolve(".");
const sourceHome = process.env.AUTOAGENT_HOME
  ? path.resolve(process.env.AUTOAGENT_HOME)
  : path.join(os.homedir(), ".autoagent");
const workspaceRoot = process.env.AUTOAGENT_REAL_RECOVERY_ROOT
  ?? await mkdtemp(path.join(os.tmpdir(), "autoagent-real-process-recovery-ws-"));
const home = await mkdtemp(path.join(os.tmpdir(), "autoagent-real-process-recovery-home-"));
const port = await reservePort();
const baseUrl = `http://127.0.0.1:${port}`;
const timeoutMs = Number(process.env.AUTOAGENT_REAL_RECOVERY_TIMEOUT_MS ?? 30 * 60_000);
const goal = process.env.AUTOAGENT_REAL_RECOVERY_GOAL ?? [
  "在当前工作目录创建一个可以直接用浏览器打开的中文 HTML 交付物。",
  "页面需要有清晰标题、三段可读内容和更新时间，并确认文件确实写入工作区。",
  "完成前请读取并检查最终文件；只有真实交付物满足目标后，才提交完成结论。",
].join(" ");

let first;
let second;
let workspace;
let taskId;
let crashedSnapshot;
let restartedSnapshot;
let selectedAgentId;
let selectedThreadId;
let humanMessage;
let finalSnapshot;

try {
  await prepareIsolatedHome();
  first = spawnServer();
  await waitForHealth(first);
  workspace = (await api("/api/workspaces", {
    method: "POST",
    body: {
      name: `真实 Provider 重启恢复 ${new Date().toISOString()}`,
      rootPath: workspaceRoot,
      policyProfile: "development",
    },
  })).workspace;

  const started = await api(`/api/workspaces/${workspace.id}/tasks`, {
    method: "POST",
    body: { title: "真实 Provider 进程恢复验收", goal },
  });
  taskId = started.snapshot.activeTask?.id;
  assert.ok(taskId, "任务创建没有返回 taskId");

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    crashedSnapshot = (await api(`/api/workspaces/${workspace.id}/snapshot`)).snapshot;
    const running = (crashedSnapshot.agents ?? []).find((agent) => agent.status === "running");
    if (running) {
      selectedAgentId = running.id;
      selectedThreadId = findLatestThreadId(crashedSnapshot, selectedAgentId);
      if (selectedThreadId) break;
    }
    if (["completed", "failed", "paused", "interrupted"].includes(crashedSnapshot.status)) {
      throw new Error(`任务在重启前已经结束，无法验证运行中恢复：${JSON.stringify(crashedSnapshot)}`);
    }
    const blockedPlan = (crashedSnapshot.tickets ?? []).find((ticket) => ticket.status === "blocked");
    const activeAgents = crashedSnapshot.agents ?? [];
    if (blockedPlan && !activeAgents.some((agent) => ["running", "waiting"].includes(agent.status))) {
      throw new Error(`任务在重启前已进入阻塞且没有活动 Agent，无法验证运行中恢复：${JSON.stringify({ ticket: blockedPlan, agents: activeAgents })}`);
    }
    await sleep(1_000);
  }
  assert.ok(selectedAgentId && selectedThreadId, `没有观察到真实 Agent 正在工作：${JSON.stringify(crashedSnapshot)}`);

  humanMessage = await sendAgentMessage(
    selectedAgentId,
    "这是服务重启前进入当前 Agent Thread 的事实：最终交付必须保留中文标题，并在完成前重新读取文件。",
  );
  crashedSnapshot = (await api(`/api/workspaces/${workspace.id}/snapshot`)).snapshot;
  assert.equal(crashedSnapshot.activeTask?.id, taskId, "崩溃前任务 ID 发生变化");

  await terminateServer(first);
  first = undefined;

  second = spawnServer();
  await waitForHealth(second);
  restartedSnapshot = await waitUntil(async () => {
    const current = (await api(`/api/workspaces/${workspace.id}/snapshot`)).snapshot;
    const currentThreadId = findLatestThreadId(current, selectedAgentId);
    return currentThreadId === selectedThreadId && current.status !== "failed" ? current : undefined;
  }, 60_000, "服务重启后没有恢复原 Agent Thread");
  assert.equal(restartedSnapshot.activeTask?.id, taskId, "服务重启后任务 ID 发生变化");
  assert.equal(findLatestThreadId(restartedSnapshot, selectedAgentId), selectedThreadId, "服务重启后切换了 Agent Thread");
  assert.ok(hasHumanMessage(restartedSnapshot, selectedAgentId, humanMessage.messageId), "服务重启后丢失了重启前的人类消息");

  finalSnapshot = await waitUntil(async () => {
    const current = (await api(`/api/workspaces/${workspace.id}/snapshot`)).snapshot;
    return current.status === "completed" ? current : undefined;
  }, timeoutMs, "服务重启后真实任务没有完成");
  assert.equal(finalSnapshot.activeTask?.id, taskId, "最终任务 ID 发生变化");
  assert.equal(new Set((finalSnapshot.tickets ?? []).map((ticket) => ticket.id)).size, (finalSnapshot.tickets ?? []).length, "服务重启后出现重复 Ticket");
  assert.ok((finalSnapshot.tickets ?? []).length > 0, "最终没有可审计 Ticket");
  assert.ok((finalSnapshot.tickets ?? []).every((ticket) => ["completed", "returned", "cancelled"].includes(ticket.status)), "最终存在未关闭 Ticket");
  assert.equal((finalSnapshot.agents ?? []).some((agent) => agent.status === "running"), false, "任务完成后仍有 Agent 在运行");

  const artifact = await inspectArtifact(workspaceRoot);
  const report = {
    passed: true,
    generatedAt: new Date().toISOString(),
    baseUrl,
    sourceHome,
    workspace: { id: workspace.id, rootPath: workspaceRoot },
    taskId,
    agentId: selectedAgentId,
    threadId: selectedThreadId,
    humanMessage,
    crashedStatus: crashedSnapshot?.status,
    restartedStatus: restartedSnapshot.status,
    finalStatus: finalSnapshot.status,
    ticketCount: finalSnapshot.tickets?.length ?? 0,
    artifact,
  };
  const reportFile = path.join(workspaceRoot, ".autoagent", "user-acceptance", "real-process-recovery-report.json");
  await mkdir(path.dirname(reportFile), { recursive: true });
  await writeFile(reportFile, JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify({ ...report, reportFile }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    passed: false,
    baseUrl,
    workspace: workspace ? { id: workspace.id, rootPath: workspaceRoot } : { rootPath: workspaceRoot },
    taskId,
    agentId: selectedAgentId,
    threadId: selectedThreadId,
    crashedStatus: crashedSnapshot?.status,
    restartedStatus: restartedSnapshot?.status,
    finalStatus: finalSnapshot?.status,
    error: error instanceof Error ? error.stack ?? error.message : String(error),
  }, null, 2));
  process.exitCode = 1;
} finally {
  await terminateServer(first).catch(() => undefined);
  await terminateServer(second).catch(() => undefined);
  if (!process.env.AUTOAGENT_REAL_RECOVERY_ROOT) await rm(workspaceRoot, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
}

async function prepareIsolatedHome() {
  await mkdir(home, { recursive: true });
  for (const file of ["providers.json", "agent-profiles.json"]) {
    const source = path.join(sourceHome, file);
    if (!existsSync(source)) throw new Error(`真实 Provider 验收缺少配置文件：${source}`);
    await copyFile(source, path.join(home, file));
  }
}

function spawnServer() {
  const env = {
    ...process.env,
    AUTOAGENT_HOME: home,
    AUTOAGENT_PROVIDER: undefined,
    NODE_ENV: "production",
    PORT: String(port),
    AUTOAGENT_PROVIDER_RETRIES: process.env.AUTOAGENT_PROVIDER_RETRIES ?? "2",
  };
  const child = spawn(process.execPath, [path.join(projectRoot, "dist/server/server/index.js")], {
    cwd: projectRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.output = { stdout: "", stderr: "" };
  child.stdout.on("data", (chunk) => { child.output.stdout = `${child.output.stdout}${chunk}`.slice(-8_000); });
  child.stderr.on("data", (chunk) => { child.output.stderr = `${child.output.stderr}${chunk}`.slice(-8_000); });
  return child;
}

async function terminateServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await waitForExit(child);
}

async function waitForHealth(child) {
  await waitUntil(async () => {
    if (child.exitCode !== null) {
      throw new Error(`服务提前退出：exitCode=${child.exitCode}, signal=${child.signalCode ?? "none"}\n${child.output.stdout}\n${child.output.stderr}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      const body = await response.json();
      return response.ok && body.ready === true;
    } catch {
      return false;
    }
  }, 30_000, "真实 Provider 恢复验收服务没有启动");
}

function findLatestThreadId(snapshot, agentId) {
  const events = snapshot.agentThreads?.[agentId] ?? [];
  return [...events].reverse().map((event) => event.threadId ?? event.payload?.threadId).find(Boolean);
}

function hasHumanMessage(snapshot, agentId, messageId) {
  return (snapshot.agentThreads?.[agentId] ?? []).some((event) => event.kind === "human_message" && event.payload?.messageId === messageId);
}

async function sendAgentMessage(agentId, message) {
  const messageId = crypto.randomUUID();
  await api(`/api/workspaces/${workspace.id}/tasks/${taskId}/agents/${agentId}/messages`, {
    method: "POST",
    body: { message, messageId },
  });
  return { messageId, sentAt: new Date().toISOString() };
}

async function inspectArtifact(root) {
  const htmlPath = await findHtmlEntryPath(root);
  assert.ok(htmlPath, "真实任务没有生成 HTML 交付物");
  const html = await readFile(htmlPath, "utf8");
  assert.match(html, /<html/i, `交付物不是有效 HTML：${htmlPath}`);
  assert.ok(html.replace(/<[^>]+>/g, " ").trim().length > 20, "HTML 交付物没有可读内容");
  return { path: htmlPath, bytes: Buffer.byteLength(html), bodyTextLength: html.replace(/<[^>]+>/g, " ").trim().length };
}

async function findHtmlEntryPath(root) {
  const indexPath = path.join(root, "index.html");
  if (existsSync(indexPath)) return indexPath;
  const entries = await readdir(root, { withFileTypes: true });
  const html = entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".html"));
  return html.length === 1 ? path.join(root, html[0].name) : undefined;
}

async function reservePort() {
  const { createServer } = await import("node:net");
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  const value = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return value;
}

async function waitUntil(read, timeout, message) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await sleep(1_000);
  }
  throw new Error(message);
}

async function waitForExit(child) {
  if (child.exitCode !== null) return;
  await new Promise((resolve) => child.once("exit", resolve));
}

async function api(endpoint, options = {}) {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method: options.method ?? "GET",
    headers: { "content-type": "application/json" },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const body = await response.json().catch(() => ({}));
  assert.equal(response.ok, true, `${options.method ?? "GET"} ${endpoint} failed: ${JSON.stringify(body)}`);
  return body;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
