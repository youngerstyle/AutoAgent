import { Router } from "express";
import { asyncHandler } from "../errors.js";
import type { MissionControl } from "../mission/mission-control.js";

export function createTaskRouter(mission: MissionControl) {
  const router = Router({ mergeParams: true });

  router.get("/snapshot", asyncHandler(async (req, res) => {
    res.json({ snapshot: await mission.snapshotByWorkspace(String(req.params.workspaceId)) });
  }));

  router.get("/debug-log", asyncHandler(async (req, res) => {
    res.json({ log: await mission.loopDebugLogByWorkspace(String(req.params.workspaceId)) });
  }));

  router.post("/tasks", asyncHandler(async (req, res) => {
    const snapshot = await mission.startTask({
      workspaceId: String(req.params.workspaceId),
      goal: String(req.body.goal ?? ""),
      title: req.body.title ? String(req.body.title) : undefined
    });
    res.status(201).json({ snapshot });
  }));

  router.post("/tasks/:taskId/pause", asyncHandler(async (req, res) => {
    const state = await mission.pauseTask(String(req.params.workspaceId), String(req.params.taskId));
    res.json({ state });
  }));

  router.post("/tasks/:taskId/resume", asyncHandler(async (req, res) => {
    const snapshot = await mission.resumeTask(String(req.params.workspaceId), String(req.params.taskId));
    res.json({ snapshot });
  }));

  router.post("/tasks/:taskId/followups", asyncHandler(async (req, res) => {
    const snapshot = await mission.followUpTask(
      String(req.params.workspaceId),
      String(req.params.taskId),
      String(req.body.message ?? "")
    );
    res.status(201).json({ snapshot });
  }));

  router.post("/tasks/:taskId/stop", asyncHandler(async (req, res) => {
    const state = await mission.stopTask(String(req.params.workspaceId), String(req.params.taskId));
    res.json({ state });
  }));

  return router;
}
