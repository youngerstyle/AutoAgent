import type { AutoAgentEvent, Workspace, WorkspaceAgent } from "../../shared/types.js";
import { createId } from "../../shared/ids.js";
import { resolvePolicy } from "../policy/policy.js";
import type { EventLedger } from "../storage/event-ledger.js";

export interface ToolContext {
  workspace: Workspace;
  agent: WorkspaceAgent;
  taskId: string;
  taskRunId: string;
  assignmentRunId?: string;
  ledger: EventLedger;
}

export function policyFor(context: ToolContext) {
  return resolvePolicy(context.workspace, context.agent);
}

export async function emitToolEvent(
  context: ToolContext,
  type: AutoAgentEvent["type"],
  summary: string,
  payload: Record<string, unknown>
) {
  return context.ledger.append(context.workspace.rootPath, {
    workspaceId: context.workspace.id,
    taskId: context.taskId,
    taskRunId: context.taskRunId,
    assignmentRunId: context.assignmentRunId,
    actorId: context.agent.id,
    type,
    summary,
    payload: { toolEventId: createId("tool"), ...payload }
  });
}
