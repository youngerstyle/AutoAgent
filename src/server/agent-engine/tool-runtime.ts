import { exec, spawn } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { WorkspaceToolName } from "../../shared/types.js";
import type { AgentToolDefinition } from "../providers/types.js";
import type { EffectivePolicy } from "../policy/policy.js";
import { assertCommandAllowed } from "../policy/command-policy.js";
import { resolveToolPath } from "../policy/path-policy.js";

const execAsync = promisify(exec);

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
      if (intent.tool === "writeFile") {
        const target = resolveToolPath(this.policy, required(intent.path, "path"), "write");
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, intent.content ?? "", "utf8");
        return { tool: intent.tool, ok: true, path: intent.path };
      }
      if (intent.tool === "shell") {
        const command = required(intent.command, "command");
        assertCommandAllowed(this.policy, command);
        try {
          const result = await execAsync(command, { cwd: this.policy.workspaceRoot, windowsHide: true, timeout: 600_000 });
          return { tool: intent.tool, ok: true, command, stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
        } catch (error) {
          const failure = error as Error & { stdout?: string; stderr?: string; code?: number };
          return { tool: intent.tool, ok: false, command, stdout: failure.stdout ?? "", stderr: failure.stderr ?? failure.message, exitCode: failure.code ?? 1 };
        }
      }
      if (intent.tool === "startService") return this.startService(required(intent.command, "command"));
      return this.pollService(required(intent.serviceId, "serviceId"));
    } catch (error) {
      return { tool: intent.tool, ok: false, error: (error as Error).message };
    }
  }

  definitions(): AgentToolDefinition[] {
    return [...this.enabled].map(toolDefinition);
  }

  private async startService(command: string): Promise<AgentToolResult> {
    assertCommandAllowed(this.policy, command);
    const serviceId = `agent_svc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const child = spawn(command, {
      cwd: this.policy.workspaceRoot,
      shell: true,
      windowsHide: true,
      detached: false,
      stdio: "ignore",
    });
    child.unref();
    const directory = path.join(this.policy.workspaceRoot, ".autoagent", "agent-services");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, `${serviceId}.json`), JSON.stringify({ serviceId, command, pid: child.pid }), "utf8");
    return { tool: "startService", ok: true, serviceId, command, pid: child.pid, running: Boolean(child.pid) };
  }

  private async pollService(serviceId: string): Promise<AgentToolResult> {
    if (!/^agent_svc_[a-z0-9_]+$/i.test(serviceId)) throw new Error("serviceId is invalid");
    const file = path.join(this.policy.workspaceRoot, ".autoagent", "agent-services", `${serviceId}.json`);
    const metadata = JSON.parse(await readFile(file, "utf8")) as { pid?: number; command?: string };
    let running = false;
    if (metadata.pid) {
      try { process.kill(metadata.pid, 0); running = true; } catch { running = false; }
    }
    return { tool: "pollProcess", ok: true, serviceId, command: metadata.command, pid: metadata.pid, running };
  }
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
