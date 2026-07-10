# AutoAgent

AutoAgent 是一个本地自动化团队平台。当前版本可以在一个项目目录里运行一个最小自治团队，并把任务执行过程投射到网页运行台。

当前已内置的最小团队：

- 老板：接收需求、验收、人员调度
- 产品/项目：计划拆解和范围控制
- 架构师：技术方案和能力缺口判断
- 开发：开发实现和工具执行
- 测试：质量检查
- 专家：当架构师报告缺少能力时由系统招募

“智能体档案库”维护可复用 Agent 的 Soul、Identity、能力说明、工具和默认模型；“项目团队实例”维护当前项目中的模型与权限覆盖。运行代码不会根据老板、PM、开发或测试等角色偷偷补工具，实际可用工具以档案和项目实例的显式配置为准。

## 快速启动

```powershell
npm.cmd install
npm.cmd run build
$env:AUTOAGENT_HOME="$HOME\.autoagent"
$env:PORT="8787"
npm.cmd start
```

打开 `http://127.0.0.1:8787`。

开发模式：

```powershell
$env:NODE_ENV="development"
$env:AUTOAGENT_HOME="$HOME\.autoagent"
npm.cmd run dev
```

## 模型服务配置

模拟模型服务始终可用，并用于测试。OpenAI 和 Anthropic 可以在网页的“模型服务”页配置模型、接口密钥和可选服务地址。密钥保存在 `AUTOAGENT_HOME/providers.json`，通过 API 读取时会脱敏。

也可以用环境变量配置：

```powershell
$env:OPENAI_API_KEY="..."
$env:ANTHROPIC_API_KEY="..."
```

也可以在 `AUTOAGENT_HOME/providers.json` 里配置：

```json
{
  "openai": {
    "provider": "openai",
    "model": "gpt-4.1-mini",
    "apiKey": "..."
  },
  "anthropic": {
    "provider": "anthropic",
    "model": "claude-3-5-sonnet-latest",
    "apiKey": "..."
  }
}
```

模型服务 API：

- `GET /api/providers/config`：返回脱敏后的模型服务配置。
- `PATCH /api/providers/:provider`：保存 `openai` 或 `anthropic` 配置。

## Agent 中心和项目团队

使用“智能体档案库”查看可复用 Agent 档案，包括 Soul、Identity、能力说明、工具、模型和记忆边界。使用“项目团队实例”查看当前项目里的 Agent 实例。每个项目会初始化老板、产品/项目、架构师、开发和测试；后续也可以加入招聘得到的新 Agent。

项目团队页不是一组裸模型表单。它的主视图是团队成员和 Agent 详情；模型服务、模型名和权限只作为“项目级覆盖”出现在详情里的“模型与项目权限”区域。

每个项目成员都有独立状态，保存在 `<workspace>/.autoagent/agents/<workspaceAgentId>/agent.json`：

- `provider`：`mock`、`openai` 或 `anthropic`。
- `model`：该成员运行时使用的模型。
- `policyOverride`：读项目、写项目、执行命令、访问本机等权限覆盖。

项目团队 API：

- `GET /api/workspaces/:workspaceId/agents`：初始化并列出项目团队。
- `PATCH /api/workspaces/:workspaceId/agents/:agentId`：更新模型服务、模型名和权限覆盖。

## 存储模型

- 全局状态：`AUTOAGENT_HOME`
- 模型服务状态：`AUTOAGENT_HOME/providers.json`
- 项目状态：`<workspace>/.autoagent`
- 团队成员状态：`<workspace>/.autoagent/agents/<workspaceAgentId>`
- Agent Thread、Goal、消息和协议结果：`<workspace>/.autoagent/agent-engine`
- Agent 完整运行轨迹：`<workspace>/.autoagent/agent-engine/traces`
- Ticket Workflow、DAG、claim 和命令结果：`<workspace>/.autoagent/ticket-engine`
- Mission 关联与恢复游标：`<workspace>/.autoagent/mission-process`
- 当前任务入口索引：`<workspace>/.autoagent/runtime-host.json`

项目里的 `.autoagent/` 会自动写入该项目的 `.gitignore`。

## 运行流程

1. 创建或选择项目。
2. 使用 OpenAI 或 Anthropic 时，先配置全局模型服务密钥。
3. 在“团队配置”里按项目需要覆盖成员的模型服务、模型名和权限策略。
4. 在运行台提交任务。
5. 产品层选择版本化 Workflow 模板；Ticket Engine 按 DAG 依赖释放可执行工单。
6. Mission Process 把可领取 Ticket 可靠地关联到一个 Agent Goal，不决定业务后继。
7. Agent Engine 在同一 Thread 中跨多个 turn 使用显式授权的工具，直到提交 Goal 结论。
8. Ticket Engine 接受合法命令后更新工单，并按 DAG 释放后继；拒绝原因返回同一个 Agent Goal 继续处理。
9. UI 从三个内核的权威事实读取状态；私聊只触发选中的 Agent，全局补充发给老板。

每个项目同一时间只允许一个活跃 `TaskRun`。

## 安全策略

生产策略会把文件访问限制在项目目录内。开发策略允许本机路径访问，适合本地实验。

核心档案提供一组可编辑的初始工具配置。档案或项目实例可以修改这些配置；Agent Engine 只执行最终显式启用且满足安全策略的工具。

## 验证命令

```powershell
npm.cmd run test:run
npm.cmd run test:e2e
npm.cmd run typecheck
npm.cmd run build
```

E2E 测试会创建项目，通过 HTTP API 跑完整模拟团队流程，验证 Ticket DAG、Agent Goal、私聊隔离和完成后的权威快照。

## 当前边界

- 还没有自动 git commit、push 或部署。
- 还没有 marketplace 式招聘界面。
- 动态招聘目前只有运行内核与基础档案，尚未提供完整招聘管理界面。
- UI 只在内存里保存视图状态；Agent 和任务事实保存在 `.autoagent`。
