import type { AgentRole, AssignmentType, EntityStatus, MissionPhase } from "./types.js";

export function roleLabel(role: AgentRole | string): string {
  const labels: Record<string, string> = {
    boss: "老板",
    pm: "产品/项目",
    architect: "架构师",
    dev: "开发",
    qa: "测试",
    specialist: "专家"
  };
  return labels[role] ?? role;
}

export function assignmentLabel(type: AssignmentType | string): string {
  const labels: Record<string, string> = {
    boss_intake: "需求接收",
    pm_plan: "计划拆解",
    architect_plan: "架构设计",
    implementation: "开发执行",
    specialist: "专家处理",
    qa: "质量检查",
    boss_acceptance: "老板验收"
  };
  return labels[type] ?? type;
}

export function phaseLabel(phase: MissionPhase | string): string {
  const labels: Record<string, string> = {
    idle: "空闲",
    intake: "需求接收",
    planning: "计划拆解",
    architecture: "架构设计",
    implementation: "开发执行",
    specialist: "专家处理",
    qa: "质量检查",
    acceptance: "验收",
    boss_intake: "需求接收",
    pm_plan: "计划拆解",
    architect_plan: "架构设计",
    boss_acceptance: "老板验收",
    completed: "已完成",
    failed: "失败",
    paused: "已暂停",
    interrupted: "已停止"
  };
  return labels[phase] ?? phase;
}

export function statusLabel(status: EntityStatus | string): string {
  const labels: Record<string, string> = {
    idle: "空闲",
    waiting: "等你回复",
    running: "运行中",
    completed: "已完成",
    failed: "失败",
    blocked: "受阻",
    paused: "已暂停",
    interrupted: "已停止"
  };
  return labels[status] ?? status;
}

export function capabilityLabels(role: AgentRole | string, capabilities?: string[]): string[] {
  const byRole: Record<string, string[]> = {
    boss: ["需求接收", "验收", "人员调度"],
    pm: ["计划拆解", "范围控制", "交接协作"],
    architect: ["技术方案", "能力缺口判断"],
    dev: ["开发实现", "工具执行", "本地验证"],
    qa: ["测试计划", "质量检查", "验收检查"],
    specialist: ["专项交付"]
  };
  return byRole[role] ?? capabilities?.map((item) => displayText(item) ?? item) ?? [];
}

export function displayText(text: string | undefined): string | undefined {
  if (!text) return text;
  const translatedCapability = text.replaceAll("Security/Auth specialist", "安全/认证");
  const rolePattern = "(Boss|PM|Architect|Dev|QA|Specialist)";

  const joined = translatedCapability.match(new RegExp(`^${rolePattern} joined workspace$`));
  if (joined) return `${legacyRoleLabel(joined[1])}已加入项目`;

  const phase = translatedCapability.match(/^Phase: (.+)$/);
  if (phase) return `进入阶段：${phaseLabel(phase[1])}`;

  const created = translatedCapability.match(/^Created (.+) assignment$/);
  if (created) return `已创建${assignmentLabel(created[1])}任务`;

  const started = translatedCapability.match(new RegExp(`^${rolePattern} started (.+)$`));
  if (started) return `${legacyRoleLabel(started[1])}开始${assignmentLabel(started[2])}`;

  const completed = translatedCapability.match(new RegExp(`^${rolePattern} completed (.+)$`));
  if (completed) return `${legacyRoleLabel(completed[1])}已完成${assignmentLabel(completed[2])}`;

  const status = translatedCapability.match(new RegExp(`^${rolePattern} is (running|waiting|failed)$`));
  if (status) return `${legacyRoleLabel(status[1])}${legacyStatusSuffix(status[2])}`;

  const requested = translatedCapability.match(new RegExp(`^${rolePattern} requested (.+)$`));
  if (requested) return `${legacyRoleLabel(requested[1])}正在调用模型服务：${requested[2]}`;

  const providerCompleted = translatedCapability.match(new RegExp(`^${rolePattern} provider turn completed$`));
  if (providerCompleted) return `${legacyRoleLabel(providerCompleted[1])}的模型调用已完成`;

  const prefixedStep = translatedCapability.match(new RegExp(`^${rolePattern}: (.+)$`));
  if (prefixedStep) return `${legacyRoleLabel(prefixedStep[1])}：${legacyStepLabel(prefixedStep[2])}`;

  if (translatedCapability === "Task run created") return "任务运行已创建";
  if (translatedCapability === "Task completed") return "任务已完成";
  if (translatedCapability === "Task failed") return "任务失败";
  if (translatedCapability === "QA requested implementation changes") return "测试要求开发返工";
  if (translatedCapability.startsWith("Boss requested specialist: ")) return translatedCapability.replace("Boss requested specialist: ", "老板发起专家招聘：");
  if (translatedCapability.startsWith("Boss hired ") && translatedCapability.endsWith(" specialist")) {
    return `老板已招募${translatedCapability.slice("Boss hired ".length, -" specialist".length)}专家`;
  }
  if (translatedCapability.endsWith(" specialist joined workspace")) {
    return `${translatedCapability.slice(0, -" specialist joined workspace".length)}专家已加入项目`;
  }

  return legacyStepLabel(translatedCapability);
}

function legacyRoleLabel(role: string): string {
  const labels: Record<string, string> = {
    Boss: "老板",
    PM: "产品/项目",
    Architect: "架构师",
    Dev: "开发",
    QA: "测试",
    Specialist: "专家"
  };
  return labels[role] ?? roleLabel(role.toLowerCase());
}

function legacyStatusSuffix(status: string): string {
  const labels: Record<string, string> = {
    running: "正在运行",
    waiting: "正在等待",
    failed: "执行失败"
  };
  return labels[status] ?? status;
}

function legacyStepLabel(step: string): string {
  if (step.startsWith("Decide if the goal is actionable: ")) return step.replace("Decide if the goal is actionable: ", "判断需求是否可执行：");
  if (step === "Break the goal into a small execution plan") return "把目标拆成小规模执行计划";
  if (step === "Identify architecture, technical approach, and capability gaps") return "判断架构方案、技术路径和能力缺口";
  if (step === "Implement the planned work and produce a delivery artifact") return "按计划开发并产出交付物";
  if (step === "Verify the implementation and report pass/fail") return "验证实现并给出通过或失败结论";
  if (step === "Accept or reject the completed task") return "验收或驳回已完成任务";
  if (step.startsWith("Address capability gap: ")) return step.replace("Address capability gap: ", "处理能力缺口：");
  return step;
}
