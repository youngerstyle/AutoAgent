import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { startServer } from "../dist/server/server/bootstrap.js";

const browserPath = resolveBrowserPath();
const home = await mkdtemp(path.join(os.tmpdir(), "autoagent-manual-test-recovery-"));
const workspaceRoot = path.join(home, "workspace");
const runtimeHome = path.join(home, "autoagent-home");
let server;
let browser;
let failureContext;
let failed = false;

try {
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(path.join(workspaceRoot, "index.html"), `<!doctype html>
<html lang="zh-CN"><body>
<button id="action">点击验证</button><output id="result"></output>
<script>document.querySelector("#action").onclick = () => document.querySelector("#result").textContent = "已完成";</script>
</body></html>`, "utf8");

  process.env.AUTOAGENT_MOCK_FORCE_MANUAL_TEST_ONCE = "1";
  process.env.AUTOAGENT_HOME = runtimeHome;
  server = await startServer({ port: 0, autoAgentHome: runtimeHome, useMockProvider: true, providerRetryCount: 0 });
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const workspace = await requestJson(`${baseUrl}/api/workspaces`, {
    method: "POST",
    body: { name: "人工测试恢复验收", rootPath: workspaceRoot, policyProfile: "development" },
  });
  const workspaceId = workspace.workspace.id;
  const started = await requestJson(`${baseUrl}/api/workspaces/${workspaceId}/tasks`, {
    method: "POST",
    body: { title: "人工测试恢复验收", goal: "验证现有 index.html 的按钮交互，并确认人工测试请求可以在同一个 Agent Goal 中恢复。" },
  });
  const taskId = started.snapshot.activeTask.id;

  browser = await chromium.launch({ headless: true, executablePath: browserPath });
  const page = await browser.newPage();
  await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });

  const blocked = await waitUntil(async () => {
    const snapshot = await getSnapshot(baseUrl, workspaceId);
    const ticket = snapshot.tickets.find((item) => item.blocker?.type === "manual_test_required");
    return ticket ? { snapshot, ticket } : undefined;
  }, 90_000, "QA 没有进入 manual_test 人工介入状态");
  assert.equal(blocked.snapshot.activeTask.id, taskId);
  assert.ok(blocked.ticket.targetAgentId, "manual_test 工单没有目标 Agent");
  const blockedLink = await readMissionLink(workspaceRoot, blocked.snapshot.mission.missionId, blocked.ticket.id);
  assert.ok(blockedLink?.agentGoalId, "Mission 没有持久化 manual_test 工单对应的 Agent Goal");
  failureContext = { stage: "blocked", workspaceId, taskId, blocked, blockedLink };

  // The production UI selects the waiting Agent automatically when its blocker is
  // projected. Clicking the role station as a user makes the test resilient to
  // the initial SSE snapshot arriving before that projection.
  await page.locator('[data-role="qa"]').click();
  const reply = "人工测试完成：已打开 index.html，点击按钮后页面显示“已完成”，交互可用。请在同一个 Goal 中继续。";
  const chatInput = page.locator("form.agent-chat textarea").last();
  await chatInput.waitFor({ state: "visible", timeout: 30_000 });
  await chatInput.fill(reply);
  await chatInput.press("Enter");
  await page.getByText(reply, { exact: false }).first().waitFor({ state: "visible", timeout: 30_000 });
  failureContext = { ...failureContext, stage: "human_reply_visible" };

  const completed = await waitUntil(async () => {
    const snapshot = await getSnapshot(baseUrl, workspaceId);
    return snapshot.status === "completed" ? snapshot : undefined;
  }, 90_000, "人工回复后 Mission 没有恢复并完成");
  const completedLink = await readMissionLink(workspaceRoot, completed.mission.missionId, blocked.ticket.id);
  assert.equal(completedLink?.agentGoalId, blockedLink.agentGoalId, "恢复后没有复用原 QA Goal");
  assert.equal(completed.status, "completed");

  const rolloutFiles = await findFiles(workspaceRoot, "rollout.jsonl");
  assert.ok(rolloutFiles.length > 0, "没有找到追加式 Agent rollout 记录");
  const report = {
    passed: true,
    workspaceId,
    taskId,
    manualTestTicketId: blocked.ticket.id,
    targetAgentId: blocked.ticket.targetAgentId,
    goalId: blockedLink.agentGoalId,
    sameGoalAfterHumanReply: completedLink.agentGoalId === blockedLink.agentGoalId,
    finalStatus: completed.status,
    rolloutFiles,
  };
  await writeFile(path.join(home, "report.json"), JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify(report));
} catch (error) {
  failed = true;
  if (failureContext) {
    const snapshot = await getSnapshot(`http://127.0.0.1:${server.address().port}`, failureContext.workspaceId).catch(() => undefined);
    const missionFiles = await findFiles(workspaceRoot, "mission-process").catch(() => []);
    const failureReport = {
      ...failureContext,
      snapshot,
      missionFiles,
      error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
    };
    const failurePath = path.join(home, "failure-report.json");
    await writeFile(failurePath, JSON.stringify(failureReport, null, 2), "utf8");
    console.error(`人工测试恢复失败快照：${failurePath}`);
  }
  throw error;
} finally {
  await browser?.close().catch(() => undefined);
  if (server) await closeServer(server).catch(() => undefined);
  if (!failed) await rm(home, { recursive: true, force: true });
  else console.error(`保留人工测试恢复失败现场：${home}`);
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
  while (Date.now() < deadline) {
    const result = await read();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(message);
}

async function findFiles(root, fileName) {
  const matches = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.name === fileName) matches.push(target);
    }
  }
  await visit(root);
  return matches;
}

async function readMissionLink(workspaceRoot, missionId, ticketId) {
  const directory = path.join(workspaceRoot, ".autoagent", "mission-process");
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const value = JSON.parse(await readFile(path.join(directory, entry.name), "utf8"));
    if (value.missionId !== missionId) continue;
    return value.links?.find((link) => link.ticketId === ticketId);
  }
  return undefined;
}

async function closeServer(value) {
  value.closeAllConnections?.();
  await new Promise((resolve, reject) => value.close((error) => error ? reject(error) : resolve()));
}

function resolveBrowserPath() {
  const configured = process.env.AUTOAGENT_BROWSER_PATH;
  if (configured) return configured;
  const candidates = process.platform === "win32"
    ? ["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"]
    : ["/usr/bin/google-chrome", "/usr/bin/microsoft-edge", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
  const found = candidates.find(existsSync);
  assert.ok(found, "找不到 Edge 或 Chrome；可通过 AUTOAGENT_BROWSER_PATH 指定浏览器");
  return found;
}
