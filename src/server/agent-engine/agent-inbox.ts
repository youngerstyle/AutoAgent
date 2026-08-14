import { createHash } from "node:crypto";
import type { AgentThreadSnapshot } from "../../shared/contracts/agent-engine.js";

export type AgentInboxEntry = AgentInboxMessageEntry | AgentInboxCorrectionEntry;

export interface AgentInboxMessageEntry {
  kind: "message";
  itemId: string;
  turnId: string;
  goalId?: string;
  source: "human" | "host";
  deliveryKind: "turn" | "context";
  content: string;
  status: "pending" | "claimed" | "retry_wait" | "context";
}

export interface AgentInboxCorrectionEntry {
  kind: "correction";
  itemId: string;
  goalId?: string;
  content: string;
  status: "pending" | "claimed";
}

/**
 * Derive the one Agent inbox from the durable thread. Messages remain the
 * canonical audit facts; later control records are their durable claims.
 */
export function projectAgentInbox(
  thread: AgentThreadSnapshot,
  payloads: ReadonlyMap<string, unknown>,
): AgentInboxEntry[] {
  return thread.items.flatMap((item, index): AgentInboxEntry[] => {
    const payload = payloads.get(item.payloadRef);
    if (item.kind === "message" && isRecord(payload) && typeof payload.content === "string") {
      const turnId = item.turnId ?? stableId("turn", thread.threadId, item.itemId);
      const deliveryKind = payload.deliveryKind === "context" ? "context" : "turn";
      const later = thread.items.slice(index + 1);
      const latestSameTurn = [...later].reverse().find((candidate) => candidate.turnId === turnId && candidate.kind !== "message");
      const latestPayload = latestSameTurn ? payloads.get(latestSameTurn.payloadRef) : undefined;
      const explicitlyClaimed = later.some((candidate) => {
        const value = payloads.get(candidate.payloadRef);
        return isRecord(value) && value.triggerMessageId === item.itemId;
      });
      const status = deliveryKind === "context"
        ? "context" as const
        : isRetryContinuationPayload(latestPayload)
          ? "retry_wait" as const
          : latestSameTurn || explicitlyClaimed
            ? "claimed" as const
            : "pending" as const;
      return [{
        kind: "message",
        itemId: item.itemId,
        turnId,
        ...(typeof payload.goalId === "string" ? { goalId: payload.goalId } : {}),
        source: payload.senderPrincipalId === "human" ? "human" : "host",
        deliveryKind,
        content: payload.content,
        status,
      }];
    }
    if (item.kind === "control" && isCorrectableDecision(payload)) {
      const claimed = thread.items.slice(index + 1).some((candidate) => candidate.kind === "control"
        && isRunningPayload(payloads.get(candidate.payloadRef)));
      return [{
        kind: "correction",
        itemId: item.itemId,
        ...(typeof payload.goalId === "string" ? { goalId: payload.goalId } : {}),
        content: JSON.stringify(payload.decision),
        status: claimed ? "claimed" : "pending",
      }];
    }
    return [];
  });
}

export function nextAgentInboxInput(
  entries: readonly AgentInboxEntry[],
  options: { humanOnly?: boolean; earliest?: boolean; goalId?: string } = {},
): AgentInboxEntry | undefined {
  const ordered = options.earliest ? entries : [...entries].reverse();
  return ordered.find((entry) => entry.status === "pending"
    && (!options.goalId || entry.goalId === options.goalId)
    && (!options.humanOnly || (entry.kind === "message" && entry.source === "human" && entry.deliveryKind === "turn")));
}

export function isAgentInboxMessageConsumed(entries: readonly AgentInboxEntry[], messageId: string): boolean {
  const entry = entries.find((candidate) => candidate.kind === "message" && candidate.itemId === messageId);
  return entry?.status === "claimed";
}

function isRetryContinuationPayload(value: unknown): boolean {
  return isRecord(value) && (value.status === "provider_retry_wait" || value.status === "external_service_waiting");
}

function isCorrectableDecision(value: unknown): value is Record<string, unknown> & { decision: unknown } {
  return isRecord(value) && value.type === "goal_resolution_decision" && value.status === "correctable" && "decision" in value;
}

function isRunningPayload(value: unknown): boolean {
  return isRecord(value) && value.status === "running";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash("sha256").update(JSON.stringify(parts)).digest("base64url")}`;
}
