# Tool Catalog Configuration Design

## Goal

工具能力必须是一个可配置、可审计的事实来源。Agent prompt、runtime 执行、项目实例配置页都不能各自维护一套工具清单。

## Design

工具定义放在 `src/shared/tool-catalog.ts`，包含工具名、中文标签、说明、类别、是否观察类工具和 prompt 示例。server 侧通过 `src/server/tools/tool-catalog.ts` re-export，避免前后端出现两份目录。

`AgentPolicy.enabledTools` 表示该 Agent 实例启用的具体工具。粗权限仍保留为安全能力边界：

- `canReadWorkspace` 控制 `listFiles`、`readFile`。
- `canWriteWorkspace` 控制项目写入；老板、PM、架构、QA 仍只允许写 `docs/`、`reports/`、`plans/` 下的 `.md/.txt` 文档产物。
- `canExecuteCommands` 控制 `shell`、`startService`、`pollProcess`。

最终可用工具 = `enabledTools` 与粗权限边界的交集。未配置 `enabledTools` 时使用角色默认工具集。

## Runtime Contract

模型返回工具请求后，runtime 先查工具目录和当前 Agent policy：

1. 未知工具：记录 `tool.denied`，返回工具错误给同一个 Agent loop。
2. 已知但未启用或被粗权限挡住：记录 `tool.denied`，返回工具错误给同一个 Agent loop。
3. 只有通过目录校验的工具才进入文件或命令实现。

平台不得因为工具被拒绝而替 Agent 猜流程或改派工单；Agent 需要基于工具结果在下一轮模型调用中自己判断。

## UI

项目团队配置页保留粗权限开关，同时展示每个具体工具的启用状态。UI 只是配置入口，不是安全边界；真正执行仍以后端目录校验为准。
