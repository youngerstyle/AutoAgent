import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { errorMiddleware } from "./errors.js";
import { createWorkspaceRouter } from "./routes/workspaces.js";

export function createApp() {
  const app = express();
  app.use(express.json({ limit: "2mb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, name: "AutoAgent" });
  });
  app.use("/api/workspaces", createWorkspaceRouter());

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const clientDir = path.resolve(__dirname, "../client");
  app.use(express.static(clientDir));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api")) {
      next();
      return;
    }
    res.sendFile(path.join(clientDir, "index.html"), (err) => {
      if (err) next();
    });
  });

  app.use(errorMiddleware);
  return app;
}
