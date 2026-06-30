import type { Assignment, AssignmentRun, AutoAgentEvent, Workspace, WorkspaceAgent } from "../../shared/types.js";
import { createId } from "../../shared/ids.js";
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
    const profile = profileForRole(input.agent.roleInWorkspace);
    const provider = input.agent.provider ?? profile.defaultProvider;
    const model = input.agent.model ?? profile.defaultModel;
    const session = await this.sessionStore.read(input.workspace.rootPath, input.agent.id, sessionId);
    const prompt = buildAgentPrompt({ ...input, assignment, session });

    await this.emit(input, "assignment.created", `Created ${input.type} assignment`, { assignment, assignmentRun });
    await this.emit(input, "assignment.started", `${profile.name} started ${input.type}`, { assignmentId: assignment.id, assignmentRun });
    await this.emit(input, "agent.status_changed", `${profile.name} is running`, { agentId: input.agent.id, status: "running" });
    await this.emit(input, "agent.step_started", `${profile.name}: ${input.brief}`, { agentId: input.agent.id, step: input.brief });
    await this.emit(input, "provider.started", `${profile.name} requested ${provider}`, { provider, model });

    try {
      const providerResult = await this.providerRunner.runWithRetry({
        role: input.agent.roleInWorkspace,
        assignmentType: input.type,
        prompt,
        provider,
        model,
        context: { ...input.context, goal: input.goal }
      });
      await this.emit(input, "provider.completed", `${profile.name} provider turn completed`, {
        provider,
        model,
        usage: providerResult.usage,
        providerEvents: providerResult.events
      });

      const toolResults = await this.executeToolIntents(input, assignmentRun.id, providerResult);
      await this.sessionStore.appendTurn(input.workspace.rootPath, input.agent.id, sessionId, {
        user: prompt,
        assistant: providerResult.text,
        providerEvents: providerResult.events,
        usage: providerResult.usage,
        toolResults
      });

      assignment.status = "completed";
      assignmentRun.status = "completed";
      assignmentRun.endedAt = new Date().toISOString();
      await this.emit(input, "agent.step_completed", `${profile.name} completed ${input.type}`, { agentId: input.agent.id, step: input.brief });
      await this.emit(input, "assignment.completed", `${profile.name} completed ${input.type}`, {
        assignmentId: assignment.id,
        assignmentRun,
        result: providerResult.structured ?? providerResult.text,
        toolResults
      });
      await this.emit(input, "agent.status_changed", `${profile.name} is waiting`, { agentId: input.agent.id, status: "waiting" });
      return { assignment, assignmentRun, providerResult, toolResults };
    } catch (error) {
      assignment.status = "failed";
      assignmentRun.status = "failed";
      assignmentRun.endedAt = new Date().toISOString();
      await this.emit(input, "provider.failed", `${profile.name} provider/tool turn failed`, { error: (error as Error).message });
      await this.emit(input, "assignment.failed", `${profile.name} failed ${input.type}`, { assignmentId: assignment.id, assignmentRun, error: (error as Error).message });
      await this.emit(input, "agent.status_changed", `${profile.name} failed`, { agentId: input.agent.id, status: "failed" });
      throw error;
    }
  }

  private async executeToolIntents(input: RunAssignmentInput, assignmentRunId: string, providerResult: AgentTurnResult): Promise<Array<Record<string, unknown>>> {
    const intents = Array.isArray(providerResult.structured?.toolIntents) ? providerResult.structured.toolIntents : [];
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
      if (tool === "writeFile") {
        await writeWorkspaceFile(context, String(intent.path ?? ""), String(intent.content ?? ""));
        results.push({ tool, path: String(intent.path ?? ""), ok: true });
      } else if (tool === "readFile") {
        const content = await readWorkspaceFile(context, String(intent.path ?? ""));
        results.push({ tool, path: String(intent.path ?? ""), content });
      } else if (tool === "listFiles") {
        const files = await listWorkspaceFiles(context, String(intent.path ?? "."));
        results.push({ tool, path: String(intent.path ?? "."), files });
      } else if (tool === "shell") {
        const result = await runWorkspaceCommand(context, String(intent.command ?? ""));
        results.push({ tool, command: String(intent.command ?? ""), ...result });
      } else if (tool) {
        await this.emit(input, "tool.denied", `Unknown tool ${tool}`, { tool, error: "Unknown tool" });
        results.push({ tool, ok: false, error: "Unknown tool" });
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
