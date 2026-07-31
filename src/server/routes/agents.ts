import { Router } from "express";
import type { AgentPolicy, ProviderName, WorkspaceToolName } from "../../shared/types.js";
import { isKnownToolName } from "../tools/tool-catalog.js";
import { AgentProfileStore } from "../agents/profile-store.js";
import { asyncHandler, HttpError } from "../errors.js";
import { addWorkspaceAgent, listWorkspaceAgents, profileMetadata, removeWorkspaceAgent, updateWorkspaceAgent } from "../agents/roster.js";
import { RuntimeHostStore } from "../runtime/runtime-host-store.js";
import type { WorkspaceStore } from "../storage/workspace-store.js";

export function createAgentRouter(workspaceStore: WorkspaceStore, profileStore?: AgentProfileStore) {
  const router = Router({ mergeParams: true });

  router.get("/", asyncHandler(async (req, res) => {
    const workspace = await workspaceStore.get(String((req.params as { workspaceId: string }).workspaceId));
    const profiles = profileStore ? await profileStore.list() : undefined;
    const agents = await listWorkspaceAgents(workspace);
    res.json({ agents: agents.map((agent) => ({ ...agent, ...profileMetadata(agent, profiles) })) });
  }));

  router.post("/", asyncHandler(async (req, res) => {
    const workspace = await workspaceStore.get(String((req.params as { workspaceId: string }).workspaceId));
    await assertTeamMutable(workspace.rootPath);
    const profiles = profileStore ? await profileStore.list() : [];
    const profile = profiles.find((item) => item.id === String(req.body.profileId));
    if (!profile) throw new HttpError(404, "Agent profile not found", "AGENT_PROFILE_NOT_FOUND");
    try {
      const agent = await addWorkspaceAgent(workspace, profile);
      res.status(201).json({ agent: { ...agent, ...profileMetadata(agent, profiles) } });
    } catch (error) {
      if ((error as Error).message.includes("already in workspace")) {
        throw new HttpError(409, (error as Error).message, "AGENT_ALREADY_IN_WORKSPACE");
      }
      throw error;
    }
  }));

  router.patch("/:agentId", asyncHandler(async (req, res) => {
    const workspace = await workspaceStore.get(String((req.params as { workspaceId: string }).workspaceId));
    const profiles = profileStore ? await profileStore.list() : undefined;
    const provider = req.body.provider === undefined ? undefined : assertProvider(String(req.body.provider));
    const policyOverride = req.body.policyOverride === undefined ? undefined : sanitizePolicy(req.body.policyOverride as Record<string, unknown>);
    const skillOverrides = req.body.skillOverrides === undefined ? undefined : sanitizeSkillOverrides(req.body.skillOverrides);
    const agent = await updateWorkspaceAgent(workspace, String(req.params.agentId), {
      provider,
      model: req.body.model === undefined ? undefined : String(req.body.model),
      skillOverrides,
      policyOverride
    });
    res.json({ agent: { ...agent, ...profileMetadata(agent, profiles) } });
  }));

  router.delete("/:agentId", asyncHandler(async (req, res) => {
    const workspace = await workspaceStore.get(String((req.params as { workspaceId: string }).workspaceId));
    await assertTeamMutable(workspace.rootPath);
    try {
      const agent = await removeWorkspaceAgent(workspace, String(req.params.agentId));
      res.json({ agent });
    } catch (error) {
      if ((error as Error).message.includes("not found")) {
        throw new HttpError(404, (error as Error).message, "WORKSPACE_AGENT_NOT_FOUND");
      }
      throw error;
    }
  }));

  return router;
}

async function assertTeamMutable(workspaceRoot: string): Promise<void> {
  const tasks = await new RuntimeHostStore(workspaceRoot).list();
  if (tasks.some((task) => task.status === "active" || task.status === "paused")) {
    throw new HttpError(409, "当前任务运行期间不能调整项目团队；任务结束后再添加或移出成员。", "TEAM_BINDING_ACTIVE");
  }
}

function assertProvider(provider: string): ProviderName {
  if (provider === "mock" || provider === "openai" || provider === "anthropic") return provider;
  throw new HttpError(400, `Invalid provider: ${provider}`, "INVALID_PROVIDER");
}

function sanitizeSkillOverrides(input: unknown): string[] | null {
  if (input === null) return null;
  if (!Array.isArray(input)) throw new HttpError(400, "skillOverrides must be an array or null", "INVALID_SKILL_OVERRIDES");
  return [...new Set(input.map(String).map((skill) => skill.trim()).filter(Boolean))];
}

function sanitizePolicy(input: Record<string, unknown>): Partial<AgentPolicy> {
  const enabledTools = Array.isArray(input.enabledTools)
    ? input.enabledTools.filter((tool): tool is WorkspaceToolName => typeof tool === "string" && isKnownToolName(tool))
    : undefined;
  return {
    canReadWorkspace: Boolean(input.canReadWorkspace),
    canWriteWorkspace: Boolean(input.canWriteWorkspace),
    canExecuteCommands: Boolean(input.canExecuteCommands),
    ...(enabledTools ? { enabledTools } : {}),
    allowHostAccess: Boolean(input.allowHostAccess)
  };
}
