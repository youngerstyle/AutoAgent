import type { ProviderName, Workspace, WorkspaceAgent } from "../../shared/types.js";
import { createId } from "../../shared/ids.js";
import type { EventLedger } from "../storage/event-ledger.js";
import { ensureWorkspaceAgent, listWorkspaceAgents, profileMetadata } from "./roster.js";

export async function recruitSpecialist(input: {
  workspace: Workspace;
  taskId: string;
  taskRunId: string;
  capabilityGap: string;
  ledger: EventLedger;
  defaultProvider?: ProviderName;
  defaultModel?: string;
}): Promise<WorkspaceAgent> {
  const existing = (await listWorkspaceAgents(input.workspace)).find(
    (agent) => agent.roleInWorkspace === "specialist" && agent.profileId.toLowerCase().includes(slug(input.capabilityGap))
  );
  if (existing) return existing;

  await input.ledger.append(input.workspace.rootPath, {
    workspaceId: input.workspace.id,
    taskId: input.taskId,
    taskRunId: input.taskRunId,
    type: "recruitment.requested",
    summary: `老板发起专家招聘：${input.capabilityGap}`,
    payload: { capabilityGap: input.capabilityGap }
  });

  const capabilitySlug = slug(input.capabilityGap);
  const agent = await ensureWorkspaceAgent(
    input.workspace,
    {
      id: `prof_specialist_${capabilitySlug}`,
      name: `${input.capabilityGap}专家`,
      role: "specialist",
      capabilities: [input.capabilityGap],
      defaultProvider: input.defaultProvider ?? "mock",
      defaultModel: input.defaultModel ?? "mock-specialist",
      defaultPolicy: { canReadWorkspace: true, canWriteWorkspace: true, canExecuteCommands: true, enabledTools: ["listFiles", "readFile", "writeFile", "editFile", "shell", "startService", "pollProcess", "browser"] }
    },
    createId("wa")
  );

  await input.ledger.append(input.workspace.rootPath, {
    workspaceId: input.workspace.id,
    taskId: input.taskId,
    taskRunId: input.taskRunId,
    actorId: agent.id,
    type: "recruitment.approved",
    summary: `老板已招募${input.capabilityGap}专家`,
    payload: { capabilityGap: input.capabilityGap, agent: { ...agent, ...profileMetadata(agent), capabilities: [input.capabilityGap] } }
  });
  await input.ledger.append(input.workspace.rootPath, {
    workspaceId: input.workspace.id,
    taskId: input.taskId,
    taskRunId: input.taskRunId,
    actorId: agent.id,
    type: "agent.joined_workspace",
    summary: `${input.capabilityGap}专家已加入项目`,
    payload: { agent: { ...agent, ...profileMetadata(agent), capabilities: [input.capabilityGap] } }
  });
  return agent;
}

function slug(value: string): string {
  const ascii = value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
  if (ascii) return ascii;
  return Array.from(value)
    .map((char) => char.codePointAt(0)?.toString(36) ?? "")
    .filter(Boolean)
    .join("_")
    .slice(0, 40) || "general";
}
