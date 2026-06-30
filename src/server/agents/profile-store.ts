import type { AgentPolicy, AgentProfile, ProviderName } from "../../shared/types.js";
import { readJson, writeJson } from "../storage/json.js";
import { globalAgentProfilesFile } from "../storage/paths.js";
import { CORE_AGENT_PROFILES } from "./roster.js";

export class AgentProfileStore {
  constructor(private readonly homeDir: string) {}

  async list(): Promise<AgentProfile[]> {
    const stored = await readJson<AgentProfile[] | undefined>(globalAgentProfilesFile(this.homeDir), undefined);
    if (!stored) {
      const seeded = defaultAgentProfiles();
      await writeJson(globalAgentProfilesFile(this.homeDir), seeded);
      return seeded;
    }
    const merged = mergeDefaults(stored);
    if (JSON.stringify(stored) !== JSON.stringify(merged)) {
      await writeJson(globalAgentProfilesFile(this.homeDir), merged);
    }
    return merged;
  }

  async update(profileId: string, patch: Partial<Pick<AgentProfile, "name" | "identity" | "soul" | "capabilities" | "defaultProvider" | "defaultModel" | "defaultPolicy">>): Promise<AgentProfile> {
    const profiles = await this.list();
    const existing = profiles.find((profile) => profile.id === profileId);
    if (!existing) throw new Error(`Agent profile not found: ${profileId}`);
    const updated: AgentProfile = stripRemovedProfileFields({
      ...existing,
      name: patch.name ?? existing.name,
      identity: patch.identity ?? existing.identity,
      soul: patch.soul ?? existing.soul,
      capabilities: patch.capabilities ?? existing.capabilities,
      defaultProvider: patch.defaultProvider ?? existing.defaultProvider,
      defaultModel: patch.defaultModel ?? existing.defaultModel,
      defaultPolicy: patch.defaultPolicy ? { ...existing.defaultPolicy, ...patch.defaultPolicy } : existing.defaultPolicy
    });
    await writeJson(globalAgentProfilesFile(this.homeDir), profiles.map((profile) => profile.id === profileId ? stripRemovedProfileFields(updated) : stripRemovedProfileFields(profile)));
    return updated;
  }
}

export function defaultAgentProfiles(): AgentProfile[] {
  return CORE_AGENT_PROFILES.map((profile) => ({
    ...profile,
    identity: identityForRole(profile.role),
    soul: soulForRole(profile.role)
  }));
}

function mergeDefaults(stored: AgentProfile[]): AgentProfile[] {
  const byId = new Map(stored.map((profile) => [profile.id, profile]));
  const merged = defaultAgentProfiles().map((profile) => stripRemovedProfileFields({ ...profile, ...byId.get(profile.id) }));
  const custom = stored.filter((profile) => !merged.some((item) => item.id === profile.id)).map(stripRemovedProfileFields);
  return [...merged, ...custom];
}

function identityForRole(role: AgentProfile["role"]): string {
  const labels: Record<string, string> = {
    boss: "负责接收目标、调度团队并验收结果",
    pm: "负责把模糊目标拆成可执行计划",
    architect: "负责技术路线、架构约束和能力缺口判断",
    dev: "负责把任务变成可运行的项目变更",
    qa: "负责质量检查、回归验证和验收证据"
  };
  return labels[role] ?? "负责专项能力补位";
}

function soulForRole(role: AgentProfile["role"]): string {
  const labels: Record<string, string> = {
    boss: "像现实团队负责人一样先判断目标是否值得做，再做验收和人员调度。",
    pm: "把模糊需求压成可执行计划，控制范围，减少来回返工。",
    architect: "先找技术约束和能力缺口，再给开发留下清晰边界。",
    dev: "面向交付推进实现，优先做可验证的小步变更。",
    qa: "用证据说话，发现问题就把反馈退回开发闭环。"
  };
  return labels[role] ?? "围绕专项能力补位，交付可被主团队吸收的建议或实现。";
}

export function sanitizeProfilePatch(input: Record<string, unknown>) {
  return {
    name: input.name !== undefined ? String(input.name) : undefined,
    identity: input.identity !== undefined ? String(input.identity) : undefined,
    soul: input.soul !== undefined ? String(input.soul) : undefined,
    capabilities: Array.isArray(input.capabilities) ? input.capabilities.map(String).filter(Boolean) : undefined,
    defaultProvider: sanitizeProvider(input.defaultProvider),
    defaultModel: input.defaultModel !== undefined ? String(input.defaultModel) : undefined,
    defaultPolicy: typeof input.defaultPolicy === "object" && input.defaultPolicy ? sanitizePolicy(input.defaultPolicy as Record<string, unknown>) : undefined
  };
}

function stripRemovedProfileFields(profile: AgentProfile): AgentProfile {
  const { loopDefinition: _discarded, ...kept } = profile as AgentProfile & { loopDefinition?: unknown };
  return kept;
}

function sanitizeProvider(value: unknown): ProviderName | undefined {
  if (value === "mock" || value === "openai" || value === "anthropic") return value;
  return undefined;
}

function sanitizePolicy(input: Record<string, unknown>): Partial<AgentPolicy> {
  const policy: Partial<AgentPolicy> = {};
  if ("canReadWorkspace" in input) policy.canReadWorkspace = Boolean(input.canReadWorkspace);
  if ("canWriteWorkspace" in input) policy.canWriteWorkspace = Boolean(input.canWriteWorkspace);
  if ("canExecuteCommands" in input) policy.canExecuteCommands = Boolean(input.canExecuteCommands);
  if ("allowHostAccess" in input) policy.allowHostAccess = Boolean(input.allowHostAccess);
  return policy;
}
