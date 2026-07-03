import { mkdir, readdir } from "node:fs/promises";
import type { AgentProfile, AgentRole, Workspace, WorkspaceAgent } from "../../shared/types.js";
import { createId } from "../../shared/ids.js";
import { workspaceAgentDir, workspaceAgentFile, workspaceAgentSessionsDir } from "../storage/paths.js";
import { readJson, writeJson } from "../storage/json.js";

export const CORE_AGENT_PROFILES: AgentProfile[] = [
  {
    id: "prof_boss",
    name: "老板",
    role: "boss",
    capabilities: ["目标接收", "成功标准定义", "优先级取舍", "团队调度", "验收决策", "风险升级"],
    defaultProvider: "mock",
    defaultModel: "mock-boss",
    defaultPolicy: { canReadWorkspace: true, canWriteWorkspace: false, canExecuteCommands: false }
  },
  {
    id: "prof_pm",
    name: "产品/项目",
    role: "pm",
    capabilities: ["需求澄清", "任务拆解", "范围控制", "交付计划", "依赖协调", "验收口径", "变更管理"],
    defaultProvider: "mock",
    defaultModel: "mock-pm",
    defaultPolicy: { canReadWorkspace: true, canWriteWorkspace: false, canExecuteCommands: false }
  },
  {
    id: "prof_architect",
    name: "架构师",
    role: "architect",
    capabilities: ["代码库理解", "技术方案", "架构边界", "接口设计", "风险评估", "能力缺口判断", "安全约束"],
    defaultProvider: "mock",
    defaultModel: "mock-architect",
    defaultPolicy: { canReadWorkspace: true, canWriteWorkspace: true, canExecuteCommands: false }
  },
  {
    id: "prof_dev",
    name: "开发",
    role: "dev",
    capabilities: ["代码阅读", "实现修改", "工具执行", "本地验证", "调试定位", "变更说明", "风险反馈"],
    defaultProvider: "mock",
    defaultModel: "mock-dev",
    defaultPolicy: { canReadWorkspace: true, canWriteWorkspace: true, canExecuteCommands: true }
  },
  {
    id: "prof_qa",
    name: "测试",
    role: "qa",
    capabilities: ["测试计划", "质量检查", "回归验证", "验收证据", "缺陷报告", "风险分级", "返工反馈"],
    defaultProvider: "mock",
    defaultModel: "mock-qa",
    defaultPolicy: { canReadWorkspace: true, canWriteWorkspace: false, canExecuteCommands: true }
  }
];

export type CoreRole = Exclude<AgentRole, "specialist">;

const ROLE_ORDER: Record<AgentRole, number> = {
  boss: 0,
  pm: 1,
  architect: 2,
  dev: 3,
  qa: 4,
  specialist: 5
};

export async function ensureCoreTeam(workspace: Workspace, profiles = CORE_AGENT_PROFILES): Promise<WorkspaceAgent[]> {
  const agents: WorkspaceAgent[] = [];
  for (const profile of profiles.filter((profile) => profile.role !== "specialist")) {
    agents.push(await ensureWorkspaceAgent(workspace, profile, `wa_${profile.role}`));
  }
  return agents;
}

export async function listWorkspaceAgents(workspace: Workspace): Promise<WorkspaceAgent[]> {
  const agentsRoot = workspaceAgentDir(workspace.rootPath, "");
  try {
    const entries = await readdir(agentsRoot, { withFileTypes: true });
    const agents = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => readJson<WorkspaceAgent | undefined>(workspaceAgentFile(workspace.rootPath, entry.name), undefined))
    );
    return agents
      .filter((agent): agent is WorkspaceAgent => Boolean(agent))
      .sort((left, right) => {
        const roleDiff = ROLE_ORDER[left.roleInWorkspace] - ROLE_ORDER[right.roleInWorkspace];
        if (roleDiff !== 0) return roleDiff;
        return left.id.localeCompare(right.id);
      });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export function profileForRole(role: AgentRole, profiles = CORE_AGENT_PROFILES): AgentProfile {
  const profile = profiles.find((item) => item.role === role);
  if (profile) return profile;
  return {
    id: "prof_specialist",
    name: "专家",
    role: "specialist",
    capabilities: ["专项分析", "专业判断", "方案补位", "交接结论"],
    defaultProvider: "mock",
    defaultModel: "mock-specialist",
    defaultPolicy: { canReadWorkspace: true, canWriteWorkspace: true, canExecuteCommands: true }
  };
}

export async function ensureWorkspaceAgent(workspace: Workspace, profile: AgentProfile, workspaceAgentId = createId("wa")): Promise<WorkspaceAgent> {
  const existing = await readJson<WorkspaceAgent | undefined>(workspaceAgentFile(workspace.rootPath, workspaceAgentId), undefined);
  if (existing) return existing;

  const agent: WorkspaceAgent = {
    id: workspaceAgentId,
    workspaceId: workspace.id,
    profileId: profile.id,
    roleInWorkspace: profile.role,
    agentDir: workspaceAgentDir(workspace.rootPath, workspaceAgentId),
    status: "idle",
    provider: profile.defaultProvider,
    model: profile.defaultModel,
    policyOverride: profile.defaultPolicy
  };
  await mkdir(workspaceAgentSessionsDir(workspace.rootPath, workspaceAgentId), { recursive: true });
  await writeJson(workspaceAgentFile(workspace.rootPath, workspaceAgentId), agent);
  return agent;
}

export function profileMetadata(agent: WorkspaceAgent, profiles = CORE_AGENT_PROFILES): Pick<AgentProfile, "name" | "role" | "capabilities"> {
  const profile = profileForRole(agent.roleInWorkspace, profiles);
  return { name: profile.name, role: profile.role, capabilities: profile.capabilities };
}

export async function updateWorkspaceAgent(
  workspace: Workspace,
  workspaceAgentId: string,
  patch: Partial<Pick<WorkspaceAgent, "provider" | "model" | "policyOverride">>
): Promise<WorkspaceAgent> {
  const existing = await readJson<WorkspaceAgent | undefined>(workspaceAgentFile(workspace.rootPath, workspaceAgentId), undefined);
  if (!existing) throw new Error(`Workspace agent not found: ${workspaceAgentId}`);
  const updated: WorkspaceAgent = {
    ...existing,
    provider: patch.provider ?? existing.provider,
    model: patch.model ?? existing.model,
    policyOverride: patch.policyOverride ?? existing.policyOverride
  };
  await writeJson(workspaceAgentFile(workspace.rootPath, workspaceAgentId), updated);
  return updated;
}
