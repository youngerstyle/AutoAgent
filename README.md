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

模拟模型服务始终可用，并用于协议与故障恢复测试。它不会真实写文件、启动服务或完成浏览器验收；当任务要求真实交付时，模拟服务会明确阻塞并要求配置真实 Provider，不会伪报完成。OpenAI 和 Anthropic 可以在网页的“模型服务”页配置模型、接口密钥和可选服务地址。密钥保存在 `AUTOAGENT_HOME/providers.json`，通过 API 读取时会脱敏；新写入的 JSON 控制面文件使用仅当前 OS 账户可读写的权限（Windows 仍依赖用户目录 ACL）。更高安全要求下应通过 `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` 环境变量注入，并把 `AUTOAGENT_HOME` 放在仅当前账户可访问的位置。

AutoAgent 当前只支持本机单用户运行，默认并强制监听 `127.0.0.1`（也可显式使用 `::1`）。`AUTOAGENT_HOST=0.0.0.0`、局域网地址和公网地址会拒绝启动；当前版本没有远程多人认证边界，不应通过端口转发或反向代理暴露。

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

## Evol 自进化

Evol 从真实运行事实中发现能力缺口，产生并评测四类本地版本化资产：Memory、Prompt、Skill 和 Local Plugin。Memory、Prompt、Skill 在 active pointer 改变后的下一 turn 重新加载；Local Plugin 在下一 session 重建工具面。当前 turn/session 不热修改，rollback 也在相同的下一生命周期边界生效，并留下 inheritance proof。

临时执行脚本、只写 Candidate 文件或只通过离线评测都不算进化。Local Plugin 必须保存为不可变 Bundle，经过扫描、独立评测和批准，再由内置跨平台子进程 Host 在下一 session 挂载；默认不依赖 WSL、PowerShell、Docker 或外部 Sandbox Provider。

OpenAI、Anthropic、Mock 等模型 Provider 仍由“模型服务”和 Agent 配置选择，不因 Evol 设计而移除。软件源码交付不属于 Evol，也不进入其配置、状态或判断链。

完整语义见 `docs/superpowers/specs/2026-08-14-self-mutation-activation-v1.md`。

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

每个 Plan 还持久化独立的收敛预算。产品默认最多 64 张 Ticket、8 次正式采纳的 Plan 修订；Workflow 可以通过 `convergenceLimits` 覆盖。修订请求本身只占用 Ticket 容量，只有成功的 `apply_change` 才增加正式修订计数。预算耗尽时原命令不会改变 Plan 或 Ticket，Mission 会把当前执行持久化为由 planner 负责的阻塞状态并禁止自动重试；运行台直接展示权威 Ticket 容量和修订使用量。旧版 Plan 没有该字段时保留现有图，从首次迁移后的正式修订开始计数。

## 安全策略

生产策略会把文件访问限制在项目目录内。开发策略允许本机路径访问，适合本地实验。

核心档案提供一组可编辑的初始工具配置。档案或项目实例可以修改这些配置；Agent Engine 只执行最终显式启用且满足安全策略的工具。

## 验证命令

```powershell
npm.cmd run test:run
npm.cmd run test:e2e
npm.cmd run typecheck
npm.cmd run build
npm.cmd run verify:plan-convergence
```

E2E 测试会创建项目，通过 HTTP API 跑完整模拟团队流程，验证 Ticket DAG、Agent Goal、私聊隔离和完成后的权威快照。
`verify:plan-convergence` 会强制耗尽两类预算，并验证类型化拒绝、状态不变、幂等重放和重启稳定性。

## 当前边界

- 还没有自动 git commit、push 或部署。
- 还没有 marketplace 式招聘界面。
- 动态招聘目前只有运行内核与基础档案，尚未提供完整招聘管理界面。
- UI 只在内存里保存视图状态；Agent 和任务事实保存在 `.autoagent`。
