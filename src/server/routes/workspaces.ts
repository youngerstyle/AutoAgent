import { Router } from "express";
import { asyncHandler } from "../errors.js";
import { loadConfig } from "../config.js";
import { WorkspaceStore } from "../storage/workspace-store.js";

export function createWorkspaceRouter(
  store = new WorkspaceStore(loadConfig().autoAgentHome),
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
    const workspace = await store.create({
      name: String(req.body.name ?? ""),
      rootPath: String(req.body.rootPath ?? ""),
      policyProfile: req.body.policyProfile
    });
    res.status(201).json({ workspace });
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
