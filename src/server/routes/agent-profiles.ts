import { Router } from "express";
import os from "node:os";
import path from "node:path";
import { loadSkills } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config.js";
import { asyncHandler, HttpError } from "../errors.js";
import { AgentProfileStore, sanitizeProfileCreate, sanitizeProfilePatch } from "../agents/profile-store.js";

export function createAgentProfileRouter(store?: AgentProfileStore) {
  const router = Router();
  const profileStore = store ?? new AgentProfileStore(loadConfig().autoAgentHome);

  router.get("/", asyncHandler(async (_req, res) => {
    res.json({ profiles: await profileStore.list() });
  }));

  router.get("/skills", asyncHandler(async (_req, res) => {
    const loaded = loadSkills({
      cwd: process.cwd(),
      agentDir: path.join(os.homedir(), ".agents"),
      skillPaths: [path.join(os.homedir(), ".agents", "skills")],
      includeDefaults: false,
    });
    res.json({
      skills: loaded.skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        filePath: skill.filePath,
      })),
      diagnostics: loaded.diagnostics,
    });
  }));

  router.post("/", asyncHandler(async (req, res) => {
    try {
      const profile = await profileStore.create(sanitizeProfileCreate(req.body));
      res.status(201).json({ profile });
    } catch (error) {
      throw new HttpError(400, (error as Error).message, "INVALID_AGENT_PROFILE");
    }
  }));

  router.patch("/:profileId", asyncHandler(async (req, res) => {
    try {
      const profile = await profileStore.update(String(req.params.profileId), sanitizeProfilePatch(req.body));
      res.json({ profile });
    } catch (error) {
      if ((error as Error).message.includes("not found")) throw new HttpError(404, (error as Error).message, "AGENT_PROFILE_NOT_FOUND");
      throw error;
    }
  }));

  return router;
}
