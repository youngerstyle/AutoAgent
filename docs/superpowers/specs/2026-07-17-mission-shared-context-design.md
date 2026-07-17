# Mission 共享上下文设计

日期：2026-07-17

## 1. 问题

一个 Mission 会被拆成多张由不同 Agent 承担的 Ticket。真实团队不会依靠上一位成员重新转述需求给下一位成员；团队会先形成共同认可的目标和验收基线，再由 Ticket 描述分工，由 handoff 传递实际工作增量。

现有实现混淆了两类信息：

- `MissionRecord.objective` 是 human 的原始诉求；
- Mission Control 又把它作为 `missionObjective` 注入每一张后续 Ticket。

这会让后续 Agent 同时面对原始诉求和已经对齐后的交付，无法知道哪一个才是当前权威目标。仅传递上游 handoff 也不够，因为 Agent 仍看不到整个 Plan 及自己在功能中的位置。

## 2. 设计原则

### 2.1 原始诉求只用于需求接收和审计

human 原始输入保存在任务记录和显式声明 `contextPolicy.includeOriginalRequest` 的需求接收 Ticket 所属 Agent 的时间序会话中。它不会默认注入其他 Agent 的工作上下文。Mission Control 不根据“第一张工单”、角色名称、标题或 schema 猜测接收者。

原始诉求不是最终规格，也不能覆盖后续已经正式提交的需求共识。

### 2.2 Mission Brief 是领域交付，不是平台推理结果

需求接收 Ticket 完成时提交的 handoff 是团队对齐后的正式目标说明，即 Mission Brief。平台不解析其中的业务语义，不用关键词判断它是否为 Brief，也不复制出第二份可漂移的摘要。

Brief 的身份和版本由产生它的 Ticket ID、Ticket version、output contract 和 accepted handoff 共同确定。需求变化通过新的 Ticket/attempt 和新的正式 handoff 表达，历史版本保持可追溯。

### 2.3 Plan 是所有参与者共享的执行视图

每个被派发的 Agent 都必须收到当前 Plan 的权威快照，包括：

- Plan ID 和 version；
- 所有 Ticket 的 ID、状态、标题、目标、成功标准和输出契约；
- Ticket DAG 依赖边；
- required terminal Ticket；
- 当前团队成员及能力快照。

这相当于真实团队共同可见的 Backlog、计划板和依赖图。Agent 可以理解整个功能、其他人的职责和自己的位置，但不能读取其他 Agent 的私有会话。

### 2.4 Ticket 是个人职责，handoff 是工作增量

当前 Agent 额外收到：

- 当前 Ticket 的完整定义；
- 当前 Ticket 所有已完成祖先的 accepted handoff，按 DAG 拓扑顺序排列；
- 自己在该 Mission 内的时间序 Agent thread。

handoff 只承载已经完成的领域结果、证据和风险，不承担重新解释整个需求的职责。并行分支如果需要彼此产物，必须在 DAG 中建立依赖；平台不猜测隐含依赖。

## 3. 上下文结构

除首个需求接收 Agent 外，Agent 的工作上下文为：

```text
currentPlan
+ currentTicket
+ handoffLineage
+ current Agent thread
```

首个需求接收 Agent 还会在自己的 thread 中看到 human 原始诉求，用来形成正式 Brief。

`currentPlan` 和 `currentTicket` 来自 Ticket Engine 权威状态；`handoffLineage` 来自已完成祖先 Ticket；Agent thread 来自 Agent Engine。Mission Control 只进行确定性组装，不总结、不改写、不审批、不根据角色、标题、schema 或自然语言推断业务结论。

## 4. 生命周期

1. human 创建 Mission，原始诉求进入任务审计记录，并只投递给 Plan 显式声明的接收 Ticket。
2. 需求接收 Ticket 的 Agent 收到原始诉求，讨论并形成正式 handoff。
3. PM 收到正式 Brief、当前 Plan 和自己的规划 Ticket，追加可执行 DAG。
4. 后续每位 Agent 收到同一个当前 Plan 视图、自己的 Ticket，以及适用的祖先交付。
5. Agent 自行判断完成、阻塞、失败、纠正上游或请求计划变更；平台只校验协议和权限并提交状态。

## 5. 非目标

- 不让所有 Agent 读取彼此 session。
- 不把原始 human 消息重复塞入每轮上下文。
- 不由平台生成或维护第二份业务摘要。
- 不按老板、PM、开发、QA 等角色写流转分支。
- 不用关键词、正则或文件名判断业务是否完成。
- 不强制每个 Agent 额外调用一次 LLM 来模拟开会确认；共享权威工件即可建立一致基础，发现歧义时由 Agent 正常 blocked/correction/plan change。

## 6. 验收条件

1. 显式声明 `contextPolicy.includeOriginalRequest` 的需求接收 Agent 能看到 human 原始诉求，其他 Agent 看不到。
2. 后续 Agent 的派发上下文不再包含独立的原始 `missionObjective` 字段。
3. 每个 Agent 都能看到完整 Plan 快照，而不只是规划 Agent。
4. Plan 快照包含每张 Ticket 的成功标准、输出契约、依赖和终点。
5. 后续 Agent 能看到需求接收 handoff 和其他祖先交付，且顺序稳定、共享祖先不重复。
6. Agent 私有 thread 不互相暴露。
7. 实现中不存在按角色、标题、schema 或业务关键词选择共享上下文的逻辑。
8. Runtime 重启后，从 Ticket Engine、Mission Store 和 Agent Engine 重新组装出相同上下文。
