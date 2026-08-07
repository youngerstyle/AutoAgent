# TicketGraphContract v1

> 历史决策记录：当前生产可靠性与实现状态以 `2026-08-03-production-runtime-reliability-design.md` 和 `2026-07-14-single-plan-ticket-flow-design.md` 为准。本文的 v1 固定角色、固定终点、`human_action` 和旧阶段规则不再指导新实现。

AutoAgent 的工单系统是项目 flow 的事实来源。PM 可以用 LLM 判断业务拆解，但 PM 输出的 `ticketGraph` 必须先满足工单合约；平台只做结构性校验和投递，不替 PM 做业务决策，也不接受不完整流程继续执行。

## 合约位置

- 人可读标准：本文档。
- 机器可执行标准：`src/server/mission/ticket-graph-contract.ts`。
- Agent 提示词摘要：`src/server/context/context-assembler.ts` 中的 PM 根规划提示。
- 运行反馈：`MissionControl` 在 PM 图校验失败时写入 `context.ticketGraphContractReview`，并把同一张 PM 工单重新放回队列。

## 平台级硬标准

这些规则和具体项目无关，所有 `ticketGraph` 都必须满足：

1. `ticketGraph` 只能描述待执行工单，不能把 `done`、`completed`、`complete` 这类已完成记录写成新工单。
2. 根规划 `ticketGraph` 不能包含 `human_action`。人工动作是运行时边界，只能由执行中的 Agent 在真实授权、人工测试或安全边界受阻时触发；PM 不能把“让人手动启动服务/手动测试”预排成主流程工单。
3. 工单 `type` 必须是平台已知类型或明确别名。未知类型不能默认解释成开发工单，必须退回 PM 自修。
4. 图内依赖必须能解析到当前图里的工单 key、id、ticketId 或 ticket_id。
5. 如果省略依赖，平台按列表顺序建立相邻依赖；这只是结构默认值，不代表 PM 可以省略责任链。
6. 最终叶子工单必须是 `boss_acceptance`。任务不能停在 PM、架构、开发、返工、专家或 QA。
7. 每个 `implementation`、`rework`、`specialist` 工单后必须能到达 `qa`。
8. 每个上述 QA 后必须能到达 `boss_acceptance`。
9. `targetRole` 由工单 type 规范化，模型返回错误角色时平台按 type 修正投递角色。

## 运行时依赖语义

- 只有 `completed` 工单可以解锁正常下游。
- `returned` 表示该分支已被打回，不能解锁原下游。需要继续工作时，必须创建新的返工或补充工单。
- QA 人工测试失败时，旧 QA 分支下未完成的验收工单会被取消，再创建新的返工工单；返工完成后重新进入 QA。
- 读取快照不能修改任务状态。状态只能在 ticket claim、ack、block、yield、return、cancel 等明确动作中变化。

## 项目级标准

项目级标准来自老板和 PM 的任务定义，包括：

- 成功标准。
- 交付物。
- 不做事项和安全边界。
- QA 覆盖项。
- 老板验收口径。

平台不从自然语言里猜这些业务内容；PM 必须把它们体现在工单 brief、expectedArtifact 和依赖里。

## PM 自修流程

PM 输出 `ticketGraph` 后的处理顺序：

1. PM 自己按合约和当前项目目标审查。
2. 平台用 `TicketGraphContract v1` 做结构校验。
3. 校验通过，平台创建工单 DAG，并按依赖投递给对应 Agent。
4. 校验失败，平台不创建下游工单，也不让 human 接锅；平台把失败原因写入 `ticketGraphContractReview`，同一张 PM 工单重新进入 pending。
5. PM 下一轮必须读取 `ticketGraphContractReview`，重新输出完整图。
6. PM 自修超过 `AUTOAGENT_MAX_TICKET_SELF_REPAIR_ATTEMPTS` 次后，才阻塞给 human。

## 和真实团队的对应关系

简单项目可以跳过架构评审，但不能跳过质量检查和最终验收：

```text
老板需求接收 -> PM 拆解 -> 开发 -> QA -> 老板验收
```

复杂项目可以加入架构、专家、文档或调研工单，但最终仍然必须形成可交接、可验证、可验收的闭环。
