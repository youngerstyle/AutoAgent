# 单 Mission 单 Plan 工单流设计

日期：2026-07-14

状态：已确认，取代旧 Workflow 修订链设计

## 1. 领域模型

AutoAgent 的运行模型只有以下四层：

```text
Project 1 -> N Mission
Mission 1 -> 1 Plan
Plan 1 -> N Ticket
Ticket 1 -> N Agent Goal attempts
```

- Project 是长期项目容器。
- Mission 是一个可独立交付的功能或变更目标。
- Plan 是该 Mission 唯一、长期存在的执行 Flow。
- Ticket 是 Plan 中可领取、可依赖、可审计的工作单元。
- Agent Goal 是某个 Agent 对一张 Ticket 的一次执行，不属于 Ticket Engine。

Plan 不是 PM 的一次回复，不是 PM 工单，也不是一批可替换的 Ticket。PM 的“计划拆解”本身只是一张普通 Ticket；它完成后，Plan 仍保持 `active`，直到整个 Mission 达成终态。

## 2. Engine 边界

### 2.1 Ticket Engine

Ticket Engine 拥有 Plan 聚合及其中全部 Ticket，是 Plan/Flow 状态的唯一事实来源。Plan 是 Ticket Engine 的聚合根，不新增 Plan Engine。

Ticket Engine 负责：

- Plan 和 Ticket 的 UUID、版本与持久化；
- Ticket DAG 的结构校验、就绪计算、领取和状态提交；
- Plan 变更集的原子应用；
- Plan 是否完成、失败、暂停或取消的确定性计算；
- 只追加历史和事件审计。

Ticket Engine 不负责：

- 调用模型；
- 按 PM、开发、QA、老板等角色硬编码路由；
- 根据自然语言、关键词或错误类型猜下一张 Ticket；
- 自动克隆、复活或替换已完成 Ticket。

Ticket Engine 可以执行两类不含业务判断的标准原子操作：

- 根据当前 Ticket 明确提交的 `correction_required`，向同一 Plan 追加一张纠错 Ticket，并让当前 Ticket 等待纠错后重试；
- 根据当前 Ticket 明确提交的 `plan_change_required`，追加一张计划修订 Ticket，并暂停普通调度直到规划者提交变更。

这两类操作由 Agent 的结构化结论触发。Ticket Engine 只校验引用、权限、状态和 DAG，不通过角色名、关键词或错误文本推断结论。

### 2.2 Agent Engine

Agent Engine 是通用的 message-interactive Agent loop。它只知道 AgentThread、Goal、Turn、工具和消息，不知道 Mission、Plan、Ticket DAG 或团队角色顺序。

### 2.3 Mission Control

Mission Control 是两个 Engine 之间的 process manager：

1. 监听 `TicketReady`；
2. 为该 Ticket 创建或恢复一个 Agent Goal；
3. 将 Agent 的结构化 Goal Proposal 转成 Ticket Command；
4. 将 Ticket Engine 的接收或拒绝结果反馈给同一个 Agent Goal；
5. 不自行选择业务后继，不创建隐藏阶段。

## 3. 身份与生命周期

### 3.1 Plan 身份

每个 Mission 创建时生成且只生成一个独立 `PlanId`。`PlanId` 是 UUID，不从 Mission 名称、节点 key 或角色推导。

```ts
type PlanStatus =
  | "active"
  | "paused"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

interface PlanSnapshot {
  planId: PlanId;
  missionId: string;
  version: number;
  status: PlanStatus;
  graph: PlanGraphSnapshot;
  completionPolicy: PlanCompletionPolicy;
  policyRef: PlanPolicyRef;
}
```

一个 Mission 不能切换到第二个 Plan。Mission 完成后出现的新功能或新变更必须创建新 Mission 和新 Plan。

### 3.2 Ticket 身份

每张 Ticket 在加入 Plan 时由 Ticket Engine 生成独立 UUID。Ticket ID 不由标题、角色、临时 key、父 Ticket 或 Plan ID确定性派生。

PM 输出中的 `clientRef` 只在单次 Plan 变更命令内解析引用，绝不持久化为 Ticket 身份，也不能命中历史 Ticket。

Ticket 终态为：

- `completed`
- `returned`
- `failed`
- `cancelled`

`returned` 只保留为旧记录的终态值；新调度协议不再生成它。普通返工不会结束当前 Ticket，而是为同一 Ticket 增加一次后续 Agent Goal attempt。

进入终态后：

- 永远不再进入 ready/running；
- 永远不被新 Agent Goal 领取；
- 永远不被改写成另一张 Ticket；
- 只作为 Plan 历史、依赖事实和审计证据保留。

### 3.3 Plan 完成

PM 工单完成不等于 Plan 完成。Plan 只在完成策略引用的全部终点 Ticket 已完成，且不存在未结算的必要 Ticket 时进入 `completed`。

`completed`、`failed`、`cancelled` Plan 均为终态，不允许再追加 Ticket。后续需求创建新 Mission。

## 4. Plan 图与变更集

持久化图只使用真实 Ticket ID：

```ts
interface PlanGraphSnapshot {
  schemaVersion: 3;
  ticketIds: TicketId[];
  dependencyEdges: Array<{
    fromTicketId: TicketId;
    toTicketId: TicketId;
  }>;
}
```

PM 或其他被授权规划者提交的是命令级变更集：

```ts
interface PlanChangeSet {
  additions: Array<{
    clientRef: string;
    parentTicketId?: TicketId;
    title: string;
    objective: string;
    successCriteria: string[];
    assignment: PlannedTicketAssignment;
    outputContract: TicketOutputContract;
  }>;
  dependencyAdditions: Array<{
    from: { ticketId: TicketId } | { clientRef: string };
    to: { ticketId: TicketId } | { clientRef: string };
  }>;
  cancelTicketIds: TicketId[];
  requiredTerminalRefs: Array<{ ticketId: TicketId } | { clientRef: string }>;
}
```

应用规则：

1. 为每个 `addition` 生成全新 Ticket UUID。
2. `clientRef` 只能引用本命令新增项。
3. 历史 Ticket 和依赖边不可删除或改写。
4. 只能显式取消非终态 Ticket；完成 Ticket 不可取消。
5. 新依赖不得以非终态 Ticket 为前置时绕过原有依赖。
6. 合并后必须仍为无环图。
7. 变更集和当前 Plan version 以一次原子提交落库。
8. Ticket Engine 只验证结构、权限、版本和状态，不替 PM 补业务节点。

## 5. 初始规划与后续返工

### 5.1 初始 Plan

Mission 创建时，产品模板只创建最小启动链：需求接收 Ticket 和计划拆解 Ticket。计划拆解 Agent 完成后提交 `PlanChangeSet`，向同一个 Plan 追加开发、测试、验收等实际 Ticket。

模板可以规定最小质量策略，但 Ticket Engine 不认识角色。策略由 capability、output contract 和 Plan 图表达。

### 5.2 普通纠错闭环

测试失败、评审发现实现缺陷、下游发现某项已完成前置工作不满足原成功标准，都属于普通纠错，不属于重新规划。

当前 Agent 完成本次调查后提交结构化结论：

```ts
{
  disposition: "correction_required";
  targetTicketId: TicketId;
  reason: string;
  result?: unknown;
}
```

其中 `targetTicketId` 必须是当前 Ticket 在同一 Plan 中已完成的上游 Ticket。Ticket Engine 在一个原子提交中：

1. 结束当前 Agent Goal attempt，但不结束当前 Ticket；
2. 清除当前 Ticket 的执行权，将其恢复为 `pending`；
3. 创建一张全新 UUID 的纠错 Ticket；
4. 纠错 Ticket 继承目标上游 Ticket 的 assignment 和 output contract，不按角色名称选择负责人；
5. 追加 `target -> correction -> current` 两条依赖；
6. 纠错 Ticket 进入 `ready`，当前 Ticket 等待纠错完成；
7. 纠错完成后，原当前 Ticket 重新进入 `ready`，由 Mission Control 创建下一次 Agent Goal attempt；
8. 原当前 Ticket 的下游始终等待它最终 `completed`，因此不会抢跑。

同一 Ticket 可以经历多次 Agent Goal attempt。Ticket 的成功标准保持不变，每次纠错都追加新的 Ticket 和依赖，历史不删除、不覆盖。

该流程没有 `QA -> Dev` 等角色硬编码。报告者是当前 Ticket，纠正对象是 `targetTicketId`，执行负责人来自目标 Ticket 的 assignment。例如 QA 发现 DEV 交付缺陷时，报告来源是 QA Ticket，纠错对象是 DEV Ticket，纠错工作自然继承原 DEV assignment，PM 不参与。

### 5.3 计划结构变更

只有以下情况进入计划修订：

- 需求、范围或成功标准需要改变；
- 当前问题无法归属于一张明确的已完成上游 Ticket；
- 需要新增能力、改变责任边界或重组 DAG；
- 原 Plan 缺少完成 Mission 所需的业务工作。

当前 Agent 提交：

```ts
{
  disposition: "plan_change_required";
  reason: string;
  result?: unknown;
}
```

Ticket Engine 原子追加计划修订 Ticket，并让当前 Ticket 等待该修订 Ticket。规划 Agent 通过 `PlanChangeSet` 追加实际业务 Ticket；计划修订完成后，原 Ticket 重新就绪。普通缺陷不得用该通道绕行 PM。

计划修订 Ticket 本身不能再次提交 `plan_change_required`，避免修订递归生成修订。它只有三种合法结果：提交可校验的 `PlanChangeSet` 并完成；缺少不可替代输入时 `blocked`；有证据证明无法完成时 `failed`。

### 5.4 与成熟缺陷管理的对应

- Azure Test Plans 将失败测试结果与独立 Bug 关联；测试事实和修复工作不是同一个工作项。
- Jira 允许重开原工单；本系统为保持终态 Ticket 不可变，将“重开”实现为同一未完成验证 Ticket 的新 Goal attempt，加一张新的纠错 Ticket。
- ISTQB 的确认测试对应纠错完成后对原验证 Ticket 的下一次执行。

## 6. 持久化与事件

Plan 聚合采用 schema v3：

```text
plan.json
  identity
  plan snapshot
  tickets by UUID
  claims / blocked ownership
  idempotency records
  append-only events
```

关键事件：

- `PlanCreated`
- `PlanChanged`
- `PlanStatusChanged`
- `TicketAdded`
- `TicketReady`
- `TicketClaimed`
- `TicketCompleted`
- `TicketReturned`
- `TicketFailed`
- `TicketCancelled`
- `PlanAmendmentRequested`
- `TicketCorrectionRequested`

`TicketReturned` 仅用于读取既有历史；新命令不产生该事件。

状态只在明确命令提交时变化。读取快照、UI 刷新、Mission Control tick 和服务重启都不得改变 Plan/Ticket 状态。

## 7. 删除的旧模型

新项目直接删除以下概念，不双写、不回退：

- `WorkflowId` 作为 Mission Flow 身份；改为 `PlanId`。
- `TicketNodeKey` 作为持久化身份。
- `revisionOfKey`、`revisionOfTicketId`、`supersededByTicketId`。
- graph node 的 `active` 标记。
- `planning-v1`、`planning-v2`、`revision_*` 节点命名约定。
- `TicketPlanningState` 的 `plannedGraph/ticketIdByKey/definitionsByKey` 三份镜像。
- `return_to_parent` 自动克隆上游分支。
- `complete_with_graph` 将“完成当前 Ticket”和“替换 Workflow”混成一个动作。
- 根据角色、phase、关键词或固定流程推断后继。

旧 schema v2 项目只读展示，不再调度，不迁移为 v3。用户创建新 Mission 后只走本文协议。

## 8. 必须通过的不变量测试

1. 一个 Mission 只能创建一个 Plan，Plan ID 与 Mission/标题无确定性关系。
2. 同一 Plan 中两个同标题、同角色 Ticket 仍有不同 UUID。
3. PM 计划拆解 Ticket 完成后 Plan 仍为 active。
4. Plan 变更只能追加 Ticket/边，不能修改已完成 Ticket。
5. 完成 Ticket 永不再次产生 `TicketReady`。
6. 服务重启和重复 tick 不改变 Ticket 状态或重复投递。
7. 普通纠错只接受同一 Plan 中已完成的严格上游 Ticket，不能指向自身、下游或无关 Ticket。
8. 普通纠错原子追加全新 UUID 纠错 Ticket 和 `target -> correction -> current` 依赖；当前 Ticket 回到 pending，原下游不能抢跑。
9. 纠错 Ticket 完成后，原 Ticket 重新 ready 并产生新的 Agent Goal attempt；已完成目标 Ticket 不复活。
10. 计划结构变更才创建计划修订 Ticket；普通纠错不得经过 plannerAssignment。
11. 计划修订 Ticket 不能递归申请另一张计划修订 Ticket。
12. Plan 仅在完成策略满足时完成；没有必要终点时拒绝提交，而不是提前完成。
13. Agent Engine 测试不导入 Plan/Ticket 类型；Ticket Engine 测试不调用 Provider。
13. Mission Control 只消费 `TicketReady` 并按 Ticket ID 和 Ticket version 幂等创建 Agent Goal attempt。
14. schema v2 记录被标为只读，绝不进入 v3 调度。

## 9. 上线门槛

- 所有领域不变量测试通过；
- Ticket、Mission Control、Agent Engine 全量测试通过；
- 生产构建通过；
- 新建 Mission 的真实链路至少完成一次：需求接收 -> 计划拆解 -> 追加执行 Ticket -> 执行 -> 验证 -> Plan/Mission 完成；
- 重启服务后不会重复调度已完成 Ticket；
- UI 能显示 Mission、Plan ID/状态和 Ticket 正序历史，且不会把“PM 工单完成”显示为整个 Mission 完成。
