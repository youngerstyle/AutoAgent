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

### 5.2 下游打回

下游 Agent 发现前置工作有问题时：

1. 当前 Ticket 提交 `return`，携带目标上游 Ticket、原因和证据；
2. 当前 Ticket 进入 `returned`，不解锁正常下游；
3. Ticket Engine 记录 `PlanAmendmentRequested`，Plan 进入 `blocked`；
4. 平台根据 Plan 的 `plannerAssignment` 创建一张全新 UUID 的“计划修订”Ticket；
5. 规划 Agent 决定需要追加哪些返工、复查和后续 Ticket，并提交 `PlanChangeSet`；
6. 变更集应用后，Plan 恢复 `active`，仅新 Ticket 参与调度。

平台创建“计划修订”工作请求，不代表平台替 PM 规划实际业务 Ticket。不存在自动 `QA -> Dev`、`老板 -> Dev` 或角色跳转。

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
7. 下游 return 不克隆上游、不自动创建开发 Ticket，只产生计划修订请求。
8. PM 通过修订 Ticket 追加的新返工 Ticket 使用新 UUID，并按新依赖运行。
9. Plan 仅在完成策略满足时完成；没有必要终点时拒绝提交，而不是提前完成。
10. Agent Engine 测试不导入 Plan/Ticket 类型；Ticket Engine 测试不调用 Provider。
11. Mission Control 只消费 `TicketReady` 并按 Ticket ID 幂等创建 Agent Goal。
12. schema v2 记录被标为只读，绝不进入 v3 调度。

## 9. 上线门槛

- 所有领域不变量测试通过；
- Ticket、Mission Control、Agent Engine 全量测试通过；
- 生产构建通过；
- 新建 Mission 的真实链路至少完成一次：需求接收 -> 计划拆解 -> 追加执行 Ticket -> 执行 -> 验证 -> Plan/Mission 完成；
- 重启服务后不会重复调度已完成 Ticket；
- UI 能显示 Mission、Plan ID/状态和 Ticket 正序历史，且不会把“PM 工单完成”显示为整个 Mission 完成。
