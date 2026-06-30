import type { AgentPolicy, ProviderName, WorkspaceAgent, WorkspaceSnapshot } from "../shared/types";
import { capabilityLabels, displayText, roleLabel, statusLabel } from "../shared/labels";

export interface AgentNodeView {
  id: string;
  label: string;
  role: string;
  status: string;
  currentStep?: string;
  x: number;
  y: number;
  active: boolean;
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
  loopSteps: string[];
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
  return snapshot.agents
    .slice()
    .sort((a, b) => ROLE_ORDER.indexOf(a.roleInWorkspace) - ROLE_ORDER.indexOf(b.roleInWorkspace))
    .map((agent, index) => {
      const base = ROLE_POSITIONS[agent.roleInWorkspace] ?? { x: 18 + index * 14, y: 52 };
      const specialistOffset = agent.roleInWorkspace === "specialist" ? Math.max(0, index - ROLE_ORDER.indexOf("specialist")) * 4 : 0;
      return {
        id: agent.id,
        label: roleLabel(agent.roleInWorkspace),
        role: agent.roleInWorkspace,
        status: agent.status,
        currentStep: displayText(agent.currentStep),
        x: Math.min(base.x + specialistOffset, 88),
        y: base.y,
        active: agent.status === "running" || Boolean(agent.currentStep)
      };
    });
}

export function buildAgentProfiles(snapshot?: WorkspaceSnapshot): AgentProfileView[] {
  if (!snapshot) return [];
  return snapshot.agents
    .slice()
    .sort((a, b) => ROLE_ORDER.indexOf(a.roleInWorkspace) - ROLE_ORDER.indexOf(b.roleInWorkspace))
    .map((agent) => agentProfile(agent));
}

export function taskControlMode(snapshot?: WorkspaceSnapshot): "empty" | "running" | "paused" | "terminal" {
  if (!snapshot?.activeTask) return "empty";
  if (snapshot.status === "paused") return "paused";
  if (snapshot.status === "completed" || snapshot.status === "failed" || snapshot.status === "interrupted") return "terminal";
  return "running";
}

function agentProfile(agent: WorkspaceSnapshot["agents"][number]): AgentProfileView {
  const policy = normalizePolicy(agent.policyOverride);
  const role = agent.roleInWorkspace;
  return {
    id: agent.id,
    role,
    status: agent.status,
    statusLabel: statusLabel(agent.status),
    identity: {
      title: roleLabel(role),
      subtitle: identitySubtitle(role),
      avatar: roleLabel(role).slice(0, 1),
      scope: "项目实例，继承全局 Agent 档案"
    },
    soul: soulForRole(role),
    loopSteps: loopForRole(role),
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
    capabilities: capabilityLabels(role, agent.capabilities),
    currentStep: displayText(agent.currentStep),
    policy
  };
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
    boss: "像现实团队负责人一样先判断目标是否值得做，再做验收和人员调度。",
    pm: "把模糊需求压成可执行计划，控制范围，减少来回返工。",
    architect: "先找技术约束和能力缺口，再给开发留下清晰边界。",
    dev: "面向交付推进实现，优先做可验证的小步变更。",
    qa: "用证据说话，发现问题就把反馈退回开发闭环。",
    specialist: "围绕专项能力补位，交付可被主团队吸收的建议或实现。"
  };
  return labels[role] ?? "围绕项目目标提供专业判断和交付。";
}

function loopForRole(role: string): string[] {
  const labels: Record<string, string[]> = {
    boss: ["接收目标", "判断可执行性", "调度人员", "验收结果"],
    pm: ["理解目标", "拆解任务", "明确交接", "控制范围"],
    architect: ["分析约束", "设计方案", "发现缺口", "给出边界"],
    dev: ["理解任务", "修改项目", "本地验证", "交付说明"],
    qa: ["读取产物", "执行检查", "形成报告", "反馈闭环"],
    specialist: ["接收缺口", "专项分析", "补齐能力", "交接结论"]
  };
  return labels[role] ?? ["理解任务", "执行工作", "记录结果", "交接反馈"];
}

function fileToolDescription(policy: AgentPolicyView): string {
  if (policy.canReadWorkspace && policy.canWriteWorkspace) return "可读写项目文件";
  if (policy.canReadWorkspace) return "只读项目文件";
  return "不访问项目文件";
}
