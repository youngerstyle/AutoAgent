# Agent Engine、Mission Control 与 Ticket Engine 契约修复设计

日期：2026-07-13

状态：根因审计完成，待回归测试与实现

## 1. 事故结论

本次 PM 循环与异常 Token 消耗不是模型能力问题，而是运行核心违反既有架构边界：

1. Agent Engine 公开协议要求模型提交通用 `GoalResolutionProposal`。
2. Mission Control 又通过提示词要求模型生成 Ticket Engine 内部命令语义，例如 `complete_with_graph`、`return_to_parent`。
3. Mission Control 将输出契约错误、Ticket 命令冲突和恢复冲突统一判为 `correctable`。
4. `RuntimeHost` 对重新变为 `active` 的 Goal 自动启动下一轮，没有“相同拒绝且没有新事实”的停机条件。
5. Ticket Command 提交、Agent Goal 结算和 MissionLink 结算分步持久化；恢复时没有用已提交的 Ticket Command Result 收敛其余状态。

结果是模型按协议 A 回答，平台按协议 B 拒绝，然后在没有任何新信息的情况下重复调用模型。真实模型调用只是放大了代码错误，不是根因。

## 2. 当前实现证据

### 2.1 双重协议

- `AgentToolLoop` 的系统协议只定义 `goalResolution.status=completed|blocked|failed`。
- `AgentContextAssembler` 将 Ticket 的 `outputContract.schemaRef` 作为领域输出契约注入 Goal。
- `missionOutcomeInstruction()` 却要求 Agent 返回 `domainOutcome.kind=complete_with_graph`、`kind=return_to_parent` 等 Ticket Command 语义。
- `validateMissionTicketOutcome()` 直接以 Ticket Command 类型校验模型输出。

这使 Agent 不再是通用 Agent，而被迫了解 Ticket Engine 的内部写协议。

### 2.2 无界重试

- `MissionGoalResolutionPort.resolve()` 对不符合第二套协议的结果返回 `correctable`。
- `AgentEngine.settleProposal()` 将 `correctable` 的 Goal 恢复为 `active`。
- `RuntimeHost.tickTask()` 每次 tick 都为所有 `active` Goal 执行一次模型切片。
- 运行记录中同一 PM Goal 出现 553 次 `correctable`，其中 345 次是“计划工单必须返回 complete_with_graph”。

没有新 human 消息、工具观察、Ticket 版本变化或上下文变化时，重新调用模型不可能增加事实，只会增加费用。

### 2.3 非原子结算不能收敛

当前结算顺序是：

1. `TicketEngine.applyTicket(command)`；
2. `AgentEngine.settleProposal(decision)`；
3. `MissionStore.updateLink(settled)`。

进程可能在任意两步之间退出。Ticket Command 本身可按 `commandId` 幂等读取，但恢复路径在 Agent Goal version conflict 时直接返回，没有继续确认同一个 proposal、同一个 command result 是否已经提交，也没有完成 Goal 与 MissionLink 的剩余结算。

## 3. 唯一目标契约

### 3.1 Agent Engine

Agent Engine 保持通用，只认识：

- Goal；
- 时间序 Thread；
- Tool；
- `GoalResolutionProposal`；
- host 对 proposal 的最终 decision。

Agent 输出：

```ts
interface GoalResolutionProposal<TDomainOutcome> {
  status: "completed" | "blocked" | "failed";
  summary: string;
  evidence: EvidenceRef[];
  domainOutcome?: TDomainOutcome;
}
```

Agent 不输出以下 Ticket Engine 内部命令：

- `complete_with_graph`
- `complete`
- `block`
- `fail`
- `return_to_parent`
- `expectedWorkflowVersion`
- `cancelTicketIds`

### 3.2 Output Contract

`outputContract.schemaRef` 描述领域交付物，不描述 Ticket Command。

`ticket-graph-v2` 的 Agent 领域结果为：

```ts
interface TicketGraphV2Outcome {
  result: unknown;
  graph: PlannedTicketGraph;
  completionPolicy: PlannedWorkflowCompletionPolicy;
}
```

领域校验器只校验 Graph 的内容和结构，不要求 `kind=complete_with_graph`。

其他 Ticket 的 `domainOutcome` 由各自 output contract 定义。Agent 的 `status` 表示它对当前 Goal 的完成判断，不承担 Ticket 命令编码。

### 3.3 Mission Control

Mission Control 是唯一适配层。它根据以下输入确定性地产生 Ticket Command：

- proposal.status；
- 当前 Ticket 的 output contract；
- 已验证的 domainOutcome；
- 当前 claim authority；
- Ticket/Workflow 当前版本。

映射规则：

| Agent proposal | Output contract | Ticket Command |
|---|---|---|
| `completed` | `ticket-graph-v2` | `complete_with_graph` |
| `completed` | 其他领域契约 | `complete` |
| `blocked` | 任意 | `block` |
| `failed` | 任意 | `fail` |

`return_to_parent` 不是通用 Goal 完成状态，也不能由角色或错误文本猜测。需要上游处理时，当前 Goal 提交 `blocked` 和结构化阻塞事实；Ticket Workflow 中预先存在的上游修订 Ticket 或经明确授权的 workflow amendment 负责后续流转。此次修复不保留旧的 `domainOutcome.kind=return_to_parent` 兼容路径。

### 3.4 Ticket Engine

Ticket Engine 继续只接受结构化 Ticket Command，并拥有最终状态提交权。它不知道模型、prompt、Agent 身份模板或角色顺序。

Ticket Engine 的拒绝结果必须由 Mission Control 分类：

- `stale_authority`、`workflow_terminal`：终止旧 Goal；
- 可由重新读取最新 Ticket/Workflow 状态解决的版本冲突：Mission 自行恢复，不调用模型；
- 领域输出不符合 output contract：把明确 observation 写回同一 Agent，但没有新事实前不得自动重复调用；
- host/store/协议故障：暂停 Goal，显示平台故障，不归咎 Agent。

## 4. 可恢复结算

Mission Control 使用持久化 settlement record 把三次提交组成可恢复 process：

```text
proposal observed
  -> prepared(commandId, decision basis)
  -> ticket_committed(command result)
  -> goal_settled(decisionId)
  -> link_settled
```

规则：

1. `commandId` 只由 proposalId 和目标 Ticket 决定。
2. 重启后先查询 `getTicketCommandResult(commandId)`，不得重新询问模型。
3. Ticket 已提交时，继续结算同一个 Agent proposal。
4. Goal version conflict 时，如果 `activeProposalId` 仍是同一个 proposal，使用最新 Goal version 重放同一个 decision。
5. Goal 已以同一 decision 终结时，直接收敛 MissionLink。
6. 已存在由同一 planning proposal 创建的 successor graph，视为已提交结果，不再产生 `correctable`。

## 5. 无进展与费用安全

自动继续必须由“新事实”驱动，而不是由 Goal 仍为 active 驱动。

可触发下一 turn 的事实：

- 新 human/peer 消息；
- 新工具 observation；
- Ticket/Workflow 版本变化；
- host 对上一 proposal 的首次、可操作 correction；
- 用户显式继续；
- 首次开始 Goal。

以下情况不得调用模型：

- 相同 proposal rejection 已写入 Thread，之后没有新事实；
- Ticket Command 已提交，等待本地结算恢复；
- Provider 返回余额、认证、配额或其他执行边界错误；
- Goal paused/blocked/resolving/terminal；
- 同一 Thread revision 已经执行过 slice。

Agent Engine 直接从持久化 AgentThread 的时间序条目计算执行就绪状态：首轮 Goal、新 message、新 tool observation 和首次 host correction 可以触发下一 slice；普通模型回复后没有新事实，或相同 correction 再次出现时，不再调度。模型主动请求工具后产生的新 observation 会继续驱动工作，因此长时间运行不受固定轮数限制；没有新事实的空转会停止。

真实 Provider 还必须有独立的费用熔断：单 Agent Goal、自最近一次 human 明确消息以来的实际 Provider Token 用量达到配置边界时进入 `usage_limited`，只能由 human 新消息显式恢复。生产默认阈值为 250,000 tokens，可用 `AUTOAGENT_MAX_TOKENS_PER_AGENT_GOAL_WINDOW` 调整。该熔断是最后防线，不代替正确的进度协议。

## 6. 测试门槛

所有回归测试必须使用注入的 fake provider。测试进程中访问真实 OpenAI/Anthropic adapter 立即失败。

必须先看到以下测试在当前实现上按预期失败：

1. PM 返回纯 `ticket-graph-v2` 领域结果时，Mission 转换为 `complete_with_graph` 并被 Ticket Engine 接受。
2. Agent prompt 和 Thread 中不出现 Ticket Command 名称。
3. Ticket Command 已提交、Goal 尚未结算时重启，恢复过程不调用 provider，并最终收敛 Goal 与 MissionLink。
4. 同一 correction 且无新事实时，多次 tick 只产生一次 provider turn。
5. 新 human 消息或新工具 observation 到达后，可以继续下一 turn。
6. 余额/认证/配额错误后，多次 tick 不再调用 provider。
7. 完整最小团队链路从 intake、planning 到 PM 生成的 DAG 全部完成，PM Goal 只结算一次，不出现孤立 successor 或重复 dispatch。

## 7. 删除项

本次修复直接删除，不做兼容：

- `MissionTicketOutcome.kind` 的 Ticket Command 枚举；
- `missionOutcomeInstruction()` 中 Ticket Command 提示；
- Agent 输出 `complete_with_graph` / `return_to_parent` 的 mock 与测试；
- 所有把协议/存储故障转换成 Agent `correctable` 并立即重跑模型的路径；
- 对旧运行继续执行双协议的 fallback。

旧运行记录仍可只读审计。新项目只使用本文契约。
