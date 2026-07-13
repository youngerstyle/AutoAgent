# Mission Settlement Recovery Design

状态：批准实施

## 目标

修复 Mission Process 在 Ticket 乐观并发冲突、Agent proposal 结算冲突和运行状态投影上的错误，同时保持三个引擎的所有权边界：

- Agent Engine 只维护 Thread、Goal、turn、tool 与 proposal。
- Ticket Engine 只维护 Workflow、Ticket DAG、authority 与命令提交事实。
- Mission Process 只可靠地把同一个 proposal 适配并提交到 Ticket Engine，再把最终结果结算回同一个 Goal。

## 1. Ticket version conflict

`version_conflict` 表示命令尚未进入 Ticket 状态机，是乐观并发控制结果，不是业务拒绝，也不是 Agent 输出错误。

Ticket Engine 对 `version_conflict` 不写入 `commandInputs`、`commandResults`，不消费 `proposalId`。调用方用同一个 proposal 和 commandId、刷新后的 Ticket/Workflow version 再次提交。已接受结果和确定性语义拒绝仍按原规则持久化并保持幂等。

Mission Process 收到 `version_conflict` 后：

1. 不调用 `settleProposal`；
2. 不写 `correctable` observation；
3. 保持 link 为 `resolving`；
4. 刷新 Ticket 与 Workflow version；
5. 下一次本地 tick 重试，不触发新的模型 turn。

## 2. Agent settlement conflict

Ticket Command 已有确定结果后，Mission 使用稳定 decisionId 结算 Agent proposal。若 `settleProposal` 返回 `version_conflict`：

1. 重新读取 Goal；
2. 只有 Goal 仍为 `resolving` 且 `activeProposalId` 未改变时，才以最新 Goal version 重放同一个 decision；
3. 若本次仍未收敛，link 保持 `resolving`，下一次 tick 继续；
4. 不依赖旧 proposal event 再次投递，因此 event cursor 前移也不会永久挂起。

Mission 每次 tick 都会检查 durable `resolving` links；事件只负责发现 proposal，不是恢复结算的唯一入口。

## 3. 拒绝分类

- `version_conflict`：Mission 本地恢复，不结算 Goal。
- `stale_authority`：结算为 `stale_claim`。
- `workflow_terminal`：结算为 `workflow_terminal`。
- `invalid_command`：领域交付或命令结构可纠正时结算为 `correctable`。
- `policy_violation`、`idempotency_conflict`：平台或授权问题，结算为 `host_error`，不得再次驱动模型。

## 4. 状态投影

UI 状态优先级：

1. `blocked` / `usage_limited`
2. `paused`
3. `failed`
4. `completed` / `cancelled`
5. 当前 turn 活动 `running` / `yielded` / `waiting`
6. `idle`

旧的 turn activity 只能描述活动，不能覆盖 Goal 的权威状态。

## 5. 测试门槛

- Ticket version conflict 不持久化 command result，也不占用 proposalId。
- Mission 使用刷新后的版本收敛同一 proposal，Provider 调用次数不增加。
- Agent settle 首次 version conflict 后，无需重启即可在后续 tick 收敛。
- event cursor 已前移时，resolving link 仍能恢复。
- paused/failed Goal 不会因旧 running activity 显示绿色。
- 三个引擎的架构边界测试继续通过。

