import type { AgentProfile, WorkspaceAgent, WorkspaceToolName } from "../../shared/types.js";

const SKILL_TOOL_REQUIREMENTS: Readonly<Record<string, readonly WorkspaceToolName[]>> = {
  "agent-browser": ["browser"],
};

const SKILL_RUNTIME_ADAPTERS: Readonly<Record<string, string>> = {
  "agent-browser": [
    "agent-browser Skill 中写作 `agent-browser <command> ...` 或 `npx agent-browser <command> ...` 的命令，",
    "在本平台必须调用一级 `browser` 工具，并把 `<command> ...` 逐项放入 browserArgs；不得通过 shell 间接执行。",
    "该工具可以直接打开公网 HTTP/HTTPS 页面；只有 localhost、127.0.0.1 等本地地址要求来自当前工作区由 startService 启动的受管服务。",
  ].join(""),
};

export function effectiveAgentSkills(profile: AgentProfile, agent: WorkspaceAgent): string[] {
  return [...new Set(agent.skillOverrides ?? profile.defaultSkills ?? [])];
}

export function toolsRequiredBySkills(
  skills: readonly string[],
  enabledTools: readonly WorkspaceToolName[] = [],
): WorkspaceToolName[] {
  return [
    ...new Set([
      ...enabledTools,
      ...skills.flatMap((skill) => SKILL_TOOL_REQUIREMENTS[skill] ?? []),
    ]),
  ];
}

export function skillRuntimeAdapterInstructions(
  skills: readonly string[],
  enabledTools: readonly WorkspaceToolName[],
): string {
  const available = new Set(enabledTools);
  return [...new Set(skills)]
    .flatMap((skill) => {
      const required = SKILL_TOOL_REQUIREMENTS[skill] ?? [];
      if (!required.every((tool) => available.has(tool))) return [];
      const instruction = SKILL_RUNTIME_ADAPTERS[skill];
      return instruction ? [`- ${skill}：${instruction}`] : [];
    })
    .join("\n");
}
