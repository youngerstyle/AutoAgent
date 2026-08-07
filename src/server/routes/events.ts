import { Router } from "express";
import type { AutoAgentEvent } from "../../shared/types.js";
import type { EventLedger } from "../storage/event-ledger.js";

const SSE_HEARTBEAT_MS = positiveIntegerFromEnv("AUTOAGENT_SSE_HEARTBEAT_MS", 15_000);
type WorkspaceRootResolver = (workspaceId: string) => Promise<string | undefined>;

export function createEventRouter(ledger: EventLedger, resolveWorkspaceRoot?: WorkspaceRootResolver) {
  const router = Router({ mergeParams: true });

  router.get("/", (req, res) => {
    const workspaceId = String((req.params as { workspaceId: string }).workspaceId);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    res.write(": connected\n\n");
    let closed = false;
    let replaying = true;
    const buffered: AutoAgentEvent[] = [];
    const sentIds = new Set<string>();

    const writeEvent = (event: AutoAgentEvent) => {
      if (closed || res.writableEnded || sentIds.has(event.id)) return;
      sentIds.add(event.id);
      res.write(`event: autoagent\n`);
      res.write(`id: ${event.id}\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    const onEvent = (event: AutoAgentEvent) => {
      if (replaying) buffered.push(event);
      else writeEvent(event);
    };
    const heartbeat = setInterval(() => {
      res.write(": heartbeat\n\n");
    }, SSE_HEARTBEAT_MS);
    heartbeat.unref?.();

    ledger.bus.on(`workspace:${workspaceId}`, onEvent);
    req.on("close", () => {
      closed = true;
      clearInterval(heartbeat);
      ledger.bus.off(`workspace:${workspaceId}`, onEvent);
    });

    void replayAfterCursor();

    async function replayAfterCursor(): Promise<void> {
      try {
        const cursor = String(req.get("Last-Event-ID") ?? req.query.cursor ?? "").trim();
        if (cursor && resolveWorkspaceRoot) {
          const root = await resolveWorkspaceRoot(workspaceId);
          if (root) {
            for (const event of await ledger.readWorkspaceSince(root, cursor)) writeEvent(event);
          }
        }
        replaying = false;
        for (const event of buffered) writeEvent(event);
      } catch {
        replaying = false;
        for (const event of buffered) writeEvent(event);
      }
    }
  });

  return router;
}

function positiveIntegerFromEnv(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
