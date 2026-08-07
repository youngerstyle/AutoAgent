# Agent Engine 历史恢复与运行时背压设计

日期：2026-08-06
状态：已实现；自动化回归与真实用户链路复验已完成。本文件是 Agent Engine 专题审计记录；当前发布结论以 `2026-08-04-production-runtime-baseline.md` 为唯一准绳。

## 1. 根因

服务启动后，Mission Control 会恢复仍有调度价值的工作区。原实现存在三个基础问题：

1. 每个 `AgentStore` 实例都独立读取同一个 Agent 的 `rollout.jsonl`，同一进程内会重复重放历史。
2. JSONL 重放使用整文件读取、整行拆分和连续同步解析；历史较大时会长时间占用事件循环，健康接口、SSE 和用户操作看起来像卡死。
3. 追加式日志只有审计事实，没有可重建的读取检查点；每次进程重启都可能从第一条记录重新计算聚合。

这不是 Ticket 的业务流转问题，也不是通过减少 Agent 轮数解决的问题，而是 Agent Engine 的持久化读取和运行时调度问题。

## 2. 不变的边界

- `rollout.jsonl` 仍是 Agent 会话的唯一审计事实，永远追加，不覆盖、不删除历史。
- `rollout.index.json` 只是可丢弃的读取投影，不参与业务结论；损坏、缺失或过期时自动从原始 JSONL 重建。
- Agent 的 Goal、Session、Human 消息和工具结果仍按原有时间顺序进入同一个 Thread，不创建旁路 Session。
- 共享调度器只限制运行时资源占用，不判断角色、不判断 Ticket 结论、不替 Agent 做业务决策。

## 3. 实现方案

### 3.1 进程内投影缓存与读取合并

以 Agent 的 rollout 路径为键，多个 `AgentStore` 实例共享带文件大小和修改时间校验的投影缓存，并共享同一条正在进行的读取 Promise。这样同一 Agent 在工作区恢复、快照和 API 查询同时发生时只需要一次历史重放。

外部追加导致大小或修改时间变化时，缓存失效，重新从索引位置或原始日志读取，不使用旧投影覆盖新事实。

### 3.2 可让出事件循环的 JSONL 重放

历史恢复改为流式读取，按换行解析；每处理一批记录主动让出事件循环。恢复任务仍然可以继续处理完整历史，但健康检查、SSE、暂停和用户消息不再被一段长同步解析独占。

### 3.3 可重建读取索引

达到默认 64 个追加提交或 8 MiB 日志大小后，写入一个原子替换的 `rollout.index.json`。索引保存：

- 聚合版本；
- 原始 rollout 的字节偏移；
- 该版本的完整 Agent 投影。

重启时先读取索引，再从偏移继续消费新增 JSONL。索引写入失败不会阻塞 Agent 正式提交；下一次恢复仍可回放原始日志。

### 3.4 全服务运行时资源闸门

此前已经落地的 `RuntimeHostScheduler` 和 `RuntimeExecutionGate` 继续作为服务级资源边界：

- 工作区唤醒按工作区键合并；
- 同一工作区不会并发执行两个 tick；
- Agent 模型/工具 turn 通过共享执行闸门；
- Human 消息、Provider 恢复、Ticket 唤醒都进入同一调度入口。

这只是资源调度，不是业务流程控制。

## 4. 验证结果

已通过：

- `npm.cmd run typecheck`
- Agent Store 与 Agent Engine 回归：37 项通过
- Agent Store 新增索引恢复测试：8 项通过
- `npm.cmd run build`
- 默认用户历史目录真实冷启动：健康接口连续 18 次返回 200，首个响应约 110ms，后续约 12–28ms；恢复状态为 15 个运行时工作区

## 5. 与 Agent turn 边界的关系

历史读取变快不等于 Agent 可以被固定轮数截断。一次真实验收曾暴露：不同的普通文本 turn 被短轮数保护误判为循环，导致长目标在完成前暂停。这个策略已移除。

Agent Engine 只在通用事实成立时暂停：相同无进展回复重复、相同工具观察重复，或不同 turn 在默认无进展时间窗内没有产生持久变化。默认无进展窗口为 30 分钟，不存在“第 N 轮必须结束”的业务限制；`goal_resolution` 仍是 Agent 声明完成或失败的唯一终结入口。

## 6. 验证结果

已通过：

- `npm.cmd run typecheck`
- `npm.cmd run build`
- 历史全量 `npm.cmd run test:run`：63 个测试文件、564 个测试通过；当前全量回归为 63 个测试文件、568 个测试通过。
- Agent Engine 与 RuntimeHost 回归：90 个测试通过；
- 真实已完成工作区复验：实际 HTML 入口、桌面/移动视口、报告 JSON 均通过。

### 6.1 2026-08-06 当前基线复核

本轮补充验证了此前记录中容易被误读的三项边界：

- Agent 卡片的“需要回复”只属于对应 Agent，不再覆盖整个任务的服务端状态；任务状态由服务端快照和事件投影决定。
- 浏览器 UI 验收通过真实页面发布任务，并验证团队/Agent 对话、移动视口、换行、无内部思考泄漏、无横向溢出，以及页面状态与接口快照一致。
- SSE 断线重连验收通过：重连后可以继续收到新的事件账本记录，事件游标没有倒退或重复。
- 人工测试恢复和进程崩溃恢复验收通过：沿用同一 Goal/Thread，恢复后 Mission 完成，未新建重复 Ticket。
- 多版本验收通过同一 Mission 从 Plan v0 追加到 Plan v21：旧验收 Ticket 保留为历史 returned，新执行/验证链追加完成，9 张 Ticket 无重复 ID，Mission 最终 completed。
- 网关恢复验收首次暴露并修复了测试关闭顺序竞态：关闭 HTTP 连接前先停止 RuntimeHost 和共享调度器，再删除临时工作区；修复后不再出现 `Mission does not exist` 或 `ENOTEMPTY`。
- 全量回归为 63 个测试文件、568 个测试通过。

### 6.2 2026-08-06 暂停后的晚到结果

自动化回归进一步复现并修复了暂停竞态：操作员暂停会中止正在运行的 Agent turn，但 Provider 的中止结果可能晚到；旧实现会把它重新写成 Ticket 阻塞，导致 Plan 从 `paused` 错误变成 `blocked`，恢复动作也随之失败。

修复边界如下：

- Ticket Engine 以持久化 Plan 状态为写入闸门；Plan 已暂停时，迟到的 Ticket 命令以 `plan_paused` 拒绝，不改变 Ticket、Plan 或 DAG。
- Mission Control 不把 `plan_paused` 当作执行失败，不调用业务恢复或创建新 Ticket。
- RuntimeHost 在每个 Agent turn 返回后重新读取 Plan；已暂停则丢弃过期结果和后续重试。恢复时仍排入原 Goal/Thread，不启动旁路 Session。

回归结果：`tests/server/ticket-engine.test.ts` 全文件 19/19 通过；`tests/server/runtime-host.test.ts` 全文件 60/60 通过。该修复关闭暂停竞态；后续真实 Provider 耐久和真实页面暂停/恢复证据已汇入主基线。

## 7. 历史待验收清单（已由主基线后续证据闭合）

本设计关闭“历史恢复重复读取和事件循环阻塞”这一根因；上线判断以主基线文档的工程门槛为准。长时观察是部署运维动作，不是平台新增固定轮数或固定时长限制。

这些条目记录当时的发布条件，不代表当前仍有未完成的工程门槛。主基线已经补入真实 Provider、进程恢复、同一 Thread 排队、暂停/恢复、多版本和浏览器 UI 的通过证据。

- 全量 `npm.cmd run test:run` 已通过；
- 浏览器 UI、SSE 断线重连、人工测试恢复和进程恢复已通过；
- 全新工作区和真实 Provider 的完整用户链路已通过；
- 同一工作区内 Human 消息、Agent turn、Ticket handoff 的幂等性已有回归断言；
- UI 已使用权威状态投影，内部调试文本默认不展示。

上述证据已经汇入主基线；不能用“最多 N 轮”或自然语言关键字替代 Agent 自己的 Goal 结论。
- 真实 Provider 单版本用户验收也已复验：全新工作区 `C:\Users\xieyizhi\AppData\Local\Temp\autoagent-real-acceptance-d7lpa7` 中，老板、产品/项目、开发、测试、老板验收 5 张当前 Ticket 全部 `completed`，Plan v12、最终事件 `accepted`；实际产出为 `baidu-ai-hotsearch-daily.html`，桌面/390px 浏览器检查无横向溢出和页面错误，报告为 `passed:true`。
- 这条证据证明真实 Provider 的单版本链可运行；后续更完整的耐久、进程恢复、多版本和 UI 证据已记录在主基线中。
- 真实 Provider 多版本用户验收也已复验：全新工作区 `C:\Users\xieyizhi\AppData\Local\Temp\autoagent-real-multi-plan-LUpAEi` 中，用户在 QA 工单执行期间提交新增验收事实，消息进入 QA 原有 Thread/Goal；同一 Mission 的 Plan 从 v1 推进到 v12，旧 2 张 Ticket 保留，追加开发、QA 和老板验收 Ticket，最终 5 张 Ticket 全部 `completed`。实际产出为 `index.html`，390px 页面无横向溢出、无页面异常和真实资源错误，报告为 `passed:true`：`C:\Users\xieyizhi\AppData\Local\Temp\autoagent-real-multi-plan-LUpAEi\.autoagent\user-acceptance\multi-version-report.json`。
- 该证据关闭真实 Provider 同一 Mission 多版本返工门槛；后续进程恢复、同一 Thread 排队、暂停/恢复和 UI 证据已补齐。

## 8. 组队恢复边界

组队请求也是持久化的 Agent Goal，不是服务启动时由平台重新推断团队。负责人提交的 staffing proposal 必须包含整个 Mission 的成员能力覆盖声明；恢复、重试和进程重启只重新执行同一个 staffing Goal，不能补选成员、改写责任或重新生成另一份团队。

平台只验证稳定事实：人才档案存在、成员不重复、声明的覆盖能力属于对应档案、`staffed` 与招聘请求的组合符合协议。平台不根据目标名称判断应该有哪个岗位，也不在恢复时偷偷加入开发、测试或其他成员。若负责人提交 `recruitment_required`，请求保持阻塞并等待正式招聘结果；若 `staffed` 后续仍无法完成 Mission，由 Ticket/Agent 的正常工作结果暴露缺口，而不是由恢复器改写成另一条业务流程。

## 9. 2026-08-06 最后一轮回归与上线判断

本轮没有新增角色路由、关键字判断或业务兼容分支，只验证已经落地的三大引擎边界、持久化恢复和真实用户链路：

- 运行时压力回归：8 个独立工作区全部完成。
- 进程崩溃恢复：进程在 Mission 结算前退出后，恢复得到 5 张 Ticket，最终状态为 `completed`。
- Provider 短暂网关失败恢复：模拟 2 次暂时失败后恢复完成，Ticket 没有重复 ID。
- 真实 Provider 进程恢复：服务在 Agent 运行态且已收到 human 消息后重启，恢复同一个 Mission、Agent Thread 和消息时间线；5 张 Ticket 全部关闭，生成 `index.html`，验收报告为 `passed: true`。
- 全新构建进程真实 Provider 耐久链：5 张 Ticket 从组队到最终验收完成，运行期间两条 human 消息进入同一 Thread，任务暂停后恢复，Plan 到 v14，真实生成 `index.html`，验收报告为 `passed: true`；该链约 8 分钟自然完成，与进程恢复、网关恢复和浏览器回归证据共同构成当前发布证据。
- 同一 Mission 多版本验收：Plan 从 v0 追加到 v21，旧验收 Ticket 保留为历史，追加的执行、验证和最终验收 Ticket 完成，Mission 最终 `completed`。
- 人工测试恢复：人工回复进入原 Agent Thread/Goal，未启动旁路会话，Mission 最终完成。
- 浏览器与事件流：SSE 断线重连、桌面/移动端页面、团队聊天、Agent 聊天、换行、状态投影和横向溢出检查全部通过。
- 全量自动化回归：63 个测试文件、568 个测试通过；类型检查和生产构建通过。

本轮把“组队提案没有说明完整能力覆盖”这一根因闭合了：`staffed` 现在是负责人对整个 Mission 的团队承诺，每个成员必须声明能力覆盖；平台只核验档案事实，不替负责人决定岗位，也不会启动时自动添加成员。真实 Provider 的新鲜空工作区也已完成完整链路，证据写入生产基线第 20.4 节。

本轮真实进程恢复还暴露并修复了计划拆解上下文的边界缺口：计划 Agent 曾把 Mission 最终交付物和当前计划 Ticket 混为一谈，并因自身缺少写入工具而请求 human 授权。修复后，通用 Agent 协议明确：当前 Ticket 只提交自己的交付物；计划 Ticket 提交可执行 Ticket DAG；已有团队成员的工具能力必须通过新增 Ticket 的 `assignment.requiredTools` 传递，不能把下游能力缺口伪装成人工输入。该修复没有增加角色路由、关键字判断或平台代做业务决策。

之前文档把“两小时”写成发布门槛，这一表述已废止。它既不是 Agent Engine 的运行限制，也不是生产正确性的充分证明。本轮采用可复现工作负载作为工程证据：全新构建进程、5 张 Ticket、Plan v14、8 条按序 Human 消息、暂停/恢复、用量记录、真实 Provider 进程恢复和浏览器 UI 回归均已具备；部署后仍应持续观察 Provider 可用性、成本和资源占用，但不能通过新增平台业务分支或固定轮数来止血。
