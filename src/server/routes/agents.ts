import { Router } from "express";
import type { AgentPolicy, ProviderName, WorkspaceToolName } from "../../shared/types.js";
import { isKnownToolName } from "../tools/tool-catalog.js";
import { AgentProfileStore } from "../agents/profile-store.js";
import { asyncHandler, HttpError } from "../errors.js";
import { ensureCoreTeam, listWorkspaceAgents, profileMetadata, updateWorkspaceAgent } from "../agents/roster.js";
import type { WorkspaceStore } from "../storage/workspace-store.js";

export function createAgentRouter(workspaceStore: WorkspaceStore, profileStore?: AgentProfileStore) {
  const router = Router({ mergeParams: true });

  router.get("/", asyncHandler(async (req, res) => {
    const workspace = await workspaceStore.get(String((req.params as { workspaceId: string }).workspaceId));
    const profiles = profileStore ? await profileStore.list() : undefined;
    await ensureCoreTeam(workspace, profiles);
    const agents = await listWorkspaceAgents(workspace);
    res.json({ agents: agents.map((agent) => ({ ...agent, ...profileMetadata(agent, profiles) })) });
  }));

  router.patch("/:agentId", asyncHandler(async (req, res) => {
    const workspace = await workspaceStore.get(String((req.params as { workspaceId: string }).workspaceId));
    const profiles = profileStore ? await profileStore.list() : undefined;
    await ensureCoreTeam(workspace, profiles);
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

  return router;
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
