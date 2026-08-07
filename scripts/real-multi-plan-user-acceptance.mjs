import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const baseUrl = process.env.AUTOAGENT_BASE_URL ?? "http://127.0.0.1:13748";
const timeoutMs = Number(process.env.AUTOAGENT_ACCEPTANCE_TIMEOUT_MS ?? 2 * 60 * 60_000);
const goal = process.env.AUTOAGENT_ACCEPTANCE_MULTI_PLAN_GOAL ?? [
  "获取今天的百度热搜，整理其中与人工智能相关的内容，生成一个可以在浏览器中直接打开的中文日报网页。",
  "页面必须保留每条内容的来源和更新时间，并在桌面和 390px 手机宽度下可读、可操作。",
  "请团队先形成可运行交付，再独立验证全部成功标准，最后由验收负责人闭环。",
].join(" ");
const workspaceRoot = process.env.AUTOAGENT_ACCEPTANCE_ROOT
  ?? await mkdtemp(path.join(os.tmpdir(), "autoagent-real-multi-plan-"));
const reportDir = path.join(workspaceRoot, ".autoagent", "user-acceptance");
const reportFile = path.join(reportDir, "multi-version-report.json");
const feedbackMessage = process.env.AUTOAGENT_ACCEPTANCE_MULTI_PLAN_FEEDBACK ?? [
  "用户复核补充一个验收事实：当前交付必须在 390px 手机宽度下完整可读、可操作，不能出现横向滚动。",
  "请基于当前 Mission 基线、已有交付和可用工具自行判断：这是实现缺陷、需要人工验证，还是当前 Plan 缺少新的工作/验证增量。",
  "不要把这段话直接当成通过或失败；请按当前工单的正常工作方式形成结论并继续。",
].join("\n");

let browser;
let snapshot;
let workspace;
let feedback;
let initialPlanVersion;
let initialTicketIds = new Set();
let lastSignature = "";

try {
  await preflight();
  workspace = await createWorkspace();
  const started = await api(`/api/workspaces/${workspace.id}/tasks`, {
    method: "POST",
    body: { title: "真实用户多版本验收", goal },
  });
  snapshot = started.snapshot;
  snapshot = await observeMission(workspace.id, snapshot.activeTask?.id);
  assert.equal(snapshot.status, "completed", `真实用户多版本 Mission 未完成：${JSON.stringify(snapshot)}`);
  assert.ok(feedback, "真实运行期间没有观察到可投递的 QA 工单");
  assert.ok(
    (snapshot.mission?.planVersion ?? 0) > initialPlanVersion,
    `用户反馈没有产生新的 Plan 版本：初始 ${initialPlanVersion}，最终 ${snapshot.mission?.planVersion ?? 0}`,
  );
  assert.ok(
    initialTicketIds.size > 0 && [...initialTicketIds].every((id) => (snapshot.tickets ?? []).some((ticket) => ticket.id === id)),
    "计划修订后旧 Ticket 没有保留在 Mission 历史中",
  );
  assert.equal(new Set((snapshot.tickets ?? []).map((ticket) => ticket.id)).size, (snapshot.tickets ?? []).length, "Ticket ID 重复");
  assert.equal((snapshot.agents ?? []).some((agent) => agent.status === "running"), false, "Mission 已结束但仍有 Agent 处于运行中");
  assert.ok(
    (snapshot.tickets ?? []).every((ticket) => ["completed", "returned", "cancelled"].includes(ticket.status)),
    `最终仍有未闭合 Ticket：${JSON.stringify(snapshot.tickets)}`,
  );

  const artifact = await inspectArtifact(workspaceRoot);
  const report = {
    passed: true,
    generatedAt: new Date().toISOString(),
    baseUrl,
    workspace: { id: workspace.id, rootPath: workspaceRoot },
    taskId: snapshot.activeTask?.id,
    initialPlanVersion,
    finalPlanVersion: snapshot.mission?.planVersion,
    feedback,
    ticketCount: snapshot.tickets?.length ?? 0,
    oldTicketCount: initialTicketIds.size,
    ticketStatuses: Object.fromEntries((snapshot.tickets ?? []).map((ticket) => [ticket.id, ticket.status])),
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
    taskId: snapshot?.activeTask?.id,
    initialPlanVersion,
    finalPlanVersion: snapshot?.mission?.planVersion,
    feedback,
    error: error instanceof Error ? error.stack ?? error.message : String(error),
    snapshot,
  };
  await writeReport(report).catch(() => undefined);
  console.error(`[真实用户多版本验收失败] ${report.error}`);
  console.error(`[完整报告] ${reportFile}`);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => undefined);
}

async function preflight() {
  const health = await api("/api/health");
  assert.equal(health.ok, true, `AutoAgent 服务不可用：${baseUrl}`);
  const providerStatus = await api("/api/providers/status");
  assert.equal(
    providerStatus.providers?.openai?.configured || providerStatus.providers?.anthropic?.configured,
    true,
    "真实多版本验收需要已配置的 OpenAI 或 Anthropic Provider",
  );
}

async function createWorkspace() {
  await mkdir(workspaceRoot, { recursive: true });
  const result = await api("/api/workspaces", {
    method: "POST",
    body: { name: `真实用户多版本验收 ${new Date().toISOString()}`, rootPath: workspaceRoot, policyProfile: "development" },
  });
  return result.workspace;
}

async function observeMission(workspaceId, taskId) {
  assert.ok(taskId, "创建任务后缺少 taskId");
  const deadline = Date.now() + timeoutMs;
  const answeredManualTickets = new Set();
  while (Date.now() < deadline) {
    snapshot = await api(`/api/workspaces/${workspaceId}/snapshot`).then((value) => value.snapshot);
    const signature = [
      snapshot.status,
      snapshot.mission?.planVersion,
      (snapshot.tickets ?? []).map((ticket) => `${ticket.id}:${ticket.status}`).join(","),
    ].join("|");
    if (signature !== lastSignature) {
      console.log(`[真实用户多版本验收] ${signature}`);
      lastSignature = signature;
    }

    // Task creation can return before the first Mission Plan is persisted.
    // Lock the historical baseline only after the first real Ticket graph is
    // visible, and before the user feedback is delivered to QA.
    if (!feedback && initialTicketIds.size === 0 && (snapshot.tickets ?? []).length > 0) {
      initialPlanVersion = snapshot.mission?.planVersion ?? initialPlanVersion;
      initialTicketIds = new Set((snapshot.tickets ?? []).map((ticket) => ticket.id));
    }

    if (!feedback) {
      const qaTicket = (snapshot.tickets ?? []).find((ticket) => isAssuranceTicket(ticket)
        && ticket.targetAgentId
        && ["pending", "running", "blocked"].includes(ticket.status));
      if (qaTicket) {
        const result = await sendAgentMessage(workspaceId, taskId, qaTicket.targetAgentId, feedbackMessage);
        feedback = {
          ticketId: qaTicket.id,
          agentId: qaTicket.targetAgentId,
          sentAt: new Date().toISOString(),
          responseStatus: result.status,
        };
        console.log(`[真实用户多版本验收] 已向 QA Agent ${qaTicket.targetAgentId} 发送新增验收事实`);
      }
    }

    const manualTicket = (snapshot.tickets ?? []).find((ticket) => ticket.status === "blocked"
      && ticket.blocker?.type === "manual_test_required"
      && ticket.targetAgentId
      && !answeredManualTickets.has(ticket.id));
    if (manualTicket) {
      answeredManualTickets.add(manualTicket.id);
      const artifact = await inspectArtifact(workspaceRoot);
      await sendAgentMessage(workspaceId, taskId, manualTicket.targetAgentId, [
        "已按当前工单要求完成真实浏览器检查，以下是观察到的事实，请在同一 Goal 中继续自行形成结论：",
        JSON.stringify(artifact),
      ].join("\n"));
      console.log(`[真实用户多版本验收] 已回传人工测试事实：${manualTicket.id}`);
    }

    if (["completed", "failed", "paused", "interrupted"].includes(snapshot.status)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`真实用户多版本验收超时：${timeoutMs}ms\n${JSON.stringify(snapshot)}`);
}

function isAssuranceTicket(ticket) {
  return ticket.expectedArtifact === "mission-assurance-v1"
    || ticket.type === "qa"
    || ticket.type === "boss_acceptance"
    || ticket.targetRole === "qa";
}

async function sendAgentMessage(workspaceId, taskId, agentId, message) {
  return api(`/api/workspaces/${workspaceId}/tasks/${taskId}/agents/${agentId}/messages`, {
    method: "POST",
    body: { message, messageId: crypto.randomUUID() },
  });
}

async function inspectArtifact(root) {
  const htmlPath = await findHtmlEntryPath(root);
  if (!htmlPath) return { found: false, reason: "当前尚未找到 HTML 交付物" };
  const html = await readFile(htmlPath, "utf8");
  assert.match(html, /<html/i, `交付物不是有效 HTML：${htmlPath}`);
  browser ??= await chromium.launch({ headless: true, executablePath: resolveBrowserPath() });
  const server = await serveDirectory(root);
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    const errors = [];
    const resourceErrors = [];
    page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
    page.on("console", (message) => {
      // Chromium reports a missing optional favicon as a generic console
      // error without including the requested URL. Resource responses below
      // keep real page asset failures visible while excluding only favicon.
      if (message.type() === "error" && !message.text().includes("Failed to load resource")) {
        errors.push(`console: ${message.text()}`);
      }
    });
    page.on("response", (response) => {
      if (response.status() < 400) return;
      const pathname = new URL(response.url()).pathname.toLowerCase();
      if (pathname.endsWith("/favicon.ico")) return;
      resourceErrors.push(`resource ${response.status()}: ${response.url()}`);
    });
    await page.goto(`${server.url}${encodeURIComponent(path.relative(root, htmlPath).split(path.sep).join("/"))}`, { waitUntil: "load" });
    const bodyTextLength = (await page.locator("body").innerText()).trim().length;
    const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    await context.close();
    assert.ok(bodyTextLength > 20, `交付物页面没有可读内容：${htmlPath}`);
    assert.equal(horizontalOverflow, false, `交付物在 390px 下出现横向滚动：${htmlPath}`);
    assert.deepEqual([...errors, ...resourceErrors], [], `交付物浏览器运行报错：${[...errors, ...resourceErrors].join("; ")}`);
    return { found: true, path: htmlPath, bodyTextLength, horizontalOverflow, errors, resourceErrors };
  } finally {
    await new Promise((resolve) => server.server.close(resolve));
  }
}

async function findHtmlEntryPath(root) {
  const indexPath = path.join(root, "index.html");
  if (existsSync(indexPath)) return indexPath;
  const entries = await readdir(root, { withFileTypes: true });
  const html = entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".html"));
  return html.length === 1 ? path.join(root, html[0].name) : undefined;
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
  assert.ok(found, "找不到可执行的 Edge 或 Chrome");
  return found;
}

async function serveDirectory(root) {
  const { createServer } = await import("node:http");
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
      const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
      const filePath = path.resolve(root, relative);
      assert.ok(filePath.startsWith(path.resolve(root) + path.sep) || filePath === path.resolve(root), "静态文件路径越界");
      const content = await readFile(filePath);
      response.writeHead(200, { "content-type": filePath.endsWith(".html") ? "text/html; charset=utf-8" : "text/plain; charset=utf-8" });
      response.end(content);
    } catch {
      response.writeHead(404);
      response.end("Not Found");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { server, url: `http://127.0.0.1:${address.port}/` };
}

async function api(route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: options.method ?? "GET",
    headers: options.body ? { "content-type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  let value = {};
  try { value = text ? JSON.parse(text) : {}; } catch { value = { raw: text }; }
  assert.equal(response.ok, true, `${options.method ?? "GET"} ${route} 失败：${JSON.stringify(value)}`);
  return value;
}

async function writeReport(value) {
  await mkdir(reportDir, { recursive: true });
  await writeFile(reportFile, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
