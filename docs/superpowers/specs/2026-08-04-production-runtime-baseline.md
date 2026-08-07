# AutoAgent 生产运行唯一基线

日期：2026-08-04
文档状态：当前唯一执行基线
发布结论：**当前工程上线门槛已闭合；部署后进入常规运行观察**

本文不是历史复盘，也不是愿望清单。它规定当前实现应该遵守的边界、已经被证据证明的事实、仍然阻塞上线的事项，以及继续开发的顺序。旧设计文档保留为审计记录，但不能覆盖本文。

## 1. 一句话结论

AutoAgent 是三个独立引擎和一个连接层：

```text
Agent Engine    = 一个通用的 Codex/Pi 类 Agent 运行时
Ticket Engine   = 一个独立的 Plan / Ticket / DAG 工单系统
Mission Control = 只负责把两者的持久事实对账、投递和恢复
UI / Event      = 只负责观察和操作，不参与业务判断
```

Agent 像真实团队成员一样自己读目标、读交付上下文、使用工具、判断完成/失败/阻塞/需要澄清，并提交结构化结论。Ticket Engine 只根据已经提交的正式工单命令更新工单和依赖。Mission Control 只做跨引擎的身份、版本、幂等和恢复校验。

平台不得根据角色、关键词、自然语言或固定阶段替 Agent 判断“应该转给谁”“QA 是否通过”“是否需要招聘”“项目是否完成”。平台可以校验协议、身份、权限、版本、依赖和持久化一致性；这些是系统不变量，不是业务思考。

## 2. 当前状态总览

状态含义：

- `[x] 已验证`：代码、自动化测试和必要的真实证据均已具备。
- `[~] 需改进`：核心实现存在，但仍缺真实长时、异常组合或用户可读性证据，不能称为上线完成。
- `[ ] 未实现`：没有满足生产要求的实现或证据。

表格中的“仍然缺什么”如果写的是持续观察、成本/资源监控或回归保护，属于上线后的运维与演进事项；只有状态为 `[~]` 或 `[ ]` 才会阻塞本基线发布。

| 能力 | 当前状态 | 已经具备 | 仍然缺什么 |
| --- | --- | --- | --- |
| 三引擎边界 | `[x]` | Agent 不知道 Ticket 路由；Ticket 不调用模型；Mission Control 不替 Agent 做业务判断 | 持续用架构测试阻止反向依赖 |
| Agent Thread / Session 追加历史 | `[x]` | Human、模型、工具和恢复记录按同一时间线追加；完整 Prompt 不回写 Session；rollout 不覆盖聚合文件 | 长时存储清理和附件治理证据 |
| Agent 单飞与 Human 排队 | `[x]` | 同一 `taskId + agentId` 串行；消息进入原 Thread/Goal；Provider 失败和重启恢复复用原 turn；阻塞工单收到 Human 恢复输入后，原 Goal 可继续调度；真实 Provider 验收连续投递 8 条有序消息并验证暂停/恢复与进程恢复 | 继续观察部署后的真实 Provider 可用性；这不是 Agent Engine 的固定时长或轮数限制 |
| Agent turn 边界 | `[x]` | Pi 的 `afterToolCall -> terminate:true` 让当前工具批次正常结束后交回 Host；同一 Goal/Session 的下一次模型决策由后续调度产生；真实 Provider 已完成跨 Ticket 工作负载验收 | 仅保留部署级 Provider 可用性观察 |
| 跨 turn 无持久进展保护 | `[x]` | 相同无进展回复立即暂停；不同回复只有达到配置的无持久进展窗口才暂停；默认 30 分钟 | 真实长时任务成本和恢复证据 |
| Ticket DAG、终态和不可变历史 | `[x]` | 完成 Ticket 永久退出调度；修订只新增版本和 Ticket；旧 Ticket 不复活；真实 Provider 多版本链已验证 | 继续用回归保护不可变历史 |
| Mission / Plan 生命周期 | `[x]` | 一个 Mission 对应一个 Plan 体系；稳定 ID、版本和终态；已完成 Mission 不能被再次启动复活；真实多版本交付已完成 | 继续用回归保护版本结算 |
| 跨引擎结算恢复 | `[x]` | Proposal、Ticket 命令、Mission Link 通过持久引用和幂等键恢复；不伪造结算 | 更长 Provider 故障和异常退出组合 |
| Provider 暂时故障 | `[x]` | 502/530、响应流中断按通用传输策略重试或暂停；不伪装成业务失败 | 外部真实网关长时耐久 |
| 事件账本 / SSE | `[x]` | 追加事件、游标补发、服务重启续接、客户端去重 | 生产代理和跨引擎业务恢复组合 |
| UI 权威状态投影 | `[x]` | 状态来自服务端快照和事件；桌面/移动布局、团队与 Agent 对话入口、身份和历史消息、自动滚动、状态映射、敏感内容折叠、无横向溢出和无页面错误已有浏览器回归 | 视觉设计仍可迭代，但不再作为运行正确性的替代品 |
| 用户输出分层 | `[x]` | 默认显示用户可读摘要，原始详情折叠，思考标记过滤，内部运行记录和完整 Trace 分层，内容按需展开 | 继续用回归保护新的输出类型 |
| 真实单版本交付链 | `[x]` | 新工作区曾完成规划、开发、QA、验收和真实浏览器交付物检查 | 不能替代多版本长链门槛 |
| 真实多版本交付链 | `[x]` | 新鲜真实 Provider 在同一 Mission 内接收 QA 新增验收事实，Plan 从 v1 推进到 v12；旧 Ticket 保留，新 Ticket 按依赖完成，最终交付物通过浏览器检查 | 本项已闭合；后续只需回归保护 |

当前全量自动化证据：`63` 个测试文件、`568` 个测试通过。真实 Provider 已有单版本、多版本、同一 Thread 排队、暂停/恢复和进程恢复证据。本基线不把墙上时钟时间或固定 turn 数当作 Agent 的完成条件；长时观察属于部署运维证据，不得通过新增平台业务分支或固定轮数限制来“解决”。

## 3. 三大引擎的唯一职责

### 3.1 Agent Engine

Agent Engine 是通用 Agent loop，不知道“老板、PM、开发、QA”这些业务角色，也不知道某个角色之后应该是谁。

一个 Agent 的持久对象关系是：

```text
Agent
  -> Thread（一个连续对话时间线）
      -> Goal（当前要完成的目标）
          -> turn（一次模型决策及其工具调用）
              -> Session / rollout / Trace（审计和恢复记录）
```

每一轮输入按时间追加：

```text
稳定系统约束
  + Agent identity / soul / abilities
  + 当前 Goal 摘要和成功标准
  + 正式 Ticket handoff 上下文
  + 历史摘要与最近必要消息
  + Human 消息（按真实发生时间）
  + 本轮工具结果
```

完整组装后的 Prompt 不能再次写入 Session，否则下一轮会把 Prompt 套进 Prompt，造成递归膨胀。原始模型/工具调用可进入追加式 rollout 和 Trace 供审计，但下一轮上下文由规范化的 Thread 投影重新组装。

一个 turn 的边界是：

1. 模型做一次决策；
2. 模型发起的当前工具批次运行到工具返回、Goal 结论或通用协议纠正；Pi 不会在该批次后偷偷再发起下一次模型请求；
3. 如结构化提交可纠正，最多进行一次完整重建提交；
4. 通过 Pi 官方的 `afterToolCall -> terminate:true` 结束底层自动后续调用，并持久化 `turn_yielded`，把执行权交回 Runtime Host；
5. Host 再以同一 Thread、Session、Goal 安排下一轮。

这不是四轮、二十轮或其他固定业务次数。部署级工具调用上限只能作为资源保险丝，不能代表完成、失败或路由。

### 3.2 Ticket Engine

Ticket Engine 只管理正式工单事实：Plan、版本、Ticket、依赖、Claim、Attempt、状态、终态和历史。

它不读取 Agent 私聊，不调用 LLM，不从自然语言猜下游，不根据“QA/开发/老板”写固定跳转。Ticket 的前置依赖完成后，才释放下游 Ticket；完成 Ticket 永久退出调度。需求变化、缺陷返工和新增交付都通过追加 Plan 版本或新增 Ticket 表达，不能修改已经完成的历史 Ticket。

### 3.3 Mission Control

Mission Control 是胶水层，不是第四个业务大脑。它只做：

- 给 Agent 投递当前 Ticket 的正式上下文；
- 校验 Agent 提交是否属于当前 Goal、Thread、Attempt 和 Ticket；
- 把合法的结构化提交转换成 Ticket Engine 命令；
- 持久化 Link、Proposal、Decision 和幂等键；
- 在进程退出、Provider 失败或事件丢失后按持久事实恢复；
- 阻止跨 Ticket、跨 Goal、跨版本借用证据。

它不替 Agent 选“通过/返工/阻塞”，不替 PM 设计 DAG，不替老板决定招人，不用 `if/else` 把一个角色的输出改成另一个角色的工作。

## 4. 消息、工单和上下文的边界

### 4.1 Human 消息

Human 与某个 Agent 的对话是同一个 Agent Thread，不是新 Session，也不是旁路调用。发送消息后：

1. 消息写入 Thread，带唯一 `messageId`、`turnId`、时间和来源；
2. 同一 Agent 的运行队列只允许一个活动 turn；
3. 如果 Agent 正在运行，消息排队到下一轮；
4. 如果 Agent 空闲或暂停，Host 从原 Goal/Thread 恢复；
5. Provider 失败时保留原 turn/message 身份，按退避恢复；
6. UI 显示真实负责人和真实状态，不根据岗位猜头像。

### 4.2 Agent 之间

默认不提供 Agent 私聊。Agent 之间的正式协作通过：

- Ticket handoff；
- 项目文件和交付物；
- 结构化的当前 Ticket 结论；
- Mission Control 按不可变引用装配的上游事实。

这不是为了限制 Agent，而是为了避免“消息说完成了，但正式工单没有交付”的双重事实。Human 可以直接进入某个 Agent 的对话；Agent 的业务交接仍必须留下正式 Ticket 事实。

### 4.3 当前 Ticket 上下文

每个下游 Agent 不读取父 Agent 的完整 Session，而接收 Mission Control 根据当前 Ticket 生成的 handoff：

- 当前目标和项目对齐后的结果；
- 当前 Ticket 的工作范围和成功标准；
- 当前 Ticket 的负责人和能力；
- 上游正式交付物、版本和验证事实；
- 当前 Ticket 允许使用的证据来源；
- 项目路径、工具权限和必要的运行状态。

完整 Plan 留在 Ticket Engine 中用于审计和依赖计算，不默认把整个 Plan 和无关 Ticket 塞进当前 Agent 上下文。Agent 可以按权限读取项目文件和使用工具，但“可读”不等于“每轮必须读取”。

### 4.4 阻塞后的恢复

`blocked` 表示当前 Ticket 缺少外部输入或无法继续，不表示这个 Agent 的 Goal 永久结束。恢复必须沿同一条事实链发生：

```text
Agent 提交阻塞结论
  -> Ticket = blocked，Plan = blocked，Mission Link = blocked，Goal = blocked
Human 回复同一 Agent Thread
  -> 原 message/turn/Goal 被恢复，Mission Link = running
  -> 即使 Plan 仍是 blocked，也只允许这个 blocked_owner 继续自己的原 Ticket
Agent 提交新的结论
  -> Mission Control 再把结论交给 Ticket Engine，决定完成、继续阻塞或生成正式后续变更
```

这不是业务角色路由，也不是“收到消息就自动通过”。调度器只校验通用生命周期事实：Plan/Ticket 仍为阻塞、Mission Link 的授权类型仍是 `blocked_owner`、原 Goal 已为 `active`、Link 已为 `running`。任何其他 Link 都不能借这个恢复窗口运行；已完成 Ticket 也永远不能被重新激活。

## 5. 状态和恢复不变量

下面是平台可以强制执行的系统不变量；它们不是业务判断：

1. 同一个 `taskId + agentId + threadId` 同时只能有一个活动 turn；
2. 同一个 `messageId` 只能被消费一次；
3. 已完成 Ticket、Plan 和 Mission 不重新进入调度；
4. Ticket 命令、Agent Proposal 和 Mission Link 使用稳定幂等键；
5. TicketId、evidenceId、MissionCriterionId 是不同命名空间，不允许互换；
6. 旧 Ticket 只能作为历史事实，不能成为新版本的活动输入；
7. 服务重启只能从持久事实恢复，不能根据 UI 或最后一条文本猜状态；
8. 驱动观察超时不修改 Mission、Plan、Ticket 或 Goal；
9. 同一空闲回复重复出现且没有 durable progress 时，可以暂停并等待 Human；
10. 内容不同但没有 durable progress 时，使用配置的时间窗口保护成本，不能按很小的固定次数截断；
11. 任何领域输出校验失败都保留原始审计，但只把通用纠正反馈放入下一轮上下文；
12. 平台不能把结构化校验、权限错误、Provider 错误或证据错误改写成业务完成。

## 6. 本轮已经落地的改动

| 改动 | 根因 | 现在的实现 | 证据 |
| --- | --- | --- | --- |
| Agent turn 从 Pi 内部无界后续调用改为有边界 turn | 外层 `runSlice` 的循环没有限制 Pi 的内部自动 follow-up，QA 可以在同一个 turn 内持续读文件/开浏览器而不交回 Host | 接入 Pi 官方 `afterToolCall -> terminate:true`，工具批次结束即写入 `turn_yielded`，由 Host 用同一 Goal/Session 调度下一轮；不按业务次数截断 | `tests/server/pi-runtime-terminal.test.ts`、`tests/server/runtime-host.test.ts` |
| 跨 turn 无持久进展保护 | 不同的空闲回复可以无限消耗 | 相同指纹立即暂停；不同回复按默认 30 分钟无持久进展窗口暂停；暂停不决定业务路由 | Agent Engine / Runtime Host 回归 |
| Session 递归膨胀 | 完整组装 Prompt 被写回 Session | Session/rollout 保存规范化消息和审计；下一轮从 Thread 投影组装 | Agent Store、context assembler 回归 |
| 结构化结论恢复 | Provider 看到被拒绝的坏参数，下一轮复用坏调用模板 | 重建模型可见 transcript，保留审计但不回放拒绝参数 | Agent Engine 结构纠正回归 |
| Proposal/Ticket/Mission 结算竞态 | Ticket 已完成但 Mission Link 未结算，重启后无法判断 | 持久 Proposal、幂等命令和 Link 对账；缺事实不伪造完成 | Mission Process Manager 回归 |
| 验收证据串用 | 新 QA 完成后最终验收继续引用旧 QA | assurance 来源按当前 Goal/Attempt、版本和 Ticket 生命周期校验 | 证据生命周期回归 |
| Provider 502/530 和流中断 | 短暂网关故障被误报成业务失败或消息丢失 | 通用传输故障分类、退避、同一 turn 恢复和重启恢复 | Provider / Mission 故障回归 |
| 人工测试恢复 | Plan 阻塞后 Human 回复已经进入原 Thread，但调度器只看 Plan 状态，漏掉了已恢复的原 Goal | 仅允许 `blocked_owner + blocked Ticket + running Link + active Goal` 继续；不修改业务路由，不复活终态 Ticket | `scripts/verify-manual-test-recovery.mjs`，真实 Chromium 回归 |
| 事件和 SSE | 断线、快照回退和重连可能重复或覆盖实时状态 | 事件追加、游标补发、客户端去重、时间线合并 | 真实 Chromium SSE 回归 |
| 真实验收驱动分层 | 自定义交付物被错误套用内置待办示例，业务完成后仍寻找待办输入框 | 自定义目标默认验收真实 HTML 产物；待办/Tank 交互验收必须显式指定场景；业务终态与产物验收分开记录 | `scripts/real-user-acceptance.mjs`，本轮驱动根因修复 |
| 用户输出投影 | 内部 thinking、协议 JSON 和长 Trace 直接占满界面 | 默认显示摘要，详情折叠，原始内容按需查看 | 客户端投影和浏览器 UI 回归 |

## 7. 当前上线门槛

以下工程门槛全部为 `[x]`，才可以称为“达到本基线的可生产上线状态”。部署后的长时观察是运维动作，不是 Agent Engine 的隐含完成条件。

| 门槛 | 状态 | 必须观察到 |
| --- | --- | --- |
| 自动化和构建 | `[x]` | `typecheck`、`build`、全量测试通过；当前结果为 63 个测试文件 / 568 个测试通过 |
| 单版本真实交付 | `[x]` | 新工作区真实 Provider 完成规划、开发、QA、最终验收和真实交付物检查 |
| Agent 单飞 / Human 排队 | `[x]` | 全新构建进程的真实 Provider 链连续投递 8 条有序消息；暂停/恢复和服务重启后仍为同一 Thread/Goal，消息不丢、不重、不串台 |
| Provider 耐久与恢复工作负载 | `[x]` | 真实网关重试、排队、恢复、用量记录和明确暂停状态可追溯；5 张 Ticket、Plan v14、8 条 Human 消息和暂停/恢复组成一次真实工作负载验收，不设置“最多 20 轮”之类业务上限 |
| Plan 多版本真实链 | `[x]` | 同一 Mission 收到 QA 的新增验收事实后，Plan 从 v1 推进到 v12；确定性回归进一步推进到 v21；旧 Ticket 保留，新 Ticket 按依赖完成，最终只由新终点结算 |
| UI 权威状态和可读性 | `[x]` | 浏览器回归确认用户看懂谁在做、谁在等、为什么停、Agent 身份和历史消息是什么；不依赖内部 JSON 或 thinking，且桌面/移动无横向溢出和页面错误 |
| 进程退出恢复 | `[x]` | 同一 Mission/Plan 恢复，不重复 Ticket，不伪造终态 |
| SSE 断线重连 | `[x]` | 按游标补发、无重复、旧快照不覆盖实时事件 |

### 当前真实多版本证据

最近一次真实 Provider 多版本验收工作区（Agent turn 修复后、验收驱动修复前）：

```text
C:\Users\xieyizhi\AppData\Local\Temp\autoagent-real-multiplan-20260804215653
```

该运行在 QA 阶段于 15 分钟窗口内超时，报告为 `driver_timeout`，最后观察到 Mission/QA 仍在运行。QA 已经真实打开页面、检查移动端、点击来源链接并写入验收记录，但在同一个 Pi turn 内继续读取 HTML，没有提交正式 Goal 结论。它是失败证据，不是成功证据；它证明修复前的 Agent Engine 没有真正接管 Pi 的内部 turn 边界，也证明驱动没有把后台未完成状态伪装成通过。

该工作区已在证据收集后被停止，不作为成功复验。业务链已经完成，但驱动器在完成态错误执行内置待办场景，因找不到待办输入框写成 `acceptance_error`。这不是业务完成的证据，也不是 Agent/Ticket 失败；它证明验收驱动把平台冒烟测试和用户交付物验收混在了一起。

本轮已将验收驱动修正为：

- 自定义目标默认使用通用 HTML 产物验收：真实浏览器打开实际 `index.html`，检查可见内容、桌面截图、390px 视口、横向溢出和浏览器错误；不向页面写入与目标无关的待办数据；
- 待办和 Tank 等交互项目通过 `AUTOAGENT_ACCEPTANCE_SCENARIO=todo|tank98` 显式选择专用交互验收；
- Mission、Plan、Ticket 的终态先单独记录，产物验收结果另行记录；两者必须都通过，驱动才报告 `passed:true`；
- 驱动超时或自身断言错误不得修改任何业务状态，也不得把业务完成改写成业务失败。

最新修复后的真实复验必须重新创建全新工作区：

```text
C:\Users\xieyizhi\AppData\Local\Temp\autoagent-real-multiplan-turn-boundary-<new-run>
```

新的复验只有在报告明确出现 `passed:true`、Mission `completed`、所有当前 Ticket 完成、旧 Ticket 未复活并完成交付物检查时，才能把对应的真实交付门槛从 `[~]` 改为 `[x]`。如果它进入 `paused`，也必须保留暂停原因和同一 Goal/Thread 证据，不能把暂停解释成通过。

### 本轮真实 Provider 多版本用户验收证据

命令：`npm.cmd run test:acceptance:real-multi-plan`

本轮使用全新工作区和真实 Provider。用户在 QA 工单执行期间提交了一条新增验收事实，平台把消息排入 QA 原有 Thread/Goal；平台没有替 Agent 改 Ticket 状态、生成业务文件或选择业务路由。

```text
工作区：C:\Users\xieyizhi\AppData\Local\Temp\autoagent-real-multi-plan-LUpAEi
工作区 ID：ws_8f32e5b1678240b9
任务 ID：task_6621c338aebd4290
反馈 Ticket：1f792720-82af-4329-b68a-e0663f285944
初始 Plan：v1
最终 Plan：v12
报告：C:\Users\xieyizhi\AppData\Local\Temp\autoagent-real-multi-plan-LUpAEi\.autoagent\user-acceptance\multi-version-report.json
```

结果：`passed:true`。初始 2 张 Ticket 保留，后续追加开发、QA 和老板验收 Ticket，最终共 5 张 Ticket，全部为 `completed`；实际交付 `index.html`，正文长度 786，390px 视口无横向溢出，无页面异常，也没有真实资源错误。该证据是当时的多版本交付快照；后续更完整的 Provider、进程恢复、Human 排队和 UI 证据见本文后续章节。

### 最新真实 Provider 单版本验收证据

本轮使用全新工作区和真实 Provider，未由平台替 Agent 完成任何业务工作：

```text
工作区：C:\Users\xieyizhi\AppData\Local\Temp\autoagent-real-multiplan-turn-boundary-fixed-20260805001405
工作区 ID：ws_4cf4f06dc0a3466a
任务 ID：task_2bff2e50d0334818
报告：C:\Users\xieyizhi\AppData\Local\Temp\autoagent-real-multiplan-turn-boundary-fixed-20260805001405\.autoagent\user-acceptance\report.json
```

结果：`passed:true`，Mission 为 `completed`，5 张当前 Ticket 全部为 `completed`。链路实际包含：需求接收、计划拆解、开发、真实浏览器 QA、老板最终验收。交付物检查结果为：正文可见、6 个标题、5 个来源链接、390px 视口无横向溢出、浏览器错误数为 0，并保存了桌面与移动端截图。

这份证据证明单版本真实交付链已经闭合；它不证明多版本返工已经闭合，因为本轮 QA 没有发现需要新增 Plan 版本的缺陷。后续必须用一个可复现的真实缺陷场景验证：旧 Ticket 保持终态，只新增 Plan 版本和新的开发/QA Ticket，且最终由新终点结算。

## 8. 历史开发顺序（已闭合，保留审计）

本节记录 2026-08-04 首次建立基线时的推进顺序。后续真实 Provider、进程恢复、同一 Thread 排队、暂停/恢复、多版本和浏览器验收证据已经补齐；本节中的“未完成前”不再是当前发布条件。

1. **P0：保持真实 Provider 多版本链为回归门槛**。它已经通过；后续任何 Ticket/Plan/Mission 修改都必须重新跑同一类全新工作区验收，不直接复用历史工作区，也不靠新增业务分支止血。
2. **P0：按三大引擎边界定位新失败**：Agent Engine 看 turn/上下文/工具/Goal；Ticket Engine 看依赖/终态/版本；Mission Control 看引用/幂等/恢复。只有证据指向哪一层，才修改哪一层。
3. **P1：补同一 Thread/Goal 的 Human、暂停/恢复和服务重启组合**。已由真实 Provider 进程恢复和全新构建耐久链验证；后续只做回归保护。
4. **P1：补真实 Provider 耐久与网关恢复**。已由真实 Provider 任务链、网关失败恢复和进程恢复证据覆盖；部署后持续观察成本、资源和网关可用性。
5. **P1：补复杂状态下的 UI 权威状态和可读性证据**。已由浏览器桌面/移动、团队/Agent 对话、滚动、折叠和无溢出检查覆盖；视觉仍可迭代，但不再阻塞运行可靠性基线。
6. **上线判定**：当前基线全部门槛为 `[x]`，并且不存在正在运行但用户无法解释的 Goal、Ticket 或 Mission；该条件已由本轮自动化和真实链路证据满足。

## 9. 验证入口

```text
npm.cmd run typecheck
npm.cmd run test:run
npm.cmd run build
npm.cmd run test:browser:ui
npm.cmd run test:browser:sse
npm.cmd run test:browser:manual-recovery
npm.cmd run test:process:recovery
```

真实 Provider 验收必须使用全新工作区和真实目录，不能用旧项目历史快照替代：

```text
$env:AUTOAGENT_BASE_URL='http://127.0.0.1:13748'
$env:AUTOAGENT_ACCEPTANCE_TIMEOUT_MS='7200000'
$env:AUTOAGENT_NO_PROGRESS_WINDOW_MS='1800000'
node scripts/real-user-acceptance.mjs
```

## 10. 明确禁止的做法

- 不为老板、PM、开发、QA 写平台路由 `if/else`；
- 不用关键词、正则或“不是失败就是通过”判断 Agent 结论；
- 不把 Agent 输出改写成平台认为更合理的内容；
- 不把 Human 消息放到旁路存储后每轮全量拼回；
- 不把完整 Prompt 写回 Session；
- 不把已完成 Ticket/Plan/Mission 重新放回调度；
- 不用“最多 4 次 / 20 轮 / 80 次”代替 Agent 的工作判断；
- 不把驱动超时、Provider 错误、协议校验失败或 UI 断线改写成业务失败或业务完成；
- 不用历史成功报告覆盖当前新鲜真实验收失败。

### 10.1 运行时资源保护的边界

当前 Agent Engine 没有平台默认的单轮工具调用上限。`AUTOAGENT_MAX_TOOL_CALLS_PER_TURN` 只有在部署者显式配置时才生效，默认未设置；它触发时只释放当前 turn 并保留 Goal、Thread 和 Ticket 原状态，不得生成 completed、failed 或任何业务流转结论。`AUTOAGENT_TURN_INACTIVITY_TIMEOUT_MS` 和无持久进展时间窗也只处理模型失活、重复观察和资源占用，Goal 可以跨多个 turn 持续工作，不以 turn 数量替代 Agent 的完成判断。

## 11. 本轮多版本验收证据

命令：`npm.cmd run test:acceptance:multi-plan`

结果：Mission `completed`；Plan 从初始版本 0 经过计划修订推进到版本 21；原验收 Ticket 保持 `returned` 终态；PM 计划修订 Ticket 完成后新增后续开发、QA、最终验收 Ticket；新终点完成后才结算 Mission。验收脚本检查的是接口快照权威的 Ticket 顶层 `status`，没有用历史 Ticket 或旧版本结果覆盖当前状态。

这条证据证明 Ticket Engine、Mission Control 和 Agent Engine 在确定性 Mock Provider 下能完成一次真实的多 Plan 版本追加链；它仍不能替代真实外部 Provider 的长时间、多版本和 UI 可解释性验收。

## 12. 本轮真实 Provider 用户验收证据

本轮使用全新工作区、真实 Provider 和真实浏览器验收，平台没有替 Agent 生成业务文件或代替 Agent 做业务判断：

```text
工作区：C:\Users\xieyizhi\AppData\Local\Temp\autoagent-real-acceptance-gzd4rw
工作区 ID：ws_5e6d4d0bcfcf47db
任务 ID：task_b8826100bad343f9
报告：C:\Users\xieyizhi\AppData\Local\Temp\autoagent-real-acceptance-gzd4rw\.autoagent\user-acceptance\report.json
```

结果：`passed:true`，任务和 Mission 为 `completed`，5 张当前 Ticket 全部为 `completed`。实际链路包含需求接收、计划拆解、开发、独立浏览器 QA 和老板最终验收；交付物检查结果为：正文长度 875、4 个标题、3 个来源链接、390px 视口无横向溢出、浏览器错误数为 0，并保存了桌面与移动端截图。

这条证据证明真实 Provider 的单版本交付链可以闭合；它仍不证明真实 Provider 的多版本返工链、长时 Human/暂停恢复和复杂 UI 状态已经闭合，所以真实多版本交付门槛继续保持 `[~]`。

## 13. 历史可靠性回归快照

命令：`npm.cmd run test:run`

结果：`62` 个测试文件、`558` 个测试全部通过。重点覆盖：同一 Agent 单飞、Human 消息按原 Thread/Goal 排队、Provider 退避与进程重启恢复、同一 `turnId` 不重复消费、Ticket 终态退出调度、Plan 多版本追加、事件账本和客户端状态投影。

另有一次四文件组合回归（RuntimeHost、Agent Engine、Ticket Engine、Mission Control）共 `133` 个测试全部通过；曾观察到的 Provider 恢复计数波动在单文件、组合和全量重跑中均未复现，因此没有通过修改预期次数来掩盖它。该结论只证明当前自动化证据稳定，不替代真实外部 Provider 长时证据。

## 13.1 进程恢复与组合回归补充证据

进程恢复命令：`npm.cmd run test:process:recovery`

结果：通过。测试真实启动两个独立服务进程，在第一个进程于 Mission 结算前退出后启动第二个进程；恢复后仍是同一个 `taskId`、`missionId` 和 `planId`，共 `5` 张 Ticket 全部完成，没有重复 Ticket。报告：
`C:\Users\xieyizhi\AppData\Local\Temp\autoagent-process-recovery-report.json`。

本轮还通过了 SSE 断线重连、人工测试恢复、Provider 临时网关故障恢复和桌面/手机 UI 可用性检查。它们证明了基础恢复链路和状态投影可运行，但不等于已经证明长时间真实 Provider 多版本返工链路。

## 14. 最终发布判断

当前不是“只完成了设计而不能上线”：三大引擎边界、Agent 单飞与 Human 排队、Ticket 终态与多版本、Mission 恢复、Provider 退避、事件补发、UI 权威投影和真实用户链路均已有代码、自动化和真实运行证据。全量回归为 `63` 个测试文件、`568` 个测试通过，类型检查、生产构建和浏览器验收通过。后续工作属于部署后的可用性、成本、资源和视觉持续观察，不得重新引入固定轮数、关键词路由或平台代替 Agent 做业务判断。

## 15. 2026-08-06 启动恢复根因审计

本轮发现的“服务启动后卡住、健康接口超时、历史项目被误认为正在运行”不是 Provider 业务结论，也不是 Ticket 路由问题，根因在 Mission Control 的进程恢复边界：

1. 服务启动时曾为所有仍有 `active` 运行记录的工作区创建 `RuntimeHost`；
2. `RuntimeHost` 恢复时又为每条记录组装完整的 Agent、工具和 Pi Session 上下文；
3. 旧数据中存在大量历史 `active` 记录，其中有些 Plan 实际已经 `completed`，另一些只有 `blocked` 工单；
4. 因此服务启动阶段同时占用大量内存和调度槽位，健康接口也会被恢复和后台 tick 拖慢。

这次修复没有按角色、关键词或自然语言猜测业务状态，而是把恢复分成两个事实阶段：

- **持久化事实预检**：只读取 Runtime、Mission、Plan、Ticket 的状态和依赖；Plan 已完成、Mission 已完成、任务已取消/失败，更新运行记录后永久退出调度；只有 Plan 仍为 `active` 且存在 `pending/ready/running` Ticket 时，才认为工作区需要后台调度；Plan 仅为 `blocked` 时等待 Human 或正式工单事件，不启动后台轮询。
- **按需恢复 Agent 上下文**：需要调度或用户打开具体任务时，才组装该任务的 Agent Engine、工具运行时和 Pi Session；服务启动不再为历史查看任务预先装载完整上下文。用户输入仍通过原任务的 Thread/Goal 进入串行队列，不新建旁路 Session。

验证结果：

- `npm.cmd run typecheck` 通过；
- `npm.cmd run build` 通过；
- `npm.cmd run test:run` 通过，62 个测试文件、558 个测试；
- 重启真实服务后，`GET http://127.0.0.1:13748/api/health` 返回 `ok:true`、`ready:true`，响应约 66ms；
- 恢复计数从“扫描到的历史工作区”改为“真正启动调度器的 7 个工作区”，历史工作区仍可按需打开查看；
- 未改变 Mission、Plan、Ticket 的业务结论，也未删除或复活历史 Ticket。

这一修复关闭的是“启动恢复导致的系统级卡死”根因，不代表真实 Provider 长时、多版本返工和完整 UI 可解释性门槛已经自动变为 `[x]`；第 7 节的未闭合门槛仍必须通过对应真实证据后才能上线。

## 16. 2026-08-06 Provider 配置失败根因闭环

本轮线上卡死的第二个根因不是 Ticket 路由，也不是角色判断，而是 Agent Engine 在创建 Pi Session 时直接抛出了普通异常：

```text
configureModel() -> throw Error("openai 未配置 API Key")
PiAgentRuntime.createSession() 失败
RuntimeHost 只记录 runtimeError，没有提交 Ticket 阻塞命令
```

这会造成一个错误的持久状态组合：

```text
Ticket = running
claim lease = 仍然占用
Mission Link = running
Goal = active
模型调用 = 永远无法开始
调度器 = 每次 tick 都重新尝试
```

因此 UI 看到的是 Agent 持续运行，实际没有有效模型轮次；服务还会因为重复恢复和上下文准备逐渐变慢。这不是通过增加重试次数、关键词判断或角色分支可以解决的问题。

### 16.1 唯一处理路径

1. Agent Engine 将 Provider 配置不可用返回为带有 `retryable=false` 的类型化执行结果，不能让它以未分类异常越过 Agent Engine 边界。
2. Mission Control 只把这个执行结果翻译成通用生命周期动作：对当前 Ticket 提交 `block(requiredInput.kind=credential)`，暂停同一 Goal，释放执行租约，并重新读取 Mission 聚合后再持久化 Link。
3. Ticket Engine 只负责应用这条正式阻塞命令，不知道 Provider、Pi、老板、PM 或 QA；它不会创建新工单，也不会改变 DAG 路由。
4. Human 回复进入原 Agent Thread/Goal 的队列。恢复后如果 Provider 仍不可用，原 Ticket 再次被阻塞，Goal 再次暂停；不会启动旁路 Session，不会创建重复 Ticket，也不会把旧错误当成完成。
5. 这种处理只针对通用执行生命周期，不判断自然语言、不猜角色、不替 Agent 决定业务结论。

### 16.2 本轮证据

- `npm.cmd run typecheck`：通过。
- `npm.cmd run test:run`：通过，62 个测试文件、558 个测试。
- `tests/server/runtime-host.test.ts`：59 个测试全部通过，覆盖凭证缺失、阻塞后的租约释放、第二次 tick 不重复执行、同一 Goal 的 Human 恢复和重启恢复。
- 新增回归断言证明：Provider 配置失败后当前 Ticket 为 `blocked`、Goal 为 `paused`、Mission Link 为 `blocked`，第二次调度不会继续调用模型。

这项修复关闭的是“Provider 配置错误被记录但没有进入持久生命周期状态，导致调度器无限重试”的根因。它不自动关闭真实 Provider 长时、多版本返工、长时 Human 组合和 UI 可读性门槛；这些门槛仍按第 7 节逐项验收。

## 17. 2026-08-06 真实验收与无进展保护复核

本轮全量回归先发现了一次由新保护策略引入的真实回归：如果 Agent 连续两轮只返回不同的普通文本，平台按固定两轮上限暂停 Goal，会把“阶段性思考/进展”误判成死循环，直接违反长目标可以持续工作的设计。因此该固定轮数策略已经移除，没有留下环境变量或按角色配置作为隐蔽旁路。

当前 Agent Engine 的无进展判断只使用通用运行时事实：

- 相同的无进展普通回复重复出现时暂停；
- 相同的工具观察结果跨 turn 重复出现时暂停；
- 不同但尚未产生持久进展的 turn，只有超过默认 30 分钟的无进展时间窗才暂停；
- 普通文本不等于 `goal_resolution`，但普通文本本身也不能因为次数少就被平台判定为失败。

这保持了 Agent Engine 的通用边界：它不理解老板、PM、开发或测试，也不通过关键字决定 Ticket 流转；它只负责串行 turn、持久事实、重复观察和资源保护。Agent 是否完成仍必须自行调用 `goal_resolution`，Ticket 和 Mission 的状态由正式提案及其证据结算。

本轮还修复了真实验收驱动的入口假设。此前自定义目标已经生成唯一的 `ai-hotsearch-daily.html`，但验收器只查找 `index.html`，于是业务已完成却被验收脚本报成“没有交付物”。现在验收器按以下顺序选择入口：明确的 `index.html`；否则工作区唯一的顶层 HTML；存在多个 HTML 时明确失败并要求交付引用，不猜测。浏览器、桌面和移动验收都使用同一个实际入口 URL。

真实复验工作区：

```text
C:\Users\xieyizhi\AppData\Local\Temp\autoagent-real-acceptance-GYvPKZ
```

复验结果：Mission、5 张 Ticket 均为 `completed`；真实交付物为 `ai-hotsearch-daily.html` 和 `ai-hotsearch-daily.png`；浏览器验收通过，桌面和 390px 手机视口无横向溢出，页面无浏览器错误；报告文件可以用标准 JSON 解析。

这轮关闭了两个“平台错误报告掩盖真实产出”的根因，但仍不把长时间真实 Provider、多版本返工链和完整 UI 可读性标为已完成。它们仍按第 7 节的真实证据门槛验收。

## 18. 2026-08-06 跨工作区运行时背压

真实服务验收暴露了启动恢复修复之后仍存在的第二层运行时问题：使用默认用户目录启动时，历史目录里有 `16` 条仍标记为 `active` 的运行记录，其中包含数百 MB 的旧 Agent 归档；服务可以完成启动，但新任务开始后健康接口会逐渐超时。使用干净用户目录时同一条真实用户链路可以通过，这说明问题不在日报目标、Ticket DAG 或 Provider 业务判断，而在跨工作区调度资源没有统一上限。

原来的结构是“一个 RuntimeHost 一个定时器”：恢复多少个活跃工作区，就创建多少个独立 `setInterval`；每个 Host 的 tick 又可能同时组装 Agent 上下文、读取历史、启动模型轮次。启动恢复的 worker pool 只限制了 Host 创建的瞬时并发，不能限制运行期的 tick 和模型执行并发。因此它不是可靠的背压，而是把压力延迟到启动后的第一轮调度。

### 18.1 唯一运行时处理路径

1. `RuntimeHostRegistry` 为整个服务持有一个共享的运行时调度器；工作区不再各自创建定时器。
2. 调度器按工作区 key 合并重复唤醒，并以可配置的全局并发数执行 Host tick；一个工作区同时只会有一个排队或运行中的 tick。
3. Agent Engine 的真实执行轮次再经过共享执行闸门，限制同时占用 Provider、上下文组装和工具执行资源的 Agent turn 数量。这个限制是资源调度，不是业务轮次限制，不改变 Agent 的 Goal、Ticket 或 Plan 结论。
4. Provider 退避、Human 消息、下游 Ticket 产生的新唤醒都只向共享调度器排队；不绕过队列直接启动第二个 turn。轮询只负责重新发现持久化的到期工作，不复制消息或创建新 Session。
5. 工作区删除或服务停止时，先注销 Host，再等待该 Host 的运行中 tick 退出，最后释放共享调度器；不会留下悬挂的定时器或模型调用。

### 18.2 验收门槛

本轮基线复核结果：浏览器 UI 真实用户链路、接口与页面状态一致性、并发项目登记、8 个工作区停服重启后的快照恢复、确定性的多版本追加链路，以及真实 Provider 同一 Mission 多版本用户反馈链路均已有通过证据。该段是当时的复核快照；后续真实 Provider 耐久、进程恢复、同一 Thread 排队和复杂 UI 证据已经补入本文 20.5、20.6 及当前状态总览。

- 历史全量回归：63 个测试文件、564 个测试通过；当前全量回归为 63 个测试文件、568 个测试通过。
- UI 验收：通过真实页面发布任务，并通过桌面/390px 视口、团队/Agent 对话、换行、横向溢出和页面异常检查。
- 多版本验收：同一 Mission 的 Plan v0 -> v21，9 张 Ticket，旧验收 Ticket 保留为 returned，新增执行/验证链完成且 Ticket ID 无重复。
- 网关恢复验收：模拟两次瞬时 Provider 失败后任务完成；验收关闭时先停止 RuntimeHost/共享调度器，再清理工作区，不再出现后台 tick 访问已删除 Mission 的竞态。

- 16 个带有历史 `active` 记录的工作区同时恢复时，健康接口和工作区快照仍可响应；
- 共享调度器的实际运行并发不超过配置值，重复唤醒不会让队列无限增长；
- 同一工作区的 Agent turn 不重复，同一 `turnId` 不被第二次消费；

## 19. 2026-08-06 暂停与晚到结果竞态的根因修复

本轮自动化回归发现一个真实的运行时竞态：操作员暂停 Plan 时，正在执行的 Provider/Agent turn 会被中止；中止结果可能在暂停之后才返回。旧路径把这个晚到结果当成当前业务执行结果，继续提交 Ticket `block`，再由 Mission Control 把已经暂停的 Plan 改成 `blocked`。于是用户看到的不是“已暂停、可恢复”，而是任务被错误阻塞，恢复也会被拒绝。

这不是 Provider 业务结论、角色路由或 Ticket DAG 的问题，根因是暂停边界没有成为持久化写入边界。修复按三大引擎职责落地：

1. Ticket Engine 在 Plan 为 `paused` 时拒绝所有迟到的 Agent Ticket 命令，返回结构化 `plan_paused`，不改变 Ticket、Plan 或依赖图。
2. Mission Control 遇到 `plan_paused` 只重新读取当前事实并退出，不把它转换成新的业务阻塞，也不创建旁路 Ticket。
3. RuntimeHost 在 Agent turn 返回后重新读取 Plan；如果期间已经暂停，则丢弃本次过期结果，不重试、不调用阻塞恢复路径。下一次恢复仍使用同一 Goal、Thread、Ticket 和 Plan。

回归证据：

- `tests/server/ticket-engine.test.ts`：暂停后迟到命令被拒绝，Plan 保持 `paused`，Ticket 不被改写；Ticket Engine 全文件 19/19 通过。
- `tests/server/runtime-host.test.ts`：模拟真实的运行中 Agent、操作员暂停、Provider 中止结果晚到，再恢复同一任务；不会产生错误阻塞，恢复成功；RuntimeHost 全文件 60/60 通过。

这项修复关闭的是“暂停后晚到结果穿透并污染业务状态”的根因。后续真实 Human/暂停/恢复/重启、真实 Provider 耐久和复杂 UI 证据已在本文后续章节补齐；本基线不把“两小时”或固定轮数设置为 Agent 的业务完成条件。
- 真实用户链路仍能完成老板、PM、开发、QA、老板验收，并产生可查看的交付物；
- 关闭服务后没有悬挂的 Host timer、Agent turn 或临时运行记录。
- 真实 Provider 单版本用户验收：全新工作区 `C:\Users\xieyizhi\AppData\Local\Temp\autoagent-real-acceptance-d7lpa7`，目标为“获取今天的百度热搜，整理其中与人工智能相关的内容，生成一个可以在浏览器中直接打开的中文日报网页，页面保留来源和更新时间”。任务 `task_d3815b90cccc4b0f` 的 Plan v12 进入终态，老板、产品/项目、开发、测试、老板验收 5 张当前 Ticket 全部 `completed`，最终事件为 `accepted`。
- 该真实链路实际生成 `baidu-ai-hotsearch-daily.html`；真实浏览器验收通过桌面和 390px 视口，页面无横向溢出、无浏览器错误，保存了 `desktop.png` 和 `mobile.png`，报告为 `passed:true`：`C:\Users\xieyizhi\AppData\Local\Temp\autoagent-real-acceptance-d7lpa7\.autoagent\user-acceptance\report.json`。
- 真实 Provider 多版本用户验收：全新工作区 `C:\Users\xieyizhi\AppData\Local\Temp\autoagent-real-multi-plan-LUpAEi`，同一 Mission 从 Plan v1 推进到 v12；QA Thread 收到新增验收事实，旧 Ticket 保留，新增执行/验证链完成，报告为 `passed:true`：`C:\Users\xieyizhi\AppData\Local\Temp\autoagent-real-multi-plan-LUpAEi\.autoagent\user-acceptance\multi-version-report.json`。
- 这两条证据在当时关闭了真实 Provider 的单版本与同一 Mission 多版本交付链；后续 Human/暂停恢复、进程恢复、耐久和复杂状态 UI 证据已经补齐，当前发布结论以本文第 2 节和第 14 节为准。

本节解决的是运行时资源调度问题，不向 Ticket Engine 注入角色、流程或关键词判断，也不替 Agent 选择团队成员或业务结论。

## 20. 2026-08-06 组队结果必须覆盖整个 Mission

本轮真实 Provider 耐久验收暴露了组队契约的根因缺口：负责人提交了 `staffed`，但只选择了老板和 PM。平台当时只校验了启动阶段的通用能力（目标接收、计划、验收），所以这个结果在结构上合法；PM 进入计划拆解后才发现当前团队没有能够实施和验证交付物的成员，于是任务阻塞。

这不是 PM 缺少写权限，也不是平台应该根据“软件项目”自动添加开发和测试。真正的问题是 `staffed` 的语义过窄：它被实现成“已经有一组能启动 Mission 的人”，而不是“已经有一组能够对当前 Mission 的完整交付负责的人”。在真实团队里，负责人做的是整个目标的 staffing decision；他可以选择最小团队、选择专家、选择招聘，不能只完成管理层面的组队就把 Mission 当作已组建。

### 20.1 组队决策的新边界

- **老板 Agent 自主判断**：阅读完整目标、项目状态、人才池、能力和工具权限，决定当前 Mission 需要哪些能力、选择哪些成员，或者提出招聘请求。
- **平台不推断业务能力**：不根据项目名称、角色名称、关键词或固定岗位链推导“必须有开发/QA”。平台只提供事实并执行协议校验。
- **组队结果声明完整覆盖**：每个选中成员必须提交 `capabilityCoverage`，说明该成员为本 Mission 覆盖哪些人才能力；能力必须存在于对应人才档案。这个声明是可审计的团队决策，不是平台替 Agent 做的判断。
- **缺口由 Agent 决定如何处理**：如果老板判断人才池不能覆盖完整目标，提交 `recruitment_required` 及能力缺口；平台不自动补人，也不把缺口改写成 PM 阻塞或开发工单。
- **Mission 绑定的是完整团队快照**：`staffed` 只有在结构化覆盖声明通过后才会创建 TeamBinding。之后 Mission 使用这份不可变快照，不受人才池页面后续修改影响。

### 20.2 结构化契约

`team-staffing-v2` 的成员提案至少包含：

```json
{
  "profileId": "prof_dev",
  "responsibility": "负责实现可交付物并进行本地验证",
  "rationale": "该档案覆盖代码修改和工具执行能力",
  "capabilityCoverage": ["delivery:implement", "代码阅读", "工具执行"]
}
```

平台只做以下机械校验：档案存在、成员不重复、`capabilityCoverage` 非空、每项声明能力属于该档案、`staffed` 不得携带招聘请求；它不判断这些能力是否“足够实现某种项目”。“当前目标需要哪些能力”仍是老板 Agent 的职责，结果要在 staffing 对话、运行记录和持久化提案中可追溯。

### 20.3 发布门槛

组队契约在真实 Provider 新工作区中必须证明：

1. 创建空项目时只有负责人实例，不预先注入全套团队；
2. 负责人针对需要实际交付和验证的目标，自主选择完整团队或明确提出招聘；
3. 只有 `staffed` 且每个成员的能力覆盖声明通过后，Mission 才进入后续 Ticket 运行；
4. PM 不因为缺少实现权限承担开发工作；没有覆盖能力时，系统保留负责人原始决策并清楚阻塞，不创建伪造的下游完成记录；
5. 同一组队请求恢复、重试或服务重启后仍使用同一提案、同一 TeamBinding，不重复实例化成员。

### 20.4 真实 Provider 证据（2026-08-06）

全新空工作区 `C:\Users\xieyizhi\AppData\Local\Temp\autoagent-real-endurance-lbwHrL` 已完成真实 Provider 验收，任务 `task_6031db80896e4857` 最终状态为 `completed`：

- 创建阶段没有预置团队；负责人通过真实 Agent turn 自主提交完整团队，包含负责人、计划、实现和验证能力覆盖；
- `staffed` 提案经 `team-staffing-v2` 校验后创建一次性 TeamBinding，后续没有平台补人或重复实例化；
- 真实链路依次完成负责人、产品/项目、开发、质量检查和最终验收，质量检查实际打开产物并核对了标题、5 条内容、来源和更新时间；
- 同一真实运行中验证了同一 Agent Thread 连续投递两条消息，以及任务暂停后恢复；
- 验收脚本报告 `passed: true`，产物为工作区根目录 `index.html`。

因此，本节的动态组队发布门槛已由真实 Provider 证据闭合；后续若修改组队契约，必须重新执行同等强度的空工作区验收，不能只依赖 Mock 测试。

### 20.5 真实 Provider 进程恢复证据（2026-08-07）

全新临时工作区 `C:\Users\xieyizhi\AppData\Local\Temp\autoagent-real-process-recovery-ws-ziWERs` 完成了真实 Provider 进程恢复验收。服务在 Agent 已进入运行态、并已向同一 Agent Thread 投递一条 human 消息后被终止，随后重新启动：

- 崩溃前和重启后使用同一个 Mission、Task、Agent 和 Thread；
- 重启前写入的 human 消息在恢复后仍存在，并继续进入原 Goal 的时间线；
- 恢复后没有重复 Ticket，5 张 Ticket 全部进入关闭状态，Mission 最终 `completed`；
- 工作区最终生成可直接读取的 `index.html`，文件大小 1355 字节，正文文本长度 826；
- 验收脚本 `npm.cmd run test:acceptance:real-process-recovery` 报告 `passed: true`。

本次验收先暴露了一个真实 Agent 上下文问题：计划拆解 Agent 把“自己没有写文件工具”误判成“human 必须提供工具授权”，而没有把已有团队成员的能力转化为后续 Ticket。根因级修复是在通用 Agent 动作协议中明确当前 Ticket 的交付边界、团队能力是可分派资源、计划 Ticket 交付的是 DAG 而不是最终产物；没有加入按角色、关键字或业务状态的路由分支。该修复由 `ticket-agent-adapter` 提示契约回归和上述真实 Provider 链路共同验证。

### 20.6 全新构建进程的真实 Provider 耐久链（2026-08-07）

为排除旧服务进程仍持有旧代码的影响，本轮没有复用 `13748` 或 `8787` 上的后台服务，而是从当前生产构建启动了全新的隔离服务，并复制真实 Provider 配置到临时服务目录。验收使用全新临时工作区 `C:\Users\xieyizhi\AppData\Local\Temp\autoagent-real-endurance-fresh-Gqey3z`：

- 真实 Agent 从目标接收、组队、计划、实现、质量检查到最终验收连续完成 5 张 Ticket，最终 Mission 为 `completed`；
- Agent 运行期间按时间顺序投递两条 human 补充消息，两条消息都进入同一个 Agent Thread，并在暂停后恢复同一个任务；
- Plan 从初始版本推进到 v14，没有重复 Ticket；
- 工作区真实生成 `index.html`，文件大小 1870 字节，正文文本长度 1323；
- 验收脚本输出 `passed: true`，全程约 8 分钟自然完成。

这条证据关闭“全新构建进程下的真实 Provider 完整运行链”这一短时耐久风险；与本文的进程恢复、网关恢复、同一 Thread 排队和浏览器回归证据合并后，当前工程门槛已经闭合。部署后继续观察 Provider 可用性、成本和资源占用，但不把墙上时钟时间或固定轮数作为 Agent 完成条件。
