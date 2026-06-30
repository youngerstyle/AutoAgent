# AutoAgent

AutoAgent 是一个本地自动化团队平台。当前版本可以在一个项目目录里运行一个最小自治团队，并把任务执行过程投射到网页运行台。

当前已内置的最小团队：

- 老板：接收需求、验收、人员调度
- 产品/项目：计划拆解和范围控制
- 架构师：技术方案和能力缺口判断
- 开发：开发实现和工具执行
- 测试：质量检查
- 专家：当架构师报告缺少能力时由系统招募

注意：当前网页里的“团队配置”只是项目内团队成员的运行覆盖配置，例如模型服务、模型名和权限策略。真正的 Agent Studio，也就是 Agent 的 identity、soul、loop definition、capabilities，还在后续 P0 计划里。

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

## 团队运行配置

使用“团队配置”页查看和编辑当前项目里的团队成员运行设置。每个项目会初始化老板、产品/项目、架构师、开发和测试。运行时发现能力缺口后，可以招募专家。

每个项目成员都有独立状态，保存在 `<workspace>/.autoagent/agents/<workspaceAgentId>/agent.json`：

- `provider`：`mock`、`openai` 或 `anthropic`。
- `model`：该成员运行时使用的模型。
- `policyOverride`：读项目、写项目、执行命令、访问本机等权限覆盖。

团队配置 API：

- `GET /api/workspaces/:workspaceId/agents`：初始化并列出项目团队。
- `PATCH /api/workspaces/:workspaceId/agents/:agentId`：更新模型服务、模型名和权限覆盖。

## 存储模型

- 全局状态：`AUTOAGENT_HOME`
- 模型服务状态：`AUTOAGENT_HOME/providers.json`
- 项目状态：`<workspace>/.autoagent`
- 团队成员状态：`<workspace>/.autoagent/agents/<workspaceAgentId>`
- 团队成员会话：`<workspace>/.autoagent/agents/<workspaceAgentId>/sessions`
- 任务事件：`<workspace>/.autoagent/tasks/<taskId>/runs/<taskRunId>/events.jsonl`
- 任务控制状态：`<workspace>/.autoagent/tasks/<taskId>/runs/<taskRunId>/state.json`

项目里的 `.autoagent/` 会自动写入该项目的 `.gitignore`。

## 运行流程

1. 创建或选择项目。
2. 使用 OpenAI 或 Anthropic 时，先配置全局模型服务密钥。
3. 在“团队配置”里按项目需要覆盖成员的模型服务、模型名和权限策略。
4. 在运行台提交任务。
5. 任务调度器依次调度老板、产品/项目、架构师、开发、测试和老板验收。
6. Agent Runtime 在执行 assignment 前读取该项目成员自己的模型服务、模型名和权限。
7. 如果架构师报告能力缺口，老板招募专家，专家会出现在画布上。
8. 测试失败会产生 `qa.failed`，并在重试预算内把任务退回开发。
9. UI 通过 SSE 接收实时事件，并刷新项目快照。

每个项目同一时间只允许一个活跃 `TaskRun`。

## 安全策略

生产策略会把文件访问限制在项目目录内。开发策略允许本机路径访问，适合本地实验。

默认角色权限较保守：产品/项目和老板不能执行命令，开发和测试可以执行命令，开发和专家可以写项目文件。

## 验证命令

```powershell
npm.cmd run test:run
npm.cmd run test:e2e
npm.cmd run typecheck
npm.cmd run build
```

E2E 测试会创建项目，通过 HTTP API 跑完整模拟团队流程，验证专家招募、完成后的快照，以及产物文件写入。

## 当前边界

- 还没有自动 git commit、push 或部署。
- 还没有 marketplace 式招聘界面。
- 真正的 Agent Studio 还未实现。
- 当前团队配置页不是 Agent 本体配置。
- UI 只在内存里保存视图状态；Agent 和任务事实保存在 `.autoagent`。
