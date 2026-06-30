import { Router } from "express";
import type { AgentPolicy, ProviderName } from "../../shared/types.js";
import { asyncHandler, HttpError } from "../errors.js";
import { ensureCoreTeam, listWorkspaceAgents, profileMetadata, updateWorkspaceAgent } from "../agents/roster.js";
import type { WorkspaceStore } from "../storage/workspace-store.js";

export function createAgentRouter(workspaceStore: WorkspaceStore) {
  const router = Router({ mergeParams: true });

  router.get("/", asyncHandler(async (req, res) => {
    const workspace = await workspaceStore.get(String((req.params as { workspaceId: string }).workspaceId));
    await ensureCoreTeam(workspace);
    const agents = await listWorkspaceAgents(workspace);
    res.json({ agents: agents.map((agent) => ({ ...agent, ...profileMetadata(agent) })) });
  }));

  router.patch("/:agentId", asyncHandler(async (req, res) => {
    const workspace = await workspaceStore.get(String((req.params as { workspaceId: string }).workspaceId));
    await ensureCoreTeam(workspace);
    const provider = req.body.provider === undefined ? undefined : assertProvider(String(req.body.provider));
    const policyOverride = req.body.policyOverride === undefined ? undefined : sanitizePolicy(req.body.policyOverride as Record<string, unknown>);
    const agent = await updateWorkspaceAgent(workspace, String(req.params.agentId), {
      provider,
      model: req.body.model === undefined ? undefined : String(req.body.model),
      policyOverride
    });
    res.json({ agent: { ...agent, ...profileMetadata(agent) } });
  }));

  return router;
}

function assertProvider(provider: string): ProviderName {
  if (provider === "mock" || provider === "openai" || provider === "anthropic") return provider;
  throw new HttpError(400, `Invalid provider: ${provider}`, "INVALID_PROVIDER");
}

function sanitizePolicy(input: Record<string, unknown>): Partial<AgentPolicy> {
  return {
    canReadWorkspace: Boolean(input.canReadWorkspace),
    canWriteWorkspace: Boolean(input.canWriteWorkspace),
    canExecuteCommands: Boolean(input.canExecuteCommands),
    allowHostAccess: Boolean(input.allowHostAccess)
  };
}
