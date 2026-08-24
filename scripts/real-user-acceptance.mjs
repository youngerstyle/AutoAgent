import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { chromium } from "playwright-core";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(".");
const baseUrl = process.env.AUTOAGENT_BASE_URL ?? "http://127.0.0.1:13748";
const timeoutMs = Number(process.env.AUTOAGENT_ACCEPTANCE_TIMEOUT_MS ?? 2 * 60 * 60_000);
const initializeGit = process.env.AUTOAGENT_ACCEPTANCE_GIT_INIT === "true";
const maxHumanInputs = process.env.AUTOAGENT_ACCEPTANCE_MAX_HUMAN_INPUTS === undefined
  ? Number.POSITIVE_INFINITY
  : Number(process.env.AUTOAGENT_ACCEPTANCE_MAX_HUMAN_INPUTS);
assert.ok(
  maxHumanInputs === Number.POSITIVE_INFINITY || (Number.isInteger(maxHumanInputs) && maxHumanInputs >= 0),
  "AUTOAGENT_ACCEPTANCE_MAX_HUMAN_INPUTS 必须是非负整数",
);
// The built-in goal is a todo demo. A custom goal must be checked as the
// artifact it actually produced, rather than inheriting that demo UI.
const scenario = process.env.AUTOAGENT_ACCEPTANCE_SCENARIO
  ?? (process.env.AUTOAGENT_ACCEPTANCE_GOAL ? "html" : "todo");
const followupGoal = process.env.AUTOAGENT_ACCEPTANCE_FOLLOWUP_GOAL;
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
let repositoryResult;
let transportRetries = 0;
let missionContinuity;
const acceptanceStartedAt = new Date().toISOString();
const acceptanceStartedAtMs = Date.now();
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

  if (followupGoal) {
    const firstSnapshot = snapshot;
    const firstRepository = await inspectRepository();
    if (initializeGit) assert.equal(firstRepository.clean, true, `第一轮 Mission 完成后 Git 工作树不干净：${firstRepository.status.join(", ")}`);
    const firstTargetAgentIds = new Set(firstSnapshot.tickets.map((ticket) => ticket.targetAgentId).filter(Boolean));
    const firstTask = firstSnapshot.activeTask;
    snapshot = await api(`/api/workspaces/${workspace.id}/tasks`, {
      method: "POST",
      body: { title: "持久团队连续迭代", goal: followupGoal },
    }).then((value) => value.snapshot);
    snapshot = await waitForTerminal(workspace.id);
    assertRuntimeSnapshot(snapshot, { terminal: true });
    assert.equal(snapshot.status, "completed", failureMessage("第二轮 Mission 未完成", snapshot));
    assert.ok(snapshot.tickets.length > 0, "第二轮 Mission 没有生成 Ticket");
    assert.ok(snapshot.tickets.every((ticket) => ticket.status === "completed"), failureMessage("第二轮存在未完成 Ticket", snapshot));
    assertAuditablePlan(snapshot.tickets);
    const secondTargetAgentIds = new Set(snapshot.tickets.map((ticket) => ticket.targetAgentId).filter(Boolean));
    const reusedAgentIds = [...secondTargetAgentIds].filter((agentId) => firstTargetAgentIds.has(agentId));
    assert.ok(reusedAgentIds.length >= 3, `第二轮没有复用足够的持久 Agent：${reusedAgentIds.join(", ")}`);
    missionContinuity = {
      firstTaskId: firstTask?.id,
      secondTaskId: snapshot.activeTask?.id,
      sameWorkspaceId: true,
      firstTargetAgentCount: firstTargetAgentIds.size,
      secondTargetAgentCount: secondTargetAgentIds.size,
      reusedAgentIds,
      firstRepositoryClean: firstRepository.clean,
      firstMetrics: projectMetrics(firstSnapshot, acceptanceStartedAtMs),
    };
  }

  // Always re-check the final artifact after Mission reaches a terminal
  // state. A pre-terminal manual-test result must not stand in for the
  // artifact produced by a later Plan version.
  browserResult = await runArtifactAcceptance({ force: true });
  repositoryResult = await inspectRepository();
  if (initializeGit) {
    assert.equal(repositoryResult.clean, true, `Mission 完成后 Git 工作树不干净：${repositoryResult.status.join(", ")}`);
  }

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
    autonomy: {
      maxHumanInputs: Number.isFinite(maxHumanInputs) ? maxHumanInputs : null,
      humanInputsProvided: answeredManualTestTickets.size,
      providerRecoveries: resumedProviderFailures.size,
      transportRetries,
    },
    ...(missionContinuity ? { missionContinuity } : {}),
    metrics: projectMetrics(snapshot, acceptanceStartedAtMs),
    repository: repositoryResult,
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
    terminal: Boolean(snapshot && ["completed", "failed", "blocked", "paused", "cancelled", "interrupted"].includes(snapshot.status)),
    autonomy: {
      maxHumanInputs: Number.isFinite(maxHumanInputs) ? maxHumanInputs : null,
      humanInputsProvided: answeredManualTestTickets.size,
      providerRecoveries: resumedProviderFailures.size,
      transportRetries,
    },
    ...(missionContinuity ? { missionContinuity } : {}),
    metrics: snapshot ? projectMetrics(snapshot, acceptanceStartedAtMs) : undefined,
    repository: repositoryResult,
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
  if (process.env.AUTOAGENT_ACCEPTANCE_SEED) await seedAcceptanceWorkspace(process.env.AUTOAGENT_ACCEPTANCE_SEED);
  if (initializeGit) await initializeGitRepository();
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
      current.tickets.map((ticket) => `${ticket.status}:${ticket.title ?? ticket.brief?.slice(0, 24) ?? ticket.id}`).join(","),
    ].join(" | ");
    if (signature !== lastSignature) console.log(`[真实验收] ${signature}`);
    lastSignature = signature;
    const manualTest = current.tickets.find((ticket) =>
      ticket.status === "blocked"
      && ticket.blocker?.type === "manual_test_required"
      && !answeredManualTestTickets.has(ticket.id)
    );
    if (manualTest) {
      if (answeredManualTestTickets.size >= maxHumanInputs) {
        throw new Error(
          `Mission 请求了人工测试 Ticket ${manualTest.id}，但本次自主交付门禁最多允许 ${maxHumanInputs} 次人工输入`,
        );
      }
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
    if (["completed", "failed", "blocked", "paused", "cancelled", "interrupted"].includes(current.status)) return current;
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
  if (scenario === "node-cli") return runNodeCliAcceptance();
  if (scenario === "npm-library") return runNpmLibraryAcceptance();
  if (scenario === "issue-tracker-service") return runIssueTrackerServiceAcceptance();
  if (scenario === "brownfield-order-upgrade") return runBrownfieldOrderUpgradeAcceptance();
  if (scenario === "persistent-team-order-evolution") return runBrownfieldOrderUpgradeAcceptance({ withRefunds: true });
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

async function runNodeCliAcceptance() {
  const cliPath = path.join(workspaceRoot, "cli.mjs");
  const packagePath = path.join(workspaceRoot, "package.json");
  assert.ok(existsSync(cliPath), "Node CLI 交付缺少 cli.mjs");
  assert.ok(existsSync(packagePath), "Node CLI 交付缺少 package.json");
  const tests = await runNpm(["test"], 120_000);
  const fixturePath = path.join(reportDir, "cli-black-box.ndjson");
  await mkdir(reportDir, { recursive: true });
  await writeFile(fixturePath, [
    '{"level":"info","message":"boot"}',
    '{"level":"warn","message":"slow"}',
    '{broken json',
    '{"level":"error","message":"down"}',
    "",
  ].join("\n"), "utf8");
  const normal = await execFileAsync(
    process.execPath,
    [cliPath, "--input", fixturePath, "--level", "warn", "--json"],
    { cwd: workspaceRoot, encoding: "utf8", timeout: 30_000, windowsHide: true },
  );
  const parsed = JSON.parse(normal.stdout.trim());
  assert.deepEqual(parsed, { total: 4, valid: 3, invalid: 1, matched: 2 }, "CLI JSON 汇总结果不符合黑盒契约");
  let strictFailure;
  try {
    await execFileAsync(
      process.execPath,
      [cliPath, "--input", fixturePath, "--level", "warn", "--json", "--strict"],
      { cwd: workspaceRoot, encoding: "utf8", timeout: 30_000, windowsHide: true },
    );
  } catch (error) {
    strictFailure = error;
  }
  assert.ok(strictFailure, "CLI strict 模式遇到坏行时没有失败");
  assert.equal(strictFailure.code, 1, `CLI strict 模式退出码不是 1：${strictFailure.code}`);
  assert.match(String(strictFailure.stderr), /line\s+3/i, "CLI strict 模式没有定位坏行行号");
  return {
    scenario: "node-cli",
    npmTestExitCode: 0,
    npmTestOutput: tests.stdout.slice(-2_000),
    summary: parsed,
    strictExitCode: strictFailure.code,
  };
}

async function runNpmLibraryAcceptance() {
  const packagePath = path.join(workspaceRoot, "package.json");
  const entryPath = path.join(workspaceRoot, "index.js");
  assert.ok(existsSync(packagePath), "npm library 交付缺少 package.json");
  assert.ok(existsSync(entryPath), "npm library 交付缺少 index.js");
  const manifest = JSON.parse(await readFile(packagePath, "utf8"));
  assert.deepEqual(manifest.dependencies ?? {}, {}, "npm library 不允许包含运行时依赖");
  const tests = await runNpm(["test"], 120_000);
  const moduleUrl = pathToFileURL(entryPath).href;
  const library = await import(`${moduleUrl}?acceptance=${Date.now()}`);
  assert.equal(typeof library.summarize, "function", "npm library 没有导出 summarize(values)");
  assert.deepEqual(
    library.summarize([2, 4, 8, 10]),
    { count: 4, min: 2, max: 10, mean: 6 },
    "summarize(values) 黑盒结果不符合契约",
  );
  assert.throws(() => library.summarize([1, Number.NaN]), /finite|number|数值/i, "summarize 没有拒绝非有限数值");
  const packed = await runNpm(["pack", "--dry-run", "--json"], 60_000);
  const packReport = JSON.parse(packed.stdout);
  const files = packReport[0]?.files?.map((file) => file.path) ?? [];
  assert.ok(files.includes("index.js"), "npm pack 结果缺少 index.js");
  assert.equal(files.some((file) => file.startsWith("test") || file.includes("node_modules")), false, "npm pack 泄露测试或 node_modules");
  return {
    scenario: "npm-library",
    npmTestExitCode: 0,
    npmTestOutput: tests.stdout.slice(-2_000),
    packageName: manifest.name,
    packedFiles: files,
  };
}

async function runIssueTrackerServiceAcceptance() {
  const entryPath = path.join(workspaceRoot, "server.mjs");
  const packagePath = path.join(workspaceRoot, "package.json");
  assert.ok(existsSync(entryPath), "Issue Tracker 交付缺少 server.mjs");
  assert.ok(existsSync(packagePath), "Issue Tracker 交付缺少 package.json");
  const manifest = JSON.parse(await readFile(packagePath, "utf8"));
  assert.deepEqual(manifest.dependencies ?? {}, {}, "Issue Tracker 不允许包含运行时依赖");
  const tests = await runNpm(["test"], 180_000);
  await mkdir(reportDir, { recursive: true });
  const dataFile = path.join(reportDir, "issue-tracker-black-box.json");
  const port = await reservePort();
  let service = await startIssueTracker(entryPath, port, dataFile);
  const serviceUrl = `http://127.0.0.1:${port}`;
  try {
    const health = await requestIssueApi(serviceUrl, "/health");
    assert.equal(health.response.status, 200, "GET /health 未返回 200");
    assert.equal(health.value.ok, true, "GET /health 未返回 {ok:true}");

    const createdProject = await requestIssueApi(serviceUrl, "/api/projects", {
      method: "POST",
      body: { name: "自主交付项目" },
    });
    assert.equal(createdProject.response.status, 201, "创建 project 未返回 201");
    const projectId = createdProject.value.project?.id;
    assert.ok(typeof projectId === "string" && projectId.length > 0, "创建 project 未返回稳定 id");

    const firstIssue = await requestIssueApi(serviceUrl, `/api/projects/${projectId}/issues`, {
      method: "POST",
      headers: { "Idempotency-Key": "acceptance-issue-1" },
      body: { title: "修复持久化边界", priority: "high" },
    });
    assert.equal(firstIssue.response.status, 201, "首次创建 issue 未返回 201");
    assert.equal(firstIssue.value.issue?.status, "open", "新 issue 状态不是 open");
    assert.equal(firstIssue.value.issue?.version, 1, "新 issue version 不是 1");
    const firstIssueId = firstIssue.value.issue?.id;
    assert.ok(typeof firstIssueId === "string" && firstIssueId.length > 0, "创建 issue 未返回 id");

    const replay = await requestIssueApi(serviceUrl, `/api/projects/${projectId}/issues`, {
      method: "POST",
      headers: { "Idempotency-Key": "acceptance-issue-1" },
      body: { title: "修复持久化边界", priority: "high" },
    });
    assert.ok([200, 201].includes(replay.response.status), "幂等重放未返回成功状态");
    assert.equal(replay.value.issue?.id, firstIssueId, "幂等重放创建了不同 issue");

    const secondIssue = await requestIssueApi(serviceUrl, `/api/projects/${projectId}/issues`, {
      method: "POST",
      headers: { "Idempotency-Key": "acceptance-issue-2" },
      body: { title: "补充分页验证", priority: "low" },
    });
    assert.equal(secondIssue.response.status, 201, "创建第二条 issue 未返回 201");

    const highOnly = await requestIssueApi(serviceUrl, `/api/issues?projectId=${projectId}&priority=high`);
    assert.deepEqual(highOnly.value.items?.map((item) => item.id), [firstIssueId], "priority 筛选结果不准确");
    const firstPage = await requestIssueApi(serviceUrl, `/api/issues?projectId=${projectId}&limit=1`);
    assert.equal(firstPage.value.items?.length, 1, "第一页没有严格应用 limit=1");
    assert.ok(typeof firstPage.value.nextCursor === "string" && firstPage.value.nextCursor.length > 0, "第一页缺少 nextCursor");
    const secondPage = await requestIssueApi(
      serviceUrl,
      `/api/issues?projectId=${projectId}&limit=1&cursor=${encodeURIComponent(firstPage.value.nextCursor)}`,
    );
    assert.equal(secondPage.value.items?.length, 1, "第二页没有返回剩余 issue");
    assert.notEqual(secondPage.value.items?.[0]?.id, firstPage.value.items?.[0]?.id, "cursor 分页返回了重复 issue");

    const updated = await requestIssueApi(serviceUrl, `/api/issues/${firstIssueId}`, {
      method: "PATCH",
      body: { status: "closed", expectedVersion: 1 },
    });
    assert.equal(updated.response.status, 200, "合法状态更新未返回 200");
    assert.equal(updated.value.issue?.status, "closed", "状态更新未生效");
    assert.equal(updated.value.issue?.version, 2, "状态更新未递增 version");
    const stale = await requestIssueApi(serviceUrl, `/api/issues/${firstIssueId}`, {
      method: "PATCH",
      body: { status: "open", expectedVersion: 1 },
    });
    assert.equal(stale.response.status, 409, "旧 expectedVersion 写入未返回 409");

    const malformed = await fetch(`${serviceUrl}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{broken",
    });
    assert.equal(malformed.status, 400, "非法 JSON 未返回 400");

    await stopIssueTracker(service);
    service = await startIssueTracker(entryPath, port, dataFile);
    const afterRestart = await requestIssueApi(serviceUrl, `/api/issues?projectId=${projectId}&status=closed`);
    assert.deepEqual(afterRestart.value.items?.map((item) => item.id), [firstIssueId], "重启后已关闭 issue 没有恢复");
    assert.equal(afterRestart.value.items?.[0]?.version, 2, "重启后 issue version 没有恢复");

    return {
      scenario: "issue-tracker-service",
      npmTestExitCode: 0,
      npmTestOutput: tests.stdout.slice(-2_000),
      projectId,
      issueCount: 2,
      idempotencyPreserved: true,
      staleWriteStatus: stale.response.status,
      paginationVerified: true,
      restartPersistenceVerified: true,
    };
  } finally {
    await stopIssueTracker(service);
  }
}

async function runBrownfieldOrderUpgradeAcceptance({ withRefunds = false } = {}) {
  const entryPath = path.join(workspaceRoot, "server.mjs");
  const packagePath = path.join(workspaceRoot, "package.json");
  assert.ok(existsSync(entryPath), "brownfield Order Service 缺少原有 server.mjs");
  assert.ok(existsSync(packagePath), "brownfield Order Service 缺少原有 package.json");
  const manifest = JSON.parse(await readFile(packagePath, "utf8"));
  assert.deepEqual(manifest.dependencies ?? {}, {}, "brownfield Order Service 不允许新增运行时依赖");
  const tests = await runNpm(["test"], 180_000);
  await mkdir(reportDir, { recursive: true });
  const dataFile = path.join(reportDir, "brownfield-v1-data.json");
  const legacyOrder = {
    id: "legacy-order-001",
    customer: "Legacy Customer",
    amount: 73.5,
    status: "pending",
    createdAt: "2025-01-02T03:04:05.000Z",
  };
  await writeFile(dataFile, `${JSON.stringify({ schemaVersion: 1, orders: [legacyOrder] }, null, 2)}\n`, "utf8");
  const port = await reservePort();
  let service = await startIssueTracker(entryPath, port, dataFile);
  const serviceUrl = `http://127.0.0.1:${port}`;
  try {
    const migrated = await requestIssueApi(serviceUrl, `/api/orders/${legacyOrder.id}`);
    assert.equal(migrated.response.status, 200, "迁移后旧 order 无法读取");
    assert.deepEqual(
      Object.fromEntries(Object.keys(legacyOrder).map((key) => [key, migrated.value.order?.[key]])),
      legacyOrder,
      "v1→v2 迁移没有完整保留旧 order 字段",
    );
    assert.equal(migrated.value.order?.version, 1, "迁移后的旧 order version 不是 1");
    const migratedAudit = await requestIssueApi(serviceUrl, `/api/orders/${legacyOrder.id}/audit`);
    assert.equal(migratedAudit.response.status, 200, "迁移后旧 order 审计接口不可用");
    assert.deepEqual(migratedAudit.value.events?.map((event) => event.type), ["order.created"], "迁移没有补齐 order.created 审计");

    const created = await requestIssueApi(serviceUrl, "/api/orders", {
      method: "POST",
      body: { customer: "New Customer", amount: 125 },
    });
    assert.equal(created.response.status, 201, "升级后原有 POST /api/orders 契约失效");
    const orderId = created.value.order?.id;
    assert.ok(typeof orderId === "string" && orderId.length > 0, "升级后创建 order 未返回 id");
    assert.equal(created.value.order?.version, 1, "新 order version 不是 1");

    const cancelled = await requestIssueApi(serviceUrl, `/api/orders/${orderId}/cancel`, {
      method: "POST",
      body: { reason: "customer request", expectedVersion: 1 },
    });
    assert.equal(cancelled.response.status, 200, "合法取消未返回 200");
    assert.equal(cancelled.value.order?.status, "cancelled", "合法取消未改变状态");
    assert.equal(cancelled.value.order?.version, 2, "合法取消未递增 version");
    const stale = await requestIssueApi(serviceUrl, `/api/orders/${orderId}/cancel`, {
      method: "POST",
      body: { reason: "stale retry", expectedVersion: 1 },
    });
    assert.equal(stale.response.status, 409, "旧版本或终态重复取消未返回 409");
    const audit = await requestIssueApi(serviceUrl, `/api/orders/${orderId}/audit`);
    assert.deepEqual(audit.value.events?.map((event) => event.type), ["order.created", "order.cancelled"], "新 order 审计事件不完整或顺序错误");
    assert.equal(audit.value.events?.[1]?.reason, "customer request", "取消审计没有保留 reason");

    let refund;
    if (withRefunds) {
      const refunded = await requestIssueApi(serviceUrl, `/api/orders/${orderId}/refunds`, {
        method: "POST",
        headers: { "Idempotency-Key": "acceptance-refund-1" },
        body: { amount: 25, expectedVersion: 2 },
      });
      assert.equal(refunded.response.status, 201, "合法退款未返回 201");
      assert.equal(refunded.value.order?.version, 3, "合法退款未递增 order.version");
      refund = refunded.value.refund;
      assert.ok(typeof refund?.id === "string" && refund.id.length > 0, "合法退款未返回 refund id");
      const replayed = await requestIssueApi(serviceUrl, `/api/orders/${orderId}/refunds`, {
        method: "POST",
        headers: { "Idempotency-Key": "acceptance-refund-1" },
        body: { amount: 25, expectedVersion: 2 },
      });
      assert.ok([200, 201].includes(replayed.response.status), "退款幂等重放未返回成功状态");
      assert.equal(replayed.value.refund?.id, refund.id, "退款幂等重放生成了不同 refund");
      const staleRefund = await requestIssueApi(serviceUrl, `/api/orders/${orderId}/refunds`, {
        method: "POST",
        headers: { "Idempotency-Key": "acceptance-refund-stale" },
        body: { amount: 5, expectedVersion: 2 },
      });
      assert.equal(staleRefund.response.status, 409, "旧版本退款未返回 409");
      const refunds = await requestIssueApi(serviceUrl, `/api/orders/${orderId}/refunds`);
      assert.deepEqual(refunds.value.refunds?.map((item) => item.id), [refund.id], "退款列表存在重复或缺失");
      const refundAudit = await requestIssueApi(serviceUrl, `/api/orders/${orderId}/audit`);
      assert.deepEqual(
        refundAudit.value.events?.map((event) => event.type),
        ["order.created", "order.cancelled", "order.refunded"],
        "退款后审计事件不完整或顺序错误",
      );
    }

    await stopIssueTracker(service);
    service = await startIssueTracker(entryPath, port, dataFile);
    const afterRestart = await requestIssueApi(serviceUrl, `/api/orders/${orderId}`);
    assert.equal(afterRestart.value.order?.status, "cancelled", "重启后取消状态没有恢复");
    assert.equal(afterRestart.value.order?.version, withRefunds ? 3 : 2, "重启后 order version 没有恢复");
    const persisted = JSON.parse(await readFile(dataFile, "utf8"));
    assert.equal(persisted.schemaVersion, withRefunds ? 3 : 2, `迁移后磁盘 schemaVersion 不是 ${withRefunds ? 3 : 2}`);
    const siblingFiles = await readdir(path.dirname(dataFile));
    assert.equal(siblingFiles.some((name) => name.includes(".tmp")), false, "原子写入留下了临时文件");

    return {
      scenario: withRefunds ? "persistent-team-order-evolution" : "brownfield-order-upgrade",
      npmTestExitCode: 0,
      npmTestOutput: tests.stdout.slice(-2_000),
      legacyOrderPreserved: true,
      migratedSchemaVersion: persisted.schemaVersion,
      cancellationConflictStatus: stale.response.status,
      auditTypes: audit.value.events.map((event) => event.type),
      ...(withRefunds ? { refundId: refund.id, refundIdempotencyPreserved: true } : {}),
      restartPersistenceVerified: true,
    };
  } finally {
    await stopIssueTracker(service);
  }
}

async function seedAcceptanceWorkspace(seedName) {
  const entries = await readdir(workspaceRoot);
  const nonPlatformEntries = entries.filter((entry) => entry !== ".autoagent");
  assert.deepEqual(nonPlatformEntries, [], `seeded acceptance workspace 除平台 .autoagent 外必须为空：${entries.join(", ")}`);
  const seedRoot = path.join(projectRoot, "scripts", "fixtures", seedName);
  assert.ok(existsSync(seedRoot), `找不到 acceptance seed：${seedName}`);
  await cp(seedRoot, workspaceRoot, { recursive: true });
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function startIssueTracker(entryPath, port, dataFile) {
  const child = spawn(process.execPath, [entryPath], {
    cwd: workspaceRoot,
    env: { ...process.env, PORT: String(port), DATA_FILE: dataFile },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output = `${output}${chunk}`.slice(-4_000); });
  child.stderr.on("data", (chunk) => { output = `${output}${chunk}`.slice(-4_000); });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Issue Tracker 启动前退出 (${child.exitCode})：${output}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return child;
    } catch {
      // The process may not have bound its port yet.
    }
    await sleep(100);
  }
  child.kill();
  throw new Error(`Issue Tracker 在 15 秒内未就绪：${output}`);
}

async function stopIssueTracker(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill();
  await Promise.race([exited, sleep(3_000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function requestIssueApi(serviceUrl, route, options = {}) {
  const response = await fetch(`${serviceUrl}${route}`, {
    method: options.method ?? "GET",
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.headers ?? {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  let value;
  try {
    value = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${options.method ?? "GET"} ${route} 返回非 JSON (${response.status}): ${text.slice(0, 300)}`);
  }
  return { response, value };
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
  const usesCheckbox = await firstCheckbox.count() > 0 && await firstCheckbox.isVisible();
  if (usesCheckbox) {
    await firstCheckbox.check();
    assert.equal(await firstCheckbox.isChecked(), true, "勾选完成没有生效");
  } else {
    const completeButton = firstRow.getByRole("button", { name: /完成/ }).first();
    await assertVisible(completeButton, "第一条待办没有可访问的完成控件（checkbox 或完成按钮）");
    await completeButton.click();
    const completedRow = page.getByText("真实验收任务一", { exact: true }).locator("xpath=ancestor::*[self::li or self::article][1]");
    const restoreButton = completedRow.getByRole("button", { name: /恢复|取消完成/ }).first();
    const completedStatus = completedRow.getByText(/已完成/, { exact: true }).first();
    assert.ok(
      (await restoreButton.count() > 0 && await restoreButton.isVisible())
        || (await completedStatus.count() > 0 && await completedStatus.isVisible()),
      "点击完成按钮后没有可观察到的已完成状态",
    );
  }

  await page.reload({ waitUntil: "load" });
  const persistedRow = page.getByText("真实验收任务一", { exact: true }).locator("xpath=ancestor::*[self::li or self::article][1]");
  if (usesCheckbox) {
    assert.equal(await persistedRow.getByRole("checkbox").first().isChecked(), true, "刷新后完成状态没有持久化");
  } else {
    const persistedRestoreButton = persistedRow.getByRole("button", { name: /恢复|取消完成/ }).first();
    const persistedCompletedStatus = persistedRow.getByText(/已完成/, { exact: true }).first();
    assert.ok(
      (await persistedRestoreButton.count() > 0 && await persistedRestoreButton.isVisible())
        || (await persistedCompletedStatus.count() > 0 && await persistedCompletedStatus.isVisible()),
      "刷新后按钮式完成状态没有持久化",
    );
  }

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
    completionControl: usesCheckbox ? "checkbox" : "button",
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
  const method = options.method ?? "GET";
  const maxTransportRetries = method === "GET" ? 3 : 0;
  let response;
  for (let attempt = 0; ; attempt += 1) {
    try {
      response = await fetch(`${baseUrl}${route}`, {
        method,
        headers: options.body ? { "content-type": "application/json" } : undefined,
        body: options.body ? JSON.stringify(options.body) : undefined,
      });
      break;
    } catch (error) {
      if (attempt >= maxTransportRetries) throw error;
      transportRetries += 1;
      const retryDelayMs = 500 * (2 ** attempt);
      console.warn(`[真实验收] ${method} ${route} 传输失败，${retryDelayMs}ms 后进行第 ${attempt + 1}/${maxTransportRetries} 次重试`);
      await sleep(retryDelayMs);
    }
  }
  const text = await response.text();
  let value;
  try {
    value = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${method} ${route} 返回非 JSON (${response.status}): ${text.slice(0, 500)}`);
  }
  if (!response.ok) throw new Error(`${method} ${route} 失败 (${response.status}): ${JSON.stringify(value)}`);
  return value;
}

async function saveReport(report) {
  await mkdir(reportDir, { recursive: true });
  await writeFile(path.join(reportDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

async function initializeGitRepository() {
  if (existsSync(path.join(workspaceRoot, ".git"))) return;
  await execFileAsync("git", ["init"], { cwd: workspaceRoot, encoding: "utf8", windowsHide: true });
  await writeFile(path.join(workspaceRoot, ".gitignore"), ".autoagent/\nnode_modules/\n", "utf8");
  await execFileAsync("git", ["add", "--all"], { cwd: workspaceRoot, encoding: "utf8", windowsHide: true });
  await execFileAsync(
    "git",
    ["-c", "user.name=AutoAgent Acceptance", "-c", "user.email=acceptance@autoagent.local", "commit", "-m", "acceptance baseline"],
    { cwd: workspaceRoot, encoding: "utf8", windowsHide: true },
  );
}

async function runNpm(args, timeout) {
  if (process.platform === "win32") {
    return execFileAsync(
      process.env.ComSpec ?? "cmd.exe",
      ["/d", "/s", "/c", `npm.cmd ${args.join(" ")}`],
      { cwd: workspaceRoot, encoding: "utf8", timeout, windowsHide: true },
    );
  }
  return execFileAsync("npm", args, { cwd: workspaceRoot, encoding: "utf8", timeout, windowsHide: true });
}

async function inspectRepository() {
  if (!existsSync(path.join(workspaceRoot, ".git"))) return { required: initializeGit, detected: false, clean: null, status: [] };
  const { stdout } = await execFileAsync(
    "git",
    ["status", "--porcelain", "--untracked-files=all"],
    { cwd: workspaceRoot, encoding: "utf8", windowsHide: true },
  );
  const status = stdout.split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
  return { required: initializeGit, detected: true, clean: status.length === 0, status };
}

function projectMetrics(current, startedAtMs) {
  const tickets = current.tickets ?? [];
  const workstreams = new Set(tickets.map((ticket) => ticket.workstream).filter(Boolean));
  const taskStartedAt = Date.parse(current.activeTaskRun?.startedAt ?? "");
  const taskEndedAt = Date.parse(current.activeTaskRun?.endedAt ?? "");
  const effectiveStart = Number.isFinite(taskStartedAt) ? taskStartedAt : startedAtMs;
  const effectiveEnd = Number.isFinite(taskEndedAt) ? taskEndedAt : Date.now();
  return {
    durationMs: Math.max(0, effectiveEnd - effectiveStart),
    planVersion: current.mission?.planVersion ?? null,
    ticketCount: tickets.length,
    totalAttempts: tickets.reduce((sum, ticket) => sum + Math.max(0, Number(ticket.attempt ?? 0)), 0),
    returnedTicketCount: tickets.filter((ticket) => ticket.status === "returned").length,
    workstreamCount: workstreams.size,
    isolatedTicketCount: tickets.filter((ticket) => ticket.execution?.workspaceMode === "git_worktree").length,
    changedFileCount: tickets.reduce((sum, ticket) => sum + Math.max(0, Number(ticket.execution?.changedFileCount ?? 0)), 0),
  };
}

function failureMessage(message, current) {
  const tickets = current?.tickets?.map((ticket) => `${ticket.title}:${ticket.status}`).join(", ") ?? "无";
  return `${message}。状态=${current?.status ?? "unknown"}，Tickets=${tickets}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
