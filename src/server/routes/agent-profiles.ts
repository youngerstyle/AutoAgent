import { Router } from "express";
import { loadConfig } from "../config.js";
import { asyncHandler, HttpError } from "../errors.js";
import { AgentProfileStore, sanitizeProfilePatch } from "../agents/profile-store.js";

export function createAgentProfileRouter(store?: AgentProfileStore) {
  const router = Router();
  const profileStore = store ?? new AgentProfileStore(loadConfig().autoAgentHome);

  router.get("/", asyncHandler(async (_req, res) => {
    res.json({ profiles: await profileStore.list() });
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
