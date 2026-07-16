# Ticket 完成契约与返工设计

日期：2026-07-16

状态：当前规范

本文取代既有规范中“完成 Ticket 永久退出调度”和“普通返工必须新增纠错 Ticket”的部分。未冲突的 Agent Engine、Ticket Engine、Mission Control 边界继续有效。

## 1. 产品模型

AutoAgent 模拟真实产研团队，不是一个父 Agent 调用若干一次性 Subagent 的包装器：

- Agent Engine 是通用、持久、可对话的 Agent Runtime。
- Ticket Engine 是独立的工作项、依赖和状态系统。
- Mission Control 只在两者之间投递工作与提交结果，不做业务语义判断。

Agent 有权判断自己负责的工作是否完成。Agent 提交完成后，Ticket Engine 应按 Plan 依赖释放下游 Ticket。下游 Agent 再依据自己的 Ticket 契约独立评审或验收。

## 2. 三层完成语义

必须区分：

1. **Turn ended**：一次模型/工具循环结束，不代表 Goal 完成。
2. **Ticket resolved**：执行 Agent 判断当前 Ticket 的工作契约已经满足，并提交交付物、逐项完成判断和证据；这会释放下游依赖。
3. **Mission completed**：当前 Plan 的全部必需终点 Ticket 已完成。普通中间 Ticket 的完成不能直接关闭 Mission。

UI 可以继续使用用户可理解的“已完成”，但必须明确作用域，例如“开发已完成，等待质量检查”，不能把阶段完成显示成项目完成。

## 3. Ticket 是工作契约

每张可执行 Ticket 必须包含：

- objective：当前负责人要达成的目标；
- successCriteria：当前负责人判断完成时必须逐项回应的标准；
- assignment：负责人或所需能力；
- outputContract：领域交付物的结构契约；
- permissions：该工单被显式授予的控制面权限，例如是否允许提交 Plan 变更；权限不由角色名或 outputContract 猜测；
- 直接上游 Ticket 的持久 handoff；
- Mission 目标和当前 Plan 身份。

执行 Agent 不能修改 Ticket 的成功标准，也不能通过自己的总结缩小 Mission 范围。若标准无法满足，Agent 应报告 blocked、failed 或显式请求 Plan 修订。

## 4. 完成报告

Agent 的完成提案除了领域输出，还必须包含通用完成报告：

```ts
interface GoalCriterionResult {
  criterionIndex: number;
  status: "satisfied" | "not_satisfied" | "not_verified";
  evidence: EvidenceRef[];
  note?: string;
}

interface GoalResolutionProposal {
  status: "completed" | "blocked" | "failed";
  summary: string;
  evidence: EvidenceRef[];
  criterionResults: GoalCriterionResult[];
  residualRisks: string[];
  domainOutcome: unknown;
}
```

提交 `completed` 时：

- 必须覆盖当前 Goal 的全部 successCriteria，不能缺项或重复；
- 每项必须由 Agent 判断为 `satisfied`；
- 平台只校验覆盖关系和结构，不判断证据是否在业务上真实充分；
- QA、评审者或终端验收者负责独立验证语义真实性。

如果某项验证属于下游 QA，而不属于当前开发 Ticket，就不应写进开发 Ticket 的 successCriteria。开发可以完成实现交付，QA 再完成浏览器或人工交互验证。

## 5. Ticket 与 Attempt

Ticket 是 Plan 中稳定的工作项；Attempt 是某次领取和执行，采用追加式历史。

```text
Ticket DEV-1
  Attempt 1: completed
  Attempt 2: completed

Ticket QA-1
  Attempt 1: returned
  Attempt 2: completed
```

Attempt 一经结束不可修改。Ticket 的当前状态可以因下游退回而从 completed 进入 ready，开始新 Attempt。不可变的是历史，不是 Ticket 的当前投影视图。

## 6. 普通返工

普通交付缺陷不修改 Plan，也不创建新的纠错 Ticket：

```text
DEV Attempt 1 completed
  -> QA Attempt 1 returned(target=DEV, feedback)
  -> DEV Ticket ready
  -> DEV Attempt 2 completed
  -> QA Attempt 2 completed
  -> 后续验收
```

退回规则：

- 目标必须是当前 Ticket 在同一 Plan 中已完成的严格上游；
- 目标 Ticket 开启新 Attempt；
- 目标到当前评审 Ticket 之间的已执行路径重新等待，保证修改后的交付重新经过必要环节；
- 不在该路径上的并行分支不受影响；
- 当前 Plan 的节点、边和终点不改变。

## 7. Plan 修订

只有以下事实需要 Plan 修订：

- Mission 范围或成功标准必须改变；
- Ticket 拆分、能力需求或依赖关系错误；
- 需要增加或取消真实工作项；
- 当前 DAG 无法形成可交付闭环。

代码缺陷、文档缺漏、测试失败和实现返工都不是 Plan 修订。

## 8. 引擎边界

### Agent Engine

- 运行持久 Goal 和时间序 Thread；
- 向 Agent 提供 Goal 的 objective、successCriteria 和 outputContract；
- 要求显式提交完成报告；
- 不知道 Ticket、Plan、角色顺序或 Mission 完成规则。

### Ticket Engine

- 校验命令权限、版本、依赖和完成报告覆盖关系；
- 保存 Ticket、Attempt、handoff 和事件；
- 根据 DAG 解锁下游；
- 处理 reopen 和新 Attempt；
- 不判断游戏、代码、设计或测试是否真的达标；
- 不硬编码 PM、开发、QA、老板或固定 schema 名称。

能够修改 Plan 的 Ticket 必须在 Definition 中显式声明 `permissions.amendPlan=true`，执行者还必须持有该 Ticket 当前 Attempt 的有效 claim 或 blocked ownership。全局策略授权仍可用于 operator 控制，但不能用 schema 名称隐式授予权限。

### Mission Control

- 把 Ticket 工作契约转换为 Agent Goal；
- 把 Agent Proposal 转换为 Ticket Command；
- 把直接上游 handoff 投递给下一个 Agent；
- 不根据自然语言、角色名、文件数量或工具结果猜测下一步。

## 9. 完成与终止

Plan 完成只由 requiredTerminalTicketIds 和 DAG 当前状态决定。终点由 Plan 定义，不由 Ticket Engine 写死为 QA 或老板。

安全预算、上下文限制、Provider 错误和单次运行保护只暂停或让出执行权，不能伪装成业务完成或业务失败。

## 10. 必须通过的回归场景

1. Agent 缺少任一 successCriteria 结果时不能提交 completed，并在同一 Goal 中获得可修正反馈。
2. DEV completed 后自动释放 QA。
3. QA request_correction 后不新增 DAG 节点，DEV 进入新 Attempt。
4. DEV 再完成后 QA 重新执行，旧 Attempt 保持可审计。
5. 并行分支不因另一分支返工而重跑。
6. request_plan_change 才允许创建计划修订工作。
7. 只有 required terminal Tickets 全部完成时 Plan/Mission 才完成。
8. Ticket Engine 和 Mission Control 不包含固定角色或固定交付 schema 路由。
