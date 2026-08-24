import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import path from "node:path";
import type { EvidenceArtifactFact, EvidenceKind } from "../../shared/contracts/agent-engine.js";
import type { WorkspaceToolName } from "../../shared/types.js";
import type { AgentToolDefinition } from "../providers/types.js";
import type { EffectivePolicy } from "../policy/policy.js";
import { assertCommandAllowed } from "../policy/command-policy.js";
import { resolveToolPath } from "../policy/path-policy.js";
import { EvidenceLedger } from "./evidence-ledger.js";
import { managedProcessDetached, terminateManagedProcessTree } from "./managed-process-tree.js";
import { ToolExecutionPipeline } from "./tool-execution-pipeline.js";

const DEFAULT_SHELL_YIELD_MS = 2_000;
const MAX_LOG_CHARS = 64_000;
const DEFAULT_FILE_READ_CHARS = 32_000;
const MAX_FILE_READ_CHARS = 64_000;
const PLATFORM_STATE_DIRECTORY = ".autoagent";
const DEFAULT_SERVICE_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_BROWSER_COMMAND_TIMEOUT_MS = 45_000;
const BROWSER_CLOSE_TIMEOUT_MS = 10_000;
const processMetadataWrites = new Map<string, Promise<void>>();
const workspaceBrowserCleanup = new Map<string, Promise<void>>();

interface ExecutableResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface AgentToolRuntimeOptions {
  shellYieldMs?: number;
  serviceStartupTimeoutMs?: number;
  browserCommandTimeoutMs?: number;
  browserCommandRunner?: (
    executable: string,
    args: string[],
    cwd: string,
    timeoutMs?: number,
  ) => Promise<ExecutableResult>;
}

export interface AgentToolIntent {
  tool: WorkspaceToolName;
  path?: string;
  content?: string;
  oldText?: string;
  newText?: string;
  offset?: number;
  limit?: number;
  command?: string;
  port?: number;
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
  private readonly managedProcesses = new Map<string, ManagedProcess>();
  private readonly browserSessions = new Set<string>();
  private readonly activeBrowserSessions = new Map<string, string>();
  private readonly browserSessionQueues = new Map<string, Promise<void>>();
  private browserSessionGeneration = 0;
  private readonly orphanBrowserCleanup: Promise<void>;

  private readonly enabled: Set<WorkspaceToolName>;
  private readonly evidence: EvidenceLedger;
  private readonly pipeline: ToolExecutionPipeline<AgentToolIntent, AgentToolExecutionContext, AgentToolResult>;
  private fileMutationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly policy: EffectivePolicy,
    enabledTools: WorkspaceToolName[],
    private readonly options: AgentToolRuntimeOptions = {},
  ) {
    this.enabled = new Set(enabledTools);
    this.evidence = new EvidenceLedger(policy.workspaceRoot);
    this.orphanBrowserCleanup = ensureWorkspaceBrowserCleanup(policy.workspaceRoot);
    this.pipeline = new ToolExecutionPipeline<AgentToolIntent, AgentToolExecutionContext, AgentToolResult>(
      [({ intent }) => this.enabled.has(intent.tool)
        ? undefined
        : { tool: intent.tool, ok: false, error: "工具未配置" }],
      [({ intent }, next) => intent.tool === "writeFile" || intent.tool === "editFile"
        ? this.serializeFileMutation(next)
        : next()],
      [(request, result) => this.captureEvidence(request.intent, result, request.context)],
    );
  }

  async execute(intent: AgentToolIntent, context?: AgentToolExecutionContext): Promise<AgentToolResult> {
    return this.pipeline.run(
      { intent, ...(context ? { context } : {}) },
      (request) => this.executeRaw(request.intent, request.context),
    );
  }

  private async captureEvidence(
    intent: AgentToolIntent,
    result: AgentToolResult,
    context?: AgentToolExecutionContext,
  ): Promise<AgentToolResult> {
    if (!context) return result;
    const captureError = evidenceCaptureError(result);
    const fact = await this.evidence.append({
      ...context,
      toolName: intent.tool,
      kind: evidenceKind(intent.tool),
      capture: captureError
        ? { status: "unavailable", error: captureError }
        : { status: "recorded" },
      observation: {
        status: captureError ? "not_observed" : "observed",
        result: evidenceResult(result),
      },
      workspaceRoot: this.policy.workspaceRoot,
      createdAt: new Date().toISOString(),
      input: structuredClone(intent),
      artifact: await this.artifactFact(intent, result),
    });
    return { ...result, evidenceId: fact.evidenceId };
  }

  private async serializeFileMutation(operation: () => Promise<AgentToolResult>): Promise<AgentToolResult> {
    const previous = this.fileMutationTail;
    let release!: () => void;
    this.fileMutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async executeRaw(intent: AgentToolIntent, context?: AgentToolExecutionContext): Promise<AgentToolResult> {
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
      if (intent.tool === "editFile") {
        const target = resolveToolPath(this.policy, required(intent.path, "path"), "write");
        assertAgentVisiblePath(this.policy.workspaceRoot, target);
        const oldText = required(intent.oldText, "oldText");
        if (!oldText.length) throw new Error("oldText must not be empty");
        const content = await readFile(target, "utf8");
        const first = content.indexOf(oldText);
        if (first < 0) throw new Error("oldText was not found; read the current file before editing");
        if (content.indexOf(oldText, first + oldText.length) >= 0) {
          throw new Error("oldText matches more than once; include more surrounding text");
        }
        const updated = `${content.slice(0, first)}${intent.newText ?? ""}${content.slice(first + oldText.length)}`;
        await writeFile(target, updated, "utf8");
        return { tool: intent.tool, ok: true, path: intent.path, replacements: 1 };
      }
      if (intent.tool === "shell") {
        const command = required(intent.command, "command");
        assertCommandDoesNotAccessPlatformState(command);
        assertCommandUsesDedicatedTool(command, this.enabled);
        return await this.runShell(command, context);
      }
      if (intent.tool === "startService") {
        const command = required(intent.command, "command");
        assertCommandDoesNotAccessPlatformState(command);
        const automaticPort = intent.port === undefined || intent.port === 0;
        const port = automaticPort ? await allocateServicePort() : requiredPort(intent.port);
        return await this.startService(materializeServiceCommand(command, port, automaticPort), port, context);
      }
      if (intent.tool === "pollProcess") return await this.pollService(required(intent.serviceId, "serviceId"), context);
      return await this.runBrowser(requiredBrowserArgs(intent.browserArgs), context);
    } catch (error) {
      return {
        tool: intent.tool,
        ok: false,
        failureKind: "tool_execution",
        error: (error as Error).message,
      };
    }
  }

  private async artifactFact(intent: AgentToolIntent, result: AgentToolResult): Promise<EvidenceArtifactFact | undefined> {
    if (!result.ok || !intent.path || !["readFile", "readImage", "writeFile", "editFile"].includes(intent.tool)) return undefined;
    const access = intent.tool === "writeFile" || intent.tool === "editFile" ? "write" : "read";
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

  private async runShell(command: string, context?: AgentToolExecutionContext): Promise<AgentToolResult> {
    assertCommandAllowed(this.policy, command);
    const processRecord = await this.spawnManaged(command, undefined, context);
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

  async dispose(): Promise<void> {
    await Promise.allSettled(this.browserSessionQueues.values());
    const processes = [...this.managedProcesses.values()];
    const browserSessions = [...this.browserSessions];
    this.managedProcesses.clear();
    this.browserSessions.clear();
    this.activeBrowserSessions.clear();
    await Promise.allSettled([
      ...processes.map((processRecord) => processRecord.terminate()),
      ...browserSessions.map((session) => this.closeBrowserSession(session)),
    ]);
  }

  async releaseExecutionResources(
    context: Pick<AgentToolExecutionContext, "agentId" | "threadId" | "goalId" | "attemptId">,
  ): Promise<void> {
    const sessionBase = browserSessionName(this.policy.workspaceRoot, context);
    const processes = [...this.managedProcesses.values()]
      .filter((processRecord) => executionScopeMatches(processRecord.owner, context));
    for (const processRecord of processes) this.managedProcesses.delete(processRecord.serviceId);
    await Promise.allSettled([
      ...processes.map((processRecord) => processRecord.terminate()),
      this.enqueueBrowserSession(sessionBase, async () => {
        const browserSessions = [...this.browserSessions]
          .filter((session) => session === sessionBase || session.startsWith(`${sessionBase}_`));
        for (const session of browserSessions) this.browserSessions.delete(session);
        this.activeBrowserSessions.delete(sessionBase);
        await Promise.allSettled(browserSessions.map((session) => this.closeBrowserSession(session)));
      }),
    ]);
  }

  private async startService(
    command: string,
    port: number,
    context?: AgentToolExecutionContext,
  ): Promise<AgentToolResult> {
    return withServicePortReservation(port, async () => {
      assertCommandAllowed(this.policy, command);
      const claimedBy = managedServicePortOwners.get(port);
      if (claimedBy) {
        throw new Error(`端口 ${port} 已由受管服务 ${claimedBy} 占用`);
      }
      await assertPortAvailable(port);
      const processRecord = await this.spawnManaged(command, port, context);
      managedServicePortOwners.set(port, processRecord.serviceId);
      const startup = await Promise.race([
        processRecord.exit.then((exitCode) => ({ type: "exit" as const, exitCode })),
        waitForPortReady(port, this.options.serviceStartupTimeoutMs ?? DEFAULT_SERVICE_STARTUP_TIMEOUT_MS)
          .then((ready) => ({ type: ready ? "ready" as const : "timeout" as const })),
      ]);
      if (startup.type === "ready") {
        const listenerPid = await findListeningPid(port);
        if (listenerPid) await processRecord.setRuntimePid(listenerPid);
        const exitedAfterReady = await Promise.race([
          processRecord.exit.then((exitCode) => ({ exited: true as const, exitCode })),
          delay(50).then(() => ({ exited: false as const })),
        ]);
        if (processIsAlive(processRecord.runtimePid ?? processRecord.pid)) {
          return {
            tool: "startService",
            ok: true,
            serviceId: processRecord.serviceId,
            command,
            port,
            pid: processRecord.runtimePid ?? processRecord.pid,
            running: true,
          };
        }
        releaseManagedServicePort(port, processRecord.serviceId);
        return {
          tool: "startService",
          ok: false,
          serviceId: processRecord.serviceId,
          command,
          port,
          pid: processRecord.runtimePid ?? processRecord.pid,
          running: false,
          exitCode: exitedAfterReady.exited ? exitedAfterReady.exitCode : null,
          error: `端口 ${port} 已响应，但本次启动的受管进程没有保持运行；不能把其他服务误认作本次服务`,
          stdout: await readLog(processRecord.stdoutPath),
          stderr: await readLog(processRecord.stderrPath),
        };
      }
      if (startup.type === "timeout") await processRecord.terminate();
      releaseManagedServicePort(port, processRecord.serviceId);
      return {
        tool: "startService",
        ok: false,
        serviceId: processRecord.serviceId,
        command,
        port,
        pid: processRecord.runtimePid ?? processRecord.pid,
        running: false,
        ...(startup.type === "exit"
          ? { exitCode: startup.exitCode }
          : { error: `服务在 ${this.options.serviceStartupTimeoutMs ?? DEFAULT_SERVICE_STARTUP_TIMEOUT_MS}ms 内未监听端口 ${port}` }),
        stdout: await readLog(processRecord.stdoutPath),
        stderr: await readLog(processRecord.stderrPath),
      };
    });
  }

  private async pollService(serviceId: string, context?: AgentToolExecutionContext): Promise<AgentToolResult> {
    if (!/^agent_svc_[a-z0-9_]+$/i.test(serviceId)) throw new Error("serviceId is invalid");
    const file = path.join(this.policy.workspaceRoot, ".autoagent", "agent-services", `${serviceId}.json`);
    let metadata = await readProcessMetadata(file);
    assertServiceOwner(metadata, context);
    const processRecord = this.managedProcesses.get(serviceId);
    if (processRecord?.exitCode != null) {
      metadata = { ...metadata, exitCode: processRecord.exitCode };
    }
    let running = metadata.exitCode == null && processIsAlive(metadata.pid);
    if (!running && metadata.exitCode == null) {
      const deadline = Date.now() + 500;
      while (metadata.exitCode == null && Date.now() < deadline) {
        await delay(20);
        metadata = await readProcessMetadata(file);
      }
      running = metadata.exitCode == null && processIsAlive(metadata.pid);
    }
    return {
      tool: "pollProcess",
      ok: true,
      serviceId,
      command: metadata.command,
      port: metadata.port,
      pid: metadata.pid,
      running,
      ...(running ? {} : { exitCode: metadata.exitCode ?? null }),
      stdout: await readLog(metadata.stdoutPath),
      stderr: await readLog(metadata.stderrPath),
    };
  }

  private async runBrowser(args: string[], context?: AgentToolExecutionContext): Promise<AgentToolResult> {
    const sessionBase = browserSessionName(this.policy.workspaceRoot, context);
    return this.enqueueBrowserSession(sessionBase, () => this.runBrowserInSession(sessionBase, args, context));
  }

  private async runBrowserInSession(
    sessionBase: string,
    args: string[],
    context?: AgentToolExecutionContext,
  ): Promise<AgentToolResult> {
    await this.orphanBrowserCleanup;
    let session = this.activeBrowserSessions.get(sessionBase) ?? sessionBase;
    const executable = resolveAgentBrowserEntry();
    const requestedUrl = browserNavigationUrl(args);
    if (requestedUrl) {
      await assertBrowserTargetProvenance(requestedUrl, this.policy.workspaceRoot, context);
    }
    let result = await this.executeBrowserCommand(executable, session, args);
    let sessionRecovered = false;
    if (result.exitCode !== 0 && isRecoverableBrowserTransportFailure(result)) {
      this.browserSessions.add(session);
      await this.closeBrowserSession(session);
      session = `${sessionBase}_${++this.browserSessionGeneration}`;
      this.activeBrowserSessions.set(sessionBase, session);
      sessionRecovered = true;
      if (isSafeBrowserReplay(args)) {
        result = await this.executeBrowserCommand(executable, session, args);
      }
    }
    let pageUrl: string | undefined;
    let localService: BrowserLocalService | undefined;
    if (result.exitCode === 0 && !isBrowserCloseCommand(args)) {
      this.browserSessions.add(session);
      this.activeBrowserSessions.set(sessionBase, session);
      const currentUrl = await this.runBrowserExecutable(process.execPath, [
        executable,
        "--session",
        session,
        "get",
        "url",
      ], this.policy.workspaceRoot, this.browserCommandTimeoutMs);
      if (currentUrl.exitCode === 0) {
        pageUrl = currentUrl.stdout.trim();
        localService = await assertBrowserTargetProvenance(pageUrl, this.policy.workspaceRoot, context);
      }
    } else if (result.exitCode === 0) {
      this.browserSessions.delete(session);
      this.activeBrowserSessions.delete(sessionBase);
    }
    return {
      tool: "browser",
      ok: result.exitCode === 0,
      session,
      args,
      ...(sessionRecovered ? {
        sessionRecovered: true,
        ...(result.exitCode === 0 ? {} : {
          failureKind: "infrastructure_transport",
          error: "浏览器会话连接失效，已重置会话；该操作可能有副作用，未自动重放，请先观察页面状态再决定是否重试",
        }),
      } : {}),
      ...(pageUrl ? { pageUrl } : {}),
      ...(localService ? { localService } : {}),
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
  }

  private enqueueBrowserSession<T>(sessionBase: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.browserSessionQueues.get(sessionBase) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const settled = result.then(() => undefined, () => undefined);
    this.browserSessionQueues.set(sessionBase, settled);
    void settled.then(() => {
      if (this.browserSessionQueues.get(sessionBase) === settled) {
        this.browserSessionQueues.delete(sessionBase);
      }
    });
    return result;
  }

  private async closeBrowserSession(session: string): Promise<void> {
    const executable = resolveAgentBrowserEntry();
    await this.runBrowserExecutable(process.execPath, [
      executable,
      "--session",
      session,
      "close",
    ], this.policy.workspaceRoot, BROWSER_CLOSE_TIMEOUT_MS);
  }

  private async executeBrowserCommand(
    executable: string,
    session: string,
    args: string[],
  ): Promise<ExecutableResult> {
    return this.runBrowserExecutable(process.execPath, [
      executable,
      "--session",
      session,
      "--screenshot-dir",
      path.join(this.policy.workspaceRoot, ".autoagent", "browser", session),
      ...args,
    ], this.policy.workspaceRoot, this.browserCommandTimeoutMs);
  }

  private get browserCommandTimeoutMs(): number {
    return this.options.browserCommandTimeoutMs ?? DEFAULT_BROWSER_COMMAND_TIMEOUT_MS;
  }

  private get runBrowserExecutable(): (
    executable: string,
    args: string[],
    cwd: string,
    timeoutMs?: number,
  ) => Promise<ExecutableResult> {
    return this.options.browserCommandRunner ?? runExecutable;
  }

  private async spawnManaged(
    command: string,
    port?: number,
    context?: AgentToolExecutionContext,
  ): Promise<ManagedProcess> {
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
      detached: managedProcessDetached(),
      stdio: ["ignore", stdoutHandle.fd, stderrHandle.fd],
    });
    let observedExitCode: number | null = null;
    const exit = new Promise<number>((resolve) => {
      const settle = (exitCode: number) => {
        observedExitCode = exitCode;
        resolve(exitCode);
      };
      child.once("error", () => settle(1));
      child.once("exit", (code) => settle(code ?? 1));
    });
    await Promise.all([stdoutHandle.close(), stderrHandle.close()]);
    if (!child.pid) throw new Error("Command process did not start");
    const launcherPid = child.pid;
    const metadataPath = path.join(directory, `${serviceId}.json`);
    let metadata: ProcessMetadata = {
      serviceId,
      command,
      pid: launcherPid,
      port,
      workspaceRoot: path.resolve(this.policy.workspaceRoot),
      stdoutPath,
      stderrPath,
      exitCode: null as number | null,
      ...(context ? {
        agentId: context.agentId,
        threadId: context.threadId,
        goalId: context.goalId,
        attemptId: context.attemptId,
      } : {}),
    };
    await writeProcessMetadata(metadataPath, metadata);
    let runtimePid: number | undefined;
    const processRecord: ManagedProcess = {
      serviceId,
      pid: launcherPid,
      owner: context ? executionScope(context) : undefined,
      stdoutPath,
      stderrPath,
      exit,
      get exitCode() {
        return observedExitCode;
      },
      get runtimePid() {
        return runtimePid;
      },
      setRuntimePid: async (pid) => {
        runtimePid = pid;
        metadata = {
          ...metadata,
          launcherPid,
          pid,
          exitCode: null,
        };
        await writeProcessMetadata(metadataPath, metadata);
      },
      terminate: async () => {
        // The launcher is the POSIX process-group root and the Windows /T
        // tree root. Only fall back to a discovered listener pid when the
        // launcher tree already detached or re-parented it.
        await terminateManagedProcessTree(launcherPid);
        if (runtimePid && runtimePid !== launcherPid && processIsAlive(runtimePid)) {
          await terminateManagedProcessTree(runtimePid);
        }
        if (port) await waitForPortClosed(port, 5_000);
        if (port) releaseManagedServicePort(port, serviceId);
      },
    };
    this.managedProcesses.set(serviceId, processRecord);
    void exit.then(async (exitCode) => {
      await writeProcessMetadata(metadataPath, { ...metadata, exitCode });
      const serviceStillListening = port ? await canConnectToPort(port) : false;
      if (!serviceStillListening && this.managedProcesses.get(serviceId) === processRecord) {
        this.managedProcesses.delete(serviceId);
      }
      if (port && !serviceStillListening) releaseManagedServicePort(port, serviceId);
    }).catch(() => undefined);
    return processRecord;
  }
}

function evidenceKind(tool: WorkspaceToolName): EvidenceKind {
  if (tool === "writeFile" || tool === "editFile") return "file_write";
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

function evidenceCaptureError(
  result: AgentToolResult,
): { category: "tool" | "policy" | "transport" | "timeout"; message: string } | undefined {
  const failureKind = typeof result.failureKind === "string" ? result.failureKind : undefined;
  if (!failureKind) return undefined;
  const category = failureKind === "policy"
    ? "policy"
    : failureKind === "infrastructure_transport"
      ? "transport"
      : failureKind === "timeout"
        ? "timeout"
        : "tool";
  return {
    category,
    message: typeof result.error === "string" ? result.error : "The tool did not produce an observation",
  };
}

export function agentCommandEnvironment(
  baseEnvironment: NodeJS.ProcessEnv = process.env,
  platformRoot = process.cwd(),
): NodeJS.ProcessEnv {
  const environment = Object.fromEntries(
    Object.entries(baseEnvironment).filter(([key]) => (
      key.toLowerCase() !== "port"
      && !key.toLowerCase().startsWith("autoagent_")
    )),
  );
  const pathKey = Object.keys(environment).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const platformBin = path.join(platformRoot, "node_modules", ".bin");
  environment[pathKey] = [platformBin, environment[pathKey]].filter(Boolean).join(path.delimiter);
  return environment;
}

interface ManagedProcess {
  serviceId: string;
  pid: number;
  owner?: ExecutionScope;
  stdoutPath: string;
  stderrPath: string;
  exit: Promise<number>;
  exitCode: number | null;
  runtimePid?: number;
  setRuntimePid(pid: number): Promise<void>;
  terminate: () => Promise<void>;
}

type ExecutionScope = Pick<AgentToolExecutionContext, "agentId" | "threadId" | "goalId" | "attemptId">;

interface ProcessMetadata {
  serviceId?: string;
  pid?: number;
  command?: string;
  port?: number;
  workspaceRoot?: string;
  stdoutPath?: string;
  stderrPath?: string;
  exitCode?: number | null;
  launcherPid?: number;
  agentId?: string;
  threadId?: string;
  goalId?: string;
  attemptId?: string;
}

interface BrowserLocalService {
  serviceId: string;
  port: number;
}

const servicePortTails = new Map<number, Promise<unknown>>();
const managedServicePortOwners = new Map<number, string>();

async function withServicePortReservation<T>(port: number, operation: () => Promise<T>): Promise<T> {
  const previous = servicePortTails.get(port) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  servicePortTails.set(port, current);
  try {
    return await current;
  } finally {
    if (servicePortTails.get(port) === current) servicePortTails.delete(port);
  }
}

function releaseManagedServicePort(port: number, serviceId: string): void {
  if (managedServicePortOwners.get(port) === serviceId) {
    managedServicePortOwners.delete(port);
  }
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

function assertCommandUsesDedicatedTool(command: string, enabled: ReadonlySet<WorkspaceToolName>): void {
  const normalized = command.toLowerCase();
  if (enabled.has("browser") && /\bagent-browser(?:\.cmd)?\b/.test(normalized)) {
    throw new Error("浏览器操作必须调用 browser 工具，不能通过 shell 启动 agent-browser");
  }
  if (enabled.has("startService") && (
    /\b(?:http-server|live-server)\b/.test(normalized)
    || /\bpython(?:\.exe)?\s+-m\s+http\.server\b/.test(normalized)
    || /\b(?:vite|next)\s+(?:dev|start|preview)\b/.test(normalized)
    || /\bnpm\s+(?:run\s+)?(?:dev|serve|start|preview)\b/.test(normalized)
  )) {
    throw new Error("长驻网络服务必须调用 startService，并显式声明监听端口");
  }
}

function requiredPort(value: number | undefined): number {
  if (!Number.isInteger(value) || value! < 1 || value! > 65_535) {
    throw new Error("startService 必须提供 1 到 65535 之间的 port");
  }
  return value!;
}

function materializeServiceCommand(command: string, port: number, automatic: boolean): string {
  if (!automatic) return command.replaceAll("{port}", String(port));
  if (!command.includes("{port}")) {
    throw new Error("自动分配端口时，startService 的 command 必须使用 {port} 占位符");
  }
  return command.replaceAll("{port}", String(port));
}

async function allocateServicePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Host 无法分配本地服务端口")));
        return;
      }
      const port = address.port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function assertPortAvailable(port: number): Promise<void> {
  if (await canConnectToPort(port)) {
    throw new Error(`端口 ${port} 已被其他服务占用，请选择未占用端口后重试`);
  }
  await new Promise<void>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE" || error.code === "EACCES") {
        reject(new Error(`端口 ${port} 已被其他服务占用，请选择未占用端口后重试`));
        return;
      }
      reject(error);
    });
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });
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
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return JSON.parse(await readFile(filePath, "utf8")) as ProcessMetadata;
    } catch (error) {
      lastError = error;
      if (attempt < 4) await delay(10);
    }
  }
  throw lastError;
}

function browserNavigationUrl(args: string[]): string | undefined {
  const commandIndex = args.findIndex((value) => ["open", "goto", "navigate"].includes(value.toLowerCase()));
  return commandIndex >= 0 ? args[commandIndex + 1] : undefined;
}

function isBrowserCloseCommand(args: string[]): boolean {
  return args.some((value) => value.toLowerCase() === "close");
}

async function assertBrowserTargetProvenance(
  target: string,
  workspaceRoot: string,
  context?: AgentToolExecutionContext,
): Promise<BrowserLocalService | undefined> {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return undefined;
  }
  if (url.protocol === "file:") {
    const filePath = decodeURIComponent(url.pathname.replace(/^\/([a-zA-Z]:)/, "$1"));
    const relative = path.relative(path.resolve(workspaceRoot), path.resolve(filePath));
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("浏览器不能打开当前工作区之外的本地文件");
    }
    return undefined;
  }
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname.toLowerCase())) {
    return undefined;
  }
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  const directory = path.join(workspaceRoot, ".autoagent", "agent-services");
  let files: string[] = [];
  try {
    files = (await readdir(directory)).filter((file) => file.endsWith(".json"));
  } catch {
    // No service registry means no local workspace service can be observed.
  }
  for (const file of files) {
    try {
      const metadata = await readProcessMetadata(path.join(directory, file));
      if (
        metadata.serviceId
        && metadata.port === port
        && metadata.exitCode == null
        && metadata.workspaceRoot
        && isWorkspaceRoot(workspaceRoot, metadata.workspaceRoot)
        && metadata.pid
        && serviceOwnerMatches(metadata, context)
      ) {
        try {
          process.kill(metadata.pid, 0);
          return { serviceId: metadata.serviceId, port };
        } catch {
          // Stale service metadata is not valid evidence provenance.
        }
      }
    } catch {
      // Ignore incomplete metadata left by a concurrent atomic write.
    }
  }
  throw new Error(`本地地址 ${url.origin} 不属于当前工作区正在运行的受管服务；请先调用 startService，或查询已返回的 serviceId 和 port`);
}

function serviceOwnerMatches(
  metadata: ProcessMetadata,
  context?: AgentToolExecutionContext,
): boolean {
  if (!context) return true;
  if (metadata.agentId !== context.agentId || metadata.threadId !== context.threadId) return false;
  if (context.attemptId) return metadata.attemptId === context.attemptId;
  if (context.goalId) return metadata.goalId === context.goalId;
  return true;
}

function assertServiceOwner(
  metadata: ProcessMetadata,
  context?: AgentToolExecutionContext,
): void {
  if (!serviceOwnerMatches(metadata, context)) {
    throw new Error("该服务不属于当前 Agent Ticket Attempt；请在当前工作轮次重新调用 startService");
  }
}

async function writeProcessMetadata(filePath: string, metadata: ProcessMetadata): Promise<void> {
  const previous = processMetadataWrites.get(filePath) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(async () => {
    const temporaryPath = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(metadata), "utf8");
    try {
      await rename(temporaryPath, filePath);
    } catch (error) {
      if (process.platform !== "win32") throw error;
      await rm(filePath, { force: true });
      await rename(temporaryPath, filePath);
    }
  });
  processMetadataWrites.set(filePath, operation);
  try {
    await operation;
  } finally {
    if (processMetadataWrites.get(filePath) === operation) processMetadataWrites.delete(filePath);
  }
}

async function waitForPortReady(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.unref();
      socket.setTimeout(250);
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      const unavailable = () => {
        socket.destroy();
        resolve(false);
      };
      socket.once("error", unavailable);
      socket.once("timeout", unavailable);
    });
    if (ready) return true;
    await delay(25);
  }
  return false;
}

async function canConnectToPort(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.unref();
    socket.setTimeout(250);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    const unavailable = () => {
      socket.destroy();
      resolve(false);
    };
    socket.once("error", unavailable);
    socket.once("timeout", unavailable);
  });
}

function processIsAlive(pid?: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPortClosed(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (await canConnectToPort(port)) {
    if (Date.now() >= deadline) return;
    await delay(50);
  }
}

async function findListeningPid(port: number): Promise<number | undefined> {
  if (process.platform !== "win32") return undefined;
  return new Promise<number | undefined>((resolve) => {
    const child = spawn("netstat", ["-ano", "-p", "tcp"], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "";
    child.stdout?.on("data", (chunk) => {
      if (output.length < 2_000_000) output += String(chunk);
    });
    child.once("error", () => resolve(undefined));
    child.once("exit", () => {
      const pattern = new RegExp(`^\\s*TCP\\s+\\S+:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)\\s*$`, "mi");
      const match = output.match(pattern);
      resolve(match?.[1] ? Number(match[1]) : undefined);
    });
  });
}

function toolDefinition(name: WorkspaceToolName): AgentToolDefinition {
  const shellDescription = process.platform === "win32"
    ? "在工作区通过 Windows cmd.exe 执行一条已授权命令并等待结束。不要使用 Bash heredoc、mkdir -p、cat 或 PowerShell here-string；创建或修改多行文本文件必须调用 writeFile。同一复合命令会在执行 set 前展开 %VAR%，需要运行期变量时使用 setlocal EnableDelayedExpansion 和 !VAR!，或拆成多次 shell 调用"
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
    editFile: {
      name,
      description: "通过唯一精确匹配局部编辑工作区内的 UTF-8 文本文件。编辑前先读取当前内容；oldText 不存在或匹配多处时工具会拒绝，必须扩大上下文后重试",
      inputSchema: objectSchema({
        path: { type: "string" },
        oldText: { type: "string" },
        newText: { type: "string" },
      }, ["path", "oldText", "newText"]),
    },
    shell: {
      name,
      description: `${shellDescription}。验证不同退出码时分别调用 shell；不要把预期非零步骤放入 && 链后再声称后续命令已执行，只能依据 stdout、stderr 和 exitCode 中实际观察到的步骤形成证据。已有一级工具覆盖操作时必须直接调用，不得通过 shell 间接调用 readFile、writeFile、editFile、browser、startService 或 pollProcess`,
      inputSchema: objectSchema({ command: { type: "string" } }, ["command"]),
    },
    startService: {
      name,
      description: `${serviceDescription}。推荐让 Host 自动分配端口：command 中使用 {port} 占位符，并省略 port 或传入 0；只有外部协议要求固定端口时才提供非零 port。工具会检查端口冲突，并在进程立即退出时返回真实错误`,
      inputSchema: objectSchema({
        command: { type: "string" },
        port: { type: "integer", minimum: 0, maximum: 65_535 },
      }, ["command"]),
    },
    pollProcess: {
      name,
      description: "查询由 startService 启动的服务状态",
      inputSchema: objectSchema({ serviceId: { type: "string" } }, ["serviceId"]),
    },
    browser: {
      name,
      description: "在当前 Agent 与 Ticket Attempt 隔离的真实浏览器会话中执行一次浏览器操作。必须直接调用这个一级工具，不得通过 shell 或 npx 间接启动 agent-browser。公网 HTTP/HTTPS 页面可以直接打开；localhost、127.0.0.1 等本地页面只能打开当前工作区由 startService 登记且仍在运行的端口，结果会记录 serviceId 作为证据归属，不得猜测或复用其他项目端口。browserArgs 是参数数组，优先逐项传参，例如 [\"open\",\"https://example.com\"]、[\"snapshot\",\"-i\"]、[\"set\",\"viewport\",\"1264\",\"900\"]、[\"press\",\"Enter\"]、[\"screenshot\",\"result.png\"]。外部 Skill 若给出整条命令字符串也会在工具边界归一化。每次只执行一个命令，先观察结果再决定下一步。",
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

export function requiredBrowserArgs(value: string[] | undefined): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error("browserArgs is required");
  }
  const platformOwnedOptions = new Set([
    "--session",
    "--screenshot-dir",
    "--profile",
    "--user-data-dir",
    "--cdp",
    "--executable-path",
  ]);
  const normalized = normalizeBrowserArgs(value);
  const forbidden = normalized.find((item) => platformOwnedOptions.has(item.toLowerCase().split("=")[0]!));
  if (forbidden) {
    throw new Error(`browserArgs 不能覆盖平台管理的浏览器会话参数：${forbidden}`);
  }
  return normalized;
}

/**
 * External Skills describe CLI calls as one shell-like line, while the first-party
 * browser tool accepts argv. Keep the boundary tolerant without moving business
 * decisions into the platform: already-tokenized argv is preserved verbatim.
 */
export function normalizeBrowserArgs(value: readonly string[]): string[] {
  if (value.length !== 1) return [...value];
  const command = value[0]!.trim();
  if (!command.includes(" ") && !command.includes("\t")) return [command];
  return tokenizeBrowserCommand(command);
}

function tokenizeBrowserCommand(command: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | undefined;
  let escaping = false;
  let tokenStarted = false;
  for (const character of command) {
    if (escaping) {
      token += character;
      tokenStarted = true;
      escaping = false;
      continue;
    }
    if (character === "\\") {
      escaping = true;
      tokenStarted = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else token += character;
      tokenStarted = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      tokenStarted = true;
      continue;
    }
    if (character === " " || character === "\t") {
      if (tokenStarted) {
        tokens.push(token);
        token = "";
        tokenStarted = false;
      }
      continue;
    }
    token += character;
    tokenStarted = true;
  }
  if (escaping) token += "\\";
  if (quote) throw new Error("browserArgs 包含未闭合的引号");
  if (tokenStarted) tokens.push(token);
  if (tokens.length === 0) throw new Error("browserArgs is required");
  return tokens;
}

const SAFE_BROWSER_REPLAY_COMMANDS = new Set([
  "close",
  "console",
  "errors",
  "get",
  "is",
  "open",
  "read",
  "reload",
  "screenshot",
  "snapshot",
  "wait",
]);

function isSafeBrowserReplay(args: readonly string[]): boolean {
  return args.some((argument) => SAFE_BROWSER_REPLAY_COMMANDS.has(argument.toLowerCase()));
}

function isRecoverableBrowserTransportFailure(result: ExecutableResult): boolean {
  const message = `${result.stderr}\n${result.stdout}`.toLowerCase();
  return message.includes("os error 10060")
    || message.includes("failed to read")
    || message.includes("connection refused")
    || message.includes("connection reset")
    || message.includes("command timed out");
}

function executionScope(
  context: Pick<AgentToolExecutionContext, "agentId" | "threadId" | "goalId" | "attemptId">,
): ExecutionScope {
  return {
    agentId: context.agentId,
    threadId: context.threadId,
    goalId: context.goalId,
    attemptId: context.attemptId,
  };
}

function executionScopeMatches(
  owner: ExecutionScope | undefined,
  context: Pick<AgentToolExecutionContext, "agentId" | "threadId" | "goalId" | "attemptId">,
): boolean {
  if (!owner || owner.agentId !== context.agentId || owner.threadId !== context.threadId) return false;
  if (context.attemptId) return owner.attemptId === context.attemptId;
  return Boolean(context.goalId) && owner.goalId === context.goalId;
}

function browserSessionName(
  workspaceRoot: string,
  context?: Pick<AgentToolExecutionContext, "agentId" | "threadId" | "goalId" | "attemptId">,
): string {
  const sessionSeed = [
    path.resolve(workspaceRoot),
    context?.agentId ?? "agent",
    context?.attemptId ?? context?.goalId ?? context?.threadId ?? "thread",
  ].join("\u0000");
  return `autoagent_${createHash("sha256").update(sessionSeed).digest("hex").slice(0, 20)}`;
}

function ensureWorkspaceBrowserCleanup(workspaceRoot: string): Promise<void> {
  const key = path.resolve(workspaceRoot).toLowerCase();
  const existing = workspaceBrowserCleanup.get(key);
  if (existing) return existing;
  const pending = cleanupWorkspaceBrowserSessions(workspaceRoot);
  workspaceBrowserCleanup.set(key, pending);
  return pending;
}

async function cleanupWorkspaceBrowserSessions(workspaceRoot: string): Promise<void> {
  const browserRoot = path.join(workspaceRoot, ".autoagent", "browser");
  let workspaceSessions: Set<string>;
  try {
    workspaceSessions = new Set((await readdir(browserRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("autoagent_"))
      .map((entry) => entry.name));
  } catch {
    return;
  }
  if (!workspaceSessions.size) return;
  const executable = resolveAgentBrowserEntry();
  const listed = await runExecutable(process.execPath, [
    executable,
    "session",
    "list",
    "--json",
  ], workspaceRoot);
  if (listed.exitCode !== 0) return;
  let active: string[] = [];
  try {
    const parsed = JSON.parse(listed.stdout) as { data?: { sessions?: unknown } };
    if (Array.isArray(parsed.data?.sessions)) {
      active = parsed.data.sessions.filter((item): item is string => typeof item === "string");
    }
  } catch {
    return;
  }
  await Promise.allSettled(active
    .filter((session) => workspaceSessions.has(session))
    .map((session) => runExecutable(process.execPath, [
      executable,
      "--session",
      session,
      "close",
    ], workspaceRoot)));
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
  timeoutMs?: number,
): Promise<ExecutableResult> {
  return new Promise((resolve) => {
    const environment = agentCommandEnvironment();
    environment.AGENT_BROWSER_IDLE_TIMEOUT_MS ??= "300000";
    const child = spawn(executable, args, {
      cwd,
      env: environment,
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
    let settled = false;
    const finish = (result: ExecutableResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    const timer = timeoutMs == null ? undefined : setTimeout(() => {
      child.kill("SIGKILL");
      finish({
        stdout,
        stderr: `${stderr}${stderr ? "\n" : ""}Command timed out after ${timeoutMs}ms`,
        exitCode: 124,
      });
    }, timeoutMs);
    timer?.unref();
    child.once("error", (error) => finish({ stdout, stderr: `${stderr}${error.message}`, exitCode: 1 }));
    child.once("exit", (code) => finish({ stdout, stderr, exitCode: code ?? 1 }));
  });
}
