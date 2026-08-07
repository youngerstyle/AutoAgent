# AutoAgent 生产运行可靠性设计

## 本轮继续：真实验收暴露结构化终局工具调用不收敛（2026-08-04）

本轮真实用户验收在 QA 已完成真实浏览器操作后暂停。继续核对原始 `debug-log` 后，之前把问题概括为“验收标准数量多于契约”并不准确：当前 QA Ticket 声明的 Mission criterion 数量是 4，Mission baseline 也有 4 条，数量本身一致。

真实失败形状是 Agent Engine 的结构化工具调用在模型/工具边界处发生了数组边界错误：`domainOutcome.assuranceReport.missionCriterionResults` 前 4 项是对象，但后续把 `disposition`、`residualRisks`、`summary` 等父级字段尾部变成了数组里的字符串。Pi 的工具 Schema 正确拒绝了这些参数，没有替 QA 判断通过或失败；但模型收到的纠正信息只有通用 Schema 路径错误，随后重复生成相同的坏结构，直到执行保护暂停。

这不是 Ticket Engine 的依赖流转问题，不是 Mission Control 的业务决策问题，也不是 QA 不知道目标。根因属于 Agent Engine 的通用结构化输出协议：

1. 领域契约必须继续由领域适配层声明，平台不能替模型拼装结论、删除多余项或选择验收结果；
2. Agent Engine 必须把 Schema 校验错误投影成可执行的协议反馈，至少说明“数组项类型错误”“需要重新生成完整父对象”“数组外字段必须在父对象中”，同时从模型上下文排除失败参数原文；
3. 领域适配层给复杂终局契约提供紧凑、完整、可复制的对象层级示例，明确顶层 Goal 标准、领域结果和领域结果内部数组是三层不同数据；
4. 同一个 Goal/Thread 的纠正仍然是下一次正常 turn，保留前序工作事实，不创建新 Session、不旁路队列、不改变 Ticket 路由；
5. 相同无效结构持续重复时可以暂停以保护成本，但暂停原因必须指出是“终局结构化提案未收敛”，不能把它写成业务失败或自动重开开发工单。

本轮上线门槛新增：必须有回归测试证明“错误数组项 + 父级字段尾巴”会得到明确的通用协议反馈，失败参数不会递归进入下一轮上下文；还必须在真实 Provider 的干净工作区中观察 QA 从校验纠正后继续提交有效结论，不能只用 Mock Provider 通过。

## 本轮继续：跨引擎终态恢复必须重放 Agent 结论

本轮审计确认一个恢复层根因：`Mission Control` 之前在发现 Ticket 已进入终态时，允许直接把活动 `Mission Link` 标成 `settled`。这把 Ticket Engine 的终态误当成了 Mission Control 的结算凭证；如果进程恰好在 Ticket 提交或 Agent Goal 提交之后、Mission Link 记账之前退出，就可能出现“Ticket 已完成、Agent 已结束，但 Mission 没有完成结算”的半完成快照。

唯一正确的恢复顺序是：

1. Ticket Engine 只证明 Ticket 命令是否已提交；
2. Agent Engine 只证明本轮 Agent Goal 是否产生了持久化 Proposal/Decision；
3. Mission Control 必须使用同一个 `lastProposalId`、同一个 Ticket 命令幂等键和同一个 Mission Link，重放未完成的结算；
4. 只有 `continueSettlement` 完成同一次 Mission Store CAS，才能同时写入 Link 终态和 Mission 终态；
5. 如果活动 Link 看到了 Ticket 或 Goal 终态，却找不到对应的 Agent Proposal，恢复必须报告跨引擎数据损坏并保持未结算，不能猜测、不能补写、不能伪装完成。

这不是角色、阶段、关键词或业务结果的判断；它只校验三大 Engine 之间已经持久化的事实引用。本轮已覆盖：Agent 结论存在时重放同一 Proposal；Agent 结论缺失时拒绝伪结算；两种情况都不能创建第二个 Ticket、Goal 或 Plan。证据见 `tests/server/mission-process-manager.test.ts` 的 Mission 恢复专项，25 个测试通过。

## 本轮继续：驱动超时与业务终态必须分开

本轮真实验收暴露的不是 Ticket 路由错误，而是验收驱动的观测语义不完整。执行时显式设置了 `AUTOAGENT_ACCEPTANCE_TIMEOUT_MS=300000`，驱动在 5 分钟时退出并写入了当时的运行快照；这份快照显示开发仍在运行，但服务端之后继续推进：开发于 15:44 完成，质量检查于 15:44 开始并继续调用浏览器工具。此前的“失败”因此只能证明驱动观察超时，不能证明 Mission、Ticket 或 Agent 失败。

### 处理原则

1. 验收驱动超时的结果使用 `outcome: "driver_timeout"`，不使用业务失败状态；报告同时记录 `acceptanceStartedAt`、`lastObservedAt`、工作区 ID、服务地址、服务 `ready` 与运行状态，以及最后一次快照。
2. 只有服务端权威快照进入 `completed`、`failed`、`paused` 或 `interrupted`，驱动才可以结束等待并对业务结果作断言。驱动进程退出、网络断开或观察窗口结束，不能修改 Mission、Plan、Ticket 或 Goal。
3. 验收报告必须标明 `terminal`。`driver_timeout` 且 `terminal: false` 是“尚未观察到终态”，不是“项目失败”；任何自动化汇总都必须按这个字段区分。
4. 默认观察窗口仍是 2 小时；短窗口只能用于验证驱动自身的超时报告，不能作为真实项目没有完成的证据。
5. SSE 重连属于传输恢复，不是新事件来源。前端按事件 ID 去重、保持追加顺序，并只在连接真正关闭时显示断开；自动重连期间不把瞬态连接状态写成业务失败。

### 本轮证据与上线门槛

- 真实工作区：`C:\Users\xieyizhi\AppData\Local\Temp\autoagent-real-acceptance-QQCGk8`。
- 任务：开发 Ticket 已完成，质量检查 Ticket 在继续运行；后续查询确认 Mission 最终完成，五张 Ticket 均为 `completed`，浏览器验收新增 2 条、刷新保留、删除 1 条、390px 无横向溢出且无页面错误。
- 当前服务健康检查仍为 `ready: false`、`runtimeStatus: degraded`，原因是旧工作区数据不满足当前不可变 TeamBinding/Goal 版本契约。新工作区链路通过不能掩盖这个运维门槛；旧数据必须显式迁移或删除后，健康检查才可恢复 `ready: true`。
- 上线前必须再补一轮干净工作区长窗口验收，并保存包含终态时间、服务构建身份、最后事件游标和 `report.json` 的证据；同时完成旧数据迁移/清理和多小时 Provider 故障恢复测试。

### 本轮验证记录（2026-08-03）

- 自动化回归：`59` 个测试文件、`515` 个测试全部通过；生产构建（客户端 Vite、客户端类型检查、服务端类型检查）全部通过。
- 真实工作区：`autoagent-real-acceptance-QQCGk8` 已在驱动超时后继续运行并最终完成，说明驱动退出不会错误终结 Mission；终态包含 5 张 Ticket 全部完成和交付物验收结果。
- 真实服务（迁移前快照）：HTTP 存活为 `ok:true`，但 `ready:false`、`runtimeHosts.status:"degraded"`，当时有 18 个历史工作区因不完整 TeamBinding 工具快照被拒绝恢复。这是当时的上线阻塞，不是可以忽略的测试噪声；当前状态以文档末尾最新迁移记录为准。
- 结论：本轮完成了文档、验收驱动语义和 SSE 客户端去重的落地与回归验证；由于旧数据恢复、长窗口真实验收、重启/断线组合和 Provider 耐久证据仍未全部完成，本文状态继续保持“未达到生产上线”。

### 当前复核（2026-08-04）

- 代码新增了显式 `POST /api/health/reconcile` 恢复对账入口；它与项目删除入口组成“明确处理历史工作区后重新校验”的运维闭环，不自动补旧字段、不重排历史版本、不替用户删除目录。运营页现在直接显示服务是否就绪、失败工作区的名称/目录/原始错误，并提供重新检查入口；这只是运维事实投影，不参与任何业务流转。
- 恢复失败报告现在带 `workspaceId`、`workspaceName`、`rootPath` 和原始错误；运维可以定位具体项目后决定迁移或删除，不需要猜测编号对应哪个目录。
- 最新全量回归：`60` 个测试文件、`522` 个测试全部通过；本轮定向恢复/SSE/用户输出投影回归为 `3` 个文件、`31` 个测试通过，覆盖“失败后重新对账”“并发请求只执行一次恢复”“Last-Event-ID 重放及重放期间事件去重”“服务重启后的游标续接”以及“协议摘要、思考标记清理和详情截断”。Runtime Host 组合回归另覆盖 Provider 退避、服务重启、排队 Human 消息和同一 Goal/Thread 恢复。浏览器工具的工作区服务绑定测试单独运行和全量运行均通过。生产构建与类型检查通过。
- 最新干净工作区真实验收：`C:\Users\xieyizhi\AppData\Local\Temp\autoagent-real-acceptance-sNZcNA`，报告为 `C:\Users\xieyizhi\AppData\Local\Temp\autoagent-real-acceptance-sNZcNA\.autoagent\user-acceptance\report.json`，`passed:true`。老板、产品/项目、开发、QA、老板验收五张工单全部完成；真实浏览器完成新增 2 条、勾选、删除 1 条、刷新后完成状态保留、390px 视口检查，`horizontalOverflow:false`，`errors:[]`。桌面与移动截图已写入同一验收目录。
- 真实浏览器运营页验收：使用 Chrome 打开当前服务 `http://127.0.0.1:13748`，进入“运营”页面后能看到“服务恢复状态”面板和“重新检查”入口；页面读取的事实与 `/api/health` 一致，未把 `ready:false` 渲染成“已完成”。
- 新构建服务已重启在 `http://127.0.0.1:13748`。迁移前的真实健康检查为 `ok:true`、`ready:false`、`runtimeHosts.status:"degraded"`，当时为 17 个工作区恢复成功、18 个历史工作区恢复失败；每个失败项现在能直接显示项目名称、目录和错误。该数字属于迁移前快照，不是当前状态；对账入口已验证会重新计算事实。
- 当前服务复核（2026-08-04）：`GET /api/health` 返回 `ok:true`、`ready:false`、`runtimeHosts.status:"degraded"`，当前恢复成功 20 个工作区、失败 16 个工作区；失败原因均为历史 Mission 的 TeamBinding 缺少有效工具快照。`migrate:team-bindings` 的只读预览另发现 18 张 Mission，全部因“活动或未结算”而明确禁止迁移。两组数字分别按“工作区”和“Mission”统计，不能相加，也不能把 Mission 数量当作失败工作区数量。
- SSE 服务器端游标重放、重放期间缓冲去重、客户端事件去重以及“旧快照不能覆盖实时事件”的时间线合并已有回归证据；真实浏览器断线、服务重启、同一游标续接并验证不重复的组合验收也已通过，命令为 `npm.cmd run test:browser:sse`。这条证据只证明观察传输恢复，不替代业务状态恢复验收。
- 用户输出投影已补齐一层：运行记录默认显示可读摘要，结构化协议结果、内部思考标记和超长调试详情不再直接占据默认卡片；原始事件仍保留在展开详情中。该投影只属于客户端展示，不改变 Agent 原文、Trace、Ticket 或 Mission 事实。
- Agent 的无工具连续回合已改为按“相同的无进展回复”判断，而不是按固定的短轮次数量暂停。不同阶段的进展说明会继续留在同一 Goal/Thread 中，只有模型重复相同无工具回复且没有提交 Goal 结论时，才触发可恢复的无进展保险丝；回归测试覆盖超过三轮的不同阶段回复后继续完成 Goal。
- Provider 退避、服务重启和排队中的 Human 消息已完成组合回归：Provider 暂时失败后，Human 消息不会旁路启动第二个 Turn；服务重启后，消息仍进入原 Agent 的原 Thread/Goal，恢复后模型能看到这条按时间顺序追加的事实并继续完成。该证据覆盖 Runtime Host 的 49 个回归测试，但不替代真实 Provider 的多小时耐久验收。
- 当前结论：本轮根因修复和真实验收链路已落地，但整个平台仍不能宣称生产上线；剩余上线阻塞是历史数据处理、跨引擎业务恢复对账的长期证据、长期运行治理和用户输出分层，不是再加一层业务路由 `if/else`。

日期：2026-08-04

状态：唯一执行基线；P0 核心项与本轮真实链路已验证，生产上线门槛仍未全部满足

本轮最新证据：`npm.cmd run test:run` 为 60 个测试文件、525 个测试通过；类型检查、生产构建、SSE 断线重连和同一真实工作区终态复核均通过。服务当前仍为 `ready:false`、`runtimeStatus:degraded`，因此本文明确记录“核心可靠性回归通过，但整个平台尚未达到生产上线”。

### 本轮继续落地：历史 TeamBinding 的一次性运维处理（2026-08-04）

当前 18 张历史 Mission 都是 `linked`，旧记录的 `TeamBinding` 成员缺少 `enabledTools` 快照，所以恢复层拒绝加载。这是存储契约不完整，不是业务流程失败，也不能通过启动时默认补权限来掩盖。处理规则已经落到 `scripts/migrate-team-bindings.ts` 和 `src/server/mission-process/team-binding-migration.ts`：

1. 先用只读预览定位工作区、Mission、目录、状态、缺失成员和原始 `contentHash`；不修改文件。
2. 只有明确传入 `--apply` 才会修改；未完成 Mission 还必须明确传入 `--include-active`。默认命令不会动任何活动数据。
3. 迁移只从当前项目 Agent 的已配置工具策略补齐缺失工具快照，保留历史成员、能力、Mission 结果和 TeamBinding 身份；能力快照无效时直接拒绝，要求人工迁移或删除项目，不能猜。
4. 修改前写入带随机 UUID 的备份文件，并通过 Mission Store 校验后再落盘。
5. 应用前重新读取并比较原始 `contentHash`；期间文件发生变化就拒绝，避免覆盖并发修改。重复执行同一候选只返回 `already_migrated`，不会重复升版本或重复生成备份。
6. 迁移或删除完成后，必须调用 `POST /api/health/reconcile`；只有所有仍保留的工作区都能恢复，健康检查才返回 `ready:true`。

运维命令：

```text
npm.cmd run migrate:team-bindings
npm.cmd run migrate:team-bindings -- --workspace <workspaceId> --apply
npm.cmd run migrate:team-bindings -- --workspace <workspaceId> --apply --include-active
```

当前只读预览结果：18 张候选 Mission，状态全部为 `linked`，因未显式允许活动数据迁移而全部保持未修改。没有执行全量 `--include-active`，因为那会根据当前 Agent 配置重建历史权限，不能在没有逐项目审计的情况下替用户改变持久数据。对应回归覆盖：迁移只修工具快照、活动 Mission 默认拒绝、能力快照无效时拒绝、内容哈希变化拒绝、重复执行幂等。

### 当前能力清单（2026-08-04）

| 能力 | 当前状态 | 已经真正具备的内容 | 仍不能宣称完成的部分 |
| --- | --- | --- | --- |
| 模块化 | 已实现 | Agent Engine、Ticket Engine、Mission Control 的职责和依赖方向已经分开；Agent Engine 不知道角色、岗位和 Ticket 路由，Ticket Engine 不知道模型和工具，Mission Control 只负责持久引用之间的投递与对账。 | 需要继续用架构测试防止新代码跨边界调用；这不是新增第四个引擎。 |
| 队列与单飞 | 已实现，需长期验证 | 同一 `taskId + agentId` 的 Agent Turn、Human 消息和私聊进入同一条串行队列；运行租约、Provider 退避、服务重启后的排队恢复已经有自动回归。 | 真实 Provider 多小时运行、进程异常退出后的长期租约恢复还没有生产级证据。 |
| 生命周期 | 基础已实现，投影仍需收尾 | Goal、Thread、Ticket、Plan、Mission 各自保存自己的状态；终态 Ticket 退出调度；恢复不会凭 UI 或单一引擎终态伪造 Mission 结算；验收驱动超时也不再改写业务终态。 | 前端仍需把 Agent、Ticket、Mission 的事实投影统一成一套可解释的状态视图，尤其是运行中、等待输入、暂停和观察超时的区别。 |
| 事件总线与观察 | 已实现，业务恢复证据仍需补齐 | Event Ledger 追加写、`Last-Event-ID` 重放、服务重启续接、客户端去重和旧快照不覆盖实时事件已经有自动与浏览器回归。 | 事件传输恢复不等于业务恢复；仍需补跨三大引擎重启后的真实状态重建证据。 |
| 存储分层 | 已实现，运维治理未完成 | Agent Session/rollout、Trace、Ticket、Mission 和项目文件分别存储；完整 Prompt 不再递归写回 Session；历史损坏工作区会被明确报告，不会被静默补写。 | 历史 TeamBinding 损坏数据仍需运维明确迁移或删除；rollout 保留、索引、附件清理和多小时存储治理尚未形成上线证据。 |
| 输出控制 | 已实现基础投影，聊天分层仍需收尾 | 默认 UI 显示可读摘要，内部思考、结构化协议和过长 Trace 默认折叠或截断，原始事件仍可展开；Skill 工具参数协议也有独立校验。 | Agent 对话、运行动态、运维详情和原始 Trace 还需要完整的只读分层及重启后重建验收；这属于展示和审计，不改变 Agent 原文。 |

这张表是当前实现状态，不是待办愿望。凡是“仍需”项，必须同时补齐代码、自动回归和真实验收证据，才能从“需收尾”改为“已实现”。

> 本文是当前生产可靠性工作的唯一执行基线。它记录代码、测试和真实验收已经证明的事实，不把设计目标写成已完成。与本文冲突的旧方案只能作为历史决策记录，不能继续指导实现。

### 阅读规则

- 本文开头的“本轮继续”和“本轮验证记录”是当前状态的权威摘要；后面的编号章节保留历次审计证据，不是第二套规范。
- `[x]` 表示代码、回归测试和必要证据均已具备；`[~]` 表示已有部分实现但仍有上线缺口；`[ ]` 表示尚未完成。
- 历史验收使用的工作区、服务进程和失败数量可能不同。它们属于不同时间点的证据；判断当前能否上线只看当前健康检查、最新测试结果和最新真实验收报告，不把历史数字混合相加。

## 本轮根因修复与真实验收记录（2026-08-04）

本轮真实验收第一次没有继续，不是 Ticket DAG 或 PM 规划错误。PM 的 Agent Session 记录显示，上游模型响应流被中断，Agent Engine 将 `Upstream response stream was interrupted` 误判为不可自动恢复的 Provider 错误，随后暂停了同一个 Goal 和 Ticket。这个分类错误会把短暂的传输故障伪装成业务阻塞，用户看到的就是“产品/项目卡住”。

根因修复已落地：

- `src/server/providers/provider-failure.ts` 将明确的响应流传输中断归入可重试的 Provider 传输故障；不扩大到权限、配置、协议或业务结论错误。
- 既有 Runtime Host 退避机制继续使用同一个 `taskId + agentId`、同一个 Ticket Attempt、同一个 Agent Goal 和同一个 Thread；重试只重新请求被中断的模型回合，不重建 Mission/Plan，不重复已完成工单。
- `tests/server/provider-failure.test.ts` 增加精确回归；全量测试从 510 增至 511，59 个测试文件全部通过。

本轮真实用户验收证据：

- 工作区：`C:\Users\xieyizhi\AppData\Local\Temp\autoagent-real-acceptance-eI2qXM`
- 任务：`真实用户验收`，Mission 状态 `completed`。
- 工单链：老板需求接收、产品/项目计划拆解、开发交付、测试验证、老板最终验收，共 5 张工单，全部 `completed`。
- 交付物验收：新增 2 条待办；勾选完成并刷新后仍保留；删除 1 条；390 像素视口无横向滚动；浏览器错误数为 0。
- 报告：`C:\Users\xieyizhi\AppData\Local\Temp\autoagent-real-acceptance-eI2qXM\.autoagent\user-acceptance\report.json`

这证明 Agent Engine 的短暂 Provider 流中断恢复和主链路的真实交付链已经通过一轮验收，但不等于整个平台已经达到生产上线标准。该段记录的是迁移前快照：`/api/health` 为 `ok:true`、`ready:false`、`runtimeStatus:degraded`，当时为 16 个工作区恢复成功、18 个工作区恢复失败。历史数据需要明确迁移或删除后，服务才可恢复 `ready:true`；本轮不以兼容分支掩盖该问题，也不静默删除用户数据。迁移后的最新事实见第 21.11 节。

历史工作区处理现在有明确的运维闭环：用户可以在项目列表中删除不再保留的工作区（是否删除本地目录由用户明确勾选）；完成迁移或删除后调用 `POST /api/health/reconcile` 重新执行恢复对账。该接口只重新读取并恢复仍存在的工作区，不补字段、不重排 rollout、不伪造旧状态，也不改变任何 Mission、Plan、Ticket 或 Agent 的业务结论。只有对账结果没有失败工作区时，健康检查才会返回 `ready:true`。

## 当前执行目标与优先级

| 优先级 | 目标 | 当前状态 | 完成条件 |
| --- | --- | --- | --- |
| P0 | 三大引擎在重启、重复请求、终态恢复时保持各自事实不变，并由 Mission Control 做幂等对账 | 核心实现已完成，回归测试已通过 | 新工作区长窗口验收、服务重启后状态与事件游标一致 |
| P0 | 服务启动恢复结果可被运维处理，不让历史损坏数据伪装成健康 | 入口、失败定位和运营页已实现，历史数据仍阻塞 | 对失败工作区给出明确迁移/删除操作；处理完成后调用恢复对账，健康检查才可为 `ready:true` |
| P1 | SSE 断线、重连、服务重启和快照回退不重复、不丢失、不改变业务状态 | 服务器游标重放、客户端去重和真实浏览器重启组合验收已完成；业务状态恢复仍需长期证据 | 真实浏览器传输重连通过，并补齐跨引擎业务恢复证据 |
| P1 | 用户聊天、运行动态、运维详情、原始 Trace 分层展示 | 默认运行记录投影已补齐，聊天/Trace 的完整分层仍未完成 | 默认聊天只显示可读进展；原始协议和调试内容按需展开，并能在重启后重建 |
| P1 | Provider 长时间故障、排队 Human 消息和成本/token 观测 | 退避、重启、排队 Human 组合回归已完成；多小时真实 Provider 与成本观测仍未完成 | 多小时真实 Provider 验收，重试、排队、恢复和成本告警均可追溯 |

本表就是后续开发顺序。未完成项必须先补代码、测试和真实证据，再改变本文状态；不能用增加岗位、阶段、关键词判断或平台业务分支来替代这些工作。

## 1. 目标

## 1.1 本轮真正落地的内容

这一节是本轮实现的事实清单，不是设计愿望：

| 事项 | 落地内容 | 代码 / 测试证据 | 状态 |
| --- | --- | --- | --- |
| Agent Thread 单飞 | Agent Turn、Human 消息和私聊都进入同一条持久 Thread；同一 Mission 中同一 Agent 不会并发运行两个 Turn | `src/server/runtime/runtime-host.ts`；`tests/server/runtime-host.test.ts` | 已实现 |
| 跨项目隔离 | 队列、运行槽位和 Provider 退避键使用 `taskId + agentId`，同一个 Agent 参与不同项目时互不抢占、互不串上下文 | `src/server/runtime/runtime-host.ts`；跨任务队列回归 | 已实现 |
| 重启恢复 | 开放 Turn、Goal、Mission Link 和退避时间从持久记录恢复；已完成、失败、取消的终态只恢复为只读历史，不重新调度 | `src/server/runtime/runtime-host.ts`、`runtime-host-store.ts` | 已实现 |
| Provider 故障 | Provider 重试分类、退避和 `retryAt` 写入 RuntimeTaskRecord；重启后继续原 Turn，不把运行故障伪装成业务完成 | `src/server/runtime/runtime-host.ts`；Provider 退避恢复测试 | 已实现 |
| Ticket 持久事实 | Ticket 聚合版本、Claim、Attempt、终态退出和 Ticket outbox 同一次持久提交完成；终态 Ticket 不再被调度 | `src/server/tickets/ticket-store.ts`、`ticket-engine.ts` | 已实现 |
| Mission 恢复 | Mission Link、游标、步骤和结算状态持久化，恢复时继续未完成操作，不创建第二条替代链 | `src/server/mission-process/mission-store.ts`、`mission-process-manager.ts` | 已实现 |
| Mission 启动幂等 | 同一个 Mission 的并发发布请求复用同一条持久 Mission、Plan 和创建命令；版本冲突只重新读取权威结果，不产生第二个 Plan | `src/server/mission-process/mission-process-manager.ts`；并发启动回归测试 | 已实现 |
| 持久契约边界 | Mission Store 在读取/创建时验证 TeamBinding 的成员身份、能力和 `enabledTools` 快照；不完整快照在存储边界明确拒绝，不让恢复流程深处出现 `undefined.includes` | `src/server/mission-process/mission-store.ts`；`tests/server/mission-store.test.ts` | 已实现（新数据契约） |
| Agent rollout 恢复诊断 | Goal 版本必须严格连续；历史回退在 Agent Store 恢复时带出 Agent、Goal、实际版本和期望版本，不能被误报为普通运行阻塞 | `src/server/agent-engine/agent-store.ts`；`tests/server/agent-store.test.ts` | 已实现（拒绝损坏历史） |
| 事件观察 | Event Ledger 追加写串行化，SSE 支持 `Last-Event-ID` 补发并去重；快照回退不会抹掉实时事件 | `src/server/storage/event-ledger.ts`、`routes/events.ts`、`src/client/live-events.ts`、`scripts/verify-browser-sse-reconnect.mjs`；事件回放、客户端合并和浏览器重启测试 | 已实现（观察传输层；不等于业务状态恢复完成） |
| 观察账本耐久性 | 事件追加写入后 `fsync`；末尾被截断的 JSONL 记录被隔离，下一次追加前修复为最后一个完整记录 | `src/server/storage/event-ledger.ts`；事件账本尾部损坏回归测试 | 已实现（观察层） |
| 用户输出投影 | 聊天中的完整/未闭合内部思考进入默认折叠的“处理过程”；运行记录默认把结构化协议结果提炼为摘要、去除思考标记并限制详情长度；原始事件仍可按需展开 | `src/client/agent-thread.ts`、`src/client/event-view-model.ts`；`tests/client/agent-thread.test.ts`、`tests/client/event-view-model.test.ts` | 已实现（默认投影；完整 Trace/运维分层仍在收尾） |
| 阻塞负责人投影 | 人工介入和阻塞对话只使用服务端投影的 `targetAgentId`；没有真实负责人时不按岗位/阶段猜头像或回复对象 | `src/client/view-model.ts`；`tests/client/view-model.test.ts` | 已实现（基础投影） |
| 真实验收 | 真实工作区完成创建任务、运行、刷新、移动端检查、交付物持久化和无横向溢出验收 | `scripts/real-user-acceptance.mjs`；真实验收脚本输出 | 已验证一条干净链路；长期耐久与旧工作区恢复仍未完成 |
| Agent 合同错误的跨轮恢复 | 同一 Goal 的相同执行阻塞不会跨轮无限自动重跑；一次自动恢复后仍无新的人类输入或状态变化时暂停，新的 Human 消息可恢复 | `src/server/agent-engine/agent-engine.ts`；`tests/server/agent-engine.test.ts` | 已实现（基础边界，真实复验待重跑） |

以下内容没有被本轮伪装成已完成：

- Mission Store、Agent rollout 和 UI 派生事件还没有完成各自的恢复对账和跨边界幂等回归；本设计不引入一个跨三大 Engine 的统一事务 outbox，也不把 UI 事件当成业务事实；
- UI 的用户聊天、工作动态、运维详情和原始 Trace 仍需要彻底按只读投影分层；本轮已补齐运行记录默认摘要、协议结果折叠、思考标记清理和原始事件按需展开，但聊天/Trace 的完整分层与重启后重建仍未视为完成；
- 长期 rollout 的快照、保留、索引、附件清理尚未形成完整运维契约；观察账本的末尾损坏隔离已经具备，但不等于长期存储治理完成；
- 真实 Provider 的多小时故障、重启、排队消息和成本告警耐久验收尚未完成。

因此本文当前状态仍是“核心可靠性已落地，最终上线门槛未全部满足”，不是“平台已经生产就绪”。

本文档定义 AutoAgent 现有架构走向生产级所需的可靠性改进。它不引入第四个 Engine、不创建第二套工作流、不创建第二条消息队列，也不增加一个替 Agent 做业务判断的平台决策层。

产品仍然只有一条执行主链：

```text
Human 提出目标
  -> Mission Control 创建 Mission、初始 Plan 和第一个 Ticket
  -> Ticket Engine 从 Plan DAG 中释放 ready Ticket
  -> Mission Control 把一个 ready Ticket 投递为一个 Agent Goal
  -> Agent Engine 按顺序运行该 Agent 的 Thread、Turn、模型和工具
  -> Agent 提交结构化结论，或者请求外部输入
  -> Mission Control 校验权限，并把被接受的提案转换为 Ticket 命令
  -> Ticket Engine 更新 Ticket 与 Plan，释放后续工作
  -> 持久化事件重建 UI 投影
```

本文档的工作，是让这条主链可持久化、可观察、可恢复，并且让用户看得懂。规划、测试、路由、招聘、验收等业务判断不得被搬进平台 `if/else`、岗位名匹配、关键词匹配、正则表达式或固定阶段顺序。

## 2. 与现有设计的关系

本文档是现有契约之上的生产可靠性总纲，不替代各领域已有设计：

- `2026-07-21-production-engine-baseline.md`：Agent Engine、Ticket Engine、Mission Control 的职责和依赖边界。
- `2026-07-07-agent-context-memory-design.md`：Agent Thread、上下文组装、压缩、记忆和 Trace 分离。
- `2026-07-23-teamhq-workspace-design.md`：办公室工作台和用户交互模型。
- Ticket 生命周期和纠错设计：不可变历史、Plan 变更、纠错工单和最终结算。

如果局部实现与这些边界冲突，应修改实现，不得把本文档当成保留旧行为的兼容层。

### 2.1 文档优先级与废止关系

当前实现按以下顺序读取设计约束：

1. 本文：生产可靠性、上线门槛、事实状态和本轮实施清单。
2. `2026-07-21-production-engine-baseline.md`：三大 Engine 的边界和架构测试。
3. `2026-07-14-single-plan-ticket-flow-design.md`：一个 Mission 一个 Plan、不可变 Ticket 历史和 DAG 语义。
4. `2026-07-31-talent-pool-and-dynamic-project-team-design.md`：负责人自主组队和项目 TeamBinding。
5. Agent 上下文、Mission 共享上下文、交付证据等专项设计。

以下文档中的旧流程、固定角色终点、阶段跳转或旧协议只保留作历史记录，不能作为新实现依据：

- `2026-07-06-real-ticket-flow-design.md`
- `2026-07-09-ticket-graph-contract.md`
- `2026-07-10-ticket-agent-mission-control-boundary-design.md`
- `2026-07-13-agent-mission-ticket-contract-repair-design.md`
- `2026-07-13-codex-style-agent-engine-turn-protocol.md`

这些文档中的有效原则已被后续文档吸收；冲突部分不通过兼容分支保留。新增代码必须先说明自己属于 Agent Engine、Ticket Engine、Mission Control 或无业务语义的基础设施，并且只写入所属事实账本。

## 3. 当前状态与目标状态

| 能力 | 当前状态 | 已有基础 | 生产缺口 | 目标状态 |
| --- | --- | --- | --- | --- |
| 模块化 | 已实现 | 三大 Engine 已分离，架构测试会拒绝越界依赖 | 新增可靠性代码时仍需持续守住边界 | 三大 Engine 继续独立，新增协调只属于 Mission Control 或中立基础设施 |
| 队列 | P0 已落地，P1 需改进 | 有持久化 Agent rollout、Thread 串行、执行租约、Host 操作串行、忙碌 Agent 排队，以及重启后恢复和终态不再入队 | 公平性、跨进程租约和重试可见性还没有形成完整生产契约 | 唯一持久队列来源、严格单飞、确定性恢复、可见的排队与重试状态 |
| 生命周期 | P0 已落地，P1 需改进 | Agent Goal、Ticket、Plan、Mission Link 都有独立状态；终态运行记录只恢复为只读快照，不再重新调度 | 所有异常路径的 UI 投影、跨进程恢复和状态对账仍需继续验证 | 每项事实只有一个权威来源，UI 由纯投影生成，不再残留假运行状态 |
| 事件总线 | 部分实现，需改进 | 有持久事件账本、追加写串行化、进程内事件总线、SSE 和游标重放 | 各事实账本的恢复对账回归、快照回退和事件保留边界还未完整验证；不引入跨三大 Engine 的统一事务 outbox | 游标重放、事件幂等、快照加增量恢复，UI 不再根据孤立事件猜状态 |
| 存储分层 | 基础已实现，P2 需改进 | Agent rollout、原始 Trace、Ticket、Mission 和项目文件已分开，rollout 为追加式 | 长期运行的快照、保留、损坏恢复、附件和清理策略还不统一 | 回放成本有界、审计追加式、快照原子化、附件引用化、保留策略明确 |
| 输出控制 | 基础已实现，P1 需改进 | 已有 128K 默认上下文、预算、压缩、Trace 分离和工具结果截断 | 用户动态与原始运维/调试内容还没有完全分层，默认界面仍可能暴露协议文本和超长结果 | 模型上下文、原始审计、运维详情、用户聊天四层分离，默认只显示用户关心的信息 |

### 3.1 本轮实际落地与未完成项

本节是当前代码与测试的事实清单，优先级表不能覆盖或替代它。

已落地：

- Agent Turn、Human 消息和私聊进入同一条持久 Thread，并由单飞队列串行执行；重复调度不会并行启动同一 Agent 的第二个 Turn。
- 运行槽和 Provider 退避按 `Mission/Agent Thread` 隔离；不同项目使用同名 Agent 时不会互相占用槽位、继承退避或串入私聊。
- 服务重启后能够恢复开放 Turn、Goal 和 Mission Link；已经完成、失败或取消的运行记录只恢复为只读历史快照，不重新进入调度器。
- 事件账本的并发追加已串行化；SSE 支持使用 `Last-Event-ID` 从持久账本补发遗漏事件，并在切换实时流时去重。
- 新构建在干净工作区完成一条真实交付链：老板接收目标、产品拆解、开发交付、QA 在真实浏览器中验证、老板最终验收；5 张工单全部完成，5 个 Agent 均回到空闲。
- 真实验收脚本的浏览器定位曾把每条待办的容器写死为 `li`，而开发交付使用了语义正确的 `article`；脚本已改为按 `li/article` 语义定位，并在同一真实产物上复核通过。这是验收工具根因修复，不是平台替 Agent 判断业务结果。
- 当前工作区已通过 TypeScript 检查、构建和全量测试（58 个测试文件、503 个测试）；其中包含并发重复发布只生成一个 Mission/Plan 的回归测试、阻塞负责人投影不猜测的回归测试，以及合同错误跨轮恢复的回归测试。
- 本轮又补齐了两个恢复边界回归：不完整 TeamBinding 在 Mission Store 创建时即被拒绝；持久 rollout 中 Goal 版本回退会在 Agent Store 读取时报告明确身份和版本差异。两者都不通过业务角色、阶段或关键词判断来修正数据。

尚未完成，不能宣称上线闭环：

- Ticket Engine 已有聚合内 outbox；Agent rollout、Mission Store 和 UI 派生事件各自属于不同事实账本，跨边界不使用统一事务，而由 Mission Link、游标和幂等恢复对账保证不会重复投递或重复结算；这条对账链仍需要补齐异常窗口回归。
- Provider 退避状态已经写入 RuntimeTaskRecord 并在重启时恢复；长期运行、失败分类治理和成本预警仍未完成。
- 用户聊天、工作动态、运维细节和原始 Trace 的投影还没有完全分离；内部思考、协议文本和超长工具结果仍需要进一步收敛到默认折叠的运维视图。
- 长期 rollout 的索引快照、保留策略和附件清理还未实现；事件账本末尾损坏记录的隔离与修复已经实现，但还需要接入健康指标和运维检查。

因此，当前版本是“核心交付链已通过一条真实用户验收、仍需完成恢复对账与运行治理才能宣称生产上线”的开发基线，而不是已完成的生产版本。

健康检查的生产契约：`/api/health` 的 `ok` 只表示 HTTP 服务能够响应，是存活检查；`ready` 才表示运行时恢复完成且没有失败工作区，可以接收生产流量。`runtimeHosts.status` 为 `restoring`、`degraded` 或 `failed` 时，`ready` 必须为 `false`，不得用 `ok: true` 代替就绪检查。历史工作区恢复失败必须继续出现在 `failedWorkspaces` 中，进入数据修复或迁移流程，不得通过兼容分支伪装为健康。

## 4. 不可破坏的不变量

### 4.1 每项事实只有一个权威来源

| 事实 | 唯一权威来源 |
| --- | --- |
| Agent 看过什么、说过什么、执行过什么 | Agent rollout |
| Agent Turn 是排队、运行还是结束 | Agent rollout 中的 Turn 记录与执行租约 |
| Ticket 是 pending、ready、running、blocked 还是终态 | Ticket Engine |
| Plan 是 active、blocked、paused 还是终态 | Ticket Engine |
| 一个 Ticket 是否已投递给一个 Agent Goal，以及是否已结算 | Mission Control Link |
| Mission 是否满足已对齐的 Baseline | Mission Control Settlement |
| 头像颜色、角标、顶部任务状态和动态卡片 | 从上述权威来源重建的只读投影 |

UI 操作、SSE 事件处理器、运行时缓存或 Agent 的自然语言都不能直接覆盖其他系统拥有的权威事实。

### 4.2 每个 Agent 只有一条持久时间线

Human 消息、正式 handoff、Agent 回复、工具动作、压缩记录和 Turn 边界全部进入同一个有序 Thread。Human 私聊不是旁路，不得启动并行 Session。

追加式 rollout 中尚未消费的 Turn 记录，就是 Agent 的持久队列项。内存里的 Promise、定时器和数组只能用于调度优化，进程退出后必须可以从持久记录完整重建。

### 4.3 平台执行协议，不替 Agent 做业务判断

Agent 判断工作含义、证据是否充分、是否存在缺陷、是否需要澄清以及应提出什么 Plan 变更。平台只能校验：

- Schema 和必填字段；
- 身份、权限和当前版本；
- 幂等键和 fencing token；
- DAG 合法性和不可变历史；
- 证据引用与来源；
- 当前生命周期是否允许该操作。

平台不得通过岗位名、自然语言、关键词、正则表达式、产品类型或固定的“老板 -> PM -> 开发 -> QA”顺序推断业务决策。

### 4.4 原始审计不等于模型上下文，也不等于用户聊天

同一个 Turn 有四种视图：

1. 模型视图：有界的稳定规则、当前 Goal、相关 handoff、压缩历史和必要工具摘要。
2. 审计视图：完整 Provider 请求与响应、工具输入输出、耗时、用量、错误和结算记录。
3. 运维视图：队列、租约、重试、上下文预算、工具执行和系统事件。
4. 用户视图：目标、有效进展、重要发现、问题、结论、证据和需要用户做的事。

这些视图之间只能通过明确的投影或压缩转换。完整 Prompt、Base64 图片、整份源码或调试负载不得被递归复制到后续 Session 消息。

## 5. 队列与并发设计

### 5.1 Agent Turn 队列

每条消息统一走下面的写入路径：

```text
接收请求
  -> 分配稳定 messageId 和 turnId
  -> 追加写入 Agent rollout
  -> 向调用方确认“已持久化”
  -> 调度器选择最早的可执行未消费 Turn
  -> 获取执行租约
  -> 只执行一个 Turn
  -> 追加 Turn 终态结果
  -> 释放租约
  -> 调度下一个可执行 Turn
```

必须满足：

- 同一个 Thread 同时最多运行一个 Turn，不受 HTTP 请求数和 scheduler tick 次数影响。
- Agent 运行中收到的消息按时间顺序追加，等下一 Turn 处理。
- 输入框在消息持久化成功后清空，不等待模型运行结束。
- 同一个幂等键的重复提交只能产生一条消息和一个 Turn。
- 私聊在允许时恢复同一个 Thread 和 Goal，不能激活另一个 Agent 或旧 Mission 阶段。
- 进程重启后扫描 rollout，自动恢复最早可执行 Turn，不要求用户重新发送。

### 5.2 Ticket 投递队列

Ticket 的 ready 状态只由 Ticket Engine 拥有。Mission Control 只能投递 Ticket Engine 声明为 `ready` 且被当前 Plan 允许执行的 Ticket。

必须满足：

- Agent 正忙时，不得按岗位名自动改派，也不得跳阶段。Ticket 保持 ready，或者由持久 Dispatch 表示“等待该 Agent”。
- 同一个 Ticket Attempt 最多存在一个有效 Claim 和一个有效 Mission Link。
- Claim 租约使用 fencing token；恢复后的旧进程不能通过过期租约提交结果。
- Ticket 一旦 completed、returned、failed 或 cancelled，该 Attempt 永久退出调度。纠错工作必须是 Plan 历史中的新 Ticket。
- 公平性必须显式定义：按 Plan 声明优先级、ready 时间和稳定的最终排序键调度，反复 tick 不能饿死旧工作。

### 5.3 Provider 与基础设施重试

Provider 传输失败属于运行故障，不是业务结论。

重试依据结构化错误分类，而不是分析错误文案：

- 网关错误、超时、限流、临时不可用和网络故障可重试。
- 使用指数退避和抖动，并持久化 `retryAt`。
- 重试保持同一个 message、Turn、Goal、Ticket Attempt 和 Mission Link。
- 已持久化成功的工具结果或 Settlement 不得要求模型重复执行。
- 鉴权错误、非法请求、模型能力不支持和策略耗尽进入可见的运行阻塞，并给出明确恢复动作。
- 达到重试预算时暂停当前 Turn Attempt，不能伪装成 Ticket 失败或完成。

UI 应明确显示“排队中”“将在某时重试”“等待模型服务”“需要修改配置”，不能统一显示成绿色运行中。

## 6. 生命周期与 UI 投影

继续使用现有领域状态，不新增可写的“Task 阶段”或“头像状态”：

- Agent Goal：`active`、`paused`、`blocked`、`resolving`、`completed`、`failed`、`cancelled`、`budget_limited`、`usage_limited`。
- Ticket：`pending`、`ready`、`running`、`blocked`、`completed`、`returned`、`failed`、`cancelled`。
- Plan：`active`、`paused`、`blocked`、`completed`、`failed`、`cancelled`。
- Mission Link：`dispatching`、`starting`、`running`、`blocked`、`resolving`、`paused`、`recovering`、`settled`、`cancelled`。
- Mission：`starting`、`linked`、`completed`、`start_failed`。

用户状态必须由纯函数投影：

| 用户看到的状态 | 投影规则 |
| --- | --- |
| 运行中 | 存在未过期执行租约，并且最新 Turn 尚未结束且最近有进度 |
| 排队中 | 存在持久化未消费 Turn 或 ready Dispatch，但尚未开始执行 |
| 正在重试 | 当前 Turn Attempt 已记录临时故障和未来 `retryAt` |
| 需要你回复 | Agent Goal 或 Ticket 被声明的 Human 输入阻塞，并能定位发起请求的 Agent |
| 等待外部条件 | 工作被已声明的非 Human 外部依赖阻塞 |
| 已暂停 | 权威 Goal、Plan 或运行控制处于 paused |
| 空闲 | Agent 没有活动 Goal、开放 Turn 或排队消息 |
| 失败 | 权威领域对象已进入失败终态，并带可读原因 |
| 已完成 | Mission Settlement 已完成；阶段记录或 Agent 一句话不够 |

投影可以组合多个权威记录，但不能修改任何权威记录。这样才能根除“任务失败但头像仍是绿色”“Agent 在等用户但页面显示运行中”等问题。

### 6.1 重启对账顺序

服务启动时按以下顺序恢复：

1. 载入 Ticket、Plan 快照和未应用 Ticket 事件。
2. 载入 Mission 和 Link。
3. 载入 Agent rollout、开放 Turn、Goal 和执行租约。
4. 按 fencing 规则过期失效租约。
5. 把每个 Mission Link 重新连接到准确的 Ticket Attempt 和 Agent Goal。
6. 恢复未完成的幂等 Dispatch 或 Settlement 步骤。
7. 将可执行的未消费 Agent Turn 入调度。
8. 从已对账记录生成 UI 投影。

终态 `RuntimeTaskRecord` 的恢复例外：它可以被重新组合为只读上下文，用于展示真实的完成/失败/取消状态和历史 Ticket；不得创建 Agent Turn、加入调度队列、刷新租约或触发新的 Mission 结算。只有仍处于活动生命周期的记录才进入第 4 至第 7 步的恢复调度。

恢复过程不得根据最后显示的阶段、Agent 岗位、聊天文本或项目文件猜测状态。

## 7. 持久事件与 UI 重建

### 7.1 事件交付契约

权威领域账本仍然属于各自的 Engine；进程内 EventEmitter 和 SSE 只是传输方式。Ticket 聚合 outbox 是 Ticket 事件来源，Agent rollout 是 Agent 时间线来源，Mission Store 是 Mission Link/游标来源。通用 EventLedger 只承载派生的招聘和观察事件，不能反过来决定业务状态。

每个事件至少包含：

- 全局唯一 `eventId`；
- workspace 或 task run 等分区键；
- 分区内单调递增序号；
- Schema 版本；
- 来源 Engine；
- Aggregate ID 和 Aggregate Version；
- 时间戳与关联 ID；
- 适用时的简短用户摘要。

各引擎内部的状态变更与其权威事件必须通过同一次持久提交或等价的原子边界连接。Ticket Engine 使用 Ticket 聚合内 outbox；Agent Engine 使用 rollout/Turn 的追加记录；Mission Control 使用 Mission Link、游标和幂等操作记录。三者不共享事务，也不共享一份可写状态。跨边界交付的正确性由 Mission Control 在恢复时依据这些权威记录对账，并用 Link、Attempt 和命令 ID 做幂等保护；Event Ledger 只负责观察和补发，不能被当成业务完成依据。

因此，本项目的生产门槛不是再造一个跨三大 Engine 的统一事务 outbox，而是必须证明以下恢复性质：

1. Ticket 已提交但 Mission 尚未记录结果时，恢复只会补做同一个 Link，不会创建第二个 Ticket 或第二个 Agent Goal。
2. Agent 已追加 Turn 结果但 Mission 尚未结算时，恢复只会按同一个 Attempt 结算一次。
3. Mission 已记录结算但 UI 事件尚未发布时，重新读取权威 Store 仍能重建正确页面，不能依赖丢失的实时事件。
4. 任意重复的投递、结算和观察事件都能按 ID 或版本幂等处理。

### 7.2 SSE 断线重放

SSE 使用持久游标恢复：

1. 客户端加载带有最新游标的投影快照。
2. 客户端通过 `Last-Event-ID` 或等价参数携带游标打开 SSE。
3. 服务端先按顺序重放游标之后的持久事件，再切换到实时推送。
4. 客户端按 `eventId` 和 Aggregate Version 幂等应用。
5. 断线后重复该过程，不丢失也不重复。

如果游标已超过保留范围，服务端要求客户端重新加载快照。UI 不能只根据自己碰巧收到的最后一条实时事件或卡片颜色推断权威状态。

### 7.3 工作动态展示

工作动态可以按 Agent 和 Ticket 收纳，但全局时间序必须保持。默认卡片只展示：

- 谁做的；
- 做了什么有意义的动作；
- 属于哪个 Ticket 或 Goal；
- 当前结果；
- 用户是否需要处理。

原始事件负载、Prompt、Provider Envelope 和工具参数只在“运行细节/原始记录”中展开。

## 8. 存储与保留策略

### 8.1 存储归属

| 存储 | 保存内容 | 禁止保存 |
| --- | --- | --- |
| Agent rollout | 有序的模型可见消息、Turn 边界、压缩记录、工具摘要和 Goal 引用 | 重复的完整组装 Prompt、其他 Agent 历史、Base64 附件 |
| Agent trace | 完整 Provider 与工具审计、耗时、用量、原始故障和结算细节 | 权威 Ticket 或 Plan 状态 |
| Ticket store | Plan DAG、Ticket、Attempt、Claim、证据引用和不可变状态历史 | Agent Prompt 与 Session 内部数据 |
| Mission store | Mission Baseline、Dispatch Link、Settlement 进度和幂等状态 | Ticket 路由猜测或复制的 Agent 对话全文 |
| 项目工作区 | 源码、文档、资源、测试和交付物 | 被当成唯一调度来源的运行控制状态 |
| Attachment store | 通过 ID、路径、Hash、MIME 和大小引用的二进制文件 | rollout、事件或 Prompt 中的内联 Base64 |

### 8.2 长期运行策略

- 追加式日志建立周期性索引快照，使重启回放成本不会无限增长。
- 快照记录来源游标并原子提交；源日志按保留策略继续用于审计。
- 损坏或不完整的 JSONL 尾记录进入隔离；后续追加只从最后一条完整记录继续，健康检查还必须能报告这次修复，不能静默转换为合法业务状态。
- 不同层使用不同保留期：用户对话和 Ticket 历史长期保存；原始 Provider 负载和超大工具输出可配置保留；UI 派生缓存可随时重建。
- 删除项目时，平台记录和本地目录必须分别确认，删除动作可审计。
- 未声明并获得授权时，拒绝跨项目和跨 workspace 引用。

## 9. 上下文与输出控制

### 9.1 模型上下文

Context Assembler 按以下顺序组装：

1. 稳定的 Agent 档案和不变工作规则。
2. 当前 Goal 与正式 Ticket handoff，包括本次工作需要知道的已对齐 Mission Baseline。
3. 当前权限、能力、工具和工作区边界。
4. 按时间序压缩后的 Agent Thread。
5. 本轮触发消息或工作项。

默认模型上下文仍为 128K，除非所选模型配置覆盖。输入预算、输出预留和压缩阈值全部依据模型配置的 token 估算。

压缩必须保留：

- 当前目标和成功标准；
- 未解决问题和声明的阻塞；
- 决策与约束；
- 改动文件和持久交付物引用；
- 测试、证据、失败和待办；
- 审计所需的 Ticket、Goal、Turn 和 Trace 引用。

压缩应丢弃递归 Prompt、重复思考、已被替代的计划、重复工具输出，以及可以按引用重新读取的源码全文。

### 9.2 用户聊天

默认聊天是产品界面，不是 Trace 查看器。它展示：

- Human 原始目标和后续消息；
- Agent 有意义的进度；
- 问题和需要用户处理的事项；
- 结论、证据和下一步；
- 有价值时的简短工具活动摘要。

以下内容默认折叠：

- Agent 工作规则和系统约束；
- 模型思考或 `<thinking>` 片段；
- 原始 Prompt 和 Provider 负载；
- 重复的读取、列举、写入工具调用；
- 超长源码、JSON、命令输出和截图元数据；
- 不需要用户决策的生命周期账务事件。

主聊天不得把协议标记当成普通文字显示。用户可以按需展开“运行细节”“工具活动”“查看原始记录”。

### 9.3 输出大小与安全

- UI 摘要有独立稳定的大小限制，不能反过来决定模型上下文截断。
- Trace 可以保存完整工具输出；rollout 只保存有界摘要和 Trace 引用。
- 图片通过附件引用和缩略图展示。支持图片的模型通过 Provider 图片输入读取引用文件，不能把 Base64 作为文本灌入消息。
- 源码与命令输出按需重新读取，不在每一轮反复注入。
- 每个 Turn 的用量、上下文大小、压缩、重试和排队时间都可观察。

## 10. 实施优先级

### P0：队列正确性与生命周期投影（核心项已落地，收尾回归中）

1. [x] 在 Agent Engine 契约中固化持久 Turn 队列和单飞不变量。
2. [x] 让执行租约、排队消息、开放 Turn 和终态运行记录在进程重启后可确定性重建。
3. [~] 集中收敛从 Agent Goal、Ticket、Plan、Mission Link、Lease 和 Required Input 到 UI 的纯投影：本轮已把 Workspace 的 status/phase 收敛为同一个只读生命周期投影；Agent、Ticket、Lease 和聊天事件的分层投影仍需继续补齐。
4. [x] 删除按岗位/阶段猜测具体 Agent 的头像和回复对象；独立可写头像/Task 状态仍需继续清点。
5. [x] 增加崩溃、并发、重复请求、过期租约和跨项目隔离的基础回归；继续补齐跨进程场景。

### P0：事件重放与持久发布（传输恢复已落地，跨边界业务恢复对账仍未完成）

1. [x] 为持久事件增加唯一 ID，并按工作区/运行记录排序读取。
2. [x] 已明确并实现按事实账本分层的等价协议：Ticket 聚合 outbox、Agent rollout、Mission Link/游标分别负责自己的事实；跨边界由 Mission Control 幂等恢复对账，不引入统一事务 outbox。
3. [x] 实现 SSE 游标重放、服务端切换实时流时的事件去重，以及客户端快照回退时的时间线合并。
4. [~] 已用真实浏览器验证断线、服务重启、旧游标续接和不重复；跨引擎业务状态恢复与长期事件保留边界仍未完成。

### P1：Provider 恢复与长期运行

1. [x] 持久化 Provider 退避和重试状态；失败分类、抖动策略和长期运行治理仍待完成。
2. [x] 基础实现保证运行重试不直接改变 Ticket 或 Plan 的业务状态。
3. [ ] 增加包含 Provider 故障、服务重启和排队 Human 消息的长时间耐久测试。
4. [ ] 暴露成本与 token 预警，但不通过平台硬编码业务完成，也不使用任意短轮次限制代替目标判断。

### P1：输出与上下文投影

1. [ ] 定义独立于原始 Trace Event 的用户动态类型。
2. [~] 默认聊天和运行记录已移除/折叠内部思考与协议文本；跨页面统一投影和重启后重建仍需补齐。
3. [x] 运行记录保留完整原始事件的按需展开；默认视图只显示用户可读摘要。
4. [x] 已有长 Thread、工具、源码和图片的基础 token 预算/截断；仍需补齐压缩回归和用户投影回归。

### P2：存储运维

1. [ ] 为长期追加日志增加索引快照和有界回放。
2. [ ] 增加可配置的 Trace 保留和附件清理；事件账本末尾损坏隔离与修复已实现，仍需接入健康指标和运维检查。
3. [ ] 增加存储健康指标与管理检查，不在普通用户流程中暴露内部数据。

## 11. 实施落点与边界

| 改进项 | 现有主要落点 | 允许承担的职责 | 禁止承担的职责 |
| --- | --- | --- | --- |
| Agent 消息与 Turn 串行 | `src/server/runtime/runtime-host.ts`、`src/server/agent-engine/pi-runtime.ts`、`src/server/agent-engine/agent-store.ts` | 持久写入、排队、租约、单飞、恢复、Provider 重试 | Ticket 路由、业务完成判断、按岗位改派 |
| Ticket 调度与终态退出 | `src/server/tickets/ticket-engine.ts`、Ticket Store 与 Plan Graph | Ready 计算、Claim、Attempt、DAG、不可变终态、公平排序 | 调模型、读取 Agent Session、根据自然语言选 Agent |
| Engine 联动与恢复 | `src/server/mission-process/mission-process-manager.ts`、Mission Store、Mission Link 契约 | 幂等投递、Goal 与 Ticket 绑定、结算、崩溃续做 | 代替 Agent 规划、测试、验收或生成修复结论 |
| 生命周期投影 | 共享只读投影与前端 selector | 读取权威记录并生成统一用户状态 | 保存第二份可写 Task/头像状态、根据卡片颜色反推 Engine 状态 |
| 事件持久化与重放 | `src/server/tickets/ticket-store.ts`、`src/server/storage/event-ledger.ts`、`src/server/routes/events.ts`、前端 SSE 消费端 | Ticket outbox、观察事件 ID、游标、重放、幂等应用、快照回退 | 把 EventLedger 当成三大 Engine 的权威状态、在前端决定业务流转 |
| 上下文与输出 | `src/server/agent-engine/context-assembler.ts`、Agent Trace、聊天与工作动态投影 | 预算、压缩、引用、用户摘要、原始记录按需展开 | 把完整 Trace 当 Prompt、把 UI 截断结果写回 Session |
| 长期存储 | Agent/Ticket/Mission Store 与附件存储 | 追加写、原子快照、索引、保留、隔离和清理 | 在项目源码中隐藏调度状态、跨项目共享未授权 Session |

实施时优先扩展现有契约和 Store，不新建同义状态或旁路服务。确实需要新增基础设施模块时，它必须是无业务语义的通用能力，并通过架构测试证明没有反向依赖。

## 12. 必须通过的测试矩阵

### 队列与并发

- 一个 Agent Turn 运行时连续发送十条私聊：全部在同一 Thread 中严格按时间序各执行一次。
- 同时触发多个 scheduler tick 和重复 HTTP 请求：只产生一个 Ticket Attempt 和一个 Agent Turn。
- 同一个繁忙 Agent 有两个 ready Ticket，同时其他 Agent 也有 ready Ticket：不丢失、不饿死、不越权改派。
- 分别在模型调用、工具执行、Goal Proposal、Ticket Commit 和 Mission Settlement 时重启：恢复同一个持久操作，不重复结算。

### 生命周期与投影

- 依次模拟失败、暂停、阻塞、重试、恢复、完成和取消：头像、顶部状态、工作动态和控制按钮最终一致。
- Human Input 请求标记正确 Agent，打开同一个 Agent 对话，回复后恢复同一个 Goal。
- Provider 故障只显示重试或配置问题，不会自行把 Mission 标为完成或失败。
- 终态 Ticket 永不重新进入调度；纠错工作有新的 Ticket ID 和完整来源关系。

### 事件

- SSE 断开期间产生事件，携带旧游标重连后，每条遗漏事件恰好收到一次。
- 状态提交后、实时推送前重启服务，页面仍可从权威 Store 和 Mission 恢复对账；Ticket 领域事件从 Ticket outbox 交付，UI 不依赖一条丢失的实时事件。
- 使用快照加重放重建 UI，结果与直接读取权威 Store 一致。

### 上下文与输出

- 长 Thread 超过压缩阈值后，目标、成功标准、阻塞、决策、改动文件和证据仍然存在。
- 之前的完整 assembled prompt 永远不会作为新对话消息再次存储。
- 默认聊天只展示可读进展和结论；原始 Prompt、工具输出和内部思考默认折叠。
- 图片和大文件使用引用，不导致 rollout 或 SSE 负载无限膨胀。

### 生产验收

- 使用真实 Provider 和真实工作区运行一个多小时项目，包含多 Ticket、纠错、Human 私聊、Provider 重试和服务重启。
- 像真实用户一样检查最终交付物，而不只检查单元测试状态。
- 每个 UI 状态都能追溯到一个权威记录，每次业务流转都能追溯到 Agent Proposal 和合法 Ticket 命令。
- 架构测试确认不存在 Ticket 到 Agent 的反向依赖、Agent 到 Ticket 的反向依赖、固定岗位路由、关键词路由或平台业务判断。

## 13. 完成定义

只有同时满足以下条件，可靠性改进才算完成：

1. 队列、生命周期、事件重放、存储和输出契约进入共享类型并由测试约束。
2. 重启与断线恢复具有确定性，不要求 Human 重发任务。
3. 同一个 Agent Thread 不可能并行运行两个 Turn。
4. 终态 Ticket 不可能重新进入调度。
5. Provider 运行错误不可能静默变成业务完成或失败。
6. UI 状态可从权威记录重建，真实运行停止后头像不可能继续保持绿色。
7. 普通聊天可读，完整审计仍可按需查看。
8. 多小时真实验收中，上下文与 UI 负载有界、审计历史完整、没有重复工作。

当前发布门槛：上述 8 项仍是最终上线门槛；本轮只证明了其中的 P0 核心子集。未完成项必须在对应代码、测试和真实验收证据齐备后才能将本文状态改为“可上线”。

### 13.1 当前发布结论

截至 2026-08-03，本轮代码与测试已经证明：

- Agent Thread 的单飞、Human 排队、跨任务隔离、Provider 退避持久化和终态只读恢复可用；
- Ticket 聚合的版本、Claim、不可变终态和 outbox 可用；
- Mission Control 的投递/结算状态可持久化恢复；
- SSE 观察流支持游标重放和切换去重；
- 真实验收脚本能跑通一条真实工作区交付链。

本轮仍不能宣称生产上线，因为“跨引擎恢复对账异常窗口、统一只读 UI 投影、长期日志快照/保留、用户输出分层和多小时真实 Provider 耐久验收”没有同时具备代码、回归测试和真实证据。任何发布说明必须引用这份结论，不得只引用通过的单元测试数量。健康检查还必须同时满足 `ready: true`；仅 `ok: true` 不能作为上线证据。

### 13.2 已完成的真实验收记录

执行时间：2026-08-03 16:56（Asia/Shanghai）

执行命令：`npm.cmd run test:acceptance:real`

结果：通过（这是此前已完成的一次记录，不代表之后每次复验自动通过）。

- 真实工作区：`C:\Users\xieyizhi\AppData\Local\Temp\autoagent-real-acceptance-EcFvfF`；
- 任务状态：`completed`；
- 工单数量：5 张，全部 `completed`；
- 交付物行为：新增 2 条、完成状态刷新后保留、删除 1 条；
- 移动宽度：390px；
- 横向溢出：无；
- 页面错误：0；
- 验收截图：真实工作区 `.autoagent/user-acceptance/desktop.png` 与 `mobile.png`。

本次继续收尾的自动检查：

- `npm.cmd run test:run`：58 个测试文件、502 个测试全部通过；
- `npm.cmd run typecheck`：通过；
- `npm.cmd run build`：通过。

同次服务健康检查还发现 18 个旧工作区成功恢复、3 个旧工作区恢复失败。失败来自历史工作区数据恢复，不改变本次新工作区验收结论，也不通过兼容逻辑掩盖；旧工作区清理或迁移属于单独的数据运维工作，不能作为新链路生产就绪的证据。

### 13.3 最新真实验收复验：未完成，不计为通过

执行时间：2026-08-03 18:27 至 18:47（Asia/Shanghai）。

- 新建真实工作区：`C:\Users\xieyizhi\AppData\Local\Temp\autoagent-real-acceptance-LRqRkc`；
- 真实链路已经推进到：老板需求接收、产品拆解、开发交付、QA 浏览器验证；前四张工单完成，QA 工单仍在运行，最终老板验收工单尚未释放；
- QA 已经实际执行了新增、完成、删除、刷新持久化、390px 和 1440px 横向溢出检查，并产生了浏览器截图与工具证据；
- 验收驱动在外层 15 分钟窗口结束时被终止，因此没有生成 `report.json`，也没有把 QA 的最后结论交给最终验收；服务端仍保留了该开放 Link/Turn；
- 这不是一次通过，也不能仅凭“进程被终止”断定 Agent 进入业务死循环。当前待补的是：验收驱动异常退出后的 Link/Turn 接管，以及在不改变业务结论的前提下提供明确的取消/恢复入口。服务端的主动取消路径已修复：取消 Goal 后会显式释放 Agent Engine 执行租约，不再留下“任务已中断但 Agent 仍显示运行”的假状态。

这条记录会保留为未完成的真实验收证据，直到重新运行产生完整报告，并验证：驱动正常结束、驱动被中止、服务重启后三种情况下，都不会留下不可见的运行工单、重复验收或永远占用的 Agent 租约。当前已用回归测试覆盖“运行中 Goal 被主动取消后，租约释放且所有 Agent 不再显示运行”；外部进程被强制终止后的自动接管仍是未完成项。

### 13.4 最新复验补充：终局输出合同错误导致跨轮重试不收敛

执行时间：2026-08-03 18:58 至 19:18（Asia/Shanghai）。

- 新建真实工作区：`C:\Users\xieyizhi\AppData\Local\Temp\autoagent-real-acceptance-pAoBrP`；
- 前三张工单完成，QA 真实执行了直接打开、待办增删改、刷新保留、桌面和 390px 视口检查；
- QA 的 `goal_resolution` 被 Agent Engine 的输出合同正确拒绝：`domainOutcome.assuranceReport.criterionResults` 传入了 4 项，而当前 QA Ticket 只声明 3 项，且第 4 项结构不合法；
- 之后同一错误在多个 Turn 中重复提交。原因不是 QA 的业务结论被平台改写，而是 Agent Engine 每个 Turn 都重新清零本轮安全计数，Mission Control 又把同一个活动 Goal 自动排入下一轮；因此形成等待/运行交替，直到真实验收驱动超时；
- 本轮没有生成通过报告，Mission 仍为运行中，QA Ticket 仍为运行中，最终验收 Ticket 仍为 pending，不能算成功。

根因级修复已经落地在 Agent Engine：相同 `execution_retry_wait` 原因连续跨两轮出现、期间没有未消费的 Human 消息时，`executionReadiness` 返回 `repeated_execution_retry_without_progress`，Mission Control 将 Goal 暂停而不再自动重试；Human 新消息优先于旧的重试标记，重新打开同一个 Goal 的下一轮。这个规则只处理通用的“相同执行阻塞没有进展”，不识别 QA、PM、开发等业务角色，也不替 Agent 选择通过或失败。

对应回归测试验证三件事：第一次相同阻塞允许一次恢复；第二次相同阻塞暂停；Human 新消息到达后恢复。真实验收仍需重新跑通，不能用该单元回归替代真实用户验收。

### 13.5 最新复验结论：提示词已区分两层标准，但领域 Schema 仍需收敛

执行时间：2026-08-03 18:58 至 19:18（Asia/Shanghai），工作区：
`C:\Users\xieyizhi\AppData\Local\Temp\autoagent-real-acceptance-pAoBrP`。

- QA 已完成真实浏览器检查，确认文件可直接打开、待办增删改、刷新保留以及桌面和 390px 视口无横向滚动；这部分有截图和工具证据，不是“自报完成”。
- QA 的终局 `goal_resolution` 仍被拒绝：`domainOutcome.assuranceReport.criterionResults` 多提交了一项，且该项结构不合法；随后同一 Goal 又提交了语义相同的错误，最终在受控重试边界处暂停。Mission 没有被错误结算，最终验收 Ticket 也没有被错误释放。
- 这说明上一轮只在提示词中解释“顶层 Ticket 标准”和“嵌套 Mission 标准”还不够。原有领域 Schema 为每个 criterion 生成多分支 `anyOf`，同时还把不同数量的 anchor 规则编码进模型可见结构；在模型重提时增加了结构歧义。
- 当前根因级改动是收敛通用领域 Schema，而不是替 QA 选择结论：`mission-assurance-v1` 现在向 Agent 暴露一个统一的 criterion 结果对象和当前 Ticket 允许的 `criterionId` 集合；运行时仍严格检查 criterion 是否完整、唯一、属于当前 Ticket，且 `anchorResults` 是否逐项覆盖 baseline。Schema 简化不等于验收放宽。
- Agent Engine 的终局提交边界同时收紧为“第一次拒绝给一次纠正机会，第二次相同终局合同错误暂停并等待新的 Agent/Human 输入”；默认值为 2，可通过运行配置调整，不是业务轮数限制。

这一轮仍不能计为真实验收通过。必须用新构建在干净工作区重新验证：正常合同可以完成老板最终验收；错误合同只暂停一次且不重复创建实体；Human 新消息能在原 Thread 恢复；服务重启后不留下隐藏租约或重复运行。

## 14. 明确不做的事

本轮可靠性改进不增加：

- Agent 到 Agent 私聊邮箱；
- rollout 和 Ticket readiness 之外的第二条队列；
- 第四个编排或决策 Engine；
- 固定岗位顺序或必选部门；
- 正则表达式和关键词路由；
- 平台生成的 QA、PM、开发、招聘或验收结论；
- 复活旧阶段记录或已完成 Ticket 的兼容逻辑。

目标保持简单：Ticket Engine 管正式工作，Agent Engine 管一个人的有序 Agent Loop，Mission Control 负责持久投递与结算，其他运行能力只负责让这三者之间的关系可靠、可恢复、可观察。

## 15. 本次续推记录：Mission 结算原子边界

本轮发现并修复了一个真实的持久化窗口：Agent 结论已经被接受后，Mission 原先可能先持久化为 `completed`，再单独把对应 Mission Link 持久化为 `settled`。进程如果在两次写入之间退出，恢复时会看到“Mission 已完成但最终工单链接仍未结算”的半完成快照。

现在的提交边界是：

1. Ticket Engine 先按自己的聚合版本提交 Ticket 结果；
2. Agent Engine 先按自己的 Goal 版本提交结论；
3. Mission Control 在一次 Mission Store CAS 提交中同时写入 Mission 终态和对应 Link 终态；
4. 恢复只依据这份权威快照继续对账，不依赖 UI 事件，也不重新创建第二个 Goal、Ticket 或 Plan。

回归测试覆盖了最终验收链：在同一条持久提交快照中断言 `Mission=completed` 与最终验收 Link=`settled` 同时成立，并确认不会把后续普通游标写入误判为新的终态提交。

这项修复只收紧 Mission Control 自己的持久提交边界，没有增加角色路由、关键字判断、固定阶段或 Agent 业务结论；跨三大 Engine 仍然保持各自事实账本和明确的 Mission Link 对账关系。

## 16. 本次续推记录：状态投影使用持久执行租约

此前 `RuntimeHost` 在投影 Agent 状态时，把内存中的 `agentRuns` 当成“正在运行”的依据。这个依据只在当前进程内成立：服务重启、后台调度切换，或者 Agent 持有执行租约但正在等待模型重试时，UI 都可能显示出与真实执行状态不一致的结果。

现在 `AgentEngine.getProjection()` 同时返回只读执行投影 `execution.leaseHeld`，来源是 Agent Engine 自己的持久执行租约。`RuntimeHost` 只使用这个投影和会话中最近的控制事件来显示 Agent 状态：

- 持有执行租约且没有等待类控制事件：显示“运行中”；
- `provider_retry_wait`、`execution_retry_wait`、`external_service_waiting` 或 `waiting`：显示“等待中”；
- 没有租约但工单仍处于运行链路：显示“等待中”，等待调度器重新领取；
- 不再使用 RuntimeHost 的进程内 Map 作为 UI 事实来源。

这仍然是只读状态投影，不负责决定角色、工单流转或 Agent 结论；业务事实仍由 Agent Store、Ticket Store 和 Mission Store 各自保存，Mission Control 只按 Link 对账。

## 17. 本次真实用户验收记录：结论协议仍需改善可用性

本次使用真实 Provider、真实工作区和真实浏览器完成了一次端到端验收：

- QA 实际打开了目标页面，完成了快照、填写、点击新增、刷新后的持久化检查；
- 真实交付物的新增、刷新后保留、删除和移动宽度检查均通过；
- 五张工单最终完成，老板最终验收通过；
- 验收过程中没有发现“读取文件与没有可结算目标”之间的旧式死循环。

同时记录到一个必须保留的 Agent Engine 改进项：QA 第一次提交 `goal_resolution` 时引用了不存在的证据 ID；Mission Control 正确拒绝了这个结论。下一轮 QA 又遗漏了工具协议要求的顶层 `status` 字段，因此提交再次被拒绝，通用的无进展保护随后暂停了该轮，后续恢复轮才提交了合法结论并继续完成验收。

这不是平台替 Agent 判断结论的理由，也不能通过“缺字段就自动补值”或关键字判断来修复。正确边界是：

1. Agent Engine 提供稳定、通用、可恢复的工具协议和校验反馈；
2. Mission Control 只接受符合契约的 Agent 结论，不替 Agent 选择通过或失败；
3. Ticket Engine 只依据已接受的正式结论更新工单，不读取聊天文本猜测结果；
4. 需要继续改进的是工具协议的模型可用性、校验错误的可恢复性，以及失败后恢复轮的可观察性和时延。

因此，本次真实验收证明了主链路可以完成，但不能把它解释成“生产就绪”。`goal_resolution` 的失败重提体验、长时间 Provider/人工输入耐久性、跨引擎重启恢复、统一只读 UI 投影和存储运维仍然是上线门槛。

## 18. 本次继续收尾：阻塞负责人和默认聊天投影

本次继续推进没有新增业务路由，也没有把“谁该处理”写成阶段表。实际改动只有两类：

1. 人工测试或阻塞工单的具体 Agent 只能来自服务端 `Ticket.targetAgentId` 投影。若权威记录没有负责人，页面不再从 `targetRole`、Ticket 类型或 Mission 阶段推导一个 Agent ID，因此不会错误点亮 QA、开发或老板头像，也不会把回复发到猜出来的会话。
2. 同一类缺少负责人时，聊天区域显示“当前工单负责人”或“团队”，明确告诉用户平台没有拿到可寻址负责人；这只是诚实的只读提示，不会替代 Mission Control 做派发。

对应回归测试覆盖：

- `targetRole=qa` 但缺少 `targetAgentId` 时，不产生 QA 人工介入标记、不生成错误 Agent 对话目标；
- 同一场景的回复对象显示为“当前工单负责人”，而不是根据 `qa` 阶段猜测；
- 有 `targetAgentId` 时仍保持原有真实负责人和 Human-in-the-loop 恢复路径。

这说明文档中的 P0 项已经继续收敛，但 P0 的“统一只读 UI 投影”尚未完成：运行动态、聊天摘要、运维详情仍需进一步拆成明确的服务端投影类型，并补齐断线/重启后的前端重建测试。

## 19. 本次继续收尾：真实验收驱动的退出契约

真实验收脚本是用户验收工具，不是 Mission 的第二个调度器。它可以创建工作区、提交目标、处理明确的人工测试输入并记录报告，但脚本进程退出不能改变 Mission、Ticket 或 Agent 的业务事实。

因此必须区分三种情况：

1. **正常结束**：脚本只在 Mission 已由 Mission Control 结算为终态、所有 Ticket 已退出调度且报告已原子写入后退出。
2. **用户中止或执行器终止**：脚本记录“验收未完成”，服务端仍按权威 Link/Turn 保存现场；恢复入口必须继续同一个未完成操作，不能新建 Plan、Ticket、Goal，也不能把运行状态显示成完成。
3. **服务重启**：RuntimeHost 和 Mission Control 从持久记录恢复开放 Turn、租约和 Link；若旧驱动已经不存在，系统仍应显示可继续/可停止的任务，而不是让用户只能重开项目。

这里不增加一个平台业务判断层，也不根据“QA”“验收”等文字补状态。需要补的是运行控制与事实对账：驱动的生命周期是观察者，Mission Link 才是投递和结算事实；所有接管、取消、恢复操作必须引用同一个 `missionId`、`ticketId`、`agentGoalId` 和 Attempt，确保幂等。

本次代码与回归证据：`RuntimeHost.cancelTask` 在取消活动 Goal 后调用对应 Agent Runtime 的 `releaseGoalResources`；`tests/server/runtime-host.test.ts` 覆盖模型 Turn 正在运行时取消任务的响应性、租约释放和最终 Agent 投影。

## 20. Agent Engine 合同错误的恢复契约

Agent Engine 不替 Agent 做领域判断，但必须保证“工具合同写错”不会变成无边界的自动消耗：

1. 工具参数或领域输出不符合当前 Goal 合同时，保留完整调用和校验结果到审计 Trace；给模型的上下文只保留字段路径、修正要求和必要的合同说明，不把整份失败参数递归注入下一轮。
2. 同一执行阻塞允许一次自动恢复，让模型有机会依据校验结果修正提交；终局提交默认最多两次尝试，即第一次拒绝后的唯一纠正机会，第二次仍错就暂停，不再靠固定轮数继续消耗。
3. 如果相同执行阻塞跨轮重复，且没有新的 Human 输入或已接受的 Goal 状态变化，Agent Engine 返回不可继续的 readiness；Mission Control 只负责暂停同一个 Goal，不创建新 Ticket、Plan 或 Session。
4. Human 消息是恢复输入，按原 Thread 时间顺序进入下一轮；它不会创建旁路 Session，也不会直接改变 Ticket 结论。
5. Provider 临时故障仍按独立的持久退避策略处理；它与合同错误不能混用，否则会把确定性错误伪装成可重试基础设施故障。

这是一条通用 Agent Engine 运行契约，不是 QA、PM 或开发的业务分支。它的目的只有一个：允许长时间工作，但在“同一个没有进展的错误”上停下来，把控制权交还给可见的 Human/运维恢复入口。

本次继续落地的代码与证据：

- `mission-assurance-v1` 的模型指令现在明确要求 `assuranceReport.missionCriterionResults` 数量必须严格等于当前 Ticket 声明的 Mission criteria 数量；顶层 `goal_resolution.criterionResults` 只对应当前 Ticket 的成功标准，两个数组不再使用同名字段，不能添加总体结论、汇总项或额外 criterion。这是让 Agent 能正确提交当前领域合同，不是平台替 QA 选择结论。
- `mission-assurance-v1` 的可见 Schema 已从按 criterion/anchor 生成的多分支结构收敛为统一结果对象，并将领域结果字段明确命名为 `missionCriterionResults`；当前 `criterionId` 集合、标准数量、锚点数量、证据归属和状态仍由通用运行时合同校验，避免把平台业务判断塞进 Agent Engine。
- 终局合同错误的默认恢复上限为 2 次：一次自动纠正，第二次暂停等待新的输入；这一上限只属于通用执行可靠性，不是 QA、PM 或开发的业务规则。
- Agent Engine 的通用 readiness 回归覆盖“第一次合同阻塞允许自动恢复、第二次相同阻塞暂停、Human 新消息恢复”；`ticket-agent-adapter` 回归覆盖验收提示词对数量和唯一 ID 的明确约束。
- 最新自动检查为 58 个测试文件、503 个测试通过；本轮 Schema 收敛后的定向 Agent/契约回归为 118 项，TypeScript 检查和生产构建也已通过。
- 新构建的干净工作区真实验收已经通过；但这只证明一条正常交付链，不代表旧工作区恢复、跨引擎对账、长期运行和运维门槛全部完成。

## 21. 本轮文档对齐与最新真实验收结论

本节记录本轮把设计真正落到实现后的事实，作为第 13 节之前结论的更新，而不是另起一套方案。

### 21.1 已落地的根因修复

真实验收暴露的根因是：`goal_resolution` 的通用完成标准与领域验收标准都叫 `criterionResults`。模型在同一次工具调用里需要同时填写两组不同语义、不同数量、不同索引方式的数组，失败后容易把 Mission 标准复制到顶层，或把总体检查项追加到领域数组。平台拒绝该结果是正确的，但旧字段设计增加了可避免的歧义。

现在的唯一协议是：

- 顶层 `criterionResults`：只属于 Agent Engine 的通用 Goal，只按当前 Ticket 的 `successCriteria` 使用 `criterionIndex`。
- `domainOutcome.assuranceReport.missionCriterionResults`：只属于 `mission-assurance-v1` 领域交付，只按当前 Ticket 声明的 Mission `criterionId` 使用 `anchorResults`。
- 两组结果的数量、身份、证据和锚点仍由运行时严格校验；平台不从自然语言、关键词或角色名推断通过、失败或返工。
- 合同错误最多给同一执行一次纠正机会；同一错误跨轮没有新的 Human 输入或状态进展时暂停，保留原 Thread、Goal、Ticket 和审计记录。

这次改动涉及领域输出契约、Agent 提示说明、模拟 Provider 和契约回归测试，没有改变 Ticket DAG 的业务路由，也没有新增 QA/PM/开发分支。

### 21.2 自动检查事实

- 58 个测试文件、503 个测试通过。
- 其中本轮相关定向回归 118 项通过。
- TypeScript 检查通过。
- 生产构建通过。

### 21.3 最新真实用户验收事实

最新验收工作区为：`C:\Users\xieyizhi\AppData\Local\Temp\autoagent-real-acceptance-JFjot9`。

- 老板完成目标接收，产品完成拆解，开发产出 `index.html`，QA 实际启动浏览器并完成新增、完成、删除、持久化、刷新和移动端无横向溢出检查。
- QA 的事实检查已经完成，但终局提交仍使用了旧的领域字段形状，平台按契约拒绝；同一 Goal 第二次无进展后暂停，真实验收驱动报告“未完成”，没有错误结算 Mission，也没有释放最终验收 Ticket。复核后确认：这次验收所连接的 13748 服务进程早于 Schema 改名后的构建启动，因此这条记录只能作为“旧进程/旧协议现场”，不能作为新构建已经复验失败的证据。
- 这条旧进程现场仍然证明验收必须绑定明确的构建版本；Schema 改名后的新构建必须在重启后的干净工作区重新跑完整链路，并在报告中记录服务进程与构建时间，避免把旧运行时结果误归因于新代码。
- 本轮服务健康检查还发现旧工作区恢复结果为 `22` 个成功、`3` 个失败；失败属于历史数据恢复异常，当前版本不能把 runtime host 标为生产健康，也不能用兼容分支掩盖。

### 21.4 当前上线结论

当前状态是“核心可靠性已落地、正常真实交付链已通过、仍不能上线”。旧工作区恢复仍有 3 个失败实例；跨引擎恢复对账、事件断线/重连组合、长期日志治理、用户输出分层和多小时 Provider 耐久仍没有同时具备代码、回归测试和真实证据。没有这些证据，文档状态不得改为“可上线”。

### 21.5 新构建真实验收与验收脚本根因修复

本轮使用新构建重启后的服务 `http://127.0.0.1:13748`，在全新工作区完成真实用户链路：

- 工作区：`C:\Users\xieyizhi\AppData\Local\Temp\autoagent-real-acceptance-5SLUGo`，ID 为 `ws_c57f47921e4c4254`。
- 任务：`task_8b7cea61308a4a26`；5 张工单全部 `completed`，包括目标接收、计划拆解、开发、质量检查和最终验收；所有 Agent 最终回到 `idle`。
- QA 使用真实浏览器验证了 `index.html`：新增 2 条待办、完成勾选、刷新后完成状态保留、删除 1 条待办、390px 移动端检查、无横向溢出、无页面错误。
- 验收报告：`C:\Users\xieyizhi\AppData\Local\Temp\autoagent-real-acceptance-5SLUGo\.autoagent\user-acceptance\report.json`；截图：同目录下的 `desktop.png` 和 `mobile.png`。
- 运行时间：任务在 `2026-08-03T14:32:54.897Z` 完成；修正验收脚本定位器后，于 `2026-08-03T14:36:11.334Z` 完成真实产物复核，报告为 `passed: true`。

这次暴露并修复了验收工具自身的根因：脚本使用 `ancestor::li[1]` 寻找待办行，而真实交付使用的是语义正确的 `<article class="todo">`，因此脚本报告“没有完成勾选框”。修复为 `ancestor::*[self::li or self::article][1]` 后复核通过。平台没有替开发或 QA 修改交付结论，脚本也没有把失败改写成通过；它只是恢复了对真实 HTML 语义的正确观察。

这条证据与之前的失败现场必须区分：之前的旧进程/旧协议现场用于定位合同问题，不能作为新构建失败的证据；本节记录的是新构建、干净工作区和修正后的真实验收报告。

本轮仍不能称为生产上线，因为服务健康检查仍显示 `runtimeHosts.status=degraded`：25 个旧工作区恢复成功、3 个历史工作区恢复失败。失败原因分别是历史数据中的缺失字段和 Goal 版本不连续。当前正确处理是把它们作为数据恢复/迁移阻塞公开出来，不通过兼容分支掩盖，也不把新工作区的成功冒充为全量生产健康。

### 21.6 本轮恢复审计与唯一处理原则

本轮对服务启动时公开的 3 个历史恢复失败进行了只读取证，并把根因分成两个事实账本的契约问题：

1. 两个旧 Mission 的 `record.teamBinding.members` 只有 `agentId`、`principalId` 和 `capabilities`，没有 `enabledTools`。旧快照因此不满足当前 TeamBinding 契约；此前它越过 Store 校验，直到权限匹配阶段才对 `undefined` 调用 `includes`。现在 Mission Store 在创建和读取边界验证完整成员快照，并明确抛出损坏数据错误。
2. 另一个旧 Agent rollout 在同一 Goal 已写入版本 15 后又出现版本 14。当前 Agent Store 拒绝这种历史回退是正确的；现在错误会包含 Agent ID、Goal ID、实际版本和期望版本，恢复系统可以把它作为数据恢复阻塞处理，而不是把它误解成普通 Agent 运行失败。

这里不做旧工作区兼容、不自动补字段、不重排历史版本，也不把旧数据“迁移成功”写回生产状态。新项目必须从完整 TeamBinding 和单调 Goal 版本开始；历史失败工作区必须经过明确的数据修复/迁移工具或被用户删除后，健康检查才可能回到 `ready: true`。这条原则保护的是事实账本，而不是让旧数据继续运行。

本轮代码验证：

- `npm.cmd test -- --run tests/server/mission-store.test.ts tests/server/agent-store.test.ts`：2 个文件、10 个测试通过；
- `npm.cmd run typecheck`：通过；
- `git diff --check`：通过；
- 当前服务健康检查仍须以 `ready` 为上线依据；旧工作区恢复失败时，`ok: true` 只代表 HTTP 存活，不能代表生产就绪。

### 21.7 本轮继续：统一 Workspace 生命周期投影

本轮又发现一个独立于业务路由的可靠性缺口：Workspace Snapshot 原来分别调用 `presentationStatus` 和 `presentationPhase`。两套判断的事实来源相同，但优先级没有集中维护，因此一个待处理 Ticket 可能被投影为“状态运行中、阶段空闲”；运行记录结束时间还依据旧的 RuntimeTaskRecord 状态，可能与已经投影出的终态不同步。

根因级处理如下：

1. 新增 `projectWorkspaceLifecycle`，一次读取 Mission、Plan 和 Ticket 的权威状态，原子地产生 `{ status, phase }`。
2. Snapshot、任务状态展示和 `presentationStatus` 统一使用这一个投影；它只负责事实展示，不决定 Agent、岗位或下一张 Ticket。
3. 终态运行记录的 `endedAt` 依据同一份投影判断，避免页面同时显示“已完成”和“仍在运行”。
4. 回归测试覆盖待处理、运行中、阻塞、Plan 已完成等待验收和 Mission 已完成五种组合，并要求 status/phase 成对一致。

验证证据：`tests/server/runtime-host.test.ts` 当前 47 个测试通过，`npm.cmd run typecheck` 通过。该修复只收敛跨引擎事实的只读投影，没有增加岗位、关键词、阶段或业务结果的硬编码路由。

### 21.8 本轮继续：跨引擎终态恢复回归证据（2026-08-04）

本轮把 21.0 中的恢复原则继续落到了 `MissionProcessManager.reconcileAuthoritativeLinks`，并用专项回归验证。修复前，Mission Control 看到 Ticket 已进入终态时，可能直接把活动 Link 标成 `settled`；这会把 Ticket Engine 的状态误当成 Agent Engine 已提交的结论，掩盖“Ticket/Goal 已结束但 Mission Link 尚未记账”的崩溃窗口。

本轮实现的边界是：

1. Ticket Engine 仍只负责证明 Ticket 命令和 Ticket 状态已经持久化；
2. Agent Engine 仍只负责保存 Goal、Proposal 和 Decision；
3. Mission Control 只有在找到同一个 `lastProposalId` 对应的持久 Proposal 时，才调用 `continueSettlement` 重放结算；重放继续使用原 Link、原 Attempt 和原命令幂等键；
4. 如果 Ticket 或 Goal 已经终态但对应 Proposal 不存在，恢复抛出 `MissionRecoveryError`，保留 Mission 未结算，不创建第二个 Ticket、Goal 或 Plan，也不猜测业务结果；
5. 如果只是活动 Goal 仍未终态、旧 Link 暂时停留在 `resolving` 且 Proposal 已被消费，继续走原有活动恢复流程，不把正常恢复误判为数据损坏。

回归证据：

- `tests/server/mission-process-manager.test.ts` 的“Ticket 已提交后的旧 Link 重放”通过；
- 同文件新增“终态 Link 缺少 Agent Proposal 时拒绝伪结算”通过；
- 同文件“已消费 Proposal 的活动 Link 恢复”通过；Mission 专项共 25 个测试通过；
- `npm.cmd run typecheck` 通过；
- `npm.cmd run test:run`：59 个测试文件、518 个测试通过；
- `git diff --check` 通过。

这次处理的是跨引擎持久事实引用，不是角色、阶段、关键词、自然语言或业务结果的 `if/else`。它只解决“恢复时能不能证明这一次结算确实有 Agent 结论”，不宣称已经完成旧工作区迁移、长期 Provider 耐久、存储保留治理或所有 UI 分层。因此当前状态仍为“核心恢复边界已补齐并通过自动回归，生产上线门槛尚未全部满足”。

### 21.9 本轮真实用户验收：外部 Provider 等待不能伪装成业务终态（2026-08-04）

本轮继续使用真实 Provider、真实工作区和真实 Agent 工具执行验收，没有由平台代替 Agent 修改项目，也没有把验收结果改写成成功。验收链路实际推进到：老板需求接收完成、产品/项目计划完成、开发完成、质量检查运行中、老板验收等待中；共 5 张工单，没有重复 Ticket、重复 Goal 或错误回到产品/项目。

这次验收驱动在 10 分钟观察窗口内没有看到业务终态，外层驱动因此被超时终止。这个结果只能记为“驱动观察超时”，不能记为 Mission 失败，也不能记为验收通过。现场保留在：

- 工作区：`C:\Users\xieyizhi\AppData\Local\Temp\autoagent-real-acceptance-Jj9jUD`；
- QA Agent：`workspace-agent_sAxWSGMC0E9t4-N6WSChh4ziGMzaLOQgMmWE8cFaJBE`；
- Agent 追加日志：`.autoagent\agent-engine\kuaScqZsmBH87HWJ7fGaP8DQsRbzK8jF1Cgkdb0kTVI\rollout.jsonl`。

现场最后记录了同一个 Agent Goal 的 `provider_retry_wait`、`external_service_waiting`，随后恢复为 `running`；QA 的 Thread 中出现多次 `502 status code (no body)`，但没有产生最终 Proposal/Decision。因此 Runtime Host 保留原 Ticket、原 Goal、原 Thread 并进行可恢复退避，不能释放下游 Ticket，也不能把“模型暂时没有返回”当成 Agent 完成。这个行为符合三大 Engine 的边界：Provider 故障由 Agent Engine/Runtime Host 处理，Ticket Engine 不猜业务结论，Mission Control 不跨越缺失的 Agent 结论做结算。

本轮自动检查仍通过：`npm.cmd run test:run`（59 个测试文件、518 个测试）、`npm.cmd run typecheck`、`npm.cmd run build`、`npm.cmd run test:browser:sse`。但是这条真实验收尚未通过，因为没有最终 Agent 结论和交付验收报告；不能用自动回归替代真实交付。

本轮新增的上线判断：

1. Provider 退避必须持续记录“正在等待外部服务”，并在 UI 显示最后一次重试时间、重试原因和当前负责人；“运行中”不能掩盖长时间无进展。
2. 真实验收驱动必须区分 `driver_timeout` 与业务 `failed`，超时只结束观察，不改变 Mission、Plan、Ticket 或 Goal。
3. 真实 Provider 故障恢复、服务重启、排队 Human 消息和最终终态必须在同一个干净工作区完成一轮长窗口验收后，才可关闭 P1 长期运行门槛。
4. 当前服务健康检查仍为 `ok: true`、`ready: false`，历史工作区恢复失败仍是上线阻塞；不能因为新工作区能启动就宣称整个平台已生产就绪。

### 21.10 本轮继续：真实验收链最终闭合与终态提交契约证据（2026-08-04）

对 21.9 现场继续观察后，不能再把“驱动曾经超时”当成这条 Mission 的最终结论。权威状态已经落盘并完成对账：

- 工作区：`C:\Users\xieyizhi\AppData\Local\Temp\autoagent-real-acceptance-Jj9jUD`；
- Mission：`task_0e3b9afcc150441e`；
- Mission 状态：`completed`；
- 工单链：需求接收、计划拆解、开发、质量检查、最终验收共 5 张 Ticket，全部 `settled`；
- 每个 Link 都保存了自己的 `lastProposalId`、`lastCommandId`、`lastDecisionId`、最终 Ticket 版本和最终 Goal 版本；
- QA 的最终 Proposal/Decision 已被 Mission Control 接受，最终验收 Ticket 随后完成；没有新增 Plan、重复 Ticket、重复 Goal 或旁路 Session。

这条现场同时验证了终态提交契约的真实行为：QA 先提交了多于当前 Mission criteria 数量的 `missionCriterionResults`，Agent Engine 按当前 `mission-assurance-v1` Schema 拒绝；模型依据工具返回的字段错误继续修正，最终提交恰好对应当前 3 个 Mission criteria 的结构化结论并被接受。平台没有替 QA 删除多余项、选择通过或改写证据。该错误是一次可见、可恢复的 Agent 合同错误，不是业务失败，也不是 Ticket 路由失败。

因此，本轮对三大 Engine 的结论是：

1. **Agent Engine**：负责保存按时间顺序的 Agent 消息、工具调用、工具错误和 Proposal/Decision；对终态工具合同做结构化校验，并在同一错误无进展时可暂停。它不决定 QA 是否通过。
2. **Ticket Engine**：负责保存 Ticket、依赖、Claim、Attempt 和终态退出；不读取模型自然语言，也不因为 Agent 的普通文本自动推进下游。
3. **Mission Control**：只把已经持久化的 Agent Proposal/Decision 转换为同一 Ticket Attempt 的命令，并以同一个 Link/幂等键完成对账；没有 Proposal 时不能从 Ticket 终态猜 Mission 已完成。

这次没有新增业务 `if/else`。已有的 Schema、Proposal/Decision、Link 和恢复对账代码已经足以处理该现场；本次补充的是证据和边界说明，而不是为了“看起来完成”再增加一条业务分支。

仍未达到“整个平台可上线”的原因也必须单独记录：最新真实链路完成不等于服务全局健康。当前 `/api/health` 仍是 `ok:true`、`ready:false`、`runtimeHosts.status:"degraded"`，历史工作区恢复失败仍需明确迁移或由用户删除；Provider 多小时耐久、长时间排队 Human 消息、跨重启业务恢复和完整 Trace/运维投影仍需真实证据。生产门槛保持未满足，不能用这条成功 Mission 掩盖这些阻塞。

### 21.11 本轮继续：历史 TeamBinding 的显式迁移入口（2026-08-04）

本轮确认历史工作区恢复阻塞的第一类根因是：旧 Mission 的 `TeamBinding.members` 持久化了 Agent 身份和能力，但没有持久化当时的 `enabledTools`。运行时拒绝恢复这些数据是正确的；在运行时偷偷补字段会把未知权限伪装成已知事实，也会破坏不可变 TeamBinding。

因此新增的是一次性运维迁移，而不是运行时兼容分支：

1. `npm.cmd run migrate:team-bindings` 默认只读扫描当前注册工作区，输出 Mission、目录、状态和缺失 Agent，不修改任何文件。
2. `npm.cmd run migrate:team-bindings -- --apply` 只迁移 `completed` Mission；每次迁移先把原始 JSON 备份到工作区 `.autoagent/migrations/team-binding/`，再用当前 Agent 的显式策略补齐缺失工具快照。
3. 迁移只补缺失成员的工具字段，保留历史 TeamBinding 的成员集合、Agent 身份、能力、投递策略和绑定身份；后来新增的 Agent 不会被带入旧 Mission。
4. 活动或未结算 Mission 默认不改写。只有运维明确使用 `--include-active` 才允许迁移，且仍然保留备份和版本递增记录。
5. 迁移结果写入 `teamBindingMigration` 元数据并递增 Mission 版本；运行时不识别旧格式、不自动改写、不把迁移前的数据当作健康数据。

初次真实预览结果为 18 个历史 Mission，其中 2 个已完成、16 个仍为活动或未结算。本轮只按默认安全规则迁移了那 2 个已完成 Mission，原始文件已分别备份；没有迁移活动任务，也没有删除工作区。随后执行恢复对账，当前恢复成功 20 个、失败 16 个，健康检查继续保持 `ready:false`。这里的 16 个是失败工作区数量，不是 Mission 数量。

迁移工具随后再次进行只读预览：当前仍发现 18 个缺少工具快照的 Mission，全部状态为 `linked`，默认预览全部标记为 `canMigrate:false`，原因是活动或未结算 Mission 必须显式使用 `--include-active`；预览与执行现在使用同一条安全门槛。该预览没有修改任何文件。剩余历史 Mission 必须由运维明确选择继续迁移或删除，不能因为想让健康检查变绿就静默恢复旧任务。这是上线门槛的真实阻塞，不是测试噪声。

本轮新增回归证据：

- `tests/server/team-binding-migration.test.ts`：验证默认只读、已完成任务可备份迁移、历史成员不会被后来成员污染、活动任务未显式授权时不会改写。
- 迁移相关定向测试：2 个测试文件、5 个测试通过；`npm.cmd run typecheck` 通过。

### 21.12 本轮继续：真实用户验收暴露 Agent 技能协议边界（2026-08-04）

上一条“真实验收通过”的记录只代表 `autoagent-real-acceptance-Jj9jUD` 那一次已经落盘的成功 Mission，不能覆盖随后对另一份干净工作区的复验。最新复验没有通过，报告为：

- 工作区：`C:\Users\xieyizhi\AppData\Local\Temp\autoagent-real-acceptance-HieRMi`；
- 结果：`passed:false`、`outcome:"driver_timeout"`；
- 观察窗口：180 秒；开发 Ticket 在窗口结束时仍未产生文件，QA 尚未开始；停止后没有后台继续运行，临时 Mission 已明确取消；
- 因此这不是“Ticket 已完成但 UI 没刷新”，也不是 QA 把失败判成通过，更不是平台替开发写了结果。这一轮不能计入上线通过。

现场 Trace 给出的根因不是业务路由，而是 Agent Engine 的工具与 Skill 协议没有对齐：

1. 空工作区中，开发 Agent 先读取了不存在的 `index.html`，得到 `ENOENT`；
2. 随后把 `agent-browser` 的完整 Skill 文档当成了当前工作对象，分段读取了外部 Skill；Skill 中使用的是 shell 风格 `agent-browser set viewport 1264 900`；
3. 平台的 `browser` 工具实际接收的是参数数组，模型提交了一个元素 `['set viewport 1264 900']`，运行时按一个完整命令执行，返回 `Unknown command`；
4. 在没有交付文件的情况下，Agent 继续探索工具，没有尽早把“交付物尚未产生”作为当前 Goal 的事实反馈出来，所以真实验收只能超时。

这里必须区分三件事：

- **Skill 被读取本身不是错误**。Pi/Codex 类 Agent 采用渐进式披露：先看 Skill 名称，命中任务后再读取完整说明；问题在于外部 Skill 的命令协议与平台工具协议没有被适配清楚。
- **平台不能替 Agent 判断业务完成或替 Agent 改代码**。平台只能提供稳定的工具协议、会话串行、执行租约、可恢复错误和证据记录。
- **“先形成交付物，再做可选的工具探索”是 Agent Engine 的通用执行纪律，不是角色路由或业务 `if/else`**。Skill 说明是参考资料，不是工作目标；Agent 读取后应立即执行最接近当前成功标准的动作。

本轮的根因修复方案已经确定：

1. 在 Skill 适配层明确声明平台工具的真实调用形状：`browserArgs` 是逐项参数数组，给出 `open`、`snapshot`、`set viewport`、`click`、`fill` 的可执行示例；不要求 Agent 通过 shell 间接调用。
2. 在通用浏览器工具边界增加一次协议归一化：已正确拆开的参数原样保留；若 Skill 使用单字符串命令形式，则按带引号的命令参数规则解析为数组后再执行。该归一化只修复工具协议，不判断任务内容、不选择 Ticket、不决定完成。
3. 在通用 Agent 执行提示中明确：不要把读取 Skill 当成交付；对于需要创建交付物的 Goal，先用最少必要的工作区观察确认现状，空目录或入口缺失时创建必要的最小交付物；只有当前成功标准需要时才加载并执行 Skill 验证。
4. 增加协议级回归：单字符串 Skill 命令、多参数数组、带引号参数、错误命令返回和空工作区交付顺序都必须可观察、可重放；真实验收必须再次确认文件产出、浏览器操作和终态，而不是只看 Ticket 状态。

本轮实现与自动验证：

- `src/server/agents/skill-config.ts` 已补齐外部 Skill 到一级 `browser` 工具的参数示例和边界说明；
- `src/server/agent-engine/tool-runtime.ts` 已增加只处理工具协议的参数归一化：正确数组原样保留，单字符串命令按带引号参数解析；没有加入角色、Ticket 或完成状态判断；
- `src/server/agent-engine/pi-runtime.ts` 已补充通用执行纪律，明确 Skill 不是交付物，空工作区需要交付时应先完成最小可逆实现；
- `tests/server/agent-tool-runtime-v2.test.ts` 和 `tests/server/agent-skill-config.test.ts` 覆盖了拆分数组、引号参数、未闭合引号和 Skill 适配说明；全量结果为 `60` 个测试文件、`524` 个测试通过，类型检查和生产构建通过。

修复完成前的上线结论保持为 **未达到上线标准**：自动回归通过不等于真实 Agent 能在干净工作区交付；当前验收阻塞明确属于 Agent Engine 的 Skill/工具协议与执行纪律问题，Ticket Engine 和 Mission Control 不应通过业务补丁替它绕过。

### 21.13 本轮继续：业务终态与验收观察终态必须分离（2026-08-04）

#### 真实证据

在修复 Agent 技能协议后，使用另一份干净工作区再次执行真实验收：

- 工作区：`C:\Users\xieyizhi\AppData\Local\Temp\autoagent-real-acceptance-zA7AmZ`；
- 验收驱动观察窗口：显式设置为 `600000ms`，在 `20:49:15.179Z` 观察到的快照仍为 `running`，因此报告 `passed:false`、`outcome:"driver_timeout"`；
- 随后同一 Mission 没有被取消、重建或改写：QA Link 在 `20:49:08.269Z` 已结算，最终老板验收 Link 在 `20:49:43.396Z` 结算；最终 Proposal 的 `goal_resolution_decision` 为 `accepted`，`committedState:"completed"`，Ticket 和 Plan 也均为 `completed`；
- 真实交付物已经存在：`index.html`、`app.js`、`styles.css`、桌面截图和 `390px` 移动截图；QA 还完成了浏览器打开、交互和无横向溢出检查。

这条证据说明“驱动在最后一次异步结算前退出”和“业务没有完成”是两件不同的事。此前报告的 `driver_timeout` 仍然是正确的观察结果，但它不能被上层汇总为 Mission 失败；随后持久事实完成时，也不能把原报告事后改写成当时已经观察到终态。

#### 根因判定

这次不是 Ticket Engine 的流转错误，不是 Agent Engine 的业务判断错误，也不是 Mission Control 需要新增角色或阶段分支。根因是验收观察器把自己的截止时间当成了业务终态边界：

1. Mission、Ticket、Agent Goal 的终态由各自持久账本提交；
2. 验收驱动只是观察者，不能替业务账本提交终态；
3. 观察者超时只能生成带最后快照的 `driver_timeout`，不能写入 `failed`、`paused` 或 `completed`；
4. 重新查询持久账本时，如果 Mission 已经完成，应生成新的“终态已确认”结果；如果仍未完成，应保留超时报告并显示当前运行事实；两者都不能伪造另一种状态。

#### 唯一执行规则

- **Agent Engine**：负责同一 Goal/Thread 的模型回合、工具协议、重试和可恢复等待；不负责决定 Ticket 或 Mission 是否完成。
- **Ticket Engine**：负责 Ticket 聚合、依赖、Claim、Attempt 和终态退出；完成 Ticket 后永久退出调度，不因为观察器超时重新开放。
- **Mission Control**：使用持久的 Link、Proposal、Decision 和 Mission Store 结算 Mission；不使用最后一个 Agent 的颜色、不使用 UI 事件、不使用观察器退出作为事实。
- **真实验收驱动**：只负责创建任务、轮询权威快照、执行真实浏览器验收和保存证据。观察窗口是测试预算，不是业务循环上限，也不是 Agent turn 上限。

#### 上线门槛新增项

真实验收报告必须同时记录：

1. `observationStatus`：`terminal_observed`、`driver_timeout` 或 `transport_error`；
2. `businessStatusAtLastObservation`：观察时从服务端快照得到的 Mission 状态；
3. `terminalConfirmedAt`：只有后来从持久账本确认终态时才有值；
4. workspace、Mission、Plan、Ticket、最后事件游标、服务构建身份和最后一次快照。

验收工具不得因为等待窗口结束就停止服务、取消 Mission 或删除工作区。长任务必须允许外部继续运行，并支持后续用同一 workspace/Mission 进行终态复核。该规则不增加平台业务 `if/else`；它只把观察事实和业务事实分开。

本轮结论：技能协议修复已经通过自动回归，真实任务也最终完成；但这次验收仍不能计为“观察窗口内通过”，因为驱动在终态提交前退出。应补充终态复核报告和一轮不人为缩短观察窗口的真实验收，再更新本文上线结论。

#### 终态复核结果（2026-08-04）

已使用同一工作区、同一 Mission 进行复核，没有重新创建任务：

- 工作区：`C:\Users\xieyizhi\AppData\Local\Temp\autoagent-real-acceptance-zA7AmZ`；
- Mission：`task_b0c6a6b232754122`；
- 复核结果：`passed:true`、`outcome:"passed"`、`observationStatus:"terminal_observed"`；
- 复核时服务端快照已明确为 `completed`，五张 Ticket 全部 `completed`，五个 Agent 均回到 `idle`；
- 真实产物复验通过：新增 2 条、勾选完成、刷新后状态保留、删除 1 条、`390px` 视口无横向溢出、无页面错误；桌面与移动截图仍保留在该工作区的 `.autoagent/user-acceptance/`；
- 报告新增 `businessStatusAtLastObservation`、`terminalConfirmedAt` 和 `observationStatus`，使“观察超时”和“后来确认终态”可以被审计地区分。

这证明终态复核路径可用，但不把前一次 `driver_timeout` 改写为“当时通过”。原报告仍然保留为观察历史，新的复核报告是后续事实。

### 21.14 本轮继续：恢复按钮、后台 Tick 与同一 Agent 回合的并发证据（2026-08-04）

本轮补了一条此前缺失的组合回归：同一个已暂停 Agent 同时收到两次恢复请求，并且后台调度器也在同一时间执行 `tick`。这对应真实 UI 中用户连续点击“继续”、服务定时调度同时唤醒的场景。

回归过程固定验证同一组持久事实：

1. 第一次模型调用因可重试的 Provider `502` 进入退避等待；
2. 操作者明确暂停任务，Goal 进入 `paused`；
3. Provider 恢复后并发执行两次 `resumeTask` 与一次调度 `tick`；
4. 同一个 Agent 的原 Goal 恢复并完成，Mission Control 再推进正常的后续对账；
5. 该 Agent 的 Thread 只出现两次 `turn.started`：一次失败尝试、一次恢复尝试，没有第三个重复回合；Goal ID、Agent Thread ID 和 Mission Link 均保持不变。

这条测试没有给生产代码增加“最多恢复几次”或角色/阶段分支。它验证的是现有 Agent Engine 单线程队列、Runtime Host 唤醒合并和持久执行租约的组合行为；测试中还显式调用 Mission Control 的对账 Tick，避免把“Agent 已提交结论、Mission 尚未完成结算”的正常窗口误判为卡死。

证据：

- `tests/server/runtime-host.test.ts` 的 `coalesces concurrent resume requests with a scheduler tick for one paused Agent` 通过；
- 该回归以同一 `threadId` 下的 `turn.started` 数量和唯一 `turnId` 验证单飞，不用全局模型调用次数推断某一个 Agent 是否重复；
- 本轮没有发现需要修改 Runtime Host 的重复调度根因，因此没有为测试添加止血代码；
- 该证据只覆盖并发恢复组合，不替代多小时真实 Provider、异常进程退出后的租约恢复和完整 SSE 断线重建验证。

当前结论更新：Agent Engine 的“同一 Agent 恢复请求不重复开回合”已有自动回归证据；生产上线仍被历史工作区健康、长期 Provider 耐久、跨重启业务恢复和完整用户可读运行记录阻塞。文档中的“已实现”只表示有代码和自动证据，“生产可用”必须同时满足真实长窗口和健康检查门槛。

#### 同一工作区真实复核（2026-08-04）

随后用同一 `ws_6b702234649b4671` 复核真实验收，没有重新发布 Mission：

- Mission `task_b0c6a6b232754122` 已为 `completed`；
- 需求接收、计划拆解、开发、质量检查、最终验收 5 张 Ticket 全部为 `completed`；
- 5 个 Agent 均为 `idle`；
- 浏览器验收新增 2 条待办、刷新后完成状态保留、删除 1 条，`390px` 视口无横向溢出且无页面错误；
- 报告：`C:\Users\xieyizhi\AppData\Local\Temp\autoagent-real-acceptance-zA7AmZ\.autoagent\user-acceptance\report.json`；
- 本次服务健康同时记录为 `ready:false`、`runtimeStatus:degraded`。因此这证明新工作区的真实链路可以闭合，但不能证明整个平台已经满足生产就绪门槛。
