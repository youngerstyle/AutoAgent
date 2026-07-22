import express, { Router } from "express";
import type { WorkspaceStore } from "../storage/workspace-store.js";
import { AttachmentStore } from "../storage/attachment-store.js";
import { asyncHandler } from "../errors.js";

export function createAttachmentRouter(workspaces: WorkspaceStore) {
  const router = Router({ mergeParams: true });

  router.post("/", express.raw({ type: ["image/png", "image/jpeg", "image/webp", "image/gif"], limit: "10mb" }), asyncHandler(async (req, res) => {
    const workspace = await workspaces.get(String(req.params.workspaceId));
    const attachment = await new AttachmentStore(workspace.rootPath).put({
      data: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
      mimeType: String(req.headers["content-type"] ?? ""),
      fileName: safeDecodeFileName(String(req.headers["x-file-name"] ?? "image")),
    });
    res.status(201).json({ attachment });
  }));

  router.get("/:attachmentId", asyncHandler(async (req, res) => {
    const workspace = await workspaces.get(String(req.params.workspaceId));
    const attachment = await new AttachmentStore(workspace.rootPath).get(String(req.params.attachmentId));
    res.type(attachment.metadata.mimeType).send(attachment.data);
  }));

  return router;
}

function safeDecodeFileName(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return "image";
  }
}
