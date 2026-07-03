import { assignmentLabel, displayText, phaseLabel, statusLabel } from "../shared/labels";
import type { AssignmentType, AutoAgentEvent, EntityStatus, MissionPhase, ProviderName } from "../shared/types";

export interface EventTimelineItem {
  actor: string;
  title: string;
  detail?: string;
  tone: "neutral" | "running" | "success" | "warning" | "danger";
  debugType: AutoAgentEvent["type"];
}

export interface EventTimelineGroup {
  id: string;
  actor: string;
  phase: string;
  title: string;
  summary: string;
  tone: EventTimelineItem["tone"];
  events: AutoAgentEvent[];
}

export function buildVisibleTimelineEvents(events: AutoAgentEvent[]): AutoAgentEvent[] {
  const assignmentBlockers = new Set(
    events
      .filter((event) => event.type === "assignment.blocked")
      .map(blockerReason)
      .filter((reason): reason is string => Boolean(reason))
  );
  if (assignmentBlockers.size === 0) return events;

  return events.filter((event) => {
    if (event.type !== "run.blocked") return true;
    const reason = blockerReason(event);
    return !reason || !assignmentBlockers.has(reason);
  });
}

export function buildEventTimelineGroups(events: AutoAgentEvent[]): EventTimelineGroup[] {
  const groups: EventTimelineGroup[] = [];
  let currentPhase = "任务流";

  for (const event of events) {
    const item = buildEventTimelineItem(event);
    const phase = phaseForTimelineEvent(event, item) ?? currentPhase;
    if (event.type === "task.phase_changed") currentPhase = phase;
    const actor = actorForTimelineGroup(event, item, groups.at(-1));
    const key = `${actor}::${phase}`;
    const previous = groups.at(-1);
    if (previous && `${previous.actor}::${previous.phase}` === key && !startsNewTimelineGroup(event)) {
      previous.events.push(event);
      previous.tone = strongerTone(previous.tone, item.tone);
      previous.summary = timelineGroupSummary(previous.events);
    } else {
      groups.push({
        id: `${event.id}_group`,
        actor,
        phase,
        title: `${actor} · ${phase}`,
        summary: timelineGroupSummary([event]),
        tone: item.tone,
        events: [event]
      });
    }
  }

  return groups;
}

export function buildEventTimelineItem(event: AutoAgentEvent): EventTimelineItem {
  if (event.type === "provider.started") {
    const provider = providerLabel(stringPayload(event, "provider"));
    const model = stringPayload(event, "model");
    return {
      actor: actorFromSummary(event.summary),
      title: "正在调用模型",
      detail: [provider, model].filter(Boolean).join(" · ") || displayText(event.summary),
      tone: "running",
      debugType: event.type
    };
  }

  if (event.type === "provider.completed") {
    return item(event, actorFromSummary(event.summary), "模型调用已完成", undefined, "success");
  }

  if (event.type === "provider.failed") {
    return item(event, actorFromSummary(event.summary), "模型调用失败", displayText(event.summary), "danger");
  }

  if (event.type === "agent.step_started") {
    return item(event, actorFromSummary(event.summary), "开始执行", stepDetail(event), "running");
  }

  if (event.type === "agent.step_completed") {
    return item(event, actorFromSummary(event.summary), "步骤结束", stepDetail(event), "neutral");
  }

  if (event.type === "agent.status_changed") {
    return item(event, actorFromSummary(event.summary), statusFromSummary(event.summary), undefined, toneForStatus(event.summary));
  }

  if (event.type === "task.phase_changed") {
    const phase = stringPayload(event, "phase") as MissionPhase | undefined;
    return item(event, "任务阶段", phase ? `进入${phaseLabel(phase)}` : displayText(event.summary) ?? event.summary, undefined, "running");
  }

  if (event.type === "human.followup") {
    const resumePhase = stringPayload(event, "resumePhase") as MissionPhase | undefined;
    return item(event, "human", "补充说明", resumePhase ? `继续到${phaseLabel(resumePhase)}` : followupDetail(event), "running");
  }

  if (event.type === "assignment.created") {
    const assignmentType = nestedStringPayload(event, "assignment", "type") as AssignmentType | undefined;
    const assignment = assignmentType ? assignmentLabel(assignmentType) : assignmentLabelFromSummary(event.summary);
    return item(event, actorForAssignment(assignmentType, event.summary), displayText(event.summary) ?? `已创建${assignment}任务`, `准备进入${assignment}`, "neutral");
  }

  if (event.type === "assignment.started") {
    const assignmentType = nestedStringPayload(event, "assignment", "type") as AssignmentType | undefined;
    return item(event, actorForAssignment(assignmentType, event.summary), "开始执行任务", displayText(event.summary), "running");
  }

  if (event.type === "assignment.completed") {
    const assignmentType = nestedStringPayload(event, "assignment", "type") as AssignmentType | undefined;
    const assignment = assignmentType ? assignmentLabel(assignmentType) : assignmentLabelFromSummary(event.summary);
    return item(event, actorForAssignment(assignmentType, event.summary), `${assignment}阶段结束`, "这只是阶段记录，不代表项目已交付", "neutral");
  }

  if (event.type === "assignment.blocked" || event.type === "run.blocked") {
    const blocker = blockedEventView(event);
    return item(event, blocker.actor, blocker.title, blocker.detail, "warning");
  }

  if (event.type === "assignment.failed" || event.type === "run.failed" || event.type === "qa.failed") {
    return item(event, actorFromSummary(event.summary) || "任务", displayText(event.summary) ?? event.summary, undefined, "danger");
  }

  if (event.type === "run.completed") {
    return item(event, "任务", "已完成", undefined, "success");
  }

  if (event.type === "tool.started" || event.type === "tool.completed" || event.type === "tool.failed" || event.type === "tool.denied") {
    return item(event, "工具", displayText(event.summary) ?? event.summary, undefined, event.type === "tool.completed" ? "success" : event.type === "tool.started" ? "running" : "warning");
  }

  if (event.type.startsWith("recruitment.")) {
    return item(event, "招聘", displayText(event.summary) ?? event.summary, undefined, event.type === "recruitment.failed" ? "danger" : "neutral");
  }

  return item(event, actorFromSummary(event.summary) || "系统", displayText(event.summary) ?? event.summary, undefined, "neutral");
}

function actorForTimelineGroup(event: AutoAgentEvent, item: EventTimelineItem, previous?: EventTimelineGroup): string {
  const phase = stringPayload(event, "phase") as MissionPhase | undefined;
  if (event.type === "task.phase_changed" && phase) return actorForPhase(phase);
  if (item.actor === "工具" && previous) return previous.actor;
  if ((event.type === "provider.completed" || event.type === "tool.started" || event.type === "tool.completed" || event.type === "tool.denied" || event.type === "tool.failed") && previous) {
    return item.actor === "工具" || !item.actor ? previous.actor : item.actor;
  }
  return item.actor || previous?.actor || "系统";
}

function phaseForTimelineEvent(event: AutoAgentEvent, item: EventTimelineItem): string | undefined {
  const phase = stringPayload(event, "phase") as MissionPhase | undefined;
  if (phase) return phaseLabel(phase);
  const assignmentType = nestedStringPayload(event, "assignment", "type") as AssignmentType | undefined;
  if (assignmentType) return assignmentLabel(assignmentType);
  if (item.actor === "任务阶段") return item.title.replace(/^进入/, "") || "任务流";
  if (event.type === "run.completed") return "任务完成";
  if (event.type === "human.followup") return "人工补充";
  if (event.type.startsWith("recruitment.")) return "专家招聘";
  return undefined;
}

function startsNewTimelineGroup(event: AutoAgentEvent): boolean {
  return event.type === "task.phase_changed"
    || event.type === "human.followup"
    || event.type === "run.completed"
    || event.type.startsWith("recruitment.");
}

function timelineGroupSummary(events: AutoAgentEvent[]): string {
  const items = events.map(buildEventTimelineItem);
  const modelTurns = events.filter((event) => event.type === "provider.started").length;
  const toolTurns = events.filter((event) => event.type.startsWith("tool.")).length;
  const blocker = items.find((item) => item.tone === "warning" || item.tone === "danger");
  const latest = items.at(-1);
  const parts = [
    `${events.length} 条记录`,
    modelTurns > 0 ? `模型 ${modelTurns} 次` : undefined,
    toolTurns > 0 ? `工具 ${toolTurns} 次` : undefined,
    blocker ? `关注：${blocker.title}` : latest ? `最新：${latest.title}` : undefined
  ];
  return parts.filter(Boolean).join(" · ");
}

function strongerTone(left: EventTimelineItem["tone"], right: EventTimelineItem["tone"]): EventTimelineItem["tone"] {
  const rank: Record<EventTimelineItem["tone"], number> = {
    neutral: 0,
    success: 1,
    running: 2,
    warning: 3,
    danger: 4
  };
  return rank[right] > rank[left] ? right : left;
}

function item(event: AutoAgentEvent, actor: string, title: string, detail: string | undefined, tone: EventTimelineItem["tone"]): EventTimelineItem {
  return {
    actor,
    title,
    detail,
    tone,
    debugType: event.type
  };
}

function blockerReason(event: AutoAgentEvent): string | undefined {
  const reason = stringPayload(event, "reason");
  if (reason) return normalizeBlocker(reason);
  return normalizeBlocker(event.summary);
}

function normalizeBlocker(value: string): string | undefined {
  const normalized = value
    .replace(/^任务受阻[:：]\s*/, "")
    .replace(/^(需求接收|计划拆解|架构设计|开发执行|质量检查|老板验收|专家交付|任务)受阻[:：]\s*/, "")
    .trim();
  return normalized || undefined;
}

function blockedEventView(event: AutoAgentEvent): { actor: string; title: string; detail?: string } {
  const label = blockedLabelFromEvent(event);
  const reason = stringPayload(event, "reason") ?? reasonFromBlockedSummary(event.summary);
  const structured = reason ? structuredBlockerView(reason) : undefined;
  if (structured) {
    return {
      actor: actorFromBlockedLabel(label),
      title: `${label}：${structured.title}`,
      detail: structured.detail
    };
  }
  return {
    actor: actorFromBlockedLabel(label) || actorFromSummary(event.summary) || "任务",
    title: displayText(event.summary) ?? event.summary
  };
}

function blockedLabelFromEvent(event: AutoAgentEvent): string {
  const phase = stringPayload(event, "phase") as MissionPhase | undefined;
  if (phase) return phaseLabel(phase);
  const summary = displayText(event.summary) ?? event.summary;
  const runMatch = summary.match(/^任务受阻[:：]\s*(.+?受阻)[:：]/);
  if (runMatch?.[1]) return runMatch[1];
  const match = summary.match(/^(.+?受阻)[:：]/);
  if (match?.[1]) return match[1];
  if (summary.includes("需求接收")) return "需求接收";
  if (summary.includes("计划拆解")) return "计划拆解";
  if (summary.includes("架构设计")) return "架构设计";
  if (summary.includes("开发执行")) return "开发执行";
  if (summary.includes("质量检查")) return "质量检查";
  if (summary.includes("老板验收")) return "老板验收";
  return "任务受阻";
}

function actorFromBlockedLabel(label: string): string {
  const phase = label.replace(/受阻$/, "");
  const labels: Record<string, string> = {
    需求接收: "老板",
    计划拆解: "产品/项目",
    架构设计: "架构师",
    开发执行: "开发",
    质量检查: "测试",
    老板验收: "老板",
    专家交付: "专家",
    任务: "任务"
  };
  return labels[phase] ?? phase;
}

function reasonFromBlockedSummary(summary: string): string | undefined {
  const readable = displayText(summary) ?? summary;
  const match = readable.match(/受阻[:：]\s*(.+)$/s);
  if (!match?.[1]) return undefined;
  return match[1].replace(/^.+?受阻[:：]\s*/s, "").trim();
}

function structuredBlockerView(reason: string): { title: string; detail?: string } | undefined {
  const manualPrefix = "需要人工测试";
  const normalized = reason.trim();
  if (normalized.startsWith(`${manualPrefix}：`) || normalized.startsWith(`${manualPrefix}:`)) {
    const jsonText = normalized.slice(manualPrefix.length + 1).trim();
    const parsed = parseJsonRecord(jsonText);
    const summary = reportSummary(parsed);
    return {
      title: manualPrefix,
      detail: summary
    };
  }
  const parsed = parseJsonRecord(normalized);
  if (!parsed) return undefined;
  const status = typeof parsed.status === "string" ? parsed.status : undefined;
  return {
    title: status === "manual_test_required" ? manualPrefix : statusLabelText(status) ?? "需要处理",
    detail: reportSummary(parsed)
  };
}

function parseJsonRecord(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Boolean(parsed) && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function reportSummary(parsed: Record<string, unknown> | undefined): string | undefined {
  if (!parsed) return undefined;
  const report = parsed.report;
  if (report && typeof report === "object" && !Array.isArray(report)) {
    const summary = (report as Record<string, unknown>).summary;
    if (typeof summary === "string" && summary.trim()) return summary.trim();
  }
  const reason = parsed.reason;
  if (typeof reason === "string" && reason.trim()) return reason.trim();
  return undefined;
}

function statusLabelText(status: string | undefined): string | undefined {
  if (!status) return undefined;
  const labels: Record<string, string> = {
    manual_test_required: "需要人工测试",
    blocked: "需要处理",
    fail: "未通过",
    failed: "失败"
  };
  return labels[status] ?? status;
}

function stringPayload(event: AutoAgentEvent, key: string): string | undefined {
  const value = event.payload[key];
  return typeof value === "string" ? value : undefined;
}

function nestedStringPayload(event: AutoAgentEvent, objectKey: string, key: string): string | undefined {
  const value = event.payload[objectKey];
  if (!value || typeof value !== "object") return undefined;
  const nested = (value as Record<string, unknown>)[key];
  return typeof nested === "string" ? nested : undefined;
}

function stepDetail(event: AutoAgentEvent): string | undefined {
  const step = stringPayload(event, "step");
  if (step) return displayText(step) ?? step;
  const parts = event.summary.split(/[:：]/);
  return parts.length > 1 ? displayText(parts.slice(1).join("：").trim()) : displayText(event.summary);
}

function followupDetail(event: AutoAgentEvent): string | undefined {
  const message = stringPayload(event, "message");
  if (!message) return undefined;
  return message.length > 60 ? `${message.slice(0, 60)}...` : message;
}

function actorFromSummary(summary: string): string {
  const readable = displayText(summary) ?? summary;
  const providerActor = readable.match(/^(.+?)的模型调用/);
  if (providerActor) return actorLabel(providerActor[1].trim());
  const match = readable.match(/^(.+?)(?:正在|开始|已完成|执行失败|：|:)/);
  return match ? actorLabel(match[1].trim()) : "";
}

function statusFromSummary(summary: string): string {
  if (summary.includes("正在运行")) return "运行中";
  if (summary.includes("正在等待")) return "等待中";
  if (summary.includes("执行失败")) return "执行失败";
  return displayText(summary) ?? summary;
}

function toneForStatus(summary: string): EventTimelineItem["tone"] {
  if (summary.includes("正在运行")) return "running";
  if (summary.includes("执行失败")) return "danger";
  return "neutral";
}

function actorForAssignment(type: AssignmentType | undefined, summary: string): string {
  const labels: Partial<Record<AssignmentType, string>> = {
    boss_intake: "老板",
    pm_plan: "产品/项目",
    architect_plan: "架构师",
    implementation: "开发",
    qa: "测试",
    boss_acceptance: "老板",
    specialist: "专家"
  };
  return type ? labels[type] ?? "任务" : actorFromSummary(summary) || "任务";
}

function actorForPhase(phase: MissionPhase): string {
  const labels: Partial<Record<MissionPhase, string>> = {
    boss_intake: "老板",
    pm_plan: "产品/项目",
    architect_plan: "架构师",
    implementation: "开发",
    qa: "测试",
    boss_acceptance: "老板",
    completed: "任务",
    failed: "任务",
    idle: "任务",
    interrupted: "任务",
    paused: "任务"
  };
  return labels[phase] ?? "任务";
}

function assignmentLabelFromSummary(summary: string): string {
  const match = summary.match(/已创建(.+)任务/);
  if (match?.[1]) return match[1];
  if (summary.includes("需求接收")) return "需求接收";
  if (summary.includes("计划拆解")) return "计划拆解";
  if (summary.includes("架构设计")) return "架构设计";
  if (summary.includes("开发执行")) return "开发执行";
  if (summary.includes("质量检查")) return "质量检查";
  if (summary.includes("老板验收")) return "老板验收";
  return "任务";
}

function providerLabel(provider?: string): string | undefined {
  const labels: Record<ProviderName | "mock", string> = {
    mock: "模拟服务",
    openai: "OpenAI",
    anthropic: "Anthropic"
  };
  if (!provider) return undefined;
  return labels[provider as ProviderName] ?? provider;
}

function actorLabel(actor: string): string {
  const labels: Record<string, string> = {
    Boss: "老板",
    PM: "产品/项目",
    Architect: "架构师",
    Dev: "开发",
    QA: "测试",
    Specialist: "专家"
  };
  return labels[actor] ?? actor;
}
