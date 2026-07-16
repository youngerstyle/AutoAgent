# Pi Agent Runtime 替换设计

## 目标

用 Pi 的可嵌入 Agent Session 替换 AutoAgent 自研的模型工具循环，停止重复实现会话组装、工具调用、上下文压缩、重试、中断和 Shell 执行。Ticket Engine、Mission Control 与 Agent 领域状态保持独立，Pi 不拥有任何工单或计划状态。

## 边界

### 保留

- `AgentEngine`：线程、Turn、Goal、消息、提案和宿主决议的持久事实。
- `TicketEngine`：Ticket、Plan、依赖、领取、完成、退回和终态。
- `MissionProcessManager`：Ticket 与 Agent Goal 的绑定、上游 handoff、调度和提交。
- 智能体档案：Soul、Identity、Agent、模型、工具和权限配置。
- `goal_resolution` 协议：Agent 对当前 Goal 的结构化完成判断。

### 替换

- `AgentToolLoop` 的模型轮询和工具后续调用。
- `RegistryAgentProviderAdapter` 的直接 Provider 调用路径。
- 自研上下文压缩执行路径。
- 自研 `shell`、文件读写和后台服务工具循环。

## 单向数据流

1. Mission Control 从 Ticket Engine 读取当前 Ticket、成功标准和直接上游 handoff。
2. Mission Control 在 `AgentEngine` 中创建或恢复 Agent Goal 和线程。
3. Pi Runtime Adapter 将稳定档案、当前 Goal、按时间序排列的线程消息和授权工具装入一个 Pi Session。
4. Pi 负责模型调用、原生工具执行、错误反馈、压缩、重试、中断和继续运行。
5. Pi 产生的 human、assistant、tool call、tool result 和 compaction 事件按原顺序追加到 `AgentEngine`。
6. Agent 调用自定义 `goal_resolution` 工具提交提案；Adapter 只记录提案，不直接修改 Ticket。
7. Mission Control 校验提案并向 Ticket Engine 提交命令，再把宿主决议追加回 Agent 线程。

不存在第二套 Ticket 状态、阶段跳转、角色路由或从文本猜测流转。

## Session 映射

- 一个 Workspace Agent 在一个 Mission 中对应一个持久 Agent Thread。
- 一个 human 消息创建一个 Turn；Ticket Goal 的首次执行也创建一个 Turn。
- Pi Session 是该线程的执行投影，不是新的事实源。
- 服务重启后从 `AgentEngine` 的有序线程重建 Pi Session；不得把已组装 Prompt 再写回历史。
- Pi 的压缩结果作为 replacement history 事件追加，原始事实仍保留用于审计。

## 工具与权限

- 工具集合只来自 Agent 实例的有效策略，不按角色写死。
- 使用 Pi 针对工作目录创建的工具工厂，所有路径以 Workspace 根目录为准。
- Windows 必须显式验证 Shell 解析、命令中断、进程树终止和 UTF-8 输出。
- `goal_resolution` 是 Host 自定义工具，不属于项目文件工具，也不能由 Pi 自动解释为工单完成。

## 失败语义

- Provider 5xx、限流或网络错误由 Pi 的短期重试处理；重试状态必须可见且可中断。
- 工具错误返回同一 Turn，Agent 可自行修正；重复无进展时暂停 Goal，但不改 Ticket 状态。
- `blocked` 只能由 Agent 通过 `goal_resolution` 提交不可替代输入缺失的事实。
- Token 预算是可配置的经济保护，不是固定工具调用轮数；触发后暂停并保留可恢复状态。

## 目标语义保真

- human 原始目标是所有下游 Goal、Ticket 成功标准和最终验收的语义上界。
- Agent 可以用可逆默认值补充目标中没有说明的实现细节，但不能用“首版”“MVP”“核心版”等新口径削弱明确限定词。
- 如果原始目标不可行、成本异常或必须缩小范围，Agent 应提交风险、阻塞或计划变更提案；未经 human 明确变更，不能把降级交付判为原目标完成。
- 这是一条通用 Prompt 合同，不由 Host 根据自然语言关键字或业务领域写分支判断。

## 迁移策略

1. 先增加 `PiAgentRuntimeAdapter`，通过端口接口驱动现有 `AgentEngine`。
2. 用假 Provider/假工具完成确定性的协议测试。
3. 用真实模型在 Windows 空目录完成“创建、运行、验证”技术验证。
4. RuntimeHost 切换到 Pi Adapter。
5. 真实 Tank 任务通过后删除旧执行路径，不长期保留双引擎兼容。

## 上线验收

- 空 Workspace 中，开发能创建多文件项目，不会因缺少现有源码阻塞。
- Windows 下不会生成 Shell 语法残骸；工具失败能在同一 Turn 修正。
- human 私聊只触发目标 Agent 的下一 Turn，消息顺序与界面一致。
- 服务重启后同一 Thread/Goal 可继续，不重放已完成 Ticket。
- 上下文超过阈值后可压缩继续，不递归嵌套完整 Prompt。
- Agent 的 `completed` 只形成提案；Mission/Ticket 提交和后续 QA 仍由现有领域层完成。
- 从目标到验收保持语义保真；可逆默认值只能填补空白，不能悄悄降低明确交付要求。
- 使用原句 `1:1复刻 CF 红白机的坦克98 游戏` 跑完整真实链路，并由浏览器操作证据证明交付，不以静态 smoke test 代替。
