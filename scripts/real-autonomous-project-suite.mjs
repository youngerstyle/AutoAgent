import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const projectRoot = path.resolve(".");
const baseUrl = process.env.AUTOAGENT_BASE_URL ?? "http://127.0.0.1:13748";
const suiteRoot = process.env.AUTOAGENT_AUTONOMOUS_SUITE_ROOT
  ?? await mkdtemp(path.join(os.tmpdir(), "autoagent-autonomous-suite-"));
const reportFile = path.join(suiteRoot, "suite-report.json");
const timeoutMs = Number(process.env.AUTOAGENT_AUTONOMOUS_CASE_TIMEOUT_MS ?? 2 * 60 * 60_000);
const selectedCaseIds = new Set(
  (process.env.AUTOAGENT_AUTONOMOUS_CASES ?? "project-board,node-cli,npm-library,issue-tracker-service")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);

const cases = [
  {
    id: "project-board",
    scenario: "todo",
    goal: [
      "在当前空目录交付一个无需构建、直接打开 index.html 即可使用的中文项目看板。",
      "必须支持创建任务、完成任务、删除任务、按状态筛选，并用 localStorage 在刷新后保留数据；首次打开要有清晰的空状态。",
      "桌面和 390px 手机视口都不能横向滚动，浏览器控制台不能报错。",
      "同时提供 README，说明启动方式、数据边界和验证方法；团队必须自行完成实现、自动化检查、独立 QA 和最终验收。",
      "不得请求 human 替团队测试或编辑文件。",
    ].join(" "),
  },
  {
    id: "node-cli",
    scenario: "node-cli",
    goal: [
      "在当前空目录交付一个 Node.js 20+、零运行时依赖的 NDJSON 日志统计 CLI。",
      "固定入口为 cli.mjs，package.json 必须提供 npm test。命令 node cli.mjs --input <file> --level warn --json",
      "必须输出且只输出 JSON {total,valid,invalid,matched}；level 阈值顺序为 debug、info、warn、error，坏 JSON 行计入 invalid。",
      "加入 --strict 后遇到第一条坏行必须向 stderr 报告从 1 开始的行号并以退出码 1 结束。",
      "请提供 README 和覆盖文件输入、阈值、坏行、strict 退出码的自动化测试；独立 QA 必须运行正式 npm test 和真实 CLI 命令。",
      "不得请求 human 替团队测试或编辑文件。",
    ].join(" "),
  },
  {
    id: "npm-library",
    scenario: "npm-library",
    goal: [
      "在当前空目录交付一个 Node.js 20+ 的零运行时依赖 ESM npm library。",
      "固定入口为 index.js，必须导出 summarize(values)，对有限数值数组返回 {count,min,max,mean}；空数组返回 {count:0,min:null,max:null,mean:null}，非有限数值必须抛出清晰错误。",
      "package.json 必须提供 exports 和 npm test，npm pack 只能包含发布所需的 package.json、index.js、README 和 LICENSE，不得包含测试或 node_modules。",
      "请提供覆盖正常、空数组、负数、小数、NaN 和 Infinity 的自动化测试，并由独立 QA 运行 npm test、真实 import 和 npm pack --dry-run。",
      "不得请求 human 替团队测试或编辑文件。",
    ].join(" "),
  },
  {
    id: "issue-tracker-service",
    scenario: "issue-tracker-service",
    goal: [
      "在当前空目录交付一个 Node.js 20+、零运行时依赖的持久化 Issue Tracker HTTP 服务，固定入口为 server.mjs。",
      "服务必须读取 PORT 和 DATA_FILE 环境变量，提供 GET /health，并以 JSON 文件持久化 projects、issues 和幂等键；进程重启后数据必须保留。",
      "POST /api/projects 接收 {name} 并返回 {project}；POST /api/projects/:projectId/issues 接收 {title,priority}，priority 只能是 low、medium、high。",
      "创建 issue 必须支持 Idempotency-Key：同一 key 重放不得新增第二条 issue，并返回同一 id。新 issue 的 status=open、version=1。",
      "PATCH /api/issues/:id 接收 {status,expectedVersion}，status 只能是 open、in_progress、closed；版本匹配时递增 version，旧版本写入必须返回 409。",
      "GET /api/issues 必须支持 projectId、status、priority 筛选以及 limit、cursor 稳定分页，返回 {items,nextCursor}。非法 JSON、字段或查询参数返回 400，不存在资源返回 404。",
      "持久化写入必须避免留下半写 JSON；package.json 必须提供 npm test，并提供 README，测试要覆盖路由契约、幂等、并发冲突、分页、错误输入和重启持久化。",
      "团队必须完成架构、分模块实现、自动化检查、独立 QA 和最终验收；不得请求 human 替团队测试、编辑文件或启动服务。",
    ].join(" "),
  },
].filter((item) => selectedCaseIds.has(item.id));

assert.ok(cases.length > 0, "自主项目套件没有选中任何 case");
assert.deepEqual(
  [...selectedCaseIds].sort(),
  cases.map((item) => item.id).sort(),
  `存在未知 case；可选值：project-board,node-cli,npm-library,issue-tracker-service`,
);

console.log(`[自主项目套件] root=${suiteRoot}`);
await preflight();
const startedAt = new Date().toISOString();
const results = [];
for (const definition of cases) {
  results.push(await runCase(definition));
}

const passedCount = results.filter((result) => result.passed).length;
const report = {
  passed: passedCount === results.length,
  generatedAt: new Date().toISOString(),
  startedAt,
  baseUrl,
  suiteRoot,
  summary: {
    caseCount: results.length,
    passedCount,
    failedCount: results.length - passedCount,
    successRate: passedCount / results.length,
    totalDurationMs: results.reduce((sum, result) => sum + Number(result.report?.metrics?.durationMs ?? 0), 0),
    totalTickets: results.reduce((sum, result) => sum + Number(result.report?.metrics?.ticketCount ?? 0), 0),
    totalAttempts: results.reduce((sum, result) => sum + Number(result.report?.metrics?.totalAttempts ?? 0), 0),
    humanInputsProvided: results.reduce((sum, result) => sum + Number(result.report?.autonomy?.humanInputsProvided ?? 0), 0),
    cleanRepositoryCount: results.filter((result) => result.report?.repository?.clean === true).length,
  },
  cases: results,
};
await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
assert.equal(report.passed, true, `自主项目套件未全部通过；报告：${reportFile}`);

async function runCase(definition) {
  const rootPath = path.join(suiteRoot, definition.id);
  await mkdir(rootPath, { recursive: true });
  console.log(`[自主项目套件] 开始 ${definition.id}`);
  const child = spawn(process.execPath, [path.join(projectRoot, "scripts", "real-user-acceptance.mjs")], {
    cwd: projectRoot,
    env: {
      ...process.env,
      AUTOAGENT_BASE_URL: baseUrl,
      AUTOAGENT_ACCEPTANCE_ROOT: rootPath,
      AUTOAGENT_ACCEPTANCE_GOAL: definition.goal,
      AUTOAGENT_ACCEPTANCE_SCENARIO: definition.scenario,
      AUTOAGENT_ACCEPTANCE_TIMEOUT_MS: String(timeoutMs),
      AUTOAGENT_ACCEPTANCE_GIT_INIT: "true",
      AUTOAGENT_ACCEPTANCE_MAX_HUMAN_INPUTS: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    const text = String(chunk);
    stdout = `${stdout}${text}`.slice(-20_000);
    process.stdout.write(`[${definition.id}] ${text}`);
  });
  child.stderr.on("data", (chunk) => {
    const text = String(chunk);
    stderr = `${stderr}${text}`.slice(-20_000);
    process.stderr.write(`[${definition.id}] ${text}`);
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  const caseReportFile = path.join(rootPath, ".autoagent", "user-acceptance", "report.json");
  const caseReport = await readFile(caseReportFile, "utf8").then(JSON.parse).catch(() => undefined);
  const passed = exitCode === 0 && caseReport?.passed === true;
  console.log(`[自主项目套件] ${definition.id} ${passed ? "PASS" : "FAIL"}`);
  return {
    id: definition.id,
    scenario: definition.scenario,
    passed,
    exitCode,
    rootPath,
    reportFile: caseReportFile,
    report: passed ? caseReport : summarizeFailedReport(caseReport),
    ...(passed ? {} : { stdoutTail: stdout, stderrTail: stderr }),
  };
}

function summarizeFailedReport(report) {
  if (!report) return undefined;
  return {
    passed: report.passed,
    outcome: report.outcome,
    observationStatus: report.observationStatus,
    businessStatusAtLastObservation: report.businessStatusAtLastObservation,
    error: report.error,
    workspace: report.workspace,
    task: report.task,
    autonomy: report.autonomy,
    metrics: report.metrics,
    repository: report.repository,
  };
}

async function preflight() {
  const response = await fetch(`${baseUrl}/api/health`);
  const health = await response.json().catch(() => ({}));
  assert.equal(response.ok && health.ok === true && health.ready !== false, true, `AutoAgent 服务未就绪：${baseUrl}`);
  const providersResponse = await fetch(`${baseUrl}/api/providers/status`);
  const providers = await providersResponse.json().catch(() => ({}));
  assert.equal(
    providersResponse.ok && (providers.providers?.openai?.configured || providers.providers?.anthropic?.configured),
    true,
    "自主项目套件需要真实 OpenAI 或 Anthropic Provider",
  );
}
