import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";

const baseUrl = process.env.AUTOAGENT_BASE_URL ?? "http://127.0.0.1:13748";
const timeoutMs = Number(process.env.AUTOAGENT_ACCEPTANCE_TIMEOUT_MS ?? 20 * 60_000);
let workspaceRoot = process.env.AUTOAGENT_ACCEPTANCE_ROOT
  ?? await mkdtemp(path.join(os.tmpdir(), "autoagent-real-acceptance-"));
let reportDir = path.join(workspaceRoot, ".autoagent", "user-acceptance");
const goal = [
  "在当前空目录创建一个无需构建、通过浏览器直接打开 index.html 即可使用的中文待办清单。",
  "必须支持新增待办、勾选完成、删除待办，并使用 localStorage 在刷新后保留数据。",
  "桌面和 390px 宽手机视口均应正常使用且不能出现横向滚动。",
  "团队必须产出真实文件，经过开发、独立质量检查和最终验收。",
].join("");

let browser;
let staticServer;
let staticUrl;
let snapshot;
let browserResult;
const answeredManualTestTickets = new Set();
const resumedProviderFailures = new Set();

try {
  await preflight();
  const workspace = await resolveWorkspace();
  if (!process.env.AUTOAGENT_ACCEPTANCE_WORKSPACE_ID) {
    snapshot = await api(`/api/workspaces/${workspace.id}/tasks`, {
      method: "POST",
      body: { title: "真实用户验收", goal },
    }).then((value) => value.snapshot);
  }
  snapshot = await waitForTerminal(workspace.id);

  assert.equal(snapshot.status, "completed", failureMessage("Mission 未完成", snapshot));
  assert.ok(snapshot.tickets.length > 0, "Mission 没有生成 Ticket");
  assert.ok(snapshot.tickets.every((ticket) => ticket.status === "completed"), failureMessage("存在未完成 Ticket", snapshot));
  assertDeliveryChain(snapshot.tickets);

  const indexPath = path.join(workspaceRoot, "index.html");
  const html = await readFile(indexPath, "utf8");
  assert.match(html, /<html/i, "最终产物 index.html 不是有效 HTML");

  browserResult ??= await runBrowserAcceptance();

  const report = {
    passed: true,
    at: new Date().toISOString(),
    baseUrl,
    workspace: { id: workspace.id, rootPath: workspaceRoot },
    task: { id: snapshot.activeTask?.id, status: snapshot.status },
    tickets: snapshot.tickets.map(({ id, type, brief, status, targetAgentId }) => ({ id, type, brief, status, targetAgentId })),
    browser: browserResult,
  };
  await saveReport(report);
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  const report = {
    passed: false,
    at: new Date().toISOString(),
    baseUrl,
    workspaceRoot,
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
}

async function preflight() {
  const health = await api("/api/health");
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

function assertDeliveryChain(tickets) {
  const implementation = tickets.find((ticket) => ticket.capabilityTags?.includes("delivery:implement"));
  const qa = tickets.find((ticket) => ticket.capabilityTags?.includes("delivery:verify"));
  const acceptance = tickets.find((ticket) =>
    ticket.capabilityTags?.includes("delivery:accept") && ticket.dependsOnTicketIds?.includes(qa?.id)
  );
  assert.ok(implementation, "真实交付链缺少开发工单");
  assert.ok(qa, "真实交付链缺少独立 QA 工单");
  assert.ok(qa.dependsOnTicketIds?.includes(implementation.id), "QA 工单没有依赖开发交付");
  assert.ok(acceptance, "真实交付链缺少依赖 QA 的最终验收工单");
}

async function waitForTerminal(workspaceId) {
  const deadline = Date.now() + timeoutMs;
  let lastSignature = "";
  while (Date.now() < deadline) {
    const current = await api(`/api/workspaces/${workspaceId}/snapshot`).then((value) => value.snapshot);
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
      const result = await runBrowserAcceptance();
      const taskId = current.activeTask?.id;
      assert.ok(taskId, "人工测试时找不到当前任务");
      assert.ok(manualTest.targetAgentId, "人工测试工单没有目标 Agent");
      await api(`/api/workspaces/${workspaceId}/tasks/${taskId}/agents/${manualTest.targetAgentId}/messages`, {
        method: "POST",
        body: {
          message: [
            "已按你给出的人工测试边界完成真实浏览器验证。以下是实际测试事实，请据此继续当前 QA Goal 并自行作出结论：",
            JSON.stringify(result),
          ].join("\n"),
        },
      });
      console.log(`[真实验收] 已向 ${manualTest.targetAgentId} 回传 Ticket ${manualTest.id} 的浏览器测试事实`);
      await sleep(1_000);
      continue;
    }
    const pausedAgent = current.agents.find((agent) => agent.status === "paused");
    if (pausedAgent) {
      const taskId = current.activeTask?.id;
      assert.ok(taskId, "Agent 暂停时找不到当前任务");
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
  throw new Error(`真实 Mission 在 ${timeoutMs}ms 内未结束`);
}

async function runBrowserAcceptance() {
  if (browserResult) return browserResult;
  const indexPath = path.join(workspaceRoot, "index.html");
  const html = await readFile(indexPath, "utf8");
  assert.match(html, /<html/i, "人工测试前发现 index.html 不是有效 HTML");
  if (!staticServer) {
    const served = await serveDirectory(workspaceRoot);
    staticServer = served.server;
    staticUrl = served.url;
  }
  browser ??= await chromium.launch({ headless: true, executablePath: resolveBrowserPath() });
  browserResult = await verifyTodoInBrowser(browser, staticUrl);
  return browserResult;
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

  const firstRow = page.getByText("真实验收任务一", { exact: true }).locator("xpath=ancestor::li[1]");
  const firstCheckbox = firstRow.getByRole("checkbox").first();
  await assertVisible(firstCheckbox, "第一条待办没有完成勾选框");
  await firstCheckbox.check();
  assert.equal(await firstCheckbox.isChecked(), true, "勾选完成没有生效");

  await page.reload({ waitUntil: "load" });
  const persistedRow = page.getByText("真实验收任务一", { exact: true }).locator("xpath=ancestor::li[1]");
  assert.equal(await persistedRow.getByRole("checkbox").first().isChecked(), true, "刷新后完成状态没有持久化");

  const secondRow = page.getByText("真实验收任务二", { exact: true }).locator("xpath=ancestor::li[1]");
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
