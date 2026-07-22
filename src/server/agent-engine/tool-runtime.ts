import { spawn } from "node:child_process";
import { mkdir, open, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { WorkspaceToolName } from "../../shared/types.js";
import type { AgentToolDefinition } from "../providers/types.js";
import type { EffectivePolicy } from "../policy/policy.js";
import { assertCommandAllowed } from "../policy/command-policy.js";
import { resolveToolPath } from "../policy/path-policy.js";

const DEFAULT_SHELL_YIELD_MS = 2_000;
const MAX_LOG_CHARS = 64_000;

export interface AgentToolIntent {
  tool: WorkspaceToolName;
  path?: string;
  content?: string;
  command?: string;
  serviceId?: string;
}

export interface AgentToolResult extends Record<string, unknown> {
  tool: WorkspaceToolName;
  ok: boolean;
}

export class AgentToolRuntime {
  private readonly enabled: Set<WorkspaceToolName>;

  constructor(
    private readonly policy: EffectivePolicy,
    enabledTools: WorkspaceToolName[],
    private readonly options: { shellYieldMs?: number } = {},
  ) {
    this.enabled = new Set(enabledTools);
  }

  async execute(intent: AgentToolIntent): Promise<AgentToolResult> {
    if (!this.enabled.has(intent.tool)) return { tool: intent.tool, ok: false, error: "工具未配置" };
    try {
      if (intent.tool === "listFiles") {
        const target = resolveToolPath(this.policy, intent.path ?? ".", "read");
        return { tool: intent.tool, ok: true, path: intent.path ?? ".", files: await readdir(target) };
      }
      if (intent.tool === "readFile") {
        const target = resolveToolPath(this.policy, required(intent.path, "path"), "read");
        return { tool: intent.tool, ok: true, path: intent.path, content: await readFile(target, "utf8") };
      }
      if (intent.tool === "readImage") {
        const target = resolveToolPath(this.policy, required(intent.path, "path"), "read");
        const mimeType = imageMimeType(target);
        if (!mimeType) throw new Error("readImage 只支持 PNG、JPEG、WebP 和 GIF");
        const data = await readFile(target);
        if (data.length > 10 * 1024 * 1024) throw new Error("图片超过 10 MiB");
        return { tool: intent.tool, ok: true, path: intent.path, mimeType, data: data.toString("base64"), size: data.length };
      }
      if (intent.tool === "writeFile") {
        const target = resolveToolPath(this.policy, required(intent.path, "path"), "write");
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, intent.content ?? "", "utf8");
        return { tool: intent.tool, ok: true, path: intent.path };
      }
      if (intent.tool === "shell") {
        const command = required(intent.command, "command");
        return this.runShell(command);
      }
      if (intent.tool === "startService") return this.startService(required(intent.command, "command"));
      return this.pollService(required(intent.serviceId, "serviceId"));
    } catch (error) {
      return { tool: intent.tool, ok: false, error: (error as Error).message };
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

  private async spawnManaged(command: string): Promise<ManagedProcess> {
    const serviceId = `agent_svc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const directory = path.join(this.policy.workspaceRoot, ".autoagent", "agent-services");
    await mkdir(directory, { recursive: true });
    const stdoutPath = path.join(directory, `${serviceId}.stdout.log`);
    const stderrPath = path.join(directory, `${serviceId}.stderr.log`);
    const [stdoutHandle, stderrHandle] = await Promise.all([open(stdoutPath, "w"), open(stderrPath, "w")]);
    const child = spawn(command, {
      cwd: this.policy.workspaceRoot,
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
      inputSchema: objectSchema({ path: { type: "string" } }, ["path"]),
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
