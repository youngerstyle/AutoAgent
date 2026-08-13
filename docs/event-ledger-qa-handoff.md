# EventLedger 回归交接（delivery-v1）

## 本次范围

本轮只补齐并复核超过 `limit` 的 legacy/未知 cursor 回归覆盖，以及向独立 QA 交接可复现的验证入口。EventLedger API、cursor 格式、事件排序模型和无关业务行为未作重设计。

## 已确认的回归覆盖

`tests/server/event-ledger.test.ts` 当前包含 10 个测试，其中包括：

- `returns the latest limit events when a legacy cursor is unknown`：写入 3 条通用历史记录，以 `limit=2` 读取未知 cursor，并明确断言返回第 2、3 条及顺序；不依赖单个固定事件样例路径来决定实现分支。
- `excludes permanent legacy records after a fresh protocol cursor`：验证 legacy 记录不会在新 protocol cursor 后重复出现。
- `allocates unique workspace sequences across ledger instances and task runs`：验证跨实例并发分配唯一 workspace sequence。
- `recovers a durable event when cursor publication fails and makes retries idempotent`：验证事件先持久化、cursor 发布失败后的恢复与重试幂等。
- `replays a later cross-run event even when its timestamp and id sort before the cursor`：验证 timestamp/id 倒序时仍按 workspace 发现后续事件。
- 其余测试覆盖 task-run sequence、截断尾记录恢复、重建 ledger、id 冲突等既有契约。

实现审查边界：生产分支只依据 durable record、protocol sequence、cursor 与恢复状态，不应依据测试 ID、事件内容或样例路径特判。既有 workspaceSequence、legacy migration、跨实例并发、事件先落盘后 cursor、重试幂等和 timestamp/id 倒序发现的测试入口均已保留在同一文件。

## 实际验证记录

| 命令 | 结果 |
| --- | --- |
| `npm run test:run -- tests/server/event-ledger.test.ts` | 退出码 0；1 file passed，10 tests passed（18:38:31，约 1.55s） |
| `npm run typecheck` | 退出码 0 |
| `npm run test:run -- tests/server/runtime-host.test.ts` | 当前一次执行仅输出 Vitest 启动信息，仍未取得退出码；不能视为通过。此前上游记录的同组验证为 61 passed，但独立 QA 必须在当前工作区重新取得进程退出码。 |
| `npm run test:run` | 本 Ticket 未宣称已执行或通过；独立 QA 必须实际执行并记录退出码。 |
| `npm run build` | 本 Ticket 未宣称已执行或通过；独立 QA 必须实际执行并记录退出码。 |

## QA 验收口径

独立 QA 应在当前未提交工作区逐项执行：

1. `npm run test:run -- tests/server/event-ledger.test.ts`，退出码必须为 0，并核对返回集合是最后两条且顺序正确。
2. `npm run test:run`，必须获得真实退出码 0；启动信息或人工中断不算通过。
3. `npm run typecheck`，退出码必须为 0。
4. `npm run build`，退出码必须为 0。
5. 检查 `git status --short`，确认不应创建 Git commit，代码和测试仍留在工作区供 human 审查。

当前已知风险是 `runtime-host.test.ts` 的一次现场运行仍未收敛；这属于全量质量门槛的未决验证，不应被本交接材料改写为通过。

## 本轮修订后的实际验证

- `npm run test:run -- tests/server/event-ledger-lock-recovery.test.ts`：退出码 0，1 file/10 tests passed；覆盖 malformed、死亡同机、发布故障注入、存活过期 lease、foreign owner、非法时间、并发竞争，并带有 100ms/1s 有界断言。
- `npm run test:run -- tests/server/event-ledger.test.ts`：退出码 0，1 file/10 tests passed。
- `npm run typecheck`：退出码 0。
- `npm run build`：退出码 0，Vite 与 server TypeScript 构建完成。
- `npm run test:run -- --reporter=dot`：本轮启动后持续输出点号，未取得退出码；为避免无上限等待按有界策略终止，不能视为通过。真实子进程发布边界仍未纳入，继续使用 `afterCreateBeforePublish` 故障注入替代并明确记录环境限制。
