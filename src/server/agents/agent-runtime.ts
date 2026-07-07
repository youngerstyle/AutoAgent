import type { AgentProfile, Assignment, AssignmentRun, AutoAgentEvent, Workspace, WorkspaceAgent } from "../../shared/types.js";
import { createId } from "../../shared/ids.js";
import { assignmentLabel, roleLabel } from "../../shared/labels.js";
import type { AgentTurnInput, AgentTurnResult } from "../providers/types.js";
import type { EventLedger } from "../storage/event-ledger.js";
import { SessionStore } from "../storage/session-store.js";
import { readWorkspaceFile, listWorkspaceFiles, writeWorkspaceFile } from "../tools/file-tools.js";
import { runWorkspaceCommand } from "../tools/shell-tool.js";
import type { ToolContext } from "../tools/tool-runtime.js";
import { buildAgentPrompt } from "./prompts.js";
import { profileForRole } from "./roster.js";

export interface ProviderRunner {
  runWithRetry(input: AgentTurnInput): Promise<AgentTurnResult>;
}

export interface RunAssignmentInput {
  workspace: Workspace;
  agent: WorkspaceAgent;
  profile?: AgentProfile;
  taskId: string;
  taskRunId: string;
  goal: string;
  type: Assignment["type"];
  brief: string;
  expectedArtifact: string;
  context?: Record<string, unknown>;
  sessionId?: string;
}

export interface AssignmentResult {
  assignment: Assignment;
  assignmentRun: AssignmentRun;
  providerResult: AgentTurnResult;
  toolResults: Array<Record<string, unknown>>;
}

const MAX_TOOL_FOLLOW_UPS = 4;
const OBSERVATION_TOOLS = new Set(["readFile", "listFiles", "shell"]);

export class AgentRuntime {
  constructor(
    private readonly ledger: EventLedger,
    private readonly providerRunner: ProviderRunner,
    private readonly sessionStore = new SessionStore()
  ) {}

  async runAssignment(input: RunAssignmentInput): Promise<AssignmentResult> {
    const assignment: Assignment = {
      id: createId("as"),
      taskId: input.taskId,
      taskRunId: input.taskRunId,
      ownerWorkspaceAgentId: input.agent.id,
      type: input.type,
      brief: input.brief,
      expectedArtifact: input.expectedArtifact,
      status: "waiting"
    };
    const assignmentRun: AssignmentRun = {
      id: createId("ar"),
      taskId: input.taskId,
      taskRunId: input.taskRunId,
      assignmentId: assignment.id,
      workspaceAgentId: input.agent.id,
      status: "running",
      startedAt: new Date().toISOString()
    };
    const sessionId = input.sessionId ?? input.taskRunId;
    const profile = input.profile ?? profileForRole(input.agent.roleInWorkspace);
    const provider = input.agent.provider ?? profile.defaultProvider;
    const model = input.agent.model ?? profile.defaultModel;
    const session = await this.sessionStore.read(input.workspace.rootPath, input.agent.id, sessionId);
    const prompt = buildAgentPrompt({ ...input, assignment, profile, session });

    const assignmentName = assignmentLabel(input.type);
    const roleName = roleLabel(input.agent.roleInWorkspace);
    await this.emit(input, "assignment.created", `已创建${assignmentName}任务`, { assignment, assignmentRun });
    await this.emit(input, "assignment.started", `${roleName}开始${assignmentName}`, { assignmentId: assignment.id, assignmentRun });
    await this.emit(input, "agent.status_changed", `${roleName}正在运行`, { agentId: input.agent.id, status: "running" });
    await this.emit(input, "agent.step_started", `${profile.name}: ${input.brief}`, { agentId: input.agent.id, step: input.brief });
    await this.emit(input, "provider.started", `${roleName}正在调用模型服务：${provider}`, { provider, model });

    try {
      let providerResult: AgentTurnResult | undefined;
      const allToolResults: Array<Record<string, unknown>> = [];
      let turnPrompt = prompt;

      for (let turn = 1; turn <= MAX_TOOL_FOLLOW_UPS; turn += 1) {
        providerResult = await this.providerRunner.runWithRetry({
          role: input.agent.roleInWorkspace,
          assignmentType: input.type,
          prompt: turnPrompt,
          provider,
          model,
          context: { ...input.context, goal: input.goal, toolResults: allToolResults }
        });
        await this.emit(input, "provider.completed", `${roleName}的模型调用已完成`, {
          provider,
          model,
          usage: providerResult.usage,
          providerEvents: providerResult.events
        });

        const toolResults = await this.executeToolIntents(input, assignmentRun.id, providerResult);
        allToolResults.push(...toolResults);
        await this.sessionStore.appendTurn(input.workspace.rootPath, input.agent.id, sessionId, {
          user: turnPrompt,
          assistant: providerResult.text,
          providerEvents: providerResult.events,
          usage: providerResult.usage,
          toolResults
        });

        if (!needsToolFollowUp(toolResults)) break;
        if (turn === MAX_TOOL_FOLLOW_UPS) {
          providerResult = {
            ...providerResult,
            structured: {
              ...(providerResult.structured ?? {}),
              status: "blocked",
              reason: "工具观察循环达到上限，任务未形成最终结论"
            }
          };
          break;
        }
        turnPrompt = buildToolFollowUpPrompt(prompt, allToolResults);
      }

      if (!providerResult) throw new Error("模型未返回结果");

      assignment.status = "completed";
      assignmentRun.status = "completed";
      assignmentRun.endedAt = new Date().toISOString();
      await this.emit(input, "agent.step_completed", `${roleName}已完成${assignmentName}`, { agentId: input.agent.id, step: input.brief });
      await this.emit(input, "assignment.completed", `${roleName}已完成${assignmentName}`, {
        assignmentId: assignment.id,
        assignmentRun,
        result: providerResult.structured ?? providerResult.text,
        rawText: providerResult.text,
        toolResults: allToolResults
      });
      await this.emit(input, "agent.status_changed", `${roleName}正在等待`, { agentId: input.agent.id, status: "waiting" });
      return { assignment, assignmentRun, providerResult, toolResults: allToolResults };
    } catch (error) {
      assignment.status = "failed";
      assignmentRun.status = "failed";
      assignmentRun.endedAt = new Date().toISOString();
      await this.emit(input, "provider.failed", `${roleName}的模型或工具调用失败`, { error: (error as Error).message });
      await this.emit(input, "assignment.failed", `${roleName}执行${assignmentName}失败`, { assignmentId: assignment.id, assignmentRun, error: (error as Error).message });
      await this.emit(input, "agent.status_changed", `${roleName}执行失败`, { agentId: input.agent.id, status: "failed" });
      throw error;
    }
  }

  private async executeToolIntents(input: RunAssignmentInput, assignmentRunId: string, providerResult: AgentTurnResult): Promise<Array<Record<string, unknown>>> {
    const intents = normalizeToolIntents(providerResult.structured);
    const context: ToolContext = {
      workspace: input.workspace,
      agent: input.agent,
      taskId: input.taskId,
      taskRunId: input.taskRunId,
      assignmentRunId,
      ledger: this.ledger
    };
    const results: Array<Record<string, unknown>> = [];
    for (const rawIntent of intents) {
      const intent = rawIntent as Record<string, unknown>;
      const tool = String(intent.tool ?? intent.name ?? "");
      try {
        if (tool === "writeFile") {
          await writeWorkspaceFile(context, String(intent.path ?? ""), String(intent.content ?? ""));
          results.push({ tool, path: String(intent.path ?? ""), ok: true });
        } else if (tool === "readFile") {
          const content = await readWorkspaceFile(context, String(intent.path ?? ""));
          results.push({ tool, path: String(intent.path ?? ""), content, ok: true });
        } else if (tool === "listFiles") {
          const files = await listWorkspaceFiles(context, String(intent.path ?? "."));
          results.push({ tool, path: String(intent.path ?? "."), files, ok: true });
        } else if (tool === "shell") {
          const result = await runWorkspaceCommand(context, String(intent.command ?? ""));
          results.push({ tool, command: String(intent.command ?? ""), ...result, ok: Number(result.exitCode) === 0 });
        } else if (tool) {
          await this.emit(input, "tool.denied", `未知工具：${tool}`, { tool, error: "未知工具" });
          results.push({ tool, ok: false, error: "未知工具" });
        }
      } catch (error) {
        results.push({
          tool,
          path: String(intent.path ?? ""),
          command: String(intent.command ?? ""),
          ok: false,
          error: (error as Error).message
        });
      }
    }
    return results;
  }

  private async emit(
    input: Pick<RunAssignmentInput, "workspace" | "taskId" | "taskRunId" | "agent">,
    type: AutoAgentEvent["type"],
    summary: string,
    payload: Record<string, unknown>
  ) {
    return this.ledger.append(input.workspace.rootPath, {
      workspaceId: input.workspace.id,
      taskId: input.taskId,
      taskRunId: input.taskRunId,
      actorId: input.agent.id,
      type,
      summary,
      payload
    });
  }
}

function normalizeToolIntents(structured?: Record<string, unknown>): Array<Record<string, unknown>> {
  if (!structured) return [];
  if (Array.isArray(structured.toolIntents)) return structured.toolIntents as Array<Record<string, unknown>>;

  const action = typeof structured.action === "string" ? structured.action : undefined;
  if (!action) return [];
  if (action === "readFiles" && Array.isArray(structured.paths)) {
    return structured.paths.map((targetPath) => ({ tool: "readFile", path: targetPath }));
  }
  if (action === "readFile" || action === "listFiles" || action === "writeFile" || action === "shell") {
    return [{ ...structured, tool: action }];
  }
  return [];
}

function needsToolFollowUp(toolResults: Array<Record<string, unknown>>): boolean {
  return toolResults.some((result) => OBSERVATION_TOOLS.has(String(result.tool)) || result.ok === false || typeof result.error === "string");
}

function buildToolFollowUpPrompt(originalPrompt: string, toolResults: Array<Record<string, unknown>>): string {
  return [
    originalPrompt,
    "",
    "上一轮真实工具结果：",
    JSON.stringify(compactToolResultsForPrompt(toolResults)),
    "只能基于这些真实工具结果继续判断。不要编造文件、命令输出或验收证据。",
    "如果还需要读文件、列目录或执行命令，返回 {\"toolIntents\":[...]}。",
    "如果已经完成，返回最终结构化结果；如果无法继续，返回 blocked/need_clarification 并说明缺什么。"
  ].join("\n");
}

const TOOL_RESULT_PROMPT_STRING_CHARS = 12_000;

function compactToolResultsForPrompt(toolResults: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return toolResults.map((result) => compactToolResultValue(result) as Record<string, unknown>);
}

function compactToolResultValue(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.length <= TOOL_RESULT_PROMPT_STRING_CHARS) return value;
    return `${value.slice(0, TOOL_RESULT_PROMPT_STRING_CHARS)}\n...[工具结果截断，原始长度 ${value.length} 字符]`;
  }
  if (Array.isArray(value)) return value.map(compactToolResultValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, compactToolResultValue(item)]));
  }
  return value;
}
