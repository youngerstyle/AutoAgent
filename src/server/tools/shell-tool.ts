import { exec } from "node:child_process";
import { promisify } from "node:util";
import { assertCommandAllowed } from "../policy/command-policy.js";
import { emitToolEvent, policyFor, type ToolContext } from "./tool-runtime.js";

const execAsync = promisify(exec);

export async function runWorkspaceCommand(context: ToolContext, command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  await emitToolEvent(context, "tool.started", `执行命令：${command}`, { tool: "shell", command });
  try {
    assertCommandAllowed(policyFor(context), command);
    const result = await execAsync(command, { cwd: context.workspace.rootPath, windowsHide: true });
    await emitToolEvent(context, "tool.completed", "命令执行完成", { tool: "shell", command, stdout: result.stdout, stderr: result.stderr, exitCode: 0 });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    const err = error as Error & { stdout?: string; stderr?: string; code?: number };
    await emitToolEvent(context, err.message.includes("not allowed") ? "tool.denied" : "tool.failed", "命令执行失败", {
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
