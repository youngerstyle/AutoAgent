import type { AgentDirectMessage, AgentThreadEvent } from "../shared/types";
import type { AgentMessageAttachment } from "../shared/contracts/agent-engine";

export type AgentThreadBubbleRole = "human" | "agent" | "platform" | "tool" | "system";

export interface AgentThreadBubble {
  id: string;
  role: AgentThreadBubbleRole;
  title?: string;
  collapsed?: boolean;
  summary?: string;
  body: string;
  attachments?: AgentMessageAttachment[];
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
  if (events.length === 0) return collapseInternalRuns(legacyMessages.flatMap(legacyMessageToBubbles));
  const bubbles = [...events]
    .sort((a, b) => a.sequence - b.sequence)
    .flatMap(eventToBubbles)
    .filter((bubble) => Boolean(bubble.body.trim() || bubble.attachments?.length));
  return collapseInternalRuns(bubbles);
}

export function appendCurrentAgentPrompt(bubbles: AgentThreadBubble[], prompt: string): AgentThreadBubble[] {
  const body = prompt.trim();
  if (!body) return bubbles;
  const latestAgent = [...bubbles].reverse().find((bubble) => bubble.role === "agent");
  if (latestAgent && equivalentMessage(latestAgent.body, body)) return bubbles;
  return [...bubbles, { id: "current-agent-prompt", role: "agent", body }];
}

function eventToBubbles(event: AgentThreadEvent): AgentThreadBubble[] {
  if (event.kind === "human_message") {
    return [{ id: event.id, role: "human", body: payloadText(event.payload, "content", "message"), attachments: payloadAttachments(event.payload) }];
  }
  if (event.kind === "agent_message") {
    return agentMessageBubbles(event);
  }
  if (event.kind === "turn_failed") {
    return [{ id: event.id, role: "agent", title: "本轮执行失败", body: payloadText(event.payload, "error", "message") }];
  }
  if (event.kind === "ticket_claimed") {
    return [{
      id: event.id,
      role: "system",
      title: "开始处理工单",
      collapsed: true,
      summary: "Agent 已领取工作，执行过程可按需查看",
      body: payloadText(event.payload, "brief", "expectedArtifact", "ticketType")
    }];
  }
  if (event.kind === "ticket_outcome") {
    return [{
      id: event.id,
      role: "platform",
      title: ticketOutcomeTitle(event.payload),
      body: payloadText(event.payload, "summary", "reason", "result", "status")
    }];
  }
  if (event.kind === "ticket_received") {
    return [{
      id: event.id,
      role: "platform",
      title: "收到工单",
      body: ticketReceivedBody(event.payload)
    }];
  }
  if (event.kind === "tool_observation") {
    return [{
      id: event.id,
      role: "tool",
      title: "工具活动",
      collapsed: true,
      summary: toolObservationSummary(event.payload),
      body: payloadText(event.payload, "summary", "name", "path", "command", "message", "content")
    }];
  }
  if (event.kind === "system_note") {
    const providerWait = providerWaitBubble(event);
    if (providerWait) return [providerWait];
    const resolution = goalResolutionBubble(event);
    if (resolution) return [resolution];
    return [{
      id: event.id,
      role: "system",
      title: "Agent 工作规则",
      collapsed: true,
      summary: "平台提供给 Agent 的内部规则，通常无需处理",
      body: payloadText(event.payload, "content", "message", "summary"),
    }];
  }
  return [];
}

function agentMessageBubbles(event: AgentThreadEvent): AgentThreadBubble[] {
  const content = payloadText(event.payload, "content", "message");
  return contentToAgentBubbles(event.id, content);
}

function contentToAgentBubbles(id: string, content: string): AgentThreadBubble[] {
  const { reasoning, answer } = splitReasoningFromAnswer(content);
  const bubbles: AgentThreadBubble[] = reasoning.map((body, index) => ({
    id: `${id}:reasoning:${index}`,
    role: "system",
    title: "处理过程",
    collapsed: true,
    summary: reasoningSummary(body),
    body,
  }));
  if (answer) bubbles.push({ id, role: "agent", body: answer });
  return bubbles;
}

export function splitReasoningFromAnswer(content: string): { reasoning: string[]; answer: string } {
  const reasoning: string[] = [];
  const answer = content
    .replace(/<thinking>([\s\S]*?)<\/thinking>/gi, (_match, body: string) => {
      const normalized = normalizeReasoning(body);
      if (normalized) reasoning.push(normalized);
      return "";
    })
    .replace(/<\/?thinking>/gi, "")
    .trim();
  return { reasoning, answer };
}

function normalizeReasoning(value: string): string {
  return value
    .replace(/^\s*\*\*|\*\*\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function reasoningSummary(value: string): string {
  const normalized = normalizeReasoning(value);
  if (!normalized) return "Agent 的内部处理过程";
  return normalized.length > 72 ? `${normalized.slice(0, 72)}…` : normalized;
}

function toolObservationSummary(payload: unknown): string {
  const record = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : undefined;
  const name = typeof record?.name === "string" ? record.name.trim() : "";
  const path = typeof record?.path === "string" ? record.path.trim() : "";
  const command = typeof record?.command === "string" ? record.command.trim() : "";
  if (name) return `已完成 ${name}`;
  if (path) return `已处理 ${path}`;
  if (command) return command.length > 72 ? `${command.slice(0, 72)}…` : command;
  return "工具调用与返回结果";
}

function collapseInternalRuns(bubbles: AgentThreadBubble[]): AgentThreadBubble[] {
  const result: AgentThreadBubble[] = [];
  let pending: AgentThreadBubble[] = [];
  const flush = () => {
    if (pending.length === 0) return;
    if (pending.length === 1) {
      result.push(pending[0]);
    } else {
      result.push({
        id: `${pending[0].id}:group`,
        role: "system",
        title: "运行细节",
        collapsed: true,
        summary: `${pending.length} 条内部记录 · 思考、工具与系统信息`,
        body: pending.map((bubble) => `${bubble.title ?? "记录"}\n${bubble.body}`).join("\n\n"),
      });
    }
    pending = [];
  };
  for (const bubble of bubbles) {
    if (bubble.collapsed) {
      pending.push(bubble);
      continue;
    }
    flush();
    result.push(bubble);
  }
  flush();
  return result;
}

function providerWaitBubble(event: AgentThreadEvent): AgentThreadBubble | undefined {
  if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return undefined;
  const payload = event.payload as Record<string, unknown>;
  if (payload.status !== "external_service_waiting" && payload.status !== "provider_retry_wait") return undefined;
  const retryAt = typeof payload.retryAt === "string" ? new Date(payload.retryAt) : undefined;
  const retryCopy = retryAt && !Number.isNaN(retryAt.getTime())
    ? `系统将在 ${retryAt.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })} 自动重试。`
    : "系统会自动重试。";
  return {
    id: event.id,
    role: "platform",
    title: "模型服务暂时不可用",
    body: `当前工单和 Agent 进度均已保存，不需要人工操作，也不会推进到下一张工单。${retryCopy}`,
  };
}

function payloadAttachments(payload: unknown): AgentMessageAttachment[] {
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as Record<string, unknown>).attachments)) return [];
  return ((payload as Record<string, unknown>).attachments as unknown[]).filter((value): value is AgentMessageAttachment => {
    if (!value || typeof value !== "object") return false;
    const item = value as Record<string, unknown>;
    return item.type === "image" && typeof item.attachmentId === "string" && typeof item.mimeType === "string";
  });
}

function goalResolutionBubble(event: AgentThreadEvent): AgentThreadBubble | undefined {
  if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return undefined;
  const payload = event.payload as Record<string, unknown>;
  if (payload.name === "request_human_input" && payload.arguments && typeof payload.arguments === "object" && !Array.isArray(payload.arguments)) {
    const args = payload.arguments as Record<string, unknown>;
    const description = typeof args.description === "string" ? args.description.trim() : "";
    if (!description) return undefined;
    return { id: event.id, role: "agent", title: "为什么停下来", body: description };
  }
  if (payload.name !== "goal_resolution" || !payload.arguments || typeof payload.arguments !== "object" || Array.isArray(payload.arguments)) return undefined;
  const args = payload.arguments as Record<string, unknown>;
  const outcome = args.domainOutcome && typeof args.domainOutcome === "object" && !Array.isArray(args.domainOutcome)
    ? args.domainOutcome as Record<string, unknown>
    : undefined;
  const body = [
    typeof args.summary === "string" ? args.summary : undefined,
    typeof outcome?.summary === "string" ? outcome.summary : undefined,
  ].filter((item): item is string => Boolean(item?.trim())).filter((item, index, items) => items.indexOf(item) === index).join("\n\n");
  if (!body) return undefined;
  return {
    id: event.id,
    role: "agent",
    title: "处理结论",
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
  if (message.response) bubbles.push(...contentToAgentBubbles(`${message.id}:response`, message.response));
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
