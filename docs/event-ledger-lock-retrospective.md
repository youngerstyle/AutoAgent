# EventLedger workspace lock 修复复盘（delivery-v1）

## 根因

`EventLedger.append` 原先在 `event-append.lock` 上遇到 `EEXIST` 时无限重试；owner 元数据又是创建后原地写入，因此进程可能在空/截断/非法 JSON 状态留下锁。旧清理逻辑是先读后删，存在竞争窗口，可能删除后来替换锁的存活 owner。

## 本轮修复与验证边界

实现改为带 deadline 的 owner 状态机：v1 token/pid/hostname/heartbeat/lease/state 元数据，发布后重读校验，有限 acquire timeout，空/非法 owner 在宽限期后只在同机 PID 已死亡时回收；存活 owner（包括 lease 已过期）保守超时。清理先将精确锁路径 quarantine rename，再校验原始字节/token 后删除，释放同样只处理匹配 token。发布边界异常用 `afterCreateBeforePublish` 故障注入覆盖；真实子进程按时序稳定控制在当前 Windows/Vitest 环境未实现，未伪造为真实崩溃证据。

既有关键路径未改变：事件 JSONL 是事实源，事件 fsync 先于 cursor，workspaceSequence 在锁内分配，幂等事件先查重，legacy 事件迁移与 limit 行为保留，事件总线在 durable 后发布。

## 上一轮漏检原因

- 设计阶段已指出 read-then-rm 竞争风险，但第一版实现仍保留 regular-file 读后删除，未在最终验收前完成原子 quarantine 返工。
- 定向测试使用较宽竞争 timeout，早期全量测试暴露出并行调度下 100ms 竞争回归不稳定；这说明定向通过不能替代全量门禁。
- QA/验收阶段对“启动输出”与“真实退出码”的区分不够前置；事件路由回放去重测试曾出现失败/不收敛，后续一次定向运行 4/4 通过，但全量 `test:run` 在当前会话仍未取得退出码 0，不能据此放行。

## 锁与崩溃一致性检查清单

- [ ] 创建锁后每个发布边界（空、截断、元数据 sync 后）都有可重复故障注入或真实子进程证据。
- [ ] owner 字段、token、PID、hostname、state、lease 的校验规则统一且有版本。
- [ ] lease 过期不是单独删除授权；同机存活 PID 始终优先保护。
- [ ] foreign/无法证明存活状态的 owner 不自动删除。
- [ ] acquire 有明确 wall-clock deadline，测试有超时断言并检查退出码。
- [ ] 清理使用 atomic quarantine/目录 rename，不能是裸 read→rm。
- [ ] 清理前后验证字节/token，释放不能删除替换后的锁。
- [ ] 并发竞争同时覆盖 cleanup、replacement、sequence 唯一性。
- [ ] 事件 durable-before-cursor、cursor 失败重试幂等、legacy、limit、tail repair 与公开 API 回归通过。
- [ ] 定向、全量 test:run、typecheck、build 均取得真实退出码；未收敛必须记录为失败/未决。
- [ ] 确认未执行 Git commit，保留工作区供 human 审查。

## 经验保存位置与后续检索事实

协议保存在 `docs/event-ledger-workspace-lock-protocol.md`，QA 交接和实际验证边界保存在 `docs/event-ledger-qa-handoff.md`，本复盘保存在本文件；实现和回归源码分别在 `src/server/storage/event-ledger.ts` 与 `tests/server/event-ledger-lock-recovery.test.ts`。这些是项目工作区文档，不是平台长期记忆。当前没有证据表明后续新任务会自动检索或自动应用本复盘；后续任务只有在其上下文显式提供这些文档、或执行者主动读取时才会使用，不能声称已建立长期记忆能力。

## 当前结论

本轮返工后，runtime-host 定向回归已取得真实退出码 0（61 tests passed），全量 `npm run test:run -- --reporter=dot` 已取得真实退出码 0（66 files / 608 tests passed），且锁恢复定向回归取得真实退出码 0（14 tests passed）、typecheck 和 build 均取得真实退出码 0。挂起根因对应的运行时 session/host teardown 现已具备有界终止路径；测试 fixture 也在 `afterEach` 中回收 host 与临时目录。保留 `afterCreateBeforePublish` 故障注入作为发布边界的可重复验证方式，未改变 no-overwrite、EventLedger 对外契约或锁生命周期语义。未执行 Git commit；当前工作区变更仍供审查。
