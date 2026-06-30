import { Router } from "express";
import { asyncHandler } from "../errors.js";
import { loadConfig } from "../config.js";
import { WorkspaceStore } from "../storage/workspace-store.js";

export function createWorkspaceRouter() {
  const router = Router();
  const store = new WorkspaceStore(loadConfig().autoAgentHome);

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

  return router;
}
