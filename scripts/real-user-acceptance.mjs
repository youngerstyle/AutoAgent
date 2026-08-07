import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright-core";

const execFileAsync = promisify(execFile);
const baseUrl = process.env.AUTOAGENT_BASE_URL ?? "http://127.0.0.1:13748";
const timeoutMs = Number(process.env.AUTOAGENT_ACCEPTANCE_TIMEOUT_MS ?? 2 * 60 * 60_000);
// The built-in goal is a todo demo. A custom goal must be checked as the
// artifact it actually produced, rather than inheriting that demo UI.
const scenario = process.env.AUTOAGENT_ACCEPTANCE_SCENARIO
  ?? (process.env.AUTOAGENT_ACCEPTANCE_GOAL ? "html" : "todo");
let workspaceRoot = process.env.AUTOAGENT_ACCEPTANCE_ROOT
  ?? await mkdtemp(path.join(os.tmpdir(), "autoagent-real-acceptance-"));
let reportDir = path.join(workspaceRoot, ".autoagent", "user-acceptance");
const defaultGoal = [
  "在当前空目录创建一个无需构建、通过浏览器直接打开 index.html 即可使用的中文待办清单。",
  "必须支持新增待办、勾选完成、删除待办，并使用 localStorage 在刷新后保留数据。",
  "桌面和 390px 宽手机视口均应正常使用且不能出现横向滚动。",
  "团队必须产出真实文件，经过开发、独立质量检查和最终验收。",
].join("");
const goal = process.env.AUTOAGENT_ACCEPTANCE_GOAL ?? defaultGoal;

let browser;
let staticServer;
let staticUrl;
let snapshot;
let browserResult;
let acceptanceLock;
let workspace;
let serviceIdentity;
let lastObservedAt;
const acceptanceStartedAt = new Date().toISOString();
const answeredManualTestTickets = new Set();
const resumedProviderFailures = new Set();

class AcceptanceDriverTimeoutError extends Error {
  constructor({ timeoutMs: duration, lastObservedAt: observedAt, snapshot: lastSnapshot }) {
    super(`Acceptance driver timed out after ${duration}ms without observing a terminal Mission state`);
    this.name = "AcceptanceDriverTimeoutError";
    this.timeoutMs = duration;
    this.lastObservedAt = observedAt;
    this.snapshot = lastSnapshot;
  }
}

try {
  acceptanceLock = await acquireAcceptanceLock();
  await preflight();
  workspace = await resolveWorkspace();
  if (!process.env.AUTOAGENT_ACCEPTANCE_WORKSPACE_ID) {
    snapshot = await api(`/api/workspaces/${workspace.id}/tasks`, {
      method: "POST",
      body: { title: "真实用户验收", goal },
    }).then((value) => value.snapshot);
  }
  snapshot = await waitForTerminal(workspace.id);

  assertRuntimeSnapshot(snapshot, { terminal: true });
  assert.equal(snapshot.status, "completed", failureMessage("Mission 未完成", snapshot));
  assert.ok(snapshot.tickets.length > 0, "Mission 没有生成 Ticket");
  assert.ok(snapshot.tickets.every((ticket) => ticket.status === "completed"), failureMessage("存在未完成 Ticket", snapshot));
  assertAuditablePlan(snapshot.tickets);

  // Always re-check the final artifact after Mission reaches a terminal
  // state. A pre-terminal manual-test result must not stand in for the
  // artifact produced by a later Plan version.
  browserResult = await runArtifactAcceptance({ force: true });

  const report = {
    passed: true,
    outcome: "passed",
    observationStatus: "terminal_observed",
    at: new Date().toISOString(),
    acceptanceStartedAt,
    lastObservedAt,
    businessStatusAtLastObservation: snapshot.status,
    terminalConfirmedAt: lastObservedAt,
    baseUrl,
    workspace: { id: workspace.id, rootPath: workspaceRoot },
    service: serviceIdentity,
    task: { id: snapshot.activeTask?.id, status: snapshot.status },
    runtimeInvariants: { passed: true },
    tickets: snapshot.tickets.map(({ id, type, brief, status, targetAgentId }) => ({ id, type, brief, status, targetAgentId })),
    artifactAcceptance: browserResult,
  };
  await saveReport(report);
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  const driverTimedOut = error instanceof AcceptanceDriverTimeoutError;
  const report = {
    passed: false,
    outcome: driverTimedOut ? "driver_timeout" : "acceptance_error",
    observationStatus: driverTimedOut ? "driver_timeout" : "transport_error",
    at: new Date().toISOString(),
    acceptanceStartedAt,
    lastObservedAt,
    businessStatusAtLastObservation: snapshot?.status ?? null,
    terminalConfirmedAt: null,
    baseUrl,
    service: serviceIdentity,
    workspace: workspace ? { id: workspace.id, rootPath: workspaceRoot } : { rootPath: workspaceRoot },
    terminal: Boolean(snapshot && ["completed", "failed", "paused", "interrupted"].includes(snapshot.status)),
    error: error instanceof Error ? error.stack ?? error.message : String(error),
    snapshot,
  };
  await saveReport(report).catch(() => undefined);
  console.error(`[真实验收失败] ${error instanceof Error ? error.message : String(error)}`);
  console.error(`[完整报告] ${path.join(reportDir, "report.json")}`);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => undefined);
  await new Promise((resolve) => staticServer?.close(resolve) ?? resolve());
  await acceptanceLock?.handle.close().catch(() => undefined);
  if (acceptanceLock) await rm(acceptanceLock.file, { force: true }).catch(() => undefined);
}

async function acquireAcceptanceLock() {
  await mkdir(reportDir, { recursive: true });
  const file = path.join(reportDir, "driver.lock");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(file, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      return { file, handle };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const owner = await readFile(file, "utf8")
        .then((value) => JSON.parse(value))
        .catch(() => ({}));
      if (Number.isInteger(owner.pid) && isProcessAlive(owner.pid)) {
        throw new Error(`同一验收目录已有运行中的驱动进程（PID ${owner.pid}）：${workspaceRoot}`);
      }
      await rm(file, { force: true });
    }
  }
  throw new Error(`无法取得验收目录锁：${workspaceRoot}`);
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function preflight() {
  const health = await api("/api/health");
  serviceIdentity = {
    baseUrl,
    ready: health.ready ?? null,
    runtimeStatus: health.runtimeHosts?.status ?? null,
  };
  assert.equal(health.ok, true, `AutoAgent 服务不可用：${baseUrl}`);
  const status = await api("/api/providers/status");
  const hasRealProvider = status.providers?.openai?.configured || status.providers?.anthropic?.configured;
  assert.equal(hasRealProvider, true, "未配置 OpenAI 或 Anthropic；真实验收禁止使用 Mock Provider");
}

async function resolveWorkspace() {
  const existingId = process.env.AUTOAGENT_ACCEPTANCE_WORKSPACE_ID;
  if (existingId) {
    const workspaces = await api("/api/workspaces").then((value) => value.workspaces ?? []);
    const existing = workspaces.find((workspace) => workspace.id === existingId);
    assert.ok(existing, `找不到复验 Workspace：${existingId}`);
    workspaceRoot = existing.rootPath;
    reportDir = path.join(workspaceRoot, ".autoagent", "user-acceptance");
    return existing;
  }
  await mkdir(workspaceRoot, { recursive: true });
  return api("/api/workspaces", {
    method: "POST",
    body: { name: `真实用户验收 ${new Date().toISOString()}`, rootPath: workspaceRoot, policyProfile: "development" },
  }).then((value) => value.workspace);
}

function assertAuditablePlan(tickets) {
  const ids = new Set(tickets.map((ticket) => ticket.id));
  assert.equal(ids.size, tickets.length, "Ticket DAG 存在重复 Ticket ID");

  let dependencyCount = 0;
  for (const ticket of tickets) {
    for (const dependencyId of ticket.dependsOnTicketIds ?? []) {
      dependencyCount += 1;
      assert.ok(ids.has(dependencyId), `Ticket ${ticket.id} 引用了不存在的依赖 ${dependencyId}`);
      const dependency = tickets.find((candidate) => candidate.id === dependencyId);
      assert.equal(dependency?.status, "completed", `Ticket ${ticket.id} 的上游 ${dependencyId} 未完成`);
    }
  }
  assert.ok(dependencyCount > 0, "真实 Mission 没有形成可追溯的 Ticket DAG");

  const visiting = new Set();
  const visited = new Set();
  const visit = (ticketId) => {
    if (visiting.has(ticketId)) throw new Error(`Ticket DAG 存在环：${ticketId}`);
    if (visited.has(ticketId)) return;
    visiting.add(ticketId);
    const ticket = tickets.find((candidate) => candidate.id === ticketId);
    for (const dependencyId of ticket?.dependsOnTicketIds ?? []) visit(dependencyId);
    visiting.delete(ticketId);
    visited.add(ticketId);
  };
  for (const ticket of tickets) visit(ticket.id);
}

async function waitForTerminal(workspaceId) {
  const deadline = Date.now() + timeoutMs;
  let lastSignature = "";
  while (Date.now() < deadline) {
    const current = await api(`/api/workspaces/${workspaceId}/snapshot`).then((value) => value.snapshot);
    // Keep the failure report at the same point in time as the poller.
    // Otherwise a timeout only records the initial POST snapshot and hides
    // the ticket/agent state that actually caused the timeout.
    snapshot = current;
    assertRuntimeSnapshot(current);
    lastObservedAt = new Date().toISOString();
    const signature = [
      current.status,
      current.agents.map((agent) => `${agent.name}:${agent.status}`).join(","),
      current.tickets.map((ticket) => `${ticket.status}:${ticket.title}`).join(","),
    ].join(" | ");
    if (signature !== lastSignature) console.log(`[真实验收] ${signature}`);
    lastSignature = signature;
    const manualTest = current.tickets.find((ticket) =>
      ticket.status === "blocked"
      && ticket.blocker?.type === "manual_test_required"
      && !answeredManualTestTickets.has(ticket.id)
    );
    if (manualTest) {
      answeredManualTestTickets.add(manualTest.id);
      const result = await runArtifactAcceptance({ force: true });
      const taskId = current.activeTask?.id;
      assert.ok(taskId, "人工测试时找不到当前任务");
      assert.ok(manualTest.targetAgentId, "人工测试工单没有目标 Agent");
      await api(`/api/workspaces/${workspaceId}/tasks/${taskId}/agents/${manualTest.targetAgentId}/messages`, {
        method: "POST",
        body: {
          message: [
            "已按当前工单要求完成真实产物验收。以下是实际测试事实，请据此继续当前 Goal 并自行作出结论：",
            JSON.stringify(result),
          ].join("\n"),
        },
      });
      console.log(`[真实验收] 已向 ${manualTest.targetAgentId} 回传 Ticket ${manualTest.id} 的产物测试事实`);
      await sleep(1_000);
      continue;
    }
    const pausedAgent = current.agents.find((agent) => agent.status === "paused");
    if (pausedAgent) {
      const taskId = current.activeTask?.id;
      assert.ok(taskId, "Agent 暂停时找不到当前任务");
      const latestControl = latestAgentControl(current, pausedAgent.id);
      if (!latestControl || !["provider_retry_wait", "external_service_waiting"].includes(latestControl.status)) {
        throw new Error(`Agent ${pausedAgent.name} 因 ${latestControl?.status ?? "未知原因"} 暂停；真实验收驱动不会把合同错误或业务阻塞伪装成供应商故障恢复`);
      }
      if (resumedProviderFailures.has(pausedAgent.id)) {
        throw new Error(`Agent ${pausedAgent.name} 在受控恢复后再次暂停，停止验收以避免继续消耗`);
      }
      resumedProviderFailures.add(pausedAgent.id);
      await api(`/api/workspaces/${workspaceId}/tasks/${taskId}/agents/${pausedAgent.id}/messages`, {
        method: "POST",
        body: { message: "上一次模型调用被供应商错误中断。请在同一个 Goal 中从已有线程状态继续，不要重做已经完成的步骤。" },
      });
      console.log(`[真实验收] Agent ${pausedAgent.name} 暂停，已执行一次受控恢复`);
      await sleep(1_000);
      continue;
    }
    if (["completed", "failed", "paused", "interrupted"].includes(current.status)) return current;
    await sleep(1_000);
  }
  throw new AcceptanceDriverTimeoutError({ timeoutMs, lastObservedAt, snapshot });
}

/**
 * Validate only cross-engine persistence invariants that are observable from
 * a workspace snapshot. This deliberately does not decide whether a domain
 * goal is complete, whether a role should receive work, or how a Ticket
 * should be routed; those decisions belong to Agents and the Ticket Engine.
 */
function assertRuntimeSnapshot(current, { terminal = false } = {}) {
  const tickets = Array.isArray(current?.tickets) ? current.tickets : [];
  const ticketIds = new Set(tickets.map((ticket) => ticket.id));
  assert.equal(ticketIds.size, tickets.length, "运行快照包含重复 Ticket ID");

  const activeTaskId = current.activeTask?.id;
  const activeTaskRunId = current.activeTaskRun?.id;
  for (const [agentId, events] of Object.entries(current.agentThreads ?? {})) {
    const eventIds = new Set();
    const sequences = [];
    for (const event of events ?? []) {
      assert.equal(event.workspaceAgentId, agentId, `Agent Thread ${agentId} 混入了其他 Agent 的事件`);
      assert.equal(eventIds.has(event.id), false, `Agent Thread ${agentId} 存在重复事件 ${event.id}`);
      eventIds.add(event.id);
      sequences.push(event.sequence);
      if (activeTaskId) assert.equal(event.taskId, activeTaskId, `Agent Thread ${agentId} 串入了其他任务事件`);
      if (activeTaskRunId) assert.equal(event.taskRunId, activeTaskRunId, `Agent Thread ${agentId} 串入了其他任务运行事件`);
    }
    const ordered = [...sequences].sort((a, b) => a - b);
    for (let index = 1; index < ordered.length; index += 1) {
      assert.ok(ordered[index] > ordered[index - 1], `Agent Thread ${agentId} 的事件 sequence 不唯一或不递增`);
    }
  }

  if (terminal) {
    assert.equal(
      current.agents?.some((agent) => agent.status === "running"),
      false,
      "Mission 已进入终态，但仍有 Agent 被投影为 running",
    );
  }
}

function latestAgentControl(current, agentId) {
  const events = current.agentThreads?.[agentId] ?? [];
  return [...events].reverse().find((event) => event.kind === "system_note"
    && event.payload && typeof event.payload === "object"
    && typeof event.payload.status === "string")?.payload;
}

async function runBrowserAcceptance({ force = false } = {}) {
  if (browserResult && !force) return browserResult;
  const htmlPath = await findHtmlEntryPath();
  assert.ok(htmlPath, "工作区没有可供浏览器验收的 HTML 入口");
  const html = await readFile(htmlPath, "utf8");
  assert.match(html, /<html/i, "人工测试前发现 index.html 不是有效 HTML");
  if (!staticServer) {
    const served = await serveDirectory(workspaceRoot);
    staticServer = served.server;
    staticUrl = served.url;
  }
  const relativeEntry = path.relative(workspaceRoot, htmlPath).split(path.sep).join("/");
  const artifactUrl = new URL(relativeEntry, new URL(".", staticUrl)).toString();
  browser ??= await chromium.launch({ headless: true, executablePath: resolveBrowserPath() });
  browserResult = scenario === "tank98"
    ? await verifyTankInBrowser(browser, artifactUrl)
    : scenario === "todo"
      ? await verifyTodoInBrowser(browser, artifactUrl)
      : await verifyHtmlArtifactInBrowser(browser, artifactUrl);
  return browserResult;
}

async function runArtifactAcceptance({ force = false } = {}) {
  if (browserResult && !force) return browserResult;
  const htmlPath = await findHtmlEntryPath();
  if (htmlPath) return runBrowserAcceptance({ force });

  const desktopEntries = [
    path.join(workspaceRoot, "dist", "tank98.py"),
    path.join(workspaceRoot, "dist", "tank98.pyz"),
    path.join(workspaceRoot, "tank98_app", "__main__.py"),
    path.join(workspaceRoot, "run_game.bat"),
  ];
  if (process.platform === "win32" && desktopEntries.some(existsSync)) {
    return runWindowsDesktopAcceptance();
  }

  throw new Error(
    `未找到可验收的交付入口。检查过：${[
      path.join(workspaceRoot, "index.html"),
      ...(await listHtmlEntryPaths()),
      ...desktopEntries,
    ].join(", ")}`,
  );
}

async function findHtmlEntryPath() {
  const indexPath = path.join(workspaceRoot, "index.html");
  if (existsSync(indexPath)) return indexPath;
  const candidates = await listHtmlEntryPaths();
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    throw new Error(`工作区存在多个 HTML 入口，无法在没有明确交付引用时猜测：${candidates.join(", ")}`);
  }
  return undefined;
}

async function listHtmlEntryPaths() {
  const entries = await readdir(workspaceRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".html"))
    .map((entry) => path.join(workspaceRoot, entry.name))
    .sort();
}

async function runWindowsDesktopAcceptance() {
  await mkdir(reportDir, { recursive: true });
  const scriptPath = path.resolve("scripts", "windows-desktop-acceptance.ps1");
  const { stdout, stderr } = await execFileAsync(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      "-WorkspaceRoot",
      workspaceRoot,
      "-ReportDir",
      reportDir,
    ],
    { encoding: "utf8", timeout: 90_000, windowsHide: true },
  );
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const result = JSON.parse(lines.at(-1) ?? "{}");
  assert.equal(result.started, true, `桌面产物未成功启动：${stderr || result.error || "未知错误"}`);
  assert.equal(result.enteredPlaying, true, "桌面产物按 Enter 后没有进入游戏");
  assert.equal(result.playerFired, true, "桌面产物按 Space 后没有产生射击");
  assert.equal(result.enemySpawned, true, "桌面产物没有生成敌方单位");
  assert.equal(result.gameEnded, true, "桌面产物没有形成结束闭环");
  assert.equal(result.restarted, true, "桌面产物结束后无法重开");
  assert.equal(result.negativeBaseHp, false, "桌面产物结束后仍继续结算碰撞，基地生命降到了 0 以下");
  return { scenario: "windows-desktop", ...result };
}

async function verifyTankInBrowser(browserInstance, url) {
  await mkdir(reportDir, { recursive: true });
  const context = await browserInstance.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("favicon")) errors.push(`console: ${message.text()}`);
  });
  await page.goto(url, { waitUntil: "load" });

  const canvas = page.locator("canvas").first();
  await assertVisible(canvas, "Tank 产物没有可见 canvas");
  const dimensions = await canvas.evaluate((element) => ({
    width: element.width,
    height: element.height,
    clientWidth: element.clientWidth,
    clientHeight: element.clientHeight,
  }));
  assert.ok(dimensions.width >= 256 && dimensions.height >= 224, `Tank canvas 内部分辨率过小：${dimensions.width}x${dimensions.height}`);
  assert.ok(dimensions.clientWidth >= 256 && dimensions.clientHeight >= 224, `Tank canvas 显示尺寸过小：${dimensions.clientWidth}x${dimensions.clientHeight}`);

  const beforeStart = await canvas.screenshot();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  const afterStart = await canvas.screenshot();
  assert.notDeepEqual(afterStart, beforeStart, "按 Enter 后 Tank 画面没有变化");

  await page.keyboard.down("ArrowUp");
  await page.waitForTimeout(350);
  await page.keyboard.up("ArrowUp");
  await page.keyboard.press("Space");
  await page.waitForTimeout(350);
  const afterInput = await canvas.screenshot();
  assert.notDeepEqual(afterInput, afterStart, "方向键和射击输入后 Tank 画面没有变化");

  await page.screenshot({ path: path.join(reportDir, "tank-desktop.png"), fullPage: true });
  const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  assert.equal(horizontalOverflow, false, "Tank 桌面页面存在横向滚动");
  assert.deepEqual(errors, [], `Tank 浏览器出现错误：${errors.join("；")}`);

  await context.close();
  return {
    scenario: "tank98",
    canvas: dimensions,
    startChangedCanvas: true,
    controlsChangedCanvas: true,
    horizontalOverflow,
    errors,
    screenshots: [path.join(reportDir, "tank-desktop.png")],
  };
}

async function verifyTodoInBrowser(browserInstance, url) {
  await mkdir(reportDir, { recursive: true });
  const context = await browserInstance.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("favicon")) errors.push(`console: ${message.text()}`);
  });
  await page.goto(url, { waitUntil: "load" });

  const input = page.getByRole("textbox").first();
  const addButton = page.getByRole("button", { name: /新增|添加/ }).first();
  await assertVisible(input, "找不到待办输入框");
  await assertVisible(addButton, "找不到新增按钮");

  await input.fill("真实验收任务一");
  await addButton.click();
  await input.fill("真实验收任务二");
  await addButton.click();
  assert.equal(await page.getByText("真实验收任务一", { exact: true }).count(), 1, "新增第一条待办失败");
  assert.equal(await page.getByText("真实验收任务二", { exact: true }).count(), 1, "新增第二条待办失败");

  const firstRow = page.getByText("真实验收任务一", { exact: true }).locator("xpath=ancestor::*[self::li or self::article][1]");
  const firstCheckbox = firstRow.getByRole("checkbox").first();
  await assertVisible(firstCheckbox, "第一条待办没有完成勾选框");
  await firstCheckbox.check();
  assert.equal(await firstCheckbox.isChecked(), true, "勾选完成没有生效");

  await page.reload({ waitUntil: "load" });
  const persistedRow = page.getByText("真实验收任务一", { exact: true }).locator("xpath=ancestor::*[self::li or self::article][1]");
  assert.equal(await persistedRow.getByRole("checkbox").first().isChecked(), true, "刷新后完成状态没有持久化");

  const secondRow = page.getByText("真实验收任务二", { exact: true }).locator("xpath=ancestor::*[self::li or self::article][1]");
  page.once("dialog", async (dialog) => {
    assert.equal(dialog.type(), "confirm", "删除待办弹出了非预期的浏览器对话框");
    await dialog.accept();
  });
  await secondRow.getByRole("button", { name: /删除/ }).first().click();
  assert.equal(await page.getByText("真实验收任务二", { exact: true }).count(), 0, "删除待办失败");
  await page.screenshot({ path: path.join(reportDir, "desktop.png"), fullPage: true });

  const mobile = await context.newPage();
  await mobile.setViewportSize({ width: 390, height: 844 });
  await mobile.goto(url, { waitUntil: "load" });
  const horizontalOverflow = await mobile.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  assert.equal(horizontalOverflow, false, "390px 手机视口存在横向滚动");
  await mobile.screenshot({ path: path.join(reportDir, "mobile.png"), fullPage: true });
  assert.deepEqual(errors, [], `浏览器出现错误：${errors.join("；")}`);

  await context.close();
  return {
    added: 2,
    completionPersistedAfterReload: true,
    deleted: 1,
    mobileWidth: 390,
    horizontalOverflow,
    errors,
    screenshots: [path.join(reportDir, "desktop.png"), path.join(reportDir, "mobile.png")],
  };
}

async function verifyHtmlArtifactInBrowser(browserInstance, url) {
  await mkdir(reportDir, { recursive: true });
  const context = await browserInstance.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("favicon")) errors.push(`console: ${message.text()}`);
  });
  await page.goto(url, { waitUntil: "load" });

  const body = page.locator("body");
  await assertVisible(body, "交付 HTML 没有可见页面主体");
  const bodyTextLength = (await body.innerText()).trim().length;
  assert.ok(bodyTextLength > 20, "交付 HTML 页面没有可读内容");
  const headingCount = await page.locator("h1, h2, h3").count();
  const linkCount = await page.locator("a[href]").count();
  await page.screenshot({ path: path.join(reportDir, "desktop.png"), fullPage: true });

  const mobile = await context.newPage();
  await mobile.setViewportSize({ width: 390, height: 844 });
  await mobile.goto(url, { waitUntil: "load" });
  await assertVisible(mobile.locator("body"), "交付 HTML 在 390px 视口下不可见");
  const horizontalOverflow = await mobile.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  assert.equal(horizontalOverflow, false, "390px 手机视口存在横向滚动");
  await mobile.screenshot({ path: path.join(reportDir, "mobile.png"), fullPage: true });
  assert.deepEqual(errors, [], `交付 HTML 浏览器出现错误：${errors.join("；")}`);

  await context.close();
  return {
    scenario: "html",
    bodyTextLength,
    headingCount,
    linkCount,
    mobileWidth: 390,
    horizontalOverflow,
    errors,
    screenshots: [path.join(reportDir, "desktop.png"), path.join(reportDir, "mobile.png")],
  };
}

async function assertVisible(locator, message) {
  assert.equal(await locator.count() > 0 && await locator.isVisible(), true, message);
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
  assert.ok(found, "找不到 Edge 或 Chrome；可通过 AUTOAGENT_BROWSER_PATH 指定真实浏览器");
  return found;
}

async function serveDirectory(root) {
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
      if (pathname === "/favicon.ico") {
        response.writeHead(204);
        response.end();
        return;
      }
      const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
      const filePath = path.resolve(root, relative);
      assert.ok(filePath.startsWith(path.resolve(root) + path.sep) || filePath === path.resolve(root), "非法静态文件路径");
      const content = await readFile(filePath);
      response.writeHead(200, { "content-type": contentType(filePath) });
      response.end(content);
    } catch {
      response.writeHead(404);
      response.end("Not Found");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { server, url: `http://127.0.0.1:${address.port}/index.html` };
}

function contentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}

async function api(route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: options.method ?? "GET",
    headers: options.body ? { "content-type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  let value;
  try {
    value = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${options.method ?? "GET"} ${route} 返回非 JSON (${response.status}): ${text.slice(0, 500)}`);
  }
  if (!response.ok) throw new Error(`${options.method ?? "GET"} ${route} 失败 (${response.status}): ${JSON.stringify(value)}`);
  return value;
}

async function saveReport(report) {
  await mkdir(reportDir, { recursive: true });
  await writeFile(path.join(reportDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function failureMessage(message, current) {
  const tickets = current?.tickets?.map((ticket) => `${ticket.title}:${ticket.status}`).join(", ") ?? "无";
  return `${message}。状态=${current?.status ?? "unknown"}，Tickets=${tickets}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
