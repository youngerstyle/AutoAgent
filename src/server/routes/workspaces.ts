import { Router } from "express";
import { asyncHandler } from "../errors.js";
import { loadConfig } from "../config.js";
import { ensureProjectOwner, selectProjectOwnerProfile } from "../agents/roster.js";
import { AgentProfileStore } from "../agents/profile-store.js";
import { WorkspaceStore } from "../storage/workspace-store.js";

export function createWorkspaceRouter(
  store = new WorkspaceStore(loadConfig().autoAgentHome),
  profiles = new AgentProfileStore(loadConfig().autoAgentHome),
  removeWorkspace?: (
    workspaceId: string,
    options: { deleteLocalFolder?: boolean },
  ) => ReturnType<WorkspaceStore["remove"]>,
) {
  const router = Router();

  router.get("/", asyncHandler(async (_req, res) => {
    res.json({ workspaces: await store.list() });
  }));

  router.post("/", asyncHandler(async (req, res) => {
    const availableProfiles = await profiles.list();
    selectProjectOwnerProfile(availableProfiles);
    const workspace = await store.create({
      name: String(req.body.name ?? ""),
      rootPath: String(req.body.rootPath ?? ""),
      policyProfile: req.body.policyProfile
    });
    await ensureProjectOwner(workspace, availableProfiles);
    res.status(201).json({ workspace });
  }));

  router.patch("/:workspaceId/organization-memory-trust", asyncHandler(async (req, res) => {
    const disabled = req.body?.enabled === false;
    const workspace = await store.configureOrganizationMemory(
      String(req.params.workspaceId),
      disabled ? undefined : {
        id: String(req.body?.organizationId ?? ""),
        trustedMemoryWorkspaceIds: Array.isArray(req.body?.trustedMemoryWorkspaceIds)
          ? req.body.trustedMemoryWorkspaceIds.map(String)
          : [],
      },
    );
    res.json({ workspace });
  }));

  router.delete("/:workspaceId", asyncHandler(async (req, res) => {
    const remove = removeWorkspace ?? ((workspaceId, options) => store.remove(workspaceId, options));
    const workspace = await remove(String(req.params.workspaceId), {
      deleteLocalFolder: req.body?.deleteLocalFolder === true
    });
    res.json({ workspace });
  }));

  return router;
}
