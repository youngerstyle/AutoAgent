import { assignmentLabel, displayText, phaseLabel, statusLabel } from "../shared/labels";
import type { AssignmentType, AutoAgentEvent, EntityStatus, MissionPhase, ProviderName } from "../shared/types";

export interface EventTimelineItem {
  actor: string;
  title: string;
  detail?: string;
  tone: "neutral" | "running" | "success" | "warning" | "danger";
  debugType: AutoAgentEvent["type"];
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
    return item(event, actorFromSummary(event.summary) || "任务", displayText(event.summary) ?? event.summary, undefined, "warning");
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

function item(event: AutoAgentEvent, actor: string, title: string, detail: string | undefined, tone: EventTimelineItem["tone"]): EventTimelineItem {
  return {
    actor,
    title,
    detail,
    tone,
    debugType: event.type
  };
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
