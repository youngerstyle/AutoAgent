import type { AgentDirectMessage, AgentThreadEvent } from "../shared/types";

export type AgentThreadBubbleRole = "human" | "agent" | "platform" | "tool" | "system";

export interface AgentThreadBubble {
  id: string;
  role: AgentThreadBubbleRole;
  title?: string;
  body: string;
}

export interface ChatComposerKeyInput {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
}

export function beginChatSubmission(draft: string): { message: string; nextDraft: string } {
  const message = draft.trim();
  return { message, nextDraft: message ? "" : draft };
}

export function chatComposerKeyAction(input: ChatComposerKeyInput): "submit" | "newline" | "ignore" {
  if (input.key !== "Enter" || input.isComposing) return "ignore";
  return input.shiftKey ? "newline" : "submit";
}

export function scrollChatThreadToLatest(container: Pick<HTMLElement, "scrollTop" | "scrollHeight">): void {
  container.scrollTop = container.scrollHeight;
}

export function buildAgentThreadBubbles(events: AgentThreadEvent[], legacyMessages: AgentDirectMessage[] = []): AgentThreadBubble[] {
  if (events.length === 0) return legacyMessages.flatMap(legacyMessageToBubbles);
  return [...events]
    .sort((a, b) => a.sequence - b.sequence)
    .map(eventToBubble)
    .filter((bubble): bubble is AgentThreadBubble => Boolean(bubble?.body.trim()));
}

export function appendCurrentAgentPrompt(bubbles: AgentThreadBubble[], prompt: string): AgentThreadBubble[] {
  const body = prompt.trim();
  if (!body) return bubbles;
  const latestAgent = [...bubbles].reverse().find((bubble) => bubble.role === "agent");
  if (latestAgent && equivalentMessage(latestAgent.body, body)) return bubbles;
  return [...bubbles, { id: "current-agent-prompt", role: "agent", body }];
}

function eventToBubble(event: AgentThreadEvent): AgentThreadBubble | undefined {
  if (event.kind === "human_message") {
    return { id: event.id, role: "human", body: payloadText(event.payload, "content", "message") };
  }
  if (event.kind === "agent_message") {
    return { id: event.id, role: "agent", body: payloadText(event.payload, "content", "message") };
  }
  if (event.kind === "turn_failed") {
    return { id: event.id, role: "agent", title: "本轮执行失败", body: payloadText(event.payload, "error", "message") };
  }
  if (event.kind === "ticket_claimed") {
    return {
      id: event.id,
      role: "platform",
      title: "开始处理工单",
      body: payloadText(event.payload, "brief", "expectedArtifact", "ticketType")
    };
  }
  if (event.kind === "ticket_outcome") {
    return {
      id: event.id,
      role: "platform",
      title: ticketOutcomeTitle(event.payload),
      body: payloadText(event.payload, "summary", "reason", "result", "status")
    };
  }
  if (event.kind === "ticket_received") {
    return {
      id: event.id,
      role: "platform",
      title: "收到工单",
      body: ticketReceivedBody(event.payload)
    };
  }
  if (event.kind === "tool_observation") {
    return {
      id: event.id,
      role: "tool",
      title: "工具观察",
      body: payloadText(event.payload, "summary", "path", "command", "message")
    };
  }
  if (event.kind === "system_note") {
    const resolution = goalResolutionBubble(event);
    if (resolution) return resolution;
    return { id: event.id, role: "system", title: "系统约束", body: payloadText(event.payload, "content", "message", "summary") };
  }
  return undefined;
}

function goalResolutionBubble(event: AgentThreadEvent): AgentThreadBubble | undefined {
  if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return undefined;
  const payload = event.payload as Record<string, unknown>;
  if (payload.name !== "goal_resolution" || !payload.arguments || typeof payload.arguments !== "object" || Array.isArray(payload.arguments)) return undefined;
  const args = payload.arguments as Record<string, unknown>;
  const outcome = args.domainOutcome && typeof args.domainOutcome === "object" && !Array.isArray(args.domainOutcome)
    ? args.domainOutcome as Record<string, unknown>
    : undefined;
  const requiredInput = typeof outcome?.requiredInput === "string"
    ? outcome.requiredInput
    : Array.isArray(outcome?.requiredInput)
      ? outcome.requiredInput.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).join("；")
      : undefined;
  const body = [
    typeof args.summary === "string" ? args.summary : undefined,
    typeof outcome?.summary === "string" ? outcome.summary : undefined,
    requiredInput ? `需要：${requiredInput}` : undefined,
  ].filter((item): item is string => Boolean(item?.trim())).filter((item, index, items) => items.indexOf(item) === index).join("\n\n");
  if (!body) return undefined;
  return {
    id: event.id,
    role: "agent",
    title: args.status === "blocked" ? "为什么停下来" : "处理结论",
    body,
  };
}

function ticketReceivedBody(payload: unknown): string {
  const objective = readString(payload, "brief") ?? "收到新的工作目标";
  const expectedArtifact = readString(payload, "expectedArtifact") ?? readString(payload, "ticketType");
  const record = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : undefined;
  const criteria = Array.isArray(record?.successCriteria)
    ? record.successCriteria.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    : [];
  return [
    objective,
    criteria.length ? `成功标准：\n${criteria.map((item) => `- ${item}`).join("\n")}` : undefined,
    expectedArtifact ? `交付格式：${expectedArtifact}` : undefined,
  ].filter((item): item is string => Boolean(item)).join("\n\n");
}

function equivalentMessage(left: string, right: string): boolean {
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
  const a = normalize(left);
  const b = normalize(right);
  return a === b || a.includes(b) || b.includes(a);
}

function legacyMessageToBubbles(message: AgentDirectMessage): AgentThreadBubble[] {
  const bubbles: AgentThreadBubble[] = [{ id: message.id, role: "human", body: message.message }];
  if (message.response) bubbles.push({ id: `${message.id}:response`, role: "agent", body: message.response });
  if (message.error) bubbles.push({ id: `${message.id}:error`, role: "agent", title: "本轮执行失败", body: message.error });
  return bubbles;
}

function ticketOutcomeTitle(payload: unknown): string {
  const status = readString(payload, "status");
  if (status === "acked") return "工单处理完成";
  if (status === "yielded") return "暂时让出工单";
  if (status === "blocked") return "工单受阻";
  return "工单状态更新";
}

function payloadText(payload: unknown, ...keys: string[]): string {
  const parts = keys
    .map((key) => readPayloadValue(payload, key))
    .filter((value): value is string => Boolean(value?.trim()));
  return [...new Set(parts)].join("\n");
}

function readPayloadValue(payload: unknown, key: string): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const value = (payload as Record<string, unknown>)[key];
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value && typeof value === "object") return readableNestedText(value);
  return undefined;
}

function readString(payload: unknown, key: string): string | undefined {
  const value = readPayloadValue(payload, key);
  return value?.trim();
}

function readableNestedText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(readableNestedText).filter(Boolean).join("\n");
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  return ["summary", "reason", "message", "artifact", "expectedArtifact", "status"]
    .map((key) => record[key])
    .map(readableNestedText)
    .filter(Boolean)
    .join("\n");
}
