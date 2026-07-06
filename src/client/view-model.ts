import type { AgentInboxMessage, AgentPolicy, AgentProfile, ProviderName, Ticket, WorkspaceAgent, WorkspaceSnapshot } from "../shared/types";
import { assignmentLabel, capabilityLabels, displayText, roleLabel, statusLabel } from "../shared/labels";

export interface AgentNodeView {
  id: string;
  label: string;
  role: string;
  status: string;
  currentStep?: string;
  currentStepTitle?: string;
  x: number;
  y: number;
  active: boolean;
  needsAttention: boolean;
}

export interface AgentProfileView {
  id: string;
  role: string;
  status: string;
  statusLabel: string;
  identity: {
    title: string;
    subtitle: string;
    avatar: string;
    scope: string;
  };
  soul: string;
  agentMd: string;
  toolGroups: Array<{
    label: string;
    enabled: boolean;
    description: string;
  }>;
  model: {
    provider: ProviderName | "mock";
    providerLabel: string;
    modelName: string;
  };
  memory: {
    sessionLabel: string;
    workspaceLabel: string;
    statePath: string;
  };
  capabilities: string[];
  currentStep?: string;
  policy: AgentPolicyView;
}

export type AgentPolicyView = Required<Pick<AgentPolicy, "canReadWorkspace" | "canWriteWorkspace" | "canExecuteCommands" | "allowHostAccess">>;

export interface HumanFlowPromptView {
  title: string;
  agentId?: string;
  waiter: string;
  phase: string;
  transcript: string;
  inputLabel: string;
  placeholder: string;
  submitLabel: string;
  suggestion: string;
  manualTest?: ManualTestActionView;
}

export interface ManualTestActionView {
  summary: string;
  testFile?: string;
  steps: string[];
  expectedResult?: string;
  passMessage: string;
  failMessage: string;
}

export interface TicketAgentMessageView {
  speaker: string;
  title: string;
  statusLabel: string;
  meta: string;
  workOrderDetail: string;
}

const ROLE_ORDER = ["boss", "pm", "architect", "dev", "specialist", "qa"];
const ROLE_POSITIONS: Record<string, { x: number; y: number }> = {
  boss: { x: 50, y: 12 },
  pm: { x: 28, y: 36 },
  architect: { x: 72, y: 36 },
  dev: { x: 20, y: 68 },
  specialist: { x: 50, y: 68 },
  qa: { x: 80, y: 68 }
};

export function buildAgentNodes(snapshot?: WorkspaceSnapshot): AgentNodeView[] {
  if (!snapshot) return [];
  const problemAgentId = snapshot.status === "blocked" ? blockedAgentProblem(snapshot)?.agentId : undefined;
  return snapshot.agents
    .slice()
    .sort((a, b) => ROLE_ORDER.indexOf(a.roleInWorkspace) - ROLE_ORDER.indexOf(b.roleInWorkspace))
    .map((agent, index) => {
      const base = ROLE_POSITIONS[agent.roleInWorkspace] ?? { x: 18 + index * 14, y: 52 };
      const specialistOffset = agent.roleInWorkspace === "specialist" ? Math.max(0, index - ROLE_ORDER.indexOf("specialist")) * 4 : 0;
      const currentStep = displayText(agent.currentStep);
      return {
        id: agent.id,
        label: roleLabel(agent.roleInWorkspace),
        role: agent.roleInWorkspace,
        status: agent.status,
        currentStep: canvasStepLabel(currentStep),
        currentStepTitle: currentStep,
        x: Math.min(base.x + specialistOffset, 88),
        y: base.y,
        active: agent.status === "running" || Boolean(currentStep),
        needsAttention: Boolean(problemAgentId && problemAgentId === agent.id)
      };
    });
}

function canvasStepLabel(step?: string): string | undefined {
  if (!step) return undefined;
  const normalized = step.replace(/\s+/g, " ").trim();
  const maxLength = 13;
  const clipped = normalized.slice(0, maxLength).replace(/[，。；、,.;:：\s]+$/u, "");
  return normalized.length > maxLength ? `${clipped}...` : normalized;
}

export function buildAgentProfiles(snapshot?: WorkspaceSnapshot, profileDefs: AgentProfile[] = []): AgentProfileView[] {
  if (!snapshot) return [];
  const profilesById = new Map(profileDefs.map((profile) => [profile.id, profile]));
  return snapshot.agents
    .slice()
    .sort((a, b) => ROLE_ORDER.indexOf(a.roleInWorkspace) - ROLE_ORDER.indexOf(b.roleInWorkspace))
    .map((agent) => agentProfile(agent, profilesById.get(agent.profileId)));
}

export function buildAgentCatalogProfiles(profileDefs: AgentProfile[]): AgentProfileView[] {
  return profileDefs
    .slice()
    .sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role))
    .map((profile) => agentProfile({
      id: profile.id,
      workspaceId: "global",
      profileId: profile.id,
      roleInWorkspace: profile.role,
      agentDir: "",
      status: "idle",
      provider: profile.defaultProvider,
      model: profile.defaultModel,
      policyOverride: profile.defaultPolicy,
      name: profile.name,
      capabilities: profile.capabilities
    }, profile));
}

export function taskControlMode(snapshot?: WorkspaceSnapshot): "empty" | "running" | "paused" | "blocked" | "terminal" {
  if (!snapshot?.activeTask) return "empty";
  if (snapshot.status === "paused") return "paused";
  if (snapshot.status === "blocked") return "blocked";
  if (snapshot.status === "completed" || snapshot.status === "failed" || snapshot.status === "interrupted") return "terminal";
  return "running";
}

export function buildBlockedPanelCopy(snapshot?: WorkspaceSnapshot): { title: string; hint: string } {
  const ticket = latestBlockedTicket(snapshot);
  const label = ticket ? ticketLabel(ticket) : "任务";
  if (ticket?.blocker?.type === "manual_test_required") {
    return {
      title: "任务控制",
      hint: "这里是全局任务控制区。人工测试请点击带感叹号的测试 Agent，在底部对话中处理；这里只用于给整个团队补充说明、继续或停止任务。"
    };
  }
  if (ticket?.blocker?.type === "human_authorization_required") {
    return {
      title: "任务已暂停在授权边界",
      hint: "只有授权、权限或安全边界会暂停任务。普通 Agent 问题会自动返工、招聘或失败归因。"
    };
  }
  if (ticket?.blocker?.type === "tool_policy_blocked") {
    return {
      title: `${label}被权限策略阻塞`,
      hint: "当前工单触碰了工具、权限或安全策略，需要你明确授权或调整项目策略。"
    };
  }
  return {
    title: `${label}已阻塞`,
    hint: "当前工单没有被识别为人工授权或人工测试边界。"
  };
}

export function buildManualTestAction(ticket: Ticket): ManualTestActionView | undefined {
  if (ticket.status !== "blocked" || ticket.blocker?.type !== "manual_test_required") return undefined;
  const parsed = parseBlockerJson(ticket.blocker.reason);
  const report = isRecord(parsed?.report) ? parsed.report : isRecord(parsed) ? parsed : undefined;
  const summary = stringValue(report?.summary) ?? "QA 静态检查已完成，但当前 Agent 没有浏览器交互能力，需要你人工测试。";
  const testFile = stringValue(report?.test_file) ?? stringValue(report?.testFile) ?? stringValue(report?.target);
  const steps = stringArray(report?.test_steps)
    ?? stringArray(report?.manual_test_steps)
    ?? stringArray(report?.steps)
    ?? [];
  const expectedResult = stringValue(report?.expected_result) ?? stringValue(report?.expectedResult) ?? stringValue(report?.conclusion_boundary);
  return {
    summary,
    testFile,
    steps,
    expectedResult,
    passMessage: "我已按 QA 给出的人工测试步骤验证通过，可以进入老板验收。",
    failMessage: "人工测试未通过，请开发根据 QA 测试步骤和失败现象继续返工。"
  };
}

export function buildTicketAgentMessage(ticket: Ticket, message?: AgentInboxMessage): TicketAgentMessageView {
  const speaker = ticket.targetRole ? roleLabel(ticket.targetRole) : "团队";
  const workOrderDetail = `工单：${ticketLabel(ticket)}${message ? `；消息：${messageStatusLabel(message.status)}` : ""}`;
  if (ticket.status === "blocked" && ticket.blocker?.type === "manual_test_required") {
    return {
      speaker,
      title: `${speaker}：需要你人工测试`,
      statusLabel: "等你处理",
      meta: "QA 已完成静态检查，等待你测试后回复。",
      workOrderDetail
    };
  }
  if (ticket.status === "blocked") {
    return {
      speaker,
      title: `${speaker}：${ticketLabel(ticket)}受阻`,
      statusLabel: "已阻塞",
      meta: "当前 Agent 无法继续，需要查看阻塞原因。",
      workOrderDetail
    };
  }
  if (ticket.status === "running") {
    return {
      speaker,
      title: `${speaker}：正在${ticketLabel(ticket)}`,
      statusLabel: "处理中",
      meta: ticket.brief,
      workOrderDetail
    };
  }
  if (ticket.status === "completed") {
    return {
      speaker,
      title: `${speaker}：已完成${ticketLabel(ticket)}`,
      statusLabel: "已完成",
      meta: ticket.brief,
      workOrderDetail
    };
  }
  return {
    speaker,
    title: `${speaker}：${ticketLabel(ticket)}`,
    statusLabel: ticketStatusLabel(ticket.status),
    meta: ticket.brief,
    workOrderDetail
  };
}

export function buildHumanFlowPrompt(snapshot?: WorkspaceSnapshot): HumanFlowPromptView | undefined {
  if (snapshot?.status !== "blocked") return undefined;
  const flowProblem = blockedAgentProblem(snapshot);
  if (!flowProblem) return undefined;
  const phase = snapshot.activeTaskRun?.phase ?? snapshot.phase;
  const owner = flowProblem.owner ?? waiterForPhase(phase);
  const manualTest = flowProblem.manualTest;
  return {
    title: manualTest ? "需要人工测试" : titleForHumanFlow(flowProblem.rawOutput),
    agentId: flowProblem.agentId,
    waiter: owner,
    phase: flowProblem.phase ?? phaseLabelForHuman(phase),
    transcript: `${owner}:\n${flowProblem.rawOutput}`,
    inputLabel: manualTest ? "测试结果" : "授权说明",
    placeholder: `回复${owner}`,
    submitLabel: "发送",
    suggestion: manualTest?.passMessage ?? "按默认 Web Canvas 单人 MVP 返工开发：做一关可玩版本，必须真实写入文件，并包含移动、射击、敌人、墙、基地和胜负条件。",
    manualTest
  };
}

function latestBlockedTicket(snapshot?: WorkspaceSnapshot): Ticket | undefined {
  return snapshot?.tickets?.slice().reverse().find((ticket) => ticket.status === "blocked");
}

function ticketLabel(ticket: Ticket): string {
  if (ticket.type === "rework") return "返工";
  if (ticket.type === "human_action") return "人工动作";
  return assignmentLabel(ticket.type);
}

function ticketStatusLabel(status: Ticket["status"]): string {
  const labels: Record<Ticket["status"], string> = {
    pending: "等待领取",
    running: "处理中",
    blocked: "已阻塞",
    completed: "已完成",
    returned: "已打回",
    failed: "失败",
    dead_letter: "死信",
    cancelled: "已取消"
  };
  return labels[status];
}

function messageStatusLabel(status: AgentInboxMessage["status"]): string {
  const labels: Record<AgentInboxMessage["status"], string> = {
    pending: "待投递",
    claimed: "已领取",
    acked: "已确认",
    expired: "租约过期",
    dead_letter: "死信",
    cancelled: "已取消"
  };
  return labels[status];
}

function parseBlockerJson(reason: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(reason);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    const start = reason.indexOf("{");
    const end = reason.lastIndexOf("}");
    if (start < 0 || end <= start) return undefined;
    try {
      const parsed = JSON.parse(reason.slice(start, end + 1));
      return isRecord(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return strings.length ? strings : undefined;
}

type BlockedAgentProblem = {
  agentId?: string;
  owner: string;
  phase: string;
  rawOutput: string;
  manualTest?: ManualTestActionView;
};

function blockedAgentProblem(snapshot: WorkspaceSnapshot): BlockedAgentProblem | undefined {
  return latestManualTestTicketProblem(snapshot) ?? latestAssignmentBlockedProblem(snapshot) ?? earliestBlockingPhaseProblem(snapshot) ?? implementationEvidenceProblem(snapshot);
}

function agentProfile(agent: WorkspaceSnapshot["agents"][number], profileDef?: AgentProfile): AgentProfileView {
  const policy = normalizePolicy(agent.policyOverride);
  const role = agent.roleInWorkspace;
  const title = profileDef?.name ?? roleLabel(role);
  return {
    id: agent.id,
    role,
    status: agent.status,
    statusLabel: statusLabel(agent.status),
    identity: {
      title,
      subtitle: profileDef?.identity ?? identitySubtitle(role),
      avatar: title.slice(0, 1),
      scope: "项目实例，继承全局智能体档案"
    },
    soul: profileDef?.soul ?? soulForRole(role),
    agentMd: profileDef?.agentMd ?? agentMdForRole(role),
    toolGroups: [
      { label: "文件", enabled: policy.canReadWorkspace || policy.canWriteWorkspace, description: fileToolDescription(policy) },
      { label: "命令", enabled: policy.canExecuteCommands, description: policy.canExecuteCommands ? "可在策略范围内执行本地命令" : "默认不执行本地命令" },
      { label: "浏览器/MCP", enabled: Boolean(policy.allowHostAccess), description: policy.allowHostAccess ? "允许访问本机外部能力" : "默认关闭本机外部访问" }
    ],
    model: {
      provider: agent.provider ?? "mock",
      providerLabel: providerLabel(agent.provider ?? "mock"),
      modelName: agent.model || defaultModelForRole(role)
    },
    memory: {
      sessionLabel: "项目会话隔离",
      workspaceLabel: "工作事实写入 .autoagent",
      statePath: `.autoagent/agents/${agent.id}`
    },
    capabilities: profileDef?.capabilities?.length ? profileDef.capabilities : capabilityLabels(role, agent.capabilities),
    currentStep: displayText(agent.currentStep),
    policy
  };
}

function waiterForPhase(phase: string): string {
  const labels: Record<string, string> = {
    boss_intake: "老板",
    boss_acceptance: "老板",
    pm_plan: "产品/项目",
    architect_plan: "架构师",
    implementation: "开发",
    qa: "测试"
  };
  return labels[phase] ?? "团队";
}

function latestManualTestTicketProblem(snapshot: WorkspaceSnapshot): BlockedAgentProblem | undefined {
  const ticket = snapshot.tickets?.slice().reverse().find((item) => {
    return item.status === "blocked" && item.blocker?.type === "manual_test_required";
  });
  if (!ticket) return undefined;
  const manualTest = buildManualTestAction(ticket);
  const phase = ticket.type;
  const owner = ticket.targetRole ? roleLabel(ticket.targetRole) : waiterForPhase(phase);
  const testLines = manualTest ? [
    manualTest.summary,
    manualTest.testFile ? `打开：${manualTest.testFile}` : undefined,
    ...manualTest.steps.map((step, index) => `${index + 1}. ${step}`),
    manualTest.expectedResult ? `通过标准：${manualTest.expectedResult}` : undefined
  ].filter((line): line is string => Boolean(line)) : [];
  return {
    agentId: ticket.targetAgentId ?? agentIdForRole(snapshot, ticket.targetRole) ?? agentIdForPhase(snapshot, phase),
    owner,
    phase: phaseLabelForHuman(phase),
    rawOutput: testLines.length ? testLines.join("\n") : ticket.blocker?.reason ?? "QA 请求人工测试。",
    manualTest
  };
}

function latestAssignmentBlockedProblem(snapshot: WorkspaceSnapshot): BlockedAgentProblem | undefined {
  const blockedIndex = lastEventIndex(snapshot.recentEvents, "assignment.blocked");
  if (blockedIndex < 0) return undefined;
  const blocked = snapshot.recentEvents[blockedIndex];
  const phase = phaseFromAssignmentEvent(blocked);
  const payload = blocked.payload as Record<string, unknown>;
  const assignmentRun = payload.assignmentRun as { workspaceAgentId?: string } | undefined;
  const assignmentId = stringValue(payload.assignmentId);
  const assignment = assignmentId ? snapshot.assignments.find((item) => item.id === assignmentId) : undefined;
  const toolResults = Array.isArray(payload.toolResults) ? payload.toolResults as Array<Record<string, unknown>> : [];
  const toolFailure = toolResults.find((item) => item.ok === false || typeof item.error === "string");
  const reason = stringValue(payload.reason) ?? stringValue(toolFailure?.error) ?? "没有拿到平台边界原因。";
  if (!isHumanActionBoundaryText(reason)) return undefined;
  const rawOutput = rawAgentOutput(snapshot.recentEvents, blocked, blockedIndex, payload.result ?? reason);
  return {
    agentId: blocked.actorId ?? assignmentRun?.workspaceAgentId ?? assignment?.ownerWorkspaceAgentId ?? agentIdForPhase(snapshot, phase),
    owner: waiterForPhase(phase),
    phase: phaseLabelForHuman(phase),
    rawOutput
  };
}

function earliestBlockingPhaseProblem(snapshot: WorkspaceSnapshot): BlockedAgentProblem | undefined {
  for (let index = 0; index < snapshot.recentEvents.length; index += 1) {
    const event = snapshot.recentEvents[index];
    if (event.type !== "assignment.completed") continue;
    const result = event.payload.result as Record<string, unknown> | undefined;
    if (!result || typeof result !== "object") continue;
    const status = lower(result.status);
    const decision = lower(result.decision);
    const action = lower(result.action);
    const reason = stringValue(result.reason) ?? stringValue(result.report) ?? stringValue(result.summary) ?? "";
    const clarificationSignal = [status, decision, action].some((value) => hasClarificationSignal(value));
    const blocked = result.clarification_required === true
      || status.includes("need_clarification")
      || status.includes("awaiting_clarification")
      || status === "blocked"
      || action.includes("awaiting_clarification")
      || action.includes("return_to_clarification")
      || action === "block"
      || result.blocked === true
      || clarificationSignal
      || decision === "reject";
    if (!blocked) continue;
    if (!isHumanActionBoundaryText(`${status} ${decision} ${action} ${reason}`)) continue;
    const phase = phaseFromAssignmentEvent(event);
    return {
      agentId: event.actorId ?? agentIdForPhase(snapshot, phase),
      owner: waiterForPhase(phase),
      phase: phaseLabelForHuman(phase),
      rawOutput: rawAgentOutput(snapshot.recentEvents, event, index, result)
    };
  }
  return undefined;
}

function implementationEvidenceProblem(snapshot: WorkspaceSnapshot): BlockedAgentProblem | undefined {
  return undefined;
}

function isHumanAuthorizationText(value: string): boolean {
  const text = value.toLowerCase();
  return text.includes("human_authorization")
    || text.includes("human_approval")
    || text.includes("requires_human")
    || text.includes("await_human_authorization")
    || text.includes("await_human_approval")
    || value.includes("需要人工授权")
    || value.includes("等待人工授权")
    || value.includes("需要人工审批")
    || value.includes("等待人工审批");
}

function isManualTestingText(value: string): boolean {
  const text = value.toLowerCase();
  return text.includes("manual_test")
    || text.includes("manual testing")
    || value.includes("人工测试")
    || value.includes("人工验收")
    || value.includes("缺少浏览器")
    || value.includes("浏览器运行环境")
    || value.includes("无法实际执行手动测试");
}

function isHumanActionBoundaryText(value: string): boolean {
  return isHumanAuthorizationText(value) || isManualTestingText(value);
}

function titleForHumanFlow(rawOutput: string): string {
  return isManualTestingText(rawOutput) ? "需要人工测试" : "需要授权";
}

function lastEventIndex(events: WorkspaceSnapshot["recentEvents"], type: WorkspaceSnapshot["recentEvents"][number]["type"]): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].type === type) return index;
  }
  return -1;
}

function agentIdForPhase(snapshot: WorkspaceSnapshot, phase: string): string | undefined {
  const roleByPhase: Record<string, string> = {
    boss_intake: "boss",
    boss_acceptance: "boss",
    pm_plan: "pm",
    architect_plan: "architect",
    implementation: "dev",
    qa: "qa"
  };
  const role = roleByPhase[phase];
  return snapshot.agents.find((agent) => agent.roleInWorkspace === role)?.id;
}

function agentIdForRole(snapshot: WorkspaceSnapshot, role?: string): string | undefined {
  return role ? snapshot.agents.find((agent) => agent.roleInWorkspace === role)?.id : undefined;
}

function rawAgentOutput(
  events: WorkspaceSnapshot["recentEvents"],
  event: WorkspaceSnapshot["recentEvents"][number],
  eventIndex: number,
  result: unknown
): string {
  const payload = event.payload as Record<string, unknown>;
  const directRaw = stringValue(payload.rawText);
  if (directRaw) return directRaw;

  for (let index = eventIndex - 1; index >= 0; index -= 1) {
    const candidate = events[index];
    if (candidate.type !== "provider.completed") continue;
    if (event.actorId && candidate.actorId && event.actorId !== candidate.actorId) continue;
    const providerEvents = (candidate.payload as Record<string, unknown>).providerEvents;
    if (!Array.isArray(providerEvents)) continue;
    const textEvent = providerEvents.find((item) => {
      return typeof item === "object"
        && item !== null
        && (item as Record<string, unknown>).type === "text"
        && stringValue((item as Record<string, unknown>).text);
    }) as Record<string, unknown> | undefined;
    const text = stringValue(textEvent?.text);
    if (text) return text;
  }

  if (typeof result === "string") return result;
  if (result && typeof result === "object") return JSON.stringify(result, null, 2);
  return "没有拿到 Agent 原始输出。";
}

function phaseFromAssignmentEvent(event: WorkspaceSnapshot["recentEvents"][number]): string {
  const assignment = event.payload.assignment as { type?: string } | undefined;
  if (assignment?.type) return assignment.type;
  if (event.summary.includes("需求接收")) return "boss_intake";
  if (event.summary.includes("计划拆解")) return "pm_plan";
  if (event.summary.includes("架构设计")) return "architect_plan";
  if (event.summary.includes("开发执行")) return "implementation";
  if (event.summary.includes("质量检查")) return "qa";
  if (event.summary.includes("老板验收")) return "boss_acceptance";
  return "boss_acceptance";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function lower(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function hasClarificationSignal(value: string): boolean {
  if (!value || value.includes("不需要澄清")) return false;
  return value.includes("need clarification")
    || value.includes("needs clarification")
    || value.includes("clarification required")
    || value.includes("awaiting clarification")
    || value.includes("暂不执行")
    || value.includes("需澄清")
    || value.includes("需要澄清")
    || value.includes("等待澄清");
}


function phaseLabelForHuman(phase: string): string {
  const labels: Record<string, string> = {
    boss_intake: "需求接收",
    pm_plan: "计划拆解",
    architect_plan: "架构设计",
    implementation: "开发执行",
    qa: "质量检查",
    boss_acceptance: "老板验收"
  };
  return labels[phase] ?? "任务流";
}

function normalizePolicy(policy?: Partial<AgentPolicy>): AgentPolicyView {
  return {
    canReadWorkspace: Boolean(policy?.canReadWorkspace),
    canWriteWorkspace: Boolean(policy?.canWriteWorkspace),
    canExecuteCommands: Boolean(policy?.canExecuteCommands),
    allowHostAccess: Boolean(policy?.allowHostAccess)
  };
}

function providerLabel(provider: ProviderName | "mock"): string {
  const labels: Record<string, string> = {
    mock: "模拟服务",
    openai: "OpenAI",
    anthropic: "Anthropic"
  };
  return labels[provider] ?? provider;
}

function defaultModelForRole(role: WorkspaceAgent["roleInWorkspace"]): string {
  return `mock-${role}`;
}

function identitySubtitle(role: string): string {
  const labels: Record<string, string> = {
    boss: "目标判断、验收与人员调度",
    pm: "拆解计划、控制范围与组织交接",
    architect: "技术路线、能力缺口与架构约束",
    dev: "实现变更、调用工具与本地验证",
    qa: "质量检查、回归验证与验收证据",
    specialist: "针对能力缺口的专项交付"
  };
  return labels[role] ?? "项目团队成员";
}

function soulForRole(role: string): string {
  const labels: Record<string, string> = {
    boss: "天然关注方向、价值和最终结果，对没有证据的完成感不信任。",
    pm: "对混乱和返工高度敏感，习惯把模糊意图压成清楚路径。",
    architect: "从结构、约束和长期代价里理解问题，警惕凭感觉拍方案。",
    dev: "以可运行变化获得安全感，喜欢从真实代码和验证反馈里判断。",
    qa: "对模糊通过很敏感，天然追问证据、复现细节和剩余风险。",
    specialist: "注意力集中在专业缺口上，倾向收窄问题并保护结论准确性。"
  };
  return labels[role] ?? "围绕专业问题形成稳定判断，并交给主团队吸收。";
}

function agentMdForRole(role: string): string {
  const labels: Record<string, string> = {
    boss: "# 使命\n判断目标、授权团队并完成验收。",
    pm: "# 使命\n把目标拆成可执行、可交接、可验收的计划。",
    architect: "# 使命\n把项目事实转成可执行、可验证的技术边界。",
    dev: "# 使命\n把授权任务变成最小真实可验证的工程变更。",
    qa: "# 使命\n用可复现证据判断交付是否达到验收口径。",
    specialist: "# 使命\n围绕能力缺口提供专项补位。"
  };
  return labels[role] ?? labels.specialist;
}

function fileToolDescription(policy: AgentPolicyView): string {
  if (policy.canReadWorkspace && policy.canWriteWorkspace) return "可读写项目文件";
  if (policy.canReadWorkspace) return "只读项目文件";
  return "不访问项目文件";
}
