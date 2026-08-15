import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import readline from "node:readline";
import path from "node:path";
import type { PluginGuardrailContribution } from "../../shared/contracts/evolution.js";
import type { RuntimeEvolutionExtension } from "./runtime-projection.js";
import { configuredPluginSandboxProgram } from "./plugin-sandbox-config.js";

const MAX_PROTOCOL_BYTES = 256 * 1024;
const MAX_STDERR_BYTES = 32 * 1024;
const HOST_SOURCE = String.raw`
import readline from "node:readline";
import { pathToFileURL } from "node:url";
const pending = new Map();
let sequence = 0;
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const safeText = (values) => values.map((value) => typeof value === "string" ? value : JSON.stringify(value)).join(" ").slice(0, 4000);
console.log = (...values) => process.stderr.write(safeText(values) + "\n");
console.info = console.log;
console.warn = console.log;
console.error = console.log;
const requestCapability = (capability, input) => new Promise((resolve, reject) => {
  const requestId = "cap-" + (++sequence);
  pending.set(requestId, { resolve, reject });
  send({ type: "capability_request", requestId, capability, input });
});
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", async (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return send({ type: "fatal", error: "Host received malformed protocol input" }); }
  if (message.type === "capability_result") {
    const item = pending.get(message.requestId);
    if (!item) return;
    pending.delete(message.requestId);
    if (message.ok) item.resolve(message.result); else item.reject(new Error(message.error || "Capability request failed"));
    return;
  }
  if (message.type !== "invoke") return;
  let extension;
  try {
    const imported = await import(pathToFileURL(process.argv[1]).href);
    extension = imported.default;
    if (!extension || typeof extension !== "object") throw new Error("Entrypoint must export a default extension object");
    const context = Object.freeze({ ...message.context, requestCapability });
    if (extension.activate) await extension.activate(context);
    if (extension.health) {
      const health = await extension.health(context);
      if (!health || health.ok !== true) throw new Error("Extension health check failed");
    }
    let result;
    if (message.operation === "tool") {
      if (typeof extension.invokeTool !== "function") throw new Error("Extension does not export invokeTool");
      result = await extension.invokeTool({ name: message.name, input: message.input, context });
    } else {
      if (typeof extension.guard !== "function") throw new Error("Extension does not export guard");
      result = await extension.guard({ name: message.name, phase: message.phase, tool: message.tool, input: message.input, output: message.output, context });
    }
    if (extension.deactivate) await extension.deactivate(context);
    send({ type: "result", requestId: message.requestId, result });
  } catch (error) {
    try { if (extension?.deactivate) await extension.deactivate(Object.freeze({ ...message.context, requestCapability })); } catch {}
    send({ type: "result", requestId: message.requestId, error: error instanceof Error ? error.message : String(error) });
  }
});
`;

export interface PluginExecutionBinding {
  agentId: string;
  threadId: string;
  goalId?: string;
  attemptId?: string;
  turnId?: string;
}

export interface PluginGuardResult {
  behavior: "allow" | "reject";
  message?: string;
}

export interface EvolutionCapabilityExecutionContext {
  agentId: string; threadId: string; goalId?: string; attemptId?: string; turnId: string; toolCallId: string;
}

/** Consumer-owned capability broker; Agent Loop may implement it structurally. */
export interface EvolutionCapabilityBroker {
  execute(call: { tool: "readFile"; path: string }, context: EvolutionCapabilityExecutionContext): Promise<{ ok: boolean; error?: unknown }>;
}

export class IsolatedPluginHost {
  constructor(
    private readonly extension: RuntimeEvolutionExtension,
    private readonly tools: EvolutionCapabilityBroker,
    private readonly binding: PluginExecutionBinding,
  ) {}

  async invokeTool(name: string, input: unknown, callId: string): Promise<unknown> {
    if (!this.extension.manifest.contributions.tools.some((item) => item.name === name)) throw new Error(`Plugin tool is not declared: ${name}`);
    return this.invoke({ operation: "tool", name, input }, callId);
  }

  async guard(contribution: PluginGuardrailContribution, tool: string, input: unknown, output: unknown, callId: string): Promise<PluginGuardResult> {
    const value = await this.invoke({ operation: "guard", name: contribution.name, phase: contribution.phase, tool, input, output }, callId);
    if (!isRecord(value) || !["allow", "reject"].includes(String(value.behavior))) throw new Error("Harness guardrail returned an invalid decision");
    return { behavior: value.behavior as "allow" | "reject", ...(typeof value.message === "string" ? { message: value.message.slice(0, 2_000) } : {}) };
  }

  private invoke(request: Record<string, unknown>, callId: string): Promise<unknown> {
    const timeoutMs = this.extension.manifest.lifecycle.invokeTimeoutMs;
    return new Promise((resolve, reject) => {
      const sandboxProgram = configuredPluginSandboxProgram();
      const launcherExtension = sandboxProgram ? path.extname(sandboxProgram).toLowerCase() : undefined;
      const javascriptLauncher = Boolean(sandboxProgram && [".js", ".mjs", ".cjs"].includes(launcherExtension!));
      const powershellLauncher = sandboxProgram && launcherExtension === ".ps1";
      const executable = javascriptLauncher ? process.execPath : powershellLauncher ? "powershell.exe" : (sandboxProgram ?? process.execPath);
      const args = sandboxProgram
        ? javascriptLauncher
          ? ["--max-old-space-size=64", "--disable-proto=throw", sandboxProgram, this.extension.entrypoint]
          : powershellLauncher
            ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", sandboxProgram, this.extension.entrypoint]
            : [this.extension.entrypoint]
        : ["--max-old-space-size=64", "--disable-proto=throw", "--permission", `--allow-fs-read=${this.extension.directory}`, "--input-type=module", "--eval", HOST_SOURCE, this.extension.entrypoint];
      const child = spawn(executable, args, {
        cwd: this.extension.directory,
        env: minimalEnvironment(),
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let settled = false;
      let protocolBytes = 0;
      let stderr = "";
      const finish = (error?: Error, value?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        lines.close();
        if (!child.killed) child.kill();
        if (error) reject(error); else resolve(value);
      };
      const timer = setTimeout(() => finish(new Error(`Extension invocation timed out after ${timeoutMs}ms`)), timeoutMs);
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-MAX_STDERR_BYTES); });
      child.on("error", (error) => finish(error));
      child.on("exit", (code) => { if (!settled) finish(new Error(`Extension host exited before a result (code ${code ?? "unknown"}): ${stderr.slice(-2_000)}`)); });
      const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
      lines.on("line", (line) => {
        protocolBytes += Buffer.byteLength(line, "utf8");
        if (protocolBytes > MAX_PROTOCOL_BYTES) return finish(new Error("Extension protocol output exceeded 256 KiB"));
        let message: Record<string, unknown>;
        try { message = JSON.parse(line) as Record<string, unknown>; }
        catch { return finish(new Error("Extension polluted the host protocol")); }
        if (message.type === "capability_request") {
          void this.handleCapability(message, callId).then(
            (result) => child.stdin.write(`${JSON.stringify({ type: "capability_result", requestId: message.requestId, ok: true, result })}\n`),
            (error) => child.stdin.write(`${JSON.stringify({ type: "capability_result", requestId: message.requestId, ok: false, error: error instanceof Error ? error.message : String(error) })}\n`),
          );
          return;
        }
        if (message.type === "fatal") return finish(new Error(String(message.error ?? "Extension host protocol failed")));
        if (message.type === "result") {
          if (message.error) return finish(new Error(`Extension invocation failed: ${String(message.error)}`));
          return finish(undefined, message.result);
        }
        return finish(new Error("Extension emitted an unknown protocol message"));
      });
      const context = {
        pluginId: this.extension.name,
        releaseId: this.extension.releaseId,
        agentId: this.binding.agentId,
        threadId: this.binding.threadId,
        ...(this.binding.goalId ? { goalId: this.binding.goalId } : {}),
      };
      const serialized = JSON.stringify({ type: "invoke", requestId: callId, ...request, context });
      if (Buffer.byteLength(serialized, "utf8") > MAX_PROTOCOL_BYTES) return finish(new Error("Extension input exceeded 256 KiB"));
      child.stdin.write(`${serialized}\n`);
    });
  }

  private async handleCapability(message: Record<string, unknown>, parentCallId: string): Promise<unknown> {
    if (message.capability !== "workspace.read" || !isRecord(message.input) || typeof message.input.path !== "string") throw new Error("Capability request is not supported");
    if (!this.extension.manifest.scope.tools?.includes("readFile")) throw new Error("Plugin Candidate scope does not authorize workspace.read");
    const requestedPath = normalizeWorkspacePath(message.input.path);
    if (!requestedPath || !this.extension.manifest.permissions.workspaceRead.some((pattern) => matchesPattern(pattern, requestedPath))) throw new Error("Plugin workspace.read path is outside its manifest allowlist");
    const turnId = this.binding.turnId;
    if (!turnId) throw new Error("Plugin capability request has no active turn");
    const context: EvolutionCapabilityExecutionContext = {
      agentId: this.binding.agentId,
      threadId: this.binding.threadId,
      ...(this.binding.goalId ? { goalId: this.binding.goalId } : {}),
      ...(this.binding.attemptId ? { attemptId: this.binding.attemptId } : {}),
      turnId,
      toolCallId: `${parentCallId}:plugin:${String(message.requestId ?? stableId(requestedPath))}`,
    };
    const result = await this.tools.execute({ tool: "readFile", path: requestedPath }, context);
    if (!result.ok) throw new Error(typeof result.error === "string" ? result.error : "Brokered workspace read failed");
    return result;
  }
}

export function pluginToolName(plugin: string, tool: string): string {
  const value = `evo_${plugin}_${tool}`.toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/_+/g, "_");
  if (value.length <= 64) return value;
  return `${value.slice(0, 51)}_${stableId(value).slice(0, 12)}`;
}

function matchesPattern(pattern: string, value: string): boolean {
  if (pattern.endsWith("/**")) {
    const root = pattern.slice(0, -3);
    return value === root || value.startsWith(`${root}/`);
  }
  return pattern === value;
}
function normalizeWorkspacePath(value: string): string | undefined {
  if (!value || value.includes("\\") || value.includes("\0") || path.posix.isAbsolute(value)) return undefined;
  const normalized = path.posix.normalize(value);
  if (normalized === ".." || normalized.startsWith("../") || normalized.startsWith(".autoagent/") || normalized === ".autoagent") return undefined;
  return normalized;
}
function minimalEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { NODE_NO_WARNINGS: "1" };
  for (const key of ["SystemRoot", "WINDIR", "TMP", "TEMP"] as const) if (process.env[key]) environment[key] = process.env[key];
  return environment;
}
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function stableId(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
