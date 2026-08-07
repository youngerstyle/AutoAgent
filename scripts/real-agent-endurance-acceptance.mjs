import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const projectRoot = path.resolve(".");
const sourceHome = process.env.AUTOAGENT_HOME
  ? path.resolve(process.env.AUTOAGENT_HOME)
  : path.join(os.homedir(), ".autoagent");
const useExternalServer = process.env.AUTOAGENT_ENDURANCE_SERVER === "external";
const isolatedHome = useExternalServer
  ? undefined
  : await mkdtemp(path.join(os.tmpdir(), "autoagent-real-endurance-home-"));
const port = useExternalServer ? undefined : await reservePort();
const baseUrl = useExternalServer
  ? process.env.AUTOAGENT_BASE_URL ?? "http://127.0.0.1:13748"
  : `http://127.0.0.1:${port}`;
const timeoutMs = Number(process.env.AUTOAGENT_ENDURANCE_TIMEOUT_MS ?? 30 * 60_000);
const queuedMessageCount = Number(process.env.AUTOAGENT_ENDURANCE_MESSAGE_COUNT ?? 8);
assert.ok(Number.isInteger(queuedMessageCount) && queuedMessageCount >= 4 && queuedMessageCount <= 8, "真实耐久验收消息数必须在 4 到 8 条之间");
const workspaceRoot = process.env.AUTOAGENT_ENDURANCE_ROOT
  ?? await mkdtemp(path.join(os.tmpdir(), "autoagent-real-endurance-"));
const reportDir = path.join(workspaceRoot, ".autoagent", "user-acceptance");
const reportFile = path.join(reportDir, "endurance-report.json");
const goal = process.env.AUTOAGENT_ENDURANCE_GOAL ?? [
  "在当前空目录创建一个可以直接用浏览器打开的中文 HTML 交付物。",
  "页面展示一个标题、三条可读内容和最后更新时间，并确保文件真实写入工作区。",
  "完成工作前请自行检查文件内容；不要把普通文本当作完成结论，完成时提交正式结构化结论。",
].join(" ");

let workspace;
let snapshot;
let selectedAgentId;
let selectedThreadId;
let selectedTaskId;
let lastSignature = "";
let firstMessage;
let secondMessage;
let queuedMessages = [];
let pauseResume;
let server;

try {
  if (!useExternalServer) {
    await prepareIsolatedHome();
    server = spawnServer();
    await waitForHealth(server);
  }
  await preflight();
  workspace = await createWorkspace();
  snapshot = (await api(`/api/workspaces/${workspace.id}/tasks`, {
    method: "POST",
    body: { title: "真实 Agent 队列耐久验收", goal },
  })).snapshot;
  selectedTaskId = snapshot.activeTask?.id;
  assert.ok(selectedTaskId, "真实任务没有返回 taskId");

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    snapshot = (await api(`/api/workspaces/${workspace.id}/snapshot`)).snapshot;
    const signature = [
      snapshot.status,
      snapshot.mission?.planVersion,
      (snapshot.agents ?? []).map((agent) => `${agent.id}:${agent.status}`).join(","),
      (snapshot.tickets ?? []).map((ticket) => `${ticket.id}:${ticket.status}`).join(","),
    ].join("|");
    if (signature !== lastSignature) {
      console.log(`[真实 Agent 耐久验收] ${signature}`);
      lastSignature = signature;
    }

    if (!selectedAgentId) await sendQueuedMessagesWhenAgentIsRunning();
    if (selectedAgentId && !pauseResume && firstMessage && secondMessage) {
      await pauseAndResumeTask();
    }
    if (["completed", "failed", "paused", "interrupted"].includes(snapshot.status)) break;
    const blockedTicket = (snapshot.tickets ?? []).find((ticket) => ticket.status === "blocked");
    const activeAgents = snapshot.agents ?? [];
    if (blockedTicket && !activeAgents.some((agent) => ["running", "waiting"].includes(agent.status))) {
      throw new Error(
        `真实耐久验收提前进入阻塞，且没有活动 Agent，不能继续等待：${JSON.stringify({
          ticket: blockedTicket,
          agents: activeAgents,
        })}`,
      );
    }
    await sleep(1_000);
  }

  assert.equal(snapshot.status, "completed", `真实任务没有完成：${JSON.stringify(snapshot)}`);
  assert.equal(queuedMessages.length, queuedMessageCount, `真实运行 Agent 时没有成功投递 ${queuedMessageCount} 条消息`);
  assert.ok(pauseResume?.paused, "没有观察到任务进入 paused 状态");
  assert.ok(pauseResume?.resumed, "暂停后没有恢复任务");
  assertThreadAndMessageInvariants(snapshot);
  const artifact = await inspectArtifact(workspaceRoot);
  const report = {
    passed: true,
    generatedAt: new Date().toISOString(),
    baseUrl,
    workspace: { id: workspace.id, rootPath: workspaceRoot },
    taskId: selectedTaskId,
    agentId: selectedAgentId,
    threadId: selectedThreadId,
    firstMessage,
    secondMessage,
    queuedMessages,
    queuedMessageCount,
    pauseResume,
    finalStatus: snapshot.status,
    artifact,
  };
  await writeReport(report);
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  const report = {
    passed: false,
    generatedAt: new Date().toISOString(),
    baseUrl,
    workspace: workspace ? { id: workspace.id, rootPath: workspaceRoot } : { rootPath: workspaceRoot },
    taskId: selectedTaskId ?? snapshot?.activeTask?.id,
    agentId: selectedAgentId,
    threadId: selectedThreadId,
    firstMessage,
    secondMessage,
    queuedMessages,
    queuedMessageCount,
    pauseResume,
    finalStatus: snapshot?.status,
    error: error instanceof Error ? error.stack ?? error.message : String(error),
    snapshot,
  };
  await writeReport(report).catch(() => undefined);
  console.error(`[真实 Agent 耐久验收失败] ${report.error}`);
  console.error(`[完整报告] ${reportFile}`);
  process.exitCode = 1;
} finally {
  await terminateServer(server).catch(() => undefined);
  if (isolatedHome) await rm(isolatedHome, { recursive: true, force: true });
}

async function preflight() {
  const health = await api("/api/health");
  assert.equal(health.ok, true, `AutoAgent 服务不可用：${baseUrl}`);
  const providerStatus = await api("/api/providers/status");
  assert.equal(
    providerStatus.providers?.openai?.configured || providerStatus.providers?.anthropic?.configured,
    true,
    "真实耐久验收需要已配置的 OpenAI 或 Anthropic Provider",
  );
}

async function prepareIsolatedHome() {
  await mkdir(isolatedHome, { recursive: true });
  for (const file of ["providers.json", "agent-profiles.json"]) {
    const source = path.join(sourceHome, file);
    assert.ok(existsSync(source), `真实耐久验收缺少配置文件：${source}`);
    await copyFile(source, path.join(isolatedHome, file));
  }
}

function spawnServer() {
  const child = spawn(process.execPath, [path.join(projectRoot, "dist/server/server/index.js")], {
    cwd: projectRoot,
    env: {
      ...process.env,
      AUTOAGENT_HOME: isolatedHome,
      NODE_ENV: "production",
      PORT: String(port),
      AUTOAGENT_PROVIDER_RETRIES: process.env.AUTOAGENT_PROVIDER_RETRIES ?? "2",
    },
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
      throw new Error(`真实耐久验收服务提前退出：exitCode=${child.exitCode}\n${child.output.stdout}\n${child.output.stderr}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      const body = await response.json();
      return response.ok && body.ready === true;
    } catch {
      return undefined;
    }
  }, 30_000, "真实耐久验收服务没有启动");
}

async function createWorkspace() {
  await mkdir(workspaceRoot, { recursive: true });
  return (await api("/api/workspaces", {
    method: "POST",
    body: { name: `真实 Agent 耐久验收 ${new Date().toISOString()}`, rootPath: workspaceRoot, policyProfile: "development" },
  })).workspace;
}

async function sendQueuedMessagesWhenAgentIsRunning() {
  const running = (snapshot.agents ?? []).find((agent) => agent.status === "running");
  if (!running) return;
  const events = snapshot.agentThreads?.[running.id] ?? [];
  const threadId = [...events]
    .reverse()
    .map((event) => event.threadId ?? event.payload?.threadId)
    .find(Boolean);
  if (!threadId) return;
  selectedAgentId = running.id;
  selectedThreadId = threadId;
  const messages = [
    "运行中的 Agent 收到的第 1 条按时间排序的补充事实：页面标题必须清晰可见。",
    "运行中的 Agent 收到的第 2 条按时间排序的补充事实：完成前请再次读取最终文件确认内容。",
    "运行中的 Agent 收到的第 3 条按时间排序的补充事实：页面内容需要适合直接阅读。",
    "运行中的 Agent 收到的第 4 条按时间排序的补充事实：不要把内部调试信息写进交付物。",
    "运行中的 Agent 收到的第 5 条按时间排序的补充事实：最终文件必须真实保存到当前工作区。",
    "运行中的 Agent 收到的第 6 条按时间排序的补充事实：完成前重新确认文件路径和内容。",
    "运行中的 Agent 收到的第 7 条按时间排序的补充事实：保持前面已经确认的要求。",
    "运行中的 Agent 收到的第 8 条按时间排序的补充事实：最后提交正式结构化完成结论。",
  ];
  const selectedMessages = messages.slice(0, queuedMessageCount);
  queuedMessages = [];
  for (const message of selectedMessages) queuedMessages.push(await sendAgentMessage(message));
  [firstMessage, secondMessage] = queuedMessages;
  console.log(`[真实 Agent 耐久验收] 已向 ${selectedAgentId} 的原 Thread 连续投递 ${queuedMessages.length} 条消息`);
}

async function sendAgentMessage(message) {
  const messageId = crypto.randomUUID();
  const result = await api(`/api/workspaces/${workspace.id}/tasks/${selectedTaskId}/agents/${selectedAgentId}/messages`, {
    method: "POST",
    body: { message, messageId },
  });
  return { messageId, sentAt: new Date().toISOString(), status: result.snapshot?.status };
}

async function pauseAndResumeTask() {
  const paused = await api(`/api/workspaces/${workspace.id}/tasks/${selectedTaskId}/pause`, { method: "POST" });
  pauseResume = { paused: paused.state?.status === "paused" || paused.snapshot?.status === "paused" };
  snapshot = (await api(`/api/workspaces/${workspace.id}/snapshot`)).snapshot;
  assert.equal(snapshot.status, "paused", `暂停接口返回后快照不是 paused：${snapshot.status}`);
  const resumed = await api(`/api/workspaces/${workspace.id}/tasks/${selectedTaskId}/resume`, { method: "POST" });
  pauseResume.resumed = resumed.snapshot?.status === "active" || resumed.snapshot?.status === "running";
  snapshot = (await api(`/api/workspaces/${workspace.id}/snapshot`)).snapshot;
  assert.notEqual(snapshot.status, "paused", "恢复接口返回后任务仍为 paused");
  console.log(`[真实 Agent 耐久验收] 已验证同一任务暂停后恢复：${snapshot.status}`);
}

function assertThreadAndMessageInvariants(current) {
  const events = current.agentThreads?.[selectedAgentId] ?? [];
  const eventThreadId = (event) => event.threadId ?? event.payload?.threadId;
  const humanMessages = events.filter(
    (event) => event.kind === "human_message" && eventThreadId(event) === selectedThreadId,
  );
  assert.ok(humanMessages.length >= queuedMessages.length, `${queuedMessages.length} 条 human 消息没有全部进入选中的 Agent Thread`);
  const humanThreadIds = new Set(humanMessages.map(eventThreadId).filter(Boolean));
  assert.deepEqual([...humanThreadIds], [selectedThreadId], "连续消息没有留在同一个 Agent Thread");
  const messageIds = humanMessages.map((event) => event.payload?.messageId).filter(Boolean);
  assert.equal(new Set(messageIds).size, messageIds.length, "同一 human 消息被重复写入 Thread");
  const messageIndexes = queuedMessages.map((message) => humanMessages.findIndex((event) => event.payload?.messageId === message.messageId));
  assert.ok(messageIndexes.every((index) => index >= 0), "排队消息没有全部进入 Thread");
  assert.deepEqual([...messageIndexes].sort((a, b) => a - b), messageIndexes, "排队消息没有按发送顺序进入 Thread");
}

async function inspectArtifact(root) {
  const htmlPath = await findHtmlEntryPath(root);
  assert.ok(htmlPath, "真实任务没有生成 HTML 交付物");
  const html = await readFile(htmlPath, "utf8");
  assert.match(html, /<html/i, `交付物不是有效 HTML：${htmlPath}`);
  assert.ok(html.replace(/<[^>]+>/g, " ").trim().length > 20, "HTML 交付物没有可读内容");
  return { found: true, path: htmlPath, bytes: Buffer.byteLength(html), bodyTextLength: html.replace(/<[^>]+>/g, " ").trim().length };
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
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
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

async function writeReport(value) {
  await mkdir(reportDir, { recursive: true });
  await writeFile(reportFile, JSON.stringify(value, null, 2), "utf8");
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
