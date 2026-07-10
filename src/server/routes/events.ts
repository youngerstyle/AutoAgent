import { Router } from "express";
import type { AutoAgentEvent } from "../../shared/types.js";
import type { EventLedger } from "../storage/event-ledger.js";

const SSE_HEARTBEAT_MS = positiveIntegerFromEnv("AUTOAGENT_SSE_HEARTBEAT_MS", 15_000);

export function createEventRouter(ledger: EventLedger) {
  const router = Router({ mergeParams: true });

  router.get("/", (req, res) => {
    const workspaceId = String((req.params as { workspaceId: string }).workspaceId);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    res.write(": connected\n\n");

    const onEvent = (event: AutoAgentEvent) => {
      res.write(`event: autoagent\n`);
      res.write(`id: ${event.id}\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const heartbeat = setInterval(() => {
      res.write(": heartbeat\n\n");
    }, SSE_HEARTBEAT_MS);
    heartbeat.unref?.();

    ledger.bus.on(`workspace:${workspaceId}`, onEvent);
    req.on("close", () => {
      clearInterval(heartbeat);
      ledger.bus.off(`workspace:${workspaceId}`, onEvent);
    });
  });

  return router;
}

function positiveIntegerFromEnv(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
