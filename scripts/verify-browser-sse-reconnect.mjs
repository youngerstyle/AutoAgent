import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { startServer } from "../dist/server/server/bootstrap.js";
import { EventLedger } from "../dist/server/server/storage/event-ledger.js";

const browserPath = resolveBrowserPath();
const home = await mkdtemp(path.join(os.tmpdir(), "autoagent-sse-browser-"));
const workspaceRoot = path.join(home, "workspace");
let server;
let browser;

try {
  server = await startServer({
    port: 0,
    autoAgentHome: path.join(home, "home"),
    useMockProvider: true,
    providerRetryCount: 0,
  });
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const workspace = await requestJson(`${baseUrl}/api/workspaces`, {
    method: "POST",
    body: { name: "SSE 浏览器重连验收", rootPath: workspaceRoot, policyProfile: "development" },
  });
  const ledger = new EventLedger();
  const first = await ledger.append(workspaceRoot, {
    workspaceId: workspace.workspace.id,
    taskId: "task_sse_browser",
    taskRunId: "run_sse_browser",
    type: "task.created",
    summary: "第一次事件",
    payload: {},
  });

  browser = await chromium.launch({ headless: true, executablePath: browserPath });
  const page = await browser.newPage();
  await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
  const firstEvents = await collectBrowserEvents(
    page,
    `${baseUrl}/api/workspaces/${workspace.workspace.id}/events?cursor=no-prior-event`,
  );
  assert.deepEqual(firstEvents.map((event) => event.id), [first.id]);

  const restartPort = port;
  await closeServer(server);
  server = undefined;
  const second = await ledger.append(workspaceRoot, {
    workspaceId: workspace.workspace.id,
    taskId: "task_sse_browser",
    taskRunId: "run_sse_browser",
    type: "run.completed",
    summary: "重启后的事件",
    payload: {},
  });
  server = await startServer({
    port: restartPort,
    autoAgentHome: path.join(home, "home"),
    useMockProvider: true,
    providerRetryCount: 0,
  });
  const secondEvents = await collectBrowserEvents(
    page,
    `${baseUrl}/api/workspaces/${workspace.workspace.id}/events?cursor=${encodeURIComponent(first.id)}`,
  );
  assert.deepEqual(secondEvents.map((event) => event.id), [second.id]);
  console.log(JSON.stringify({ passed: true, firstEvent: first.id, afterRestart: second.id }));
} finally {
  await browser?.close().catch(() => undefined);
  if (server) await closeServer(server).catch(() => undefined);
  await rm(home, { recursive: true, force: true });
}

async function collectBrowserEvents(page, url) {
  return page.evaluate((streamUrl) => new Promise((resolve, reject) => {
    const source = new EventSource(streamUrl);
    const events = [];
    const timeout = window.setTimeout(() => {
      source.close();
      reject(new Error(`SSE browser stream timed out: ${streamUrl}`));
    }, 5_000);
    source.addEventListener("autoagent", (message) => {
      events.push(JSON.parse(message.data));
      window.clearTimeout(timeout);
      source.close();
      resolve(events);
    });
    source.onerror = () => {
      source.close();
      window.clearTimeout(timeout);
      reject(new Error(`SSE browser stream failed: ${streamUrl}`));
    };
  }), url);
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

async function closeServer(value) {
  value.closeAllConnections?.();
  await new Promise((resolve, reject) => {
    value.close((error) => error ? reject(error) : resolve());
  });
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
