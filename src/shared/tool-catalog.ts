import type { AgentPolicy, WorkspaceToolName } from "./types.js";

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
    name: "readImage",
    label: "查看图片",
    description: "读取项目中的截图或设计图供视觉模型观察",
    category: "file",
    observation: true,
    promptExample: "由 Provider 原生工具调用 readImage(path)"
  },
  {
    name: "writeFile",
    label: "写文件",
    description: "在授权边界内写入项目文件",
    category: "file",
    observation: false,
    promptExample: "{\"toolIntents\":[{\"tool\":\"writeFile\",\"path\":\"README.md\",\"content\":\"...\"}]}"
  },
  {
    name: "editFile",
    label: "编辑文件",
    description: "在授权边界内通过唯一精确匹配局部编辑项目文件",
    category: "file",
    observation: false,
    promptExample: "{\"toolIntents\":[{\"tool\":\"editFile\",\"path\":\"src/app.ts\",\"oldText\":\"const value = 1;\",\"newText\":\"const value = 2;\"}]}"
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
    promptExample: "{\"toolIntents\":[{\"tool\":\"startService\",\"command\":\"npm run dev -- --port 4173\",\"port\":4173}]}"
  },
  {
    name: "pollProcess",
    label: "查询服务",
    description: "查询已启动服务的运行状态和日志",
    category: "process",
    observation: true,
    promptExample: "{\"toolIntents\":[{\"tool\":\"pollProcess\",\"serviceId\":\"svc_xxx\"}]}"
  },
  {
    name: "browser",
    label: "浏览器",
    description: "使用隔离的真实浏览器会话打开、观察和操作项目页面",
    category: "process",
    observation: true,
    promptExample: "{\"toolIntents\":[{\"tool\":\"browser\",\"browserArgs\":[\"open\",\"http://127.0.0.1:<受管服务端口>\"]}]}"
  }
];

export function toolsForPolicy(policy: Pick<AgentPolicy, "canReadWorkspace" | "canWriteWorkspace" | "canExecuteCommands" | "enabledTools">): ToolDefinition[] {
  const configuredNames = Array.isArray(policy.enabledTools) ? policy.enabledTools : [];
  const configured = new Set(configuredNames);
  if (configured.has("writeFile")) configured.add("editFile");
  return TOOL_CATALOG.filter((tool) => configured.has(tool.name) && policyAllowsTool(policy, tool.name));
}

export function configuredToolsInclude(
  configuredTools: readonly WorkspaceToolName[],
  requiredTool: WorkspaceToolName,
): boolean {
  return configuredTools.includes(requiredTool)
    || (requiredTool === "editFile" && configuredTools.includes("writeFile"));
}

export function isKnownToolName(name: string): name is WorkspaceToolName {
  return TOOL_CATALOG.some((tool) => tool.name === name);
}

export function isObservationTool(name: string): boolean {
  return TOOL_CATALOG.some((tool) => tool.name === name && tool.observation);
}

export function isToolEnabledForPolicy(policy: Pick<AgentPolicy, "canReadWorkspace" | "canWriteWorkspace" | "canExecuteCommands" | "enabledTools">, name: string): boolean {
  return isKnownToolName(name) && toolsForPolicy(policy).some((tool) => tool.name === name);
}

export function permissionPatchForTool(toolName: WorkspaceToolName): Partial<Pick<AgentPolicy, "canReadWorkspace" | "canWriteWorkspace" | "canExecuteCommands">> {
  if (toolName === "listFiles" || toolName === "readFile" || toolName === "readImage") return { canReadWorkspace: true };
  if (toolName === "writeFile" || toolName === "editFile") return { canWriteWorkspace: true };
  return { canExecuteCommands: true };
}

export function toolProtocolFor(policy: Pick<AgentPolicy, "canReadWorkspace" | "canWriteWorkspace" | "canExecuteCommands" | "enabledTools">): string {
  const tools = toolsForPolicy(policy);
  const examples = tools.map((tool) => tool.promptExample);
  const lines = [
    examples.length > 0
      ? `工具协议：需要访问真实项目文件或执行命令时，只能返回当前已启用工具允许的 JSON：${examples.join("、")}。`
      : "工具协议：当前没有启用任何项目工具；需要真实文件、命令或服务能力时，必须通过工单请求有权限的 Agent 或请求 human。"
  ];
  if (tools.some((tool) => tool.category === "command" || tool.category === "process")) {
    lines.push("命令边界：shell 用于会结束的命令；npm run dev、vite、next dev、http-server、live-server 等长驻服务必须用 startService。工具会返回 serviceId、pid、日志路径和可能的 URL；需要继续观察时用 pollProcess，不能等待长驻命令自然退出。");
  } else {
    lines.push("命令边界：当前没有启用命令类工具，禁止返回 shell、startService 或 pollProcess。需要运行服务、测试或浏览器验证时，把它拆给有权限的工单；如果当前工单确实需要不可替代的人工测试，调用 request_human_input(kind=\"manual_test\")，不得输出自定义状态字符串代替工具调用。");
  }
  return lines.join("\n");
}

function policyAllowsTool(policy: Pick<AgentPolicy, "canReadWorkspace" | "canWriteWorkspace" | "canExecuteCommands">, name: WorkspaceToolName): boolean {
  if (name === "listFiles" || name === "readFile" || name === "readImage") return policy.canReadWorkspace;
  if (name === "writeFile" || name === "editFile") return policy.canWriteWorkspace;
  return policy.canExecuteCommands;
}
