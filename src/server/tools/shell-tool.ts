import { exec, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { assertCommandAllowed } from "../policy/command-policy.js";
import { workspaceAutoAgentDir } from "../storage/paths.js";
import { emitToolEvent, policyFor, type ToolContext } from "./tool-runtime.js";

const execAsync = promisify(exec);
const SHORT_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const SERVICE_START_OBSERVATION_MS = 3_000;
const LOG_EXCERPT_CHARS = 4_000;

export type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  service?: true;
  serviceId?: string;
  pid?: number;
  stdoutLog?: string;
  stderrLog?: string;
  urls?: string[];
  running?: boolean;
};

export async function runWorkspaceCommand(context: ToolContext, command: string): Promise<CommandResult> {
  await emitToolEvent(context, "tool.started", `执行命令：${command}`, { tool: "shell", command });
  try {
    assertCommandAllowed(policyFor(context), command);
    if (looksLikeLongRunningService(command)) {
      return startWorkspaceService(context, command, "shell");
    }
    const result = await execAsync(command, {
      cwd: context.workspace.rootPath,
      windowsHide: true,
      timeout: SHORT_COMMAND_TIMEOUT_MS
    });
    await emitToolEvent(context, "tool.completed", "命令执行完成", { tool: "shell", command, stdout: result.stdout, stderr: result.stderr, exitCode: 0 });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    const err = error as Error & { stdout?: string; stderr?: string; code?: number };
    const timedOut = err.message.includes("timed out") || err.message.includes("ETIMEDOUT");
    await emitToolEvent(context, err.message.includes("not allowed") ? "tool.denied" : "tool.failed", timedOut ? "命令执行超时" : "命令执行失败", {
      tool: "shell",
      command,
      stdout: err.stdout,
      stderr: err.stderr,
      exitCode: err.code ?? 1,
      error: err.message
    });
    if (err.message.includes("not allowed") || err.message.includes("allowlisted")) throw error;
    return { stdout: err.stdout ?? "", stderr: err.stderr ?? err.message, exitCode: err.code ?? 1 };
  }
}

export interface ServiceStartResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  service: true;
  serviceId: string;
  pid: number | undefined;
  stdoutLog: string;
  stderrLog: string;
  urls: string[];
  running?: boolean;
}

export async function startWorkspaceService(context: ToolContext, command: string, requestedTool = "startService"): Promise<ServiceStartResult> {
  if (requestedTool !== "shell") {
    await emitToolEvent(context, "tool.started", `启动服务：${command}`, { tool: requestedTool, command });
  }
  assertCommandAllowed(policyFor(context), command);
  const serviceId = `svc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const servicesDir = path.join(workspaceAutoAgentDir(context.workspace.rootPath), "services");
  await mkdir(servicesDir, { recursive: true });
  const stdoutLog = path.join(servicesDir, `${serviceId}.out.log`);
  const stderrLog = path.join(servicesDir, `${serviceId}.err.log`);
  const metadataFile = path.join(servicesDir, `${serviceId}.json`);
  const stdoutStream = createWriteStream(stdoutLog, { flags: "a" });
  const stderrStream = createWriteStream(stderrLog, { flags: "a" });
  let stdoutBuffer = "";
  let stderrBuffer = "";
  let exitCode: number | null = null;
  let spawnError: Error | undefined;
  let streamsClosed = false;
  const closeStreams = () => {
    if (streamsClosed) return;
    streamsClosed = true;
    stdoutStream.end();
    stderrStream.end();
  };
  try {
    const child = spawn(command, {
      cwd: context.workspace.rootPath,
      shell: true,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdoutBuffer = trimExcerpt(`${stdoutBuffer}${text}`);
      stdoutStream.write(text);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderrBuffer = trimExcerpt(`${stderrBuffer}${text}`);
      stderrStream.write(text);
    });
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("exit", (code) => {
      exitCode = code ?? 0;
      closeStreams();
    });
    await writeFile(metadataFile, `${JSON.stringify({
      serviceId,
      command,
      cwd: context.workspace.rootPath,
      workspaceId: context.workspace.id,
      taskId: context.taskId,
      taskRunId: context.taskRunId,
      assignmentRunId: context.assignmentRunId,
      agentId: context.agent.id,
      pid: child.pid,
      stdoutLog,
      stderrLog,
      startedAt: new Date().toISOString()
    }, null, 2)}\n`, "utf8");
    await delay(SERVICE_START_OBSERVATION_MS);
    const stdout = stdoutBuffer || await readExcerpt(stdoutLog);
    const stderr = stderrBuffer || await readExcerpt(stderrLog);
    const urls = findUrls(`${stdout}\n${stderr}`);
    if (spawnError) throw spawnError;
    if (exitCode !== null && exitCode !== 0) {
      await emitToolEvent(context, "tool.failed", "服务启动失败", { tool: requestedTool, command, stdout, stderr, exitCode });
      return { stdout, stderr, exitCode, service: true, serviceId, pid: child.pid, stdoutLog, stderrLog, urls };
    }
    const running = exitCode === null && isProcessRunning(child.pid ?? -1);
    await emitToolEvent(context, "tool.completed", running ? "服务仍在运行" : "服务已退出", {
      tool: requestedTool,
      command,
      serviceId,
      pid: child.pid,
      stdoutLog,
      stderrLog,
      urls,
      stdout,
      stderr,
      exitCode: exitCode ?? 0,
      running
    });
    return { stdout, stderr, exitCode: exitCode ?? 0, service: true, serviceId, pid: child.pid, stdoutLog, stderrLog, urls, running };
  } catch (error) {
    const stdout = await readExcerpt(stdoutLog);
    const stderr = await readExcerpt(stderrLog);
    await emitToolEvent(context, "tool.failed", "服务启动失败", {
      tool: requestedTool,
      command,
      stdout,
      stderr,
      exitCode: exitCode ?? 1,
      error: (error as Error).message
    });
    return { stdout, stderr: stderr || (error as Error).message, exitCode: exitCode ?? 1, service: true, serviceId, pid: undefined, stdoutLog, stderrLog, urls: [] };
  } finally {
    if (exitCode !== null || spawnError) {
      closeStreams();
    }
  }
}

export async function pollWorkspaceProcess(context: ToolContext, serviceId: string): Promise<CommandResult> {
  const metadataFile = path.join(workspaceAutoAgentDir(context.workspace.rootPath), "services", `${serviceId}.json`);
  const metadata = JSON.parse(await readFile(metadataFile, "utf8")) as {
    pid?: number;
    command?: string;
    stdoutLog?: string;
    stderrLog?: string;
  };
  const stdoutLog = String(metadata.stdoutLog ?? "");
  const stderrLog = String(metadata.stderrLog ?? "");
  const stdout = await readExcerpt(stdoutLog);
  const stderr = await readExcerpt(stderrLog);
  const urls = findUrls(`${stdout}\n${stderr}`);
  const running = metadata.pid ? isProcessRunning(metadata.pid) : false;
  await emitToolEvent(context, "tool.completed", running ? "进程仍在运行" : "进程已结束", {
    tool: "pollProcess",
    serviceId,
    command: metadata.command,
    pid: metadata.pid,
    stdout,
    stderr,
    stdoutLog,
    stderrLog,
    urls,
    running
  });
  return { stdout, stderr, exitCode: 0, service: true, serviceId, pid: metadata.pid, stdoutLog, stderrLog, urls, running };
}

function looksLikeLongRunningService(command: string): boolean {
  const normalized = command.toLowerCase();
  return /\bnpm(?:\.cmd)?\s+run\s+(dev|start|preview)\b/.test(normalized)
    || /\bpnpm\s+(dev|start|preview)\b/.test(normalized)
    || /\byarn\s+(dev|start|preview)\b/.test(normalized)
    || /\b(vite|next|nuxt|astro|webpack-dev-server|http-server|live-server)\b/.test(normalized);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessRunning(pid: number): boolean {
  if (!pid || pid < 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readExcerpt(filePath: string): Promise<string> {
  try {
    const content = await readFile(filePath, "utf8");
    if (content.length <= LOG_EXCERPT_CHARS) return content;
    return `${content.slice(-LOG_EXCERPT_CHARS)}\n[日志已截断，原始长度 ${content.length} 字符]`;
  } catch {
    return "";
  }
}

function trimExcerpt(content: string): string {
  if (content.length <= LOG_EXCERPT_CHARS) return content;
  return `${content.slice(-LOG_EXCERPT_CHARS)}\n[日志已截断，原始长度 ${content.length} 字符]`;
}

function findUrls(text: string): string[] {
  return Array.from(new Set(text.match(/https?:\/\/[^\s"'<>]+/g) ?? []));
}
