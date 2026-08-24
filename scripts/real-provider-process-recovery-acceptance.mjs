import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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
const defaultGoal = [
  "在当前工作目录创建一个可以直接用浏览器打开的中文 HTML 交付物。",
  "页面需要有清晰标题、三段可读内容和更新时间，并确认文件确实写入工作区。",
  "完成前请读取并检查最终文件；只有真实交付物满足目标后，才提交完成结论。",
].join(" ");
const goal = process.env.AUTOAGENT_REAL_RECOVERY_GOAL ?? defaultGoal;

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
let interruptedAttempt;

try {
  await prepareIsolatedHome();
  await prepareWorkspaceRepository();
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
    interruptedAttempt = await dirtyIsolatedAttempt();
    const running = (crashedSnapshot.agents ?? []).find((agent) => agent.status === "running");
    if (running && interruptedAttempt) {
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
  assert.ok(selectedAgentId && selectedThreadId && interruptedAttempt, `没有观察到真实 Agent 在隔离 worktree 中产生未提交改动：${JSON.stringify(crashedSnapshot)}`);

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

  const artifact = goal === defaultGoal ? await inspectArtifact(workspaceRoot) : await inspectRepository(workspaceRoot);
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
    interruptedAttempt,
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

async function prepareWorkspaceRepository() {
  await mkdir(workspaceRoot, { recursive: true });
  const topLevel = await gitResult(["rev-parse", "--show-toplevel"]);
  if (topLevel.ok) {
    assert.equal(path.resolve(topLevel.stdout.trim()), path.resolve(workspaceRoot), "验收目录必须是独立 Git 根目录");
    const status = await gitResult(["status", "--porcelain", "--untracked-files=all"]);
    assert.equal(status.stdout.trim(), "", "验收开始前 Git 工作区必须干净");
    return;
  }
  await git(["init"]);
  await writeFile(path.join(workspaceRoot, ".gitignore"), ".autoagent/\nnode_modules/\n", "utf8");
  await writeFile(path.join(workspaceRoot, "README.md"), "# AutoAgent process recovery challenge\n", "utf8");
  await git(["add", ".gitignore", "README.md"]);
  await git(["-c", "user.name=AutoAgent Acceptance", "-c", "user.email=acceptance@local.invalid", "commit", "-m", "Initialize recovery challenge"]);
}

async function dirtyIsolatedAttempt() {
  const directory = path.join(workspaceRoot, ".autoagent", "tickets", "worktrees");
  let names;
  try {
    names = await readdir(directory);
  } catch {
    return undefined;
  }
  for (const name of names.filter((item) => item.endsWith(".json")).sort()) {
    const state = JSON.parse(await readFile(path.join(directory, name), "utf8"));
    if (!state.rootPath || !["prepared", "conflict"].includes(state.status) || !existsSync(state.rootPath)) continue;
    const status = await gitResult(["status", "--porcelain", "--untracked-files=all"], state.rootPath);
    if (status.ok && status.stdout.trim()) {
      return {
        attemptId: state.attemptId,
        branch: state.branch,
        rootPath: state.rootPath,
        dirtyPaths: status.stdout.trim().split(/\r?\n/),
      };
    }
  }
  return undefined;
}

async function git(args, cwd = workspaceRoot) {
  const result = await execFileAsync("git", args, { cwd, windowsHide: true, encoding: "utf8" });
  return result.stdout;
}

async function gitResult(args, cwd = workspaceRoot) {
  try {
    return { ok: true, stdout: await git(args, cwd) };
  } catch (error) {
    return { ok: false, stdout: error?.stdout ?? "", stderr: error?.stderr ?? String(error) };
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

async function inspectRepository(root) {
  const status = await gitResult(["status", "--porcelain", "--untracked-files=all"], root);
  assert.equal(status.ok, true, `无法读取最终 Git 状态：${status.stderr ?? "unknown error"}`);
  assert.equal(status.stdout.trim(), "", `最终 Git 工作区不干净：\n${status.stdout}`);
  const packageFile = path.join(root, "package.json");
  assert.equal(existsSync(packageFile), true, "自定义工程任务没有生成 package.json");
  const packageJson = JSON.parse(await readFile(packageFile, "utf8"));
  assert.ok(packageJson.scripts?.test, "自定义工程任务没有 npm test 命令");
  const verification = await verifyInDisposableWorktree(root);
  const files = await projectFiles(root);
  const head = (await git(["rev-parse", "HEAD"], root)).trim();
  return {
    type: "git_project",
    head,
    fileCount: files.length,
    sourceFiles: files.filter((file) => /^(src|lib)\//.test(file)).length,
    testFiles: files.filter((file) => /^(test|tests)\//.test(file)).length,
    verificationDirtyPaths: verification.dirtyPaths,
    installOutput: `${verification.install.stdout ?? ""}${verification.install.stderr ?? ""}`.trim().slice(-1_000),
    testOutput: `${verification.test.stdout ?? ""}${verification.test.stderr ?? ""}`.trim().slice(-2_000),
  };
}

async function verifyInDisposableWorktree(root) {
  const parent = await mkdtemp(path.join(path.dirname(root), ".autoagent-acceptance-verify-"));
  const verificationRoot = path.join(parent, "workspace");
  try {
    await git(["worktree", "add", "--detach", verificationRoot, "HEAD"], root);
    const install = await runNpm(verificationRoot, ["install", "--ignore-scripts"]);
    const test = await runNpm(verificationRoot, ["test"]);
    const status = await gitResult(["status", "--porcelain", "--untracked-files=all"], verificationRoot);
    return { install, test, dirtyPaths: status.stdout.trim() ? status.stdout.trim().split(/\r?\n/) : [] };
  } finally {
    if (existsSync(verificationRoot)) await git(["worktree", "remove", "--force", verificationRoot], root).catch(() => undefined);
    await rm(parent, { recursive: true, force: true });
  }
}

async function runNpm(root, args) {
  if (process.platform !== "win32") {
    return execFileAsync("npm", args, { cwd: root, windowsHide: true, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  }
  return execFileAsync(process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe", ["/d", "/s", "/c", "npm", ...args], {
    cwd: root, windowsHide: true, encoding: "utf8", maxBuffer: 4 * 1024 * 1024,
  });
}

async function projectFiles(root, directory = root) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if ([".autoagent", ".git", "node_modules"].includes(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await projectFiles(root, absolute));
    else if (entry.isFile()) files.push(path.relative(root, absolute).split(path.sep).join("/"));
  }
  return files;
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
