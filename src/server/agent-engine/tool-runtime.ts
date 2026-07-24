import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, open, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { EvidenceArtifactFact, EvidenceKind } from "../../shared/contracts/agent-engine.js";
import type { WorkspaceToolName } from "../../shared/types.js";
import type { AgentToolDefinition } from "../providers/types.js";
import type { EffectivePolicy } from "../policy/policy.js";
import { assertCommandAllowed } from "../policy/command-policy.js";
import { resolveToolPath } from "../policy/path-policy.js";
import { EvidenceLedger } from "./evidence-ledger.js";

const DEFAULT_SHELL_YIELD_MS = 2_000;
const MAX_LOG_CHARS = 64_000;
const DEFAULT_FILE_READ_CHARS = 32_000;
const MAX_FILE_READ_CHARS = 64_000;
const PLATFORM_STATE_DIRECTORY = ".autoagent";

export interface AgentToolIntent {
  tool: WorkspaceToolName;
  path?: string;
  content?: string;
  offset?: number;
  limit?: number;
  command?: string;
  serviceId?: string;
  browserArgs?: string[];
}

export interface AgentToolResult extends Record<string, unknown> {
  tool: WorkspaceToolName;
  ok: boolean;
  evidenceId?: string;
}

export interface AgentToolExecutionContext {
  agentId: string;
  threadId: string;
  goalId?: string;
  attemptId?: string;
  turnId: string;
  toolCallId: string;
}

export class AgentToolRuntime {
  private readonly enabled: Set<WorkspaceToolName>;
  private readonly evidence: EvidenceLedger;

  constructor(
    private readonly policy: EffectivePolicy,
    enabledTools: WorkspaceToolName[],
    private readonly options: { shellYieldMs?: number } = {},
  ) {
    this.enabled = new Set(enabledTools);
    this.evidence = new EvidenceLedger(policy.workspaceRoot);
  }

  async execute(intent: AgentToolIntent, context?: AgentToolExecutionContext): Promise<AgentToolResult> {
    const result = await this.executeRaw(intent, context);
    if (!context) return result;
    const fact = await this.evidence.append({
      ...context,
      toolName: intent.tool,
      kind: evidenceKind(intent.tool),
      status: !result.ok ? "failed" : result.running === true ? "running" : "succeeded",
      workspaceRoot: this.policy.workspaceRoot,
      createdAt: new Date().toISOString(),
      input: structuredClone(intent),
      result: evidenceResult(result),
      artifact: await this.artifactFact(intent, result),
    });
    return { ...result, evidenceId: fact.evidenceId };
  }

  private async executeRaw(intent: AgentToolIntent, context?: AgentToolExecutionContext): Promise<AgentToolResult> {
    if (!this.enabled.has(intent.tool)) return { tool: intent.tool, ok: false, error: "工具未配置" };
    try {
      if (intent.tool === "listFiles") {
        const target = resolveToolPath(this.policy, intent.path ?? ".", "read");
        assertAgentVisiblePath(this.policy.workspaceRoot, target);
        const files = await readdir(target);
        return {
          tool: intent.tool,
          ok: true,
          path: intent.path ?? ".",
          files: isWorkspaceRoot(this.policy.workspaceRoot, target)
            ? files.filter((entry) => entry.toLowerCase() !== PLATFORM_STATE_DIRECTORY)
            : files,
        };
      }
      if (intent.tool === "readFile") {
        const target = resolveToolPath(this.policy, required(intent.path, "path"), "read");
        assertAgentVisiblePath(this.policy.workspaceRoot, target);
        const content = await readFile(target, "utf8");
        const offset = normalizeReadOffset(intent.offset, content.length);
        const limit = normalizeReadLimit(intent.limit);
        const end = Math.min(content.length, offset + limit);
        return {
          tool: intent.tool,
          ok: true,
          path: intent.path,
          content: content.slice(offset, end),
          offset,
          totalChars: content.length,
          truncated: end < content.length,
          ...(end < content.length ? { nextOffset: end } : {}),
        };
      }
      if (intent.tool === "readImage") {
        const target = resolveToolPath(this.policy, required(intent.path, "path"), "read");
        assertAgentVisiblePath(this.policy.workspaceRoot, target);
        const mimeType = imageMimeType(target);
        if (!mimeType) throw new Error("readImage 只支持 PNG、JPEG、WebP 和 GIF");
        const data = await readFile(target);
        if (data.length > 10 * 1024 * 1024) throw new Error("图片超过 10 MiB");
        return { tool: intent.tool, ok: true, path: intent.path, mimeType, data: data.toString("base64"), size: data.length };
      }
      if (intent.tool === "writeFile") {
        const target = resolveToolPath(this.policy, required(intent.path, "path"), "write");
        assertAgentVisiblePath(this.policy.workspaceRoot, target);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, intent.content ?? "", "utf8");
        return { tool: intent.tool, ok: true, path: intent.path };
      }
      if (intent.tool === "shell") {
        const command = required(intent.command, "command");
        assertCommandDoesNotAccessPlatformState(command);
        return this.runShell(command);
      }
      if (intent.tool === "startService") {
        const command = required(intent.command, "command");
        assertCommandDoesNotAccessPlatformState(command);
        return this.startService(command);
      }
      if (intent.tool === "pollProcess") return this.pollService(required(intent.serviceId, "serviceId"));
      return this.runBrowser(requiredBrowserArgs(intent.browserArgs), context);
    } catch (error) {
      return { tool: intent.tool, ok: false, error: (error as Error).message };
    }
  }

  private async artifactFact(intent: AgentToolIntent, result: AgentToolResult): Promise<EvidenceArtifactFact | undefined> {
    if (!result.ok || !intent.path || !["readFile", "readImage", "writeFile"].includes(intent.tool)) return undefined;
    const access = intent.tool === "writeFile" ? "write" : "read";
    const absolute = resolveToolPath(this.policy, intent.path, access);
    try {
      const [info, content] = await Promise.all([stat(absolute), readFile(absolute)]);
      if (!info.isFile()) return undefined;
      return {
        path: path.relative(this.policy.workspaceRoot, absolute).replaceAll("\\", "/"),
        size: info.size,
        modifiedAt: info.mtime.toISOString(),
        sha256: createHash("sha256").update(content).digest("hex"),
      };
    } catch {
      return undefined;
    }
  }

  private async runShell(command: string): Promise<AgentToolResult> {
    assertCommandAllowed(this.policy, command);
    const processRecord = await this.spawnManaged(command);
    const exitCode = await Promise.race([
      processRecord.exit,
      delay(this.options.shellYieldMs ?? DEFAULT_SHELL_YIELD_MS).then(() => undefined),
    ]);
    if (exitCode === undefined) {
      return {
        tool: "shell",
        ok: true,
        command,
        serviceId: processRecord.serviceId,
        pid: processRecord.pid,
        running: true,
        stdout: await readLog(processRecord.stdoutPath),
        stderr: await readLog(processRecord.stderrPath),
      };
    }
    const stdout = await readLog(processRecord.stdoutPath);
    const stderr = await readLog(processRecord.stderrPath);
    return { tool: "shell", ok: exitCode === 0, command, stdout, stderr, exitCode, running: false };
  }

  definitions(): AgentToolDefinition[] {
    return [...this.enabled].map(toolDefinition);
  }

  private async startService(command: string): Promise<AgentToolResult> {
    assertCommandAllowed(this.policy, command);
    const processRecord = await this.spawnManaged(command);
    return {
      tool: "startService",
      ok: true,
      serviceId: processRecord.serviceId,
      command,
      pid: processRecord.pid,
      running: true,
    };
  }

  private async pollService(serviceId: string): Promise<AgentToolResult> {
    if (!/^agent_svc_[a-z0-9_]+$/i.test(serviceId)) throw new Error("serviceId is invalid");
    const file = path.join(this.policy.workspaceRoot, ".autoagent", "agent-services", `${serviceId}.json`);
    let metadata = await readProcessMetadata(file);
    let running = false;
    if (metadata.pid) {
      try { process.kill(metadata.pid, 0); running = true; } catch { running = false; }
    }
    if (!running && metadata.exitCode == null) {
      const deadline = Date.now() + 500;
      while (metadata.exitCode == null && Date.now() < deadline) {
        await delay(20);
        metadata = await readProcessMetadata(file);
      }
    }
    return {
      tool: "pollProcess",
      ok: true,
      serviceId,
      command: metadata.command,
      pid: metadata.pid,
      running,
      ...(running ? {} : { exitCode: metadata.exitCode ?? null }),
      stdout: await readLog(metadata.stdoutPath),
      stderr: await readLog(metadata.stderrPath),
    };
  }

  private async runBrowser(args: string[], context?: AgentToolExecutionContext): Promise<AgentToolResult> {
    const sessionSeed = [
      path.resolve(this.policy.workspaceRoot),
      context?.agentId ?? "agent",
      context?.attemptId ?? context?.goalId ?? context?.threadId ?? "thread",
    ].join("\u0000");
    const session = `autoagent_${createHash("sha256").update(sessionSeed).digest("hex").slice(0, 20)}`;
    const executable = resolveAgentBrowserEntry();
    const result = await runExecutable(process.execPath, [
      executable,
      "--session",
      session,
      "--screenshot-dir",
      path.join(this.policy.workspaceRoot, ".autoagent", "browser", session),
      ...args,
    ], this.policy.workspaceRoot);
    return {
      tool: "browser",
      ok: result.exitCode === 0,
      session,
      args,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
  }

  private async spawnManaged(command: string): Promise<ManagedProcess> {
    const serviceId = `agent_svc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const directory = path.join(this.policy.workspaceRoot, ".autoagent", "agent-services");
    await mkdir(directory, { recursive: true });
    const stdoutPath = path.join(directory, `${serviceId}.stdout.log`);
    const stderrPath = path.join(directory, `${serviceId}.stderr.log`);
    const [stdoutHandle, stderrHandle] = await Promise.all([open(stdoutPath, "w"), open(stderrPath, "w")]);
    const child = spawn(command, {
      cwd: this.policy.workspaceRoot,
      env: agentCommandEnvironment(),
      shell: true,
      windowsHide: true,
      detached: false,
      stdio: ["ignore", stdoutHandle.fd, stderrHandle.fd],
    });
    const exit = new Promise<number>((resolve) => {
      child.once("error", () => resolve(1));
      child.once("exit", (code) => resolve(code ?? 1));
    });
    await Promise.all([stdoutHandle.close(), stderrHandle.close()]);
    if (!child.pid) throw new Error("Command process did not start");
    const metadataPath = path.join(directory, `${serviceId}.json`);
    const metadata = { serviceId, command, pid: child.pid, stdoutPath, stderrPath, exitCode: null as number | null };
    await writeFile(metadataPath, JSON.stringify(metadata), "utf8");
    void exit.then((exitCode) => writeFile(metadataPath, JSON.stringify({ ...metadata, exitCode }), "utf8"));
    return { serviceId, pid: child.pid, stdoutPath, stderrPath, exit };
  }
}

function evidenceKind(tool: WorkspaceToolName): EvidenceKind {
  if (tool === "writeFile") return "file_write";
  if (tool === "readFile" || tool === "listFiles") return "file_read";
  if (tool === "readImage") return "image";
  if (tool === "shell") return "command";
  if (tool === "startService" || tool === "pollProcess") return "service";
  if (tool === "browser") return "browser";
  return "tool";
}

function evidenceResult(result: AgentToolResult): unknown {
  return JSON.parse(JSON.stringify(result, (key, value) => {
    if (key === "data") return undefined;
    if (typeof value === "string" && value.length > 16_000) return `${value.slice(0, 16_000)}\n...[truncated]`;
    return value;
  }));
}

export function agentCommandEnvironment(
  baseEnvironment: NodeJS.ProcessEnv = process.env,
  platformRoot = process.cwd(),
): NodeJS.ProcessEnv {
  const environment = { ...baseEnvironment };
  const pathKey = Object.keys(environment).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const platformBin = path.join(platformRoot, "node_modules", ".bin");
  environment[pathKey] = [platformBin, environment[pathKey]].filter(Boolean).join(path.delimiter);
  return environment;
}

interface ManagedProcess {
  serviceId: string;
  pid: number;
  stdoutPath: string;
  stderrPath: string;
  exit: Promise<number>;
}

interface ProcessMetadata {
  pid?: number;
  command?: string;
  stdoutPath?: string;
  stderrPath?: string;
  exitCode?: number | null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isWorkspaceRoot(workspaceRoot: string, targetPath: string): boolean {
  return path.resolve(workspaceRoot).toLowerCase() === path.resolve(targetPath).toLowerCase();
}

function assertAgentVisiblePath(workspaceRoot: string, targetPath: string): void {
  const relative = path.relative(path.resolve(workspaceRoot), path.resolve(targetPath));
  const firstSegment = relative.split(/[\\/]/, 1)[0]?.toLowerCase();
  if (firstSegment === PLATFORM_STATE_DIRECTORY) {
    throw new Error(".autoagent 是平台内部状态目录；Agent 应使用已注入的 Goal、handoff 和 Plan 上下文");
  }
}

function assertCommandDoesNotAccessPlatformState(command: string): void {
  if (/(^|[\\/\s"'`])\.autoagent(?:[\\/\s"'`]|$)/i.test(command)) {
    throw new Error(".autoagent 是平台内部状态目录；命令只能操作项目交付文件");
  }
}

async function readLog(filePath?: string): Promise<string> {
  if (!filePath) return "";
  try {
    const content = await readFile(filePath, "utf8");
    return content.length > MAX_LOG_CHARS ? content.slice(-MAX_LOG_CHARS) : content;
  } catch {
    return "";
  }
}

async function readProcessMetadata(filePath: string): Promise<ProcessMetadata> {
  return JSON.parse(await readFile(filePath, "utf8")) as ProcessMetadata;
}

function toolDefinition(name: WorkspaceToolName): AgentToolDefinition {
  const shellDescription = process.platform === "win32"
    ? "在工作区通过 Windows cmd.exe 执行一条已授权命令并等待结束。不要使用 Bash heredoc、mkdir -p、cat 或 PowerShell here-string；创建或修改多行文本文件必须调用 writeFile"
    : "在工作区通过 POSIX shell 执行一条已授权命令并等待结束。创建或修改多行文本文件优先调用 writeFile";
  const serviceDescription = process.platform === "win32"
    ? "在工作区通过 Windows cmd.exe 启动一个已授权的后台服务。不要使用 Bash 或 PowerShell 专用语法"
    : "在工作区通过 POSIX shell 启动一个已授权的后台服务";
  const schemas: Record<WorkspaceToolName, AgentToolDefinition> = {
    listFiles: {
      name,
      description: "列出工作区目录中的文件",
      inputSchema: objectSchema({ path: { type: "string" } }),
    },
    readFile: {
      name,
      description: "读取工作区内的 UTF-8 文本文件",
      inputSchema: objectSchema({
        path: { type: "string" },
        offset: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: MAX_FILE_READ_CHARS },
      }, ["path"]),
    },
    readImage: {
      name,
      description: "读取工作区内的 PNG、JPEG、WebP 或 GIF 图片，让视觉模型观察截图或设计稿",
      inputSchema: objectSchema({ path: { type: "string" } }, ["path"]),
    },
    writeFile: {
      name,
      description: "写入工作区内的 UTF-8 文本文件",
      inputSchema: objectSchema({ path: { type: "string" }, content: { type: "string" } }, ["path", "content"]),
    },
    shell: {
      name,
      description: shellDescription,
      inputSchema: objectSchema({ command: { type: "string" } }, ["command"]),
    },
    startService: {
      name,
      description: serviceDescription,
      inputSchema: objectSchema({ command: { type: "string" } }, ["command"]),
    },
    pollProcess: {
      name,
      description: "查询由 startService 启动的服务状态",
      inputSchema: objectSchema({ serviceId: { type: "string" } }, ["serviceId"]),
    },
    browser: {
      name,
      description: "在当前 Agent 与 Ticket Attempt 隔离的真实浏览器会话中执行一次 agent-browser 命令。browserArgs 是参数数组，例如 [\"open\",\"http://127.0.0.1:3000\"]、[\"snapshot\",\"-i\"]、[\"press\",\"Enter\"]、[\"screenshot\",\"result.png\"]。每次只执行一个命令，先观察结果再决定下一步。",
      inputSchema: {
        type: "object",
        properties: {
          browserArgs: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
          },
        },
        required: ["browserArgs"],
        additionalProperties: false,
      },
    },
  };
  return schemas[name];
}

function imageMimeType(filePath: string): "image/png" | "image/jpeg" | "image/webp" | "image/gif" | undefined {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  if (extension === ".gif") return "image/gif";
  return undefined;
}

function objectSchema(
  properties: Record<string, Record<string, unknown>>,
  required: string[] = [],
): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value;
}

function normalizeReadOffset(value: number | undefined, totalChars: number): number {
  if (value === undefined) return 0;
  if (!Number.isInteger(value) || value < 0) throw new Error("offset must be a non-negative integer");
  return Math.min(value, totalChars);
}

function normalizeReadLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_FILE_READ_CHARS;
  if (!Number.isInteger(value) || value <= 0) throw new Error("limit must be a positive integer");
  return Math.min(value, MAX_FILE_READ_CHARS);
}

function requiredBrowserArgs(value: string[] | undefined): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error("browserArgs is required");
  }
  return value;
}

function resolveAgentBrowserEntry(): string {
  const require = createRequire(import.meta.url);
  const packageJson = require.resolve("agent-browser/package.json");
  return path.join(path.dirname(packageJson), "bin", "agent-browser.js");
}

async function runExecutable(
  executable: string,
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      cwd,
      env: agentCommandEnvironment(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout = `${stdout}${String(chunk)}`.slice(-MAX_LOG_CHARS);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-MAX_LOG_CHARS);
    });
    child.once("error", (error) => resolve({ stdout, stderr: `${stderr}${error.message}`, exitCode: 1 }));
    child.once("exit", (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
  });
}
