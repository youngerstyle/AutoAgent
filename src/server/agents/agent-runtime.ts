import type { AgentProfile, Assignment, AssignmentRun, AutoAgentEvent, Ticket, Workspace, WorkspaceAgent } from "../../shared/types.js";
import { createId } from "../../shared/ids.js";
import { assignmentLabel, roleLabel } from "../../shared/labels.js";
import type { AgentTurnInput, AgentTurnResult } from "../providers/types.js";
import type { EventLedger } from "../storage/event-ledger.js";
import { LoopTraceStore } from "../storage/loop-trace-store.js";
import { SessionStore } from "../storage/session-store.js";
import { readWorkspaceFile, listWorkspaceFiles, writeWorkspaceFile } from "../tools/file-tools.js";
import { runWorkspaceCommand } from "../tools/shell-tool.js";
import type { ToolContext } from "../tools/tool-runtime.js";
import { ContextAssembler } from "../context/context-assembler.js";
import { profileForRole } from "./roster.js";
import { RUNTIME_LIMITS } from "../runtime-limits.js";

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
  currentTicket?: Ticket;
  context?: Record<string, unknown>;
  sessionId?: string;
}

export interface AssignmentResult {
  kind: "final";
  assignment: Assignment;
  assignmentRun: AssignmentRun;
  providerResult: AgentTurnResult;
  toolResults: Array<Record<string, unknown>>;
}

export interface YieldedAssignmentResult {
  kind: "yielded";
  assignment: Assignment;
  assignmentRun: AssignmentRun;
  reason: string;
  providerResult?: AgentTurnResult;
  toolResults: Array<Record<string, unknown>>;
  continuation: {
    sessionId: string;
    nextTurn: number;
    observedToolCount: number;
  };
}

export type RunAssignmentResult = AssignmentResult | YieldedAssignmentResult;

export interface AgentRuntimeLimits {
  maxToolFollowUps: number;
}

const OBSERVATION_TOOLS = new Set(["readFile", "listFiles", "shell"]);

export class AgentRuntime {
  constructor(
    private readonly ledger: EventLedger,
    private readonly providerRunner: ProviderRunner,
    private readonly sessionStore = new SessionStore(),
    private readonly contextAssembler = new ContextAssembler(),
    private readonly loopTraceStore = new LoopTraceStore(),
    private readonly limits: AgentRuntimeLimits = RUNTIME_LIMITS
  ) {}

  async runAssignment(input: RunAssignmentInput): Promise<RunAssignmentResult> {
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

      for (let turn = 1; turn <= this.limits.maxToolFollowUps; turn += 1) {
        const session = await this.sessionStore.read(input.workspace.rootPath, input.agent.id, sessionId);
        const assembled = await this.contextAssembler.assemble({
          ...input,
          assignment,
          currentTicket: input.currentTicket,
          profile,
          sessionId,
          taskRunId: input.taskRunId,
          session,
          toolResults: allToolResults
        });
        await this.emit(input, "context.assembled", `${roleName}完成上下文组装`, {
          agentId: input.agent.id,
          assignmentId: assignment.id,
          turn,
          report: assembled.report
        });
        await this.loopTraceStore.append(input.workspace.rootPath, input.taskId, input.taskRunId, {
          assignmentRunId: assignmentRun.id,
          agentId: input.agent.id,
          actor: roleName,
          kind: "prompt",
          turn,
          title: "Prompt",
          content: assembled.prompt,
          detail: contextReportDetail(assembled.report),
          metadata: {
            agentId: input.agent.id,
            role: input.agent.roleInWorkspace,
            assignmentId: assignment.id,
            assignmentType: input.type,
            provider,
            model,
            contextReport: assembled.report
          }
        });
        providerResult = await this.providerRunner.runWithRetry({
          role: input.agent.roleInWorkspace,
          assignmentType: input.type,
          prompt: assembled.prompt,
          provider,
          model,
          context: { ...input.context, goal: input.goal, currentTicket: input.currentTicket, toolResults: allToolResults, contextReport: assembled.report }
        });
        await this.emit(input, "provider.completed", `${roleName}的模型调用已完成`, {
          provider,
          model,
          usage: providerResult.usage,
          providerEvents: providerResult.events
        });
        await this.loopTraceStore.append(input.workspace.rootPath, input.taskId, input.taskRunId, {
          assignmentRunId: assignmentRun.id,
          agentId: input.agent.id,
          actor: roleName,
          kind: "llm",
          turn,
          title: "LLM 返回",
          content: providerResult.text,
          detail: providerResult.usage ? `tokens: ${providerResult.usage.totalTokens}` : undefined,
          metadata: {
            agentId: input.agent.id,
            role: input.agent.roleInWorkspace,
            assignmentId: assignment.id,
            assignmentType: input.type,
            provider,
            model,
            usage: providerResult.usage,
            structured: providerResult.structured,
            providerEvents: providerResult.events
          }
        });

        const toolResults = await this.executeToolIntents(input, assignmentRun.id, providerResult);
        allToolResults.push(...toolResults);
        for (const toolResult of toolResults) {
          await this.loopTraceStore.append(input.workspace.rootPath, input.taskId, input.taskRunId, {
            assignmentRunId: assignmentRun.id,
            agentId: input.agent.id,
            actor: roleName,
            kind: "tool",
            turn,
            title: "工具结果",
            content: JSON.stringify(toolResult),
            detail: toolTraceDetail(toolResult),
            metadata: {
              agentId: input.agent.id,
              role: input.agent.roleInWorkspace,
              assignmentId: assignment.id,
              assignmentType: input.type,
              tool: toolResult.tool
            }
          });
        }
        await this.sessionStore.appendTurn(input.workspace.rootPath, input.agent.id, sessionId, {
          user: sessionTurnUserMessage(input, assignmentName, roleName, turn),
          assistant: providerResult.text,
          usage: providerResult.usage,
          toolResults,
          userMetadata: { contextReport: assembled.report }
        });

        if (!needsToolFollowUp(toolResults)) break;
        if (turn === this.limits.maxToolFollowUps) {
          const reason = "执行片工具观察预算已用完，已保存进度并等待继续";
          assignment.status = "waiting";
          assignmentRun.status = "waiting";
          assignmentRun.endedAt = new Date().toISOString();
          await this.loopTraceStore.append(input.workspace.rootPath, input.taskId, input.taskRunId, {
            assignmentRunId: assignmentRun.id,
            agentId: input.agent.id,
            actor: roleName,
            kind: "llm",
            turn,
            title: "执行片已让出",
            content: reason,
            detail: `工具观察 ${allToolResults.length} 次`,
            metadata: {
              agentId: input.agent.id,
              role: input.agent.roleInWorkspace,
              assignmentId: assignment.id,
              assignmentType: input.type,
              maxToolFollowUps: this.limits.maxToolFollowUps,
              observedToolCount: allToolResults.length
            }
          });
          await this.emit(input, "assignment.yielded", `${roleName}已保存进度，等待继续`, {
            assignmentId: assignment.id,
            assignmentRun,
            reason,
            observedToolCount: allToolResults.length,
            maxToolFollowUps: this.limits.maxToolFollowUps
          });
          await this.emit(input, "agent.status_changed", `${roleName}正在等待`, { agentId: input.agent.id, status: "waiting" });
          return {
            kind: "yielded",
            assignment,
            assignmentRun,
            reason,
            providerResult,
            toolResults: allToolResults,
            continuation: {
              sessionId,
              nextTurn: turn + 1,
              observedToolCount: allToolResults.length
            }
          };
        }
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
      return { kind: "final", assignment, assignmentRun, providerResult, toolResults: allToolResults };
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

function contextReportDetail(report: { injectedChars: number; originalSessionChars: number; estimatedTokens: number; compaction?: { compacted?: boolean } }): string {
  const compacted = report.compaction?.compacted ? "，已压缩" : "";
  return `上下文 ${report.injectedChars} 字，原始 session ${report.originalSessionChars} 字，约 ${report.estimatedTokens} tokens${compacted}`;
}

function toolTraceDetail(toolResult: Record<string, unknown>): string | undefined {
  const tool = typeof toolResult.tool === "string" ? toolResult.tool : undefined;
  return tool ? `tool: ${tool}` : undefined;
}

function sessionTurnUserMessage(input: RunAssignmentInput, assignmentName: string, roleName: string, turn: number): string {
  return [
    `Agent：${roleName}`,
    `轮次：${turn}`,
    `任务类型：${assignmentName}`,
    `项目：${input.workspace.name}`,
    `目标：${input.goal}`,
    `任务说明：${input.brief}`,
    `预期产物：${input.expectedArtifact}`,
    compactSessionContext(input.context)
  ].filter(Boolean).join("\n");
}

function compactSessionContext(context?: Record<string, unknown>): string | undefined {
  if (!context) return undefined;
  const lines: string[] = [];
  const humanFollowup = stringValue(context.humanFollowup);
  const latestHumanFollowup = recordValue(context.latestHumanFollowup);
  const blockedTicket = recordValue(context.blockedTicket);
  const previousHumanFollowup = recordValue(context.previousHumanFollowup);
  const taskContext = recordValue(context.taskContext);

  if (humanFollowup) lines.push(`本轮 humanFollowup：${limitInline(humanFollowup)}`);
  const latestMessage = stringValue(latestHumanFollowup?.message);
  if (latestMessage) lines.push(`最新 humanFollowup：${limitInline(latestMessage)}`);
  const previousMessage = stringValue(previousHumanFollowup?.message);
  if (previousMessage) lines.push(`上一轮 humanFollowup：${limitInline(previousMessage)}`);
  if (blockedTicket) {
    const ticketSummary = [
      stringValue(blockedTicket.type),
      stringValue(blockedTicket.status),
      stringValue(blockedTicket.brief)
    ].filter(Boolean).join(" / ");
    if (ticketSummary) lines.push(`阻塞工单：${limitInline(ticketSummary)}`);
    const blocker = recordValue(blockedTicket.blocker);
    const blockerReason = stringValue(blocker?.reason);
    if (blockerReason) lines.push(`阻塞原因：${limitInline(blockerReason)}`);
  }
  const contextKeys = Object.keys(context)
    .filter((key) => !["toolResults", "contextReport"].includes(key))
    .slice(0, 20);
  if (contextKeys.length > 0) lines.push(`上下文字段：${contextKeys.join("、")}`);
  const taskKeys = taskContext ? Object.keys(taskContext).slice(0, 20) : [];
  if (taskKeys.length > 0) lines.push(`任务上下文字段：${taskKeys.join("、")}`);

  return lines.length > 0 ? `上下文摘要：\n${lines.join("\n")}` : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function limitInline(value: string, max = 500): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max)}...[截断，原始长度 ${compact.length} 字符]`;
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
