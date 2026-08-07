import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { startServer } from "../dist/server/server/bootstrap.js";

const browserPath = resolveBrowserPath();
const home = await mkdtemp(path.join(os.tmpdir(), "autoagent-browser-ui-"));
const workspaceRoot = path.join(home, "workspace");
let server;
let browser;
const previousHoldGoal = process.env.AUTOAGENT_MOCK_HOLD_GOAL_ONCE_MS;
const previousAutoAgentHome = process.env.AUTOAGENT_HOME;

try {
  process.env.AUTOAGENT_HOME = path.join(home, "home");
  process.env.AUTOAGENT_MOCK_HOLD_GOAL_ONCE_MS = "1500";
  server = await startServer({
    port: 0,
    autoAgentHome: process.env.AUTOAGENT_HOME,
    useMockProvider: true,
    providerRetryCount: 0,
  });
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const workspace = await requestJson(`${baseUrl}/api/workspaces`, {
    method: "POST",
    body: { name: "浏览器生产级界面验收", rootPath: workspaceRoot, policyProfile: "development" },
  });

  browser = await chromium.launch({ headless: true, executablePath: browserPath });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErrors = [];
  const consoleErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  // The app intentionally keeps an SSE connection open, so networkidle is not
  // a valid readiness signal for this UI. Wait for DOM readiness and a stable
  // user-facing landmark instead.
  await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
  await page.getByText("任务控制", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
  await page.locator('select[aria-label="切换当前项目"] option:checked', { hasText: "浏览器生产级界面验收" }).waitFor({ state: "attached", timeout: 10_000 });
  await assertNoHorizontalOverflow(page, "desktop");
  await assertReadableState(page, workspace.workspace.id);

  const teamButton = page.locator("button.mission-contact-button");
  await teamButton.click();
  const teamInput = page.locator('form.agent-chat textarea[aria-label="项目目标"]');
  await teamInput.waitFor({ state: "visible", timeout: 10_000 });
  await teamInput.fill("只验证界面入口，不启动实际任务");
  await teamInput.press("Shift+Enter");
  assert.equal(await teamInput.inputValue(), "只验证界面入口，不启动实际任务\n");
  await page.locator('button[aria-label="关闭对话"]').click();

  const boss = page.locator('[data-role="boss"]');
  await boss.click();
  await page.locator('section.conversation-dock[role="dialog"]').waitFor({ state: "visible", timeout: 10_000 });
  await assertNoHorizontalOverflow(page, "agent-chat");
  await assertReadableState(page, workspace.workspace.id);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(100);
  await assertNoHorizontalOverflow(page, "mobile");
  await page.locator('section.conversation-dock[role="dialog"]').waitFor({ state: "visible", timeout: 10_000 });
  await page.locator('form.agent-chat textarea').last().waitFor({ state: "visible", timeout: 10_000 });
  await page.locator('button[aria-label="关闭对话"]').click();

  await page.locator("button.mission-contact-button").click();
  const taskInput = page.locator('form.agent-chat textarea[aria-label="项目目标"]');
  await taskInput.waitFor({ state: "visible", timeout: 10_000 });
  await taskInput.fill("Complete a small verifiable delivery and expose the real runtime state.");
  await taskInput.press("Enter");
  const started = await waitUntil(async () => {
    const snapshot = await getSnapshot(baseUrl, workspace.workspace.id);
    return snapshot.activeTask?.id ? snapshot : undefined;
  }, 10_000, "UI did not create a task");
  const taskId = started.activeTask.id;
  const openConversation = page.locator('section.conversation-dock[role="dialog"] button[aria-label="关闭对话"]');
  if (await openConversation.count()) await openConversation.click();
  await waitForProjectedStatus(page, baseUrl, workspace.workspace.id, taskId, "running", 30_000);
  const terminal = await waitUntil(async () => {
    const snapshot = await getSnapshot(baseUrl, workspace.workspace.id);
    return ["completed", "failed", "paused", "interrupted"].includes(snapshot.status) ? snapshot : undefined;
  }, 90_000, "state projection acceptance did not reach a terminal state");
  await waitForProjectedStatus(page, baseUrl, workspace.workspace.id, taskId, terminal.status, 10_000);
  await assertReadableState(page, workspace.workspace.id);

  const station = page.locator(".agent-station").first();
  await station.click();
  const conversation = page.locator('section.conversation-dock[role="dialog"]');
  await conversation.waitFor({ state: "visible", timeout: 10_000 });
  const chatThread = conversation.locator(".chat-thread");
  await chatThread.waitFor({ state: "visible", timeout: 10_000 });
  const chatText = await chatThread.innerText();
  assert.ok(chatText.trim(), "Agent 对话打开后没有可读内容");
  const chatHeader = await conversation.locator(".agent-chat-header strong").innerText();
  assert.match(chatHeader, /对话$/, "Agent 对话没有显示当前 Agent 身份");
  const scrollMetrics = await chatThread.evaluate((element) => ({
    scrollTop: element.scrollTop,
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  assert.ok(
    scrollMetrics.scrollTop + scrollMetrics.clientHeight >= scrollMetrics.scrollHeight - 2,
    `Agent 对话没有自动滚动到最新内容：${JSON.stringify(scrollMetrics)}`,
  );

  assert.deepEqual(pageErrors, [], `浏览器页面异常：${pageErrors.join(" | ")}`);
  assert.deepEqual(consoleErrors, [], `浏览器控制台异常：${consoleErrors.join(" | ")}`);
  console.log(JSON.stringify({
    passed: true,
    workspaceId: workspace.workspace.id,
    checks: [
      "桌面页面加载",
      "项目和团队入口可见",
      "团队对话入口可打开",
      "Shift+Enter 换行不发送",
      "Agent 对话入口可打开",
      "Agent 对话显示身份和历史消息",
      "Agent 对话自动滚动到最新内容",
      "未泄漏内部思考标记",
      "桌面无横向溢出",
      "手机无横向溢出",
      "无页面异常和控制台错误",
    ],
  }));
} finally {
  await browser?.close().catch(() => undefined);
  if (server) await closeServer(server).catch(() => undefined);
  if (previousHoldGoal === undefined) delete process.env.AUTOAGENT_MOCK_HOLD_GOAL_ONCE_MS;
  else process.env.AUTOAGENT_MOCK_HOLD_GOAL_ONCE_MS = previousHoldGoal;
  if (previousAutoAgentHome === undefined) delete process.env.AUTOAGENT_HOME;
  else process.env.AUTOAGENT_HOME = previousAutoAgentHome;
  await rm(home, { recursive: true, force: true });
}

async function assertNoHorizontalOverflow(page, label) {
  const metrics = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
  }));
  assert.ok(metrics.documentWidth <= metrics.viewport + 1, `${label} 页面横向溢出: ${JSON.stringify(metrics)}`);
  assert.ok(metrics.bodyWidth <= metrics.viewport + 1, `${label} body 横向溢出: ${JSON.stringify(metrics)}`);
}

async function assertReadableState(page, workspaceId) {
  const visibleText = await page.locator("body").innerText();
  assert.equal(visibleText.includes("<thinking>"), false, "界面泄漏了内部 thinking 标记");
  assert.equal(visibleText.includes("Agent 工作规则"), false, "默认界面展开了内部工作规则");
  const snapshot = await requestJson(`http://127.0.0.1:${new URL(page.url()).port}/api/workspaces/${workspaceId}/snapshot`);
  const status = snapshot.snapshot.status;
  const projectStatus = await page.locator(".context-status strong").innerText();
  const statusLabels = {
    idle: "空闲",
    running: "运行中",
    completed: "已完成",
    failed: "失败",
    paused: "已暂停",
    blocked: "受阻",
    interrupted: "已停止",
  };
  if (statusLabels[status]) assert.equal(projectStatus, statusLabels[status], `UI 没有按权威快照显示 ${status}`);
  const stations = page.locator(".agent-station");
  assert.ok(await stations.count() > 0, "办公室没有显示团队成员");
  const stationLabels = await stations.locator(".agent-status-bubble").allInnerTexts();
  assert.ok(stationLabels.some((label) => label.trim()), "团队成员没有显示姓名和当前状态");
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

async function waitForProjectedStatus(page, baseUrl, workspaceId, taskId, expectedStatus, timeoutMs) {
  const labels = {
    idle: "空闲",
    running: "运行中",
    completed: "已完成",
    failed: "失败",
    paused: "已暂停",
    blocked: "受阻",
    interrupted: "已停止",
  };
  let lastState;
  try {
    await waitUntil(async () => {
    const snapshot = await getSnapshot(baseUrl, workspaceId);
    const displayed = await page.locator(".context-status strong").innerText();
    lastState = {
      taskId: snapshot.activeTask?.id,
      status: snapshot.status,
      phase: snapshot.phase,
      displayed,
    };
    if (snapshot.activeTask?.id !== taskId || snapshot.status !== expectedStatus) return undefined;
    return displayed === labels[expectedStatus] ? snapshot : undefined;
    }, timeoutMs, `UI did not project authoritative status ${expectedStatus}`);
  } catch (error) {
    throw new Error(`${error.message}; lastState=${JSON.stringify(lastState)}`);
  }
}

async function getSnapshot(baseUrl, workspaceId) {
  return (await requestJson(`${baseUrl}/api/workspaces/${workspaceId}/snapshot`)).snapshot;
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

async function closeServer(value) {
  value.closeAllConnections?.();
  await new Promise((resolve, reject) => value.close((error) => error ? reject(error) : resolve()));
}

function resolveBrowserPath() {
  const configured = process.env.AUTOAGENT_BROWSER_PATH;
  if (configured) return configured;
  const candidates = process.platform === "win32"
    ? [
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      ]
    : ["/usr/bin/google-chrome", "/usr/bin/microsoft-edge", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
  const found = candidates.find(existsSync);
  assert.ok(found, "找不到 Edge 或 Chrome；可通过 AUTOAGENT_BROWSER_PATH 指定浏览器");
  return found;
}
