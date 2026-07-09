import type { AgentPolicy, AgentRole, WorkspaceToolName } from "./types.js";

export interface ToolDefinition {
  name: WorkspaceToolName;
  label: string;
  description: string;
  category: "file" | "command" | "process";
  observation: boolean;
  promptExample: string;
}

export const TOOL_CATALOG: ToolDefinition[] = [
  {
    name: "listFiles",
    label: "列文件",
    description: "列出项目目录内容",
    category: "file",
    observation: true,
    promptExample: "{\"toolIntents\":[{\"tool\":\"listFiles\",\"path\":\".\"}]}"
  },
  {
    name: "readFile",
    label: "读文件",
    description: "读取项目文件内容",
    category: "file",
    observation: true,
    promptExample: "{\"toolIntents\":[{\"tool\":\"readFile\",\"path\":\"package.json\"}]}"
  },
  {
    name: "writeFile",
    label: "写文件",
    description: "写入项目文件；非开发角色只允许写文档产物目录",
    category: "file",
    observation: false,
    promptExample: "{\"toolIntents\":[{\"tool\":\"writeFile\",\"path\":\"README.md\",\"content\":\"...\"}]}"
  },
  {
    name: "shell",
    label: "执行命令",
    description: "执行会结束的本地命令",
    category: "command",
    observation: true,
    promptExample: "{\"toolIntents\":[{\"tool\":\"shell\",\"command\":\"npm test\"}]}"
  },
  {
    name: "startService",
    label: "启动服务",
    description: "启动 dev server 等长驻服务",
    category: "process",
    observation: false,
    promptExample: "{\"toolIntents\":[{\"tool\":\"startService\",\"command\":\"npm run dev\"}]}"
  },
  {
    name: "pollProcess",
    label: "查询服务",
    description: "查询已启动服务的运行状态和日志",
    category: "process",
    observation: true,
    promptExample: "{\"toolIntents\":[{\"tool\":\"pollProcess\",\"serviceId\":\"svc_xxx\"}]}"
  }
];

export function roleToolDefaults(role: AgentRole): WorkspaceToolName[] {
  if (role === "dev" || role === "specialist") return ["listFiles", "readFile", "writeFile", "shell", "startService", "pollProcess"];
  if (role === "qa") return ["listFiles", "readFile", "writeFile", "shell", "startService", "pollProcess"];
  return ["listFiles", "readFile", "writeFile"];
}

export function toolsForPolicy(policy: Pick<AgentPolicy, "canReadWorkspace" | "canWriteWorkspace" | "canExecuteCommands" | "enabledTools">, role: AgentRole): ToolDefinition[] {
  const configuredNames = Array.isArray(policy.enabledTools) ? policy.enabledTools : roleToolDefaults(role);
  const configured = new Set(configuredNames);
  return TOOL_CATALOG.filter((tool) => configured.has(tool.name) && policyAllowsTool(policy, role, tool.name));
}

export function isKnownToolName(name: string): name is WorkspaceToolName {
  return TOOL_CATALOG.some((tool) => tool.name === name);
}

export function isObservationTool(name: string): boolean {
  return TOOL_CATALOG.some((tool) => tool.name === name && tool.observation);
}

export function isToolEnabledForPolicy(policy: Pick<AgentPolicy, "canReadWorkspace" | "canWriteWorkspace" | "canExecuteCommands" | "enabledTools">, role: AgentRole, name: string): boolean {
  return isKnownToolName(name) && toolsForPolicy(policy, role).some((tool) => tool.name === name);
}

export function toolProtocolFor(policy: Pick<AgentPolicy, "canReadWorkspace" | "canWriteWorkspace" | "canExecuteCommands" | "enabledTools">, role: AgentRole): string {
  const tools = toolsForPolicy(policy, role);
  const examples = tools.map((tool) => {
    if (tool.name === "writeFile" && !policy.canWriteWorkspace && canWriteDocumentArtifacts(role)) {
      return "{\"toolIntents\":[{\"tool\":\"writeFile\",\"path\":\"docs/notes.md\",\"content\":\"...\"}]}";
    }
    return tool.promptExample;
  });
  const lines = [
    examples.length > 0
      ? `工具协议：需要访问真实项目文件或执行命令时，只能返回当前已启用工具允许的 JSON：${examples.join("、")}。`
      : "工具协议：当前没有启用任何项目工具；需要真实文件、命令或服务能力时，必须通过工单请求有权限的 Agent 或请求 human。"
  ];
  if (tools.some((tool) => tool.category === "command" || tool.category === "process")) {
    lines.push("命令边界：shell 用于会结束的命令；npm run dev、vite、next dev、http-server、live-server 等长驻服务必须用 startService。工具会返回 serviceId、pid、日志路径和可能的 URL；需要继续观察时用 pollProcess，不能等待长驻命令自然退出。");
  } else {
    lines.push("命令边界：当前没有启用命令类工具，禁止返回 shell、startService 或 pollProcess。需要运行服务、测试或浏览器验证时，把它拆给有权限的工单，或返回 human_action / manual_test_required。");
  }
  return lines.join("\n");
}

function policyAllowsTool(policy: Pick<AgentPolicy, "canReadWorkspace" | "canWriteWorkspace" | "canExecuteCommands">, role: AgentRole, name: WorkspaceToolName): boolean {
  if (name === "listFiles" || name === "readFile") return policy.canReadWorkspace;
  if (name === "writeFile") return policy.canWriteWorkspace || canWriteDocumentArtifacts(role);
  return policy.canExecuteCommands;
}

function canWriteDocumentArtifacts(role: AgentRole): boolean {
  return role === "boss" || role === "pm" || role === "architect" || role === "qa";
}
