import { createHash } from "node:crypto";
import { mkdir, readdir, rm } from "node:fs/promises";
import type { Dirent } from "node:fs";
import type { AgentProfile, AgentRole, Workspace, WorkspaceAgent } from "../../shared/types.js";
import { createId } from "../../shared/ids.js";
import { workspaceAgentDir, workspaceAgentFile, workspaceAgentSessionsDir } from "../storage/paths.js";
import { readJson, writeJson } from "../storage/json.js";

export const CORE_AGENT_PROFILES: AgentProfile[] = [
  {
    id: "prof_boss",
    name: "老板",
    role: "boss",
    capabilities: ["team:staff", "team:staff:default", "company:evolve", "mission:intake", "delivery:accept", "目标接收", "成功标准定义", "优先级取舍", "团队调度", "验收决策", "风险升级"],
    defaultProvider: "mock",
    defaultModel: "mock-boss",
    defaultPolicy: { canReadWorkspace: true, canWriteWorkspace: false, canExecuteCommands: false, enabledTools: ["listFiles", "readFile"] }
  },
  {
    id: "prof_pm",
    name: "产品/项目",
    role: "pm",
    capabilities: ["plan:plan", "需求澄清", "任务拆解", "范围控制", "交付计划", "依赖协调", "验收口径", "变更管理"],
    defaultProvider: "mock",
    defaultModel: "mock-pm",
    defaultPolicy: { canReadWorkspace: true, canWriteWorkspace: false, canExecuteCommands: false, enabledTools: ["listFiles", "readFile"] }
  },
  {
    id: "prof_architect",
    name: "架构师",
    role: "architect",
    capabilities: ["architecture:design", "代码库理解", "技术方案", "架构边界", "接口设计", "风险评估", "能力缺口判断", "安全约束"],
    defaultProvider: "mock",
    defaultModel: "mock-architect",
    defaultPolicy: { canReadWorkspace: true, canWriteWorkspace: true, canExecuteCommands: false, enabledTools: ["listFiles", "readFile", "writeFile", "editFile"] }
  },
  {
    id: "prof_dev",
    name: "开发",
    role: "dev",
    defaultSkills: ["agent-browser"],
    capabilities: ["delivery:implement", "代码阅读", "实现修改", "工具执行", "本地验证", "调试定位", "变更说明", "风险反馈"],
    defaultProvider: "mock",
    defaultModel: "mock-dev",
    defaultPolicy: { canReadWorkspace: true, canWriteWorkspace: true, canExecuteCommands: true, enabledTools: ["listFiles", "readFile", "readImage", "writeFile", "editFile", "shell", "startService", "pollProcess", "browser"] }
  },
  {
    id: "prof_dev_integration",
    name: "集成开发",
    role: "dev",
    defaultSkills: ["agent-browser"],
    capabilities: ["delivery:implement", "代码阅读", "实现修改", "工具执行", "本地验证", "调试定位", "变更说明", "风险反馈", "并行交付", "集成冲突处理"],
    defaultProvider: "mock",
    defaultModel: "mock-dev",
    defaultPolicy: { canReadWorkspace: true, canWriteWorkspace: true, canExecuteCommands: true, enabledTools: ["listFiles", "readFile", "readImage", "writeFile", "editFile", "shell", "startService", "pollProcess", "browser"] }
  },
  {
    id: "prof_qa",
    name: "测试",
    role: "qa",
    defaultSkills: ["agent-browser"],
    capabilities: ["delivery:verify", "测试计划", "质量检查", "回归验证", "验收证据", "缺陷报告", "风险分级", "返工反馈"],
    defaultProvider: "mock",
    defaultModel: "mock-qa",
    defaultPolicy: { canReadWorkspace: true, canWriteWorkspace: false, canExecuteCommands: true, enabledTools: ["listFiles", "readFile", "readImage", "shell", "startService", "pollProcess", "browser"] }
  }
];

const ROLE_ORDER: Record<AgentRole, number> = {
  boss: 0,
  pm: 1,
  architect: 2,
  dev: 3,
  qa: 4,
  specialist: 5
};

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
      .filter((agent) => agent.workspaceId === workspace.id)
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

/** One-time compatibility migration plus a hard identity-integrity check. */
export async function migrateAndValidateWorkspaceAgentProfiles(workspace: Workspace, profiles: AgentProfile[]): Promise<WorkspaceAgent[]> {
  const agentsRoot = workspaceAgentDir(workspace.rootPath, "");
  let entries: Dirent[];
  try { entries = await readdir(agentsRoot, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const known = new Map(profiles.map((profile) => [profile.id, profile])); const seen = new Set<string>(); const result: WorkspaceAgent[] = [];
  for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = workspaceAgentFile(workspace.rootPath, entry.name); const raw = await readJson<Partial<WorkspaceAgent> | undefined>(file, undefined);
    if (!raw) continue;
    if (!raw.id || raw.id !== entry.name || raw.workspaceId !== workspace.id || !raw.roleInWorkspace) throw new Error(`Workspace Agent identity record is invalid: ${entry.name}`);
    let profileId = raw.profileId;
    if (!profileId) {
      const candidates = profiles.filter((profile) => profile.role === raw.roleInWorkspace);
      const canonical = candidates.find((profile) => profile.id === `prof_${raw.roleInWorkspace}`);
      if (candidates.length !== 1 && !canonical) throw new Error(`Legacy Workspace Agent ${raw.id} has no unambiguous AgentProfile mapping`);
      profileId = (canonical ?? candidates[0])!.id;
      await writeJson(file, { ...raw, profileId });
    }
    if (!known.has(profileId)) throw new Error(`Workspace Agent ${raw.id} references unknown AgentProfile ${profileId}`);
    if (seen.has(profileId)) throw new Error(`Workspace ${workspace.id} contains duplicate instances of AgentProfile ${profileId}`);
    seen.add(profileId); result.push({ ...raw, profileId } as WorkspaceAgent);
  }
  return result;
}

export async function ensureProjectOwner(workspace: Workspace, profiles: AgentProfile[]): Promise<WorkspaceAgent> {
  const ownerProfile = selectProjectOwnerProfile(profiles);
  const existing = (await listWorkspaceAgents(workspace)).find((agent) => agent.profileId === ownerProfile.id);
  return existing ?? ensureWorkspaceAgent(
    workspace,
    ownerProfile,
    stableWorkspaceAgentId(workspace.id, ownerProfile.id),
  );
}

export function selectProjectOwnerProfile(profiles: AgentProfile[]): AgentProfile {
  const candidates = profiles.filter((profile) => profile.capabilities.includes("team:staff"));
  if (candidates.length === 1) return candidates[0]!;
  const defaults = candidates.filter((profile) => profile.capabilities.includes("team:staff:default"));
  if (defaults.length === 1) return defaults[0]!;
  if (!candidates.length) throw new Error("组织人才池缺少具备 team:staff 能力的项目负责人");
  throw new Error("组织存在多个项目负责人人选，但没有唯一的 team:staff:default");
}

function stableWorkspaceAgentId(workspaceId: string, profileId: string): string {
  const digest = createHash("sha256").update(`${workspaceId}\u0000${profileId}`).digest("hex").slice(0, 24);
  return `workspace-agent_${digest}`;
}

export function profileMetadata(agent: WorkspaceAgent, profiles = CORE_AGENT_PROFILES): Pick<AgentProfile, "name" | "role" | "capabilities"> {
  const profile = profiles.find((item) => item.id === agent.profileId);
  if (!profile) {
    return {
      name: "档案已缺失",
      role: agent.roleInWorkspace,
      capabilities: [],
    };
  }
  return { name: profile.name, role: profile.role, capabilities: profile.capabilities };
}

export async function addWorkspaceAgent(workspace: Workspace, profile: AgentProfile): Promise<WorkspaceAgent> {
  const agents = await listWorkspaceAgents(workspace);
  if (agents.some((agent) => agent.profileId === profile.id)) {
    throw new Error(`Agent profile is already in workspace: ${profile.id}`);
  }
  return ensureWorkspaceAgent(workspace, profile);
}

export async function removeWorkspaceAgent(workspace: Workspace, workspaceAgentId: string): Promise<WorkspaceAgent> {
  const existing = await readJson<WorkspaceAgent | undefined>(workspaceAgentFile(workspace.rootPath, workspaceAgentId), undefined);
  if (!existing) throw new Error(`Workspace agent not found: ${workspaceAgentId}`);
  await rm(workspaceAgentDir(workspace.rootPath, workspaceAgentId), { recursive: true, force: true });
  return existing;
}

export async function updateWorkspaceAgent(
  workspace: Workspace,
  workspaceAgentId: string,
  patch: Partial<Pick<WorkspaceAgent, "provider" | "model" | "policyOverride">> & { skillOverrides?: string[] | null }
): Promise<WorkspaceAgent> {
  const existing = await readJson<WorkspaceAgent | undefined>(workspaceAgentFile(workspace.rootPath, workspaceAgentId), undefined);
  if (!existing) throw new Error(`Workspace agent not found: ${workspaceAgentId}`);
  const updated: WorkspaceAgent = {
    ...existing,
    provider: patch.provider ?? existing.provider,
    model: patch.model ?? existing.model,
    ...(patch.skillOverrides !== undefined ? { skillOverrides: patch.skillOverrides ?? undefined } : {}),
    policyOverride: patch.policyOverride ?? existing.policyOverride
  };
  await writeJson(workspaceAgentFile(workspace.rootPath, workspaceAgentId), updated);
  return updated;
}
