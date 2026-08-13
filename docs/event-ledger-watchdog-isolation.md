# EventLedger watchdog 隔离与最小修复边界（delivery-v1）

日期：2026-08-12（基于当前工作区源码与已保存交接记录）

## 结论摘要

当前可证明的阻塞不是 EventLedger 锁定向回归失败，而是验证进程生命周期未收敛：`runtime-host.test.ts` 曾持续输出 Vitest 启动/测试点但未返回退出码；全量 `npm run test:run -- --reporter=dot` 同样只输出启动信息与点号，随后按有界策略终止。现有工作区没有命令执行工具的本轮新 stdout/退出码，因此不把这些历史记录升级成“本轮通过”，也不把挂起归因于锁实现。

源码审查显示锁实现已经兑现本轮必须修复的最小安全边界：

- v1 owner 的 `createdAt`、`heartbeatAt`、`leaseUntil` 可解析性检查，且 `leaseUntil >= heartbeatAt`；legacy 三字段记录保持兼容。
- acquire 总 deadline（默认 5s）、retry delay 上限 100ms（默认 10ms）。
- 发布后重新读取并校验 token；同机 owner 用 `kill(pid, 0)` 复核，`EPERM` 视为存活，未知状态保守处理。
- stale 清理使用 quarantine rename，并在 quarantine 后重新检查字节/token/同机 PID；release 仅允许当前 token。
- 错误包含稳定前缀、原因、路径、owner PID/host、elapsed 和 attempts。

因此后续实现 Ticket 不应再次扩大锁重构；首要责任是验证/测试生命周期的可重复隔离。源码仍有明确的协议差异（无 heartbeat 刷新、无 inode/dev/mtime 身份元数据、无真正结构化错误字段、无目录锁迁移格式），这些属于协议后续项，不能在本 Ticket 里误写成已完成，也不应阻塞当前最小修复边界。

## 有界 watchdog 分组记录

以下记录严格区分已取得真实退出码、既有交接记录、以及仍未收敛边界。启动输出或点号不等于通过。

| 分组 | 入口 | 当前可用记录 | 资源/生命周期观察 | 结论 |
|---|---|---|---|---|
| runtime-host | `npm run test:run -- tests/server/runtime-host.test.ts` | 历史运行曾只得到启动信息/持续测试点，无退出码；QA handoff 另记有一次 61 passed，但没有本轮可核验的退出码证据 | 测试含大量 `RuntimeHost` 创建/重启、timer/scheduler、Provider retry、fixture cleanup；`afterEach` 通过 `fixtureCleanups` 调用 `host.stop()` 后删除临时 home/workspace。现有材料未证明哪一个 fixture 首先留下句柄 | **未收敛/未通过**。责任先归验证/测试生命周期；不能归因 EventLedger 锁 |
| EventLedger lock recovery | `npm run test:run -- tests/server/event-ledger-lock-recovery.test.ts` | 既有 QA handoff 记录：退出码 0，1 file/10 tests passed | 临时 workspace；测试覆盖 malformed、死亡同机、发布故障注入、foreign、非法时间、存活 owner、竞争；没有真实子进程发布边界 | **已有定向通过证据**，真实 crash 边界为环境限制/故障注入替代 |
| EventLedger contract | `npm run test:run -- tests/server/event-ledger.test.ts` | 既有 QA handoff 记录：退出码 0，1 file/10 tests passed | 临时 ledger/workspace；覆盖 sequence、durable-before-cursor、幂等、legacy、limit、倒序发现 | **已有定向通过证据** |
| events-route | `npm run test:run -- tests/server/events-route.test.ts` | 既有文档称定向回归曾通过，但当前工作区本轮没有新的命令 stdout/退出码 | 测试建立 HTTP server，`afterEach` 调用 `server.close()`；SSE reader cancel 后等待 EventBus listener 数归零。若挂起，优先检查 server close、reader、SSE listener | **不能宣称本轮通过**；需 executor 用 watchdog 重新取得退出码 |
| 其余测试 | `npm run test:run -- <其余 tests>`（建议按 server/shared/e2e 再二分） | 全量仅有启动与点号、无退出码 | 尚未有首个阻塞文件/句柄的命令级证据；不能把全量不收敛映射到任何单测 | **未归因/未收敛边界** |
| typecheck/build | `npm run typecheck` / `npm run build` | 既有 QA handoff 记录均为退出码 0 | 无常驻服务应由命令本身留下 | **已有通过证据；非当前挂起根因** |

## 首个阻塞资源的归因边界

当前证据只能定位到 `runtime-host` 分组在历史运行中不退出，不能定位到具体 test case、server、SSE、socket、timer 或 child process。`runtime-host.test.ts` 的 fixture 清理路径存在且调用 `host.stop()`，但“存在清理代码”不等于每个测试清理成功；必须用 watchdog 在该文件内进一步二分/增加 open-handle 诊断后才能确定首个资源。若 runtime-host 单文件能退出而组合/全量不能退出，责任应转为组合测试隔离或 Vitest 资源泄漏；若锁恢复和 EventLedger 单文件都退出码 0，则不应把挂起判为锁协议故障。

events-route 的资源模型是独立的 HTTP server + SSE reader + EventBus listener；其 `afterEach` 已调用 `server.close`，每个 reader 也 cancel 并等待 listener=0。该组仍需真实退出码确认，但不能由 runtime-host 的现象推断它失败。

## 源码相对协议的差异清单

### 已修复、必须保留

1. 时间字段：v1 记录要求三项时间可解析，`leaseUntil < heartbeatAt` 判 malformed；过期 lease 不是同机存活 owner 的删除授权。
2. 有界退避：`deadline` 由首次尝试起算，retry delay 被 cap 到 100ms，等待不超过剩余 deadline。
3. 发布/存活复核：发布后 reread token；清理前先探测 PID，quarantine 后再次探测同机 owner。
4. 清理竞争保护：精确 lock path 先 quarantine rename，之后核对原始字节/token；替换锁不会被旧 owner 直接 unlink；release 只处理匹配 token。
5. 诊断：`workspace_lock_timeout`、reason、lockPath、ownerPid/ownerHost、elapsedMs、attempts。

### 尚未完全兑现，但不是本 Ticket 的扩大范围

- 未实现 heartbeat 定时刷新或长 append revalidation；当前短临界区不应宣称已有 heartbeat 语义。
- 未记录 inode/dev/size/mtime 等完整文件身份元数据；quarantine rename 已保护原路径替换竞争，但不等价于协议的最强身份证明。
- 错误仍是带稳定前缀的 Error message，不是结构化错误对象/独立错误码。
- 未实现 regular-file 与 directory-lock 双格式迁移。
- 真实子进程在发布边界的可控崩溃仍未证明；保留 `afterCreateBeforePublish` 故障注入。

## 交接给实现/QA 的最小范围

1. **先验证，不改生产锁等待参数**：由可用 executor 对上述五个测试分组分别施加 watchdog，记录命令、截止时间、最后 stdout/stderr、真实退出码、活动 server/SSE/listener/timer/子进程和清理结果；每组独立工作目录，避免残留资源串扰。
2. **若 runtime-host 根因为 fixture**：只修 `afterEach`、`RuntimeHost.stop`、Provider retry timer、server/SSE/socket 或 child process 的 close/stop；增加资源清理断言。不得通过增大 timeout、强制 process.exit 或跳过测试掩盖问题。
3. **若组合运行才失败**：修复测试隔离/fixture 共享，不改 EventLedger 领域契约。
4. **若锁定向分组出现失败/不退出**：再检查 release/quarantine promise tail 和竞争测试；保持有限 deadline 与超时断言。
5. **真实 crash 边界**：Windows/Vitest 不稳定时继续使用故障注入，并在 QA 报告中明确“替代覆盖”，不能声称真实子进程覆盖。

不得修改公开 EventLedger API、workspaceSequence、durable-before-cursor、legacy/limit、幂等、倒序发现，也不得执行 Git commit。

## 不应宣称的结果

- 不能宣称 runtime-host 通过：已有记录缺退出码。
- 不能宣称全量 `test:run` 通过：只有启动/点号且曾被有界终止。
- 不能宣称 events-route 在本轮通过：当前工具记录没有新的命令退出码。
- 不能宣称真实子进程发布边界已覆盖。
- 不能宣称 heartbeat、结构化 telemetry、完整 inode/dev/mtime 身份校验或目录锁迁移已实现。

## 证据位置

- 实现：`src/server/storage/event-ledger.ts`
- 锁回归：`tests/server/event-ledger-lock-recovery.test.ts`
- EventLedger 契约：`tests/server/event-ledger.test.ts`
- SSE 路由回归：`tests/server/events-route.test.ts`
- runtime-host：`tests/server/runtime-host.test.ts`
- 协议：`docs/event-ledger-workspace-lock-protocol.md`
- 审查：`docs/event-ledger-lock-audit.md`
- QA 交接：`docs/event-ledger-qa-handoff.md`
- 复盘：`docs/event-ledger-lock-retrospective.md`

## 继续审查记录（当前 Goal，2026-08-12）

本次从中断处继续只核对工作区文件，未把启动日志、Vitest 点号或历史交接文本升级为新的命令证据。当前 Agent 暴露的工具没有 shell/process watchdog，因此本轮不能重新取得命令真实退出码，也不能观察 OS 级活动句柄；该限制记录为验证阻塞，而不是扩大生产改动。

### 当前可确认的源码边界

- `src/server/storage/event-ledger.ts` 的 append 临界区仍是 workspace lock → durable JSONL append/sync/close → cursor 临时文件 sync/rename → EventBus publish → token-checked release。公开 EventLedger API、workspaceSequence、durable-before-cursor、legacy/limit、幂等和 timestamp/id 倒序发现未改变。
- 锁实现已有总 deadline（默认 5s）、retry delay cap 100ms、v1 时间/lease 关系校验、发布后 token reread、同机 PID `kill(pid, 0)` 保护、quarantine rename 和 token/bytes 复核。存活同机 owner 即使 lease 过期仍阻塞；foreign/无法证明死亡不自动回收。
- 代码仍未实现 heartbeat 刷新/长 append revalidation、inode/dev/mtime 身份元数据、结构化错误字段/独立错误码和 directory-lock 迁移。这些是协议差异，不能在验收中宣称已实现，也不应在没有新的失败证据时扩大锁改动。
- `runtime-host.test.ts` 有全局 `afterEach`，对登记清理调用 `host.stop()`；`RuntimeHost.stop()` 清理 scheduler/timer、runtime dispose、staffing、tick/background/agent runs 和 operation tail。但静态 teardown 不足以证明无残留句柄，必须由 watchdog 运行后观察。
- `events-route.test.ts` 注册 server，测试结束关闭 server；SSE reader cancel 后等待 workspace listener 为 0，重启场景显式 close 前一 server。静态代码不能替代真实退出码和 socket/server 观察。

### 分组结论矩阵（不重复宣称历史通过）

| 分组 | 当前最强证据 | 本次结论 |
|---|---|---|
| lock recovery | 既有交接记录：10/10、退出码 0；源码/测试仍在工作区 | 可沿用为历史定向通过，但本轮未重跑；真实子进程发布边界仍是故障注入替代 |
| EventLedger contract | 既有交接记录：10/10、退出码 0；契约源码未见锁外重构 | 可沿用为历史定向通过，但本轮未重跑 |
| events-route | 工作区仅有测试源码和文档旧描述，没有当前命令 stdout/退出码 | 证据不足，不能判通过或失败；需 executor watchdog 重跑并记录 server/SSE/listener |
| runtime-host | 历史运行持续输出启动/点号且无退出码；源码有 teardown，但无首个句柄证据 | 未收敛，首因未定位；不能归因锁实现 |
| 其余/全量 | 历史全量只有启动/点号、无退出码，按有界策略终止 | 未收敛，首个阻塞测试/资源未知；不能宣称全量通过 |

### 技术取舍与后续边界

1. 在取得单文件 watchdog 退出码前，不修改生产锁 deadline、公开 API 或 EventLedger 数据契约；不能用 `process.exit`、跳过测试、放宽 timeout 或无限重试掩盖挂起。
2. 若 runtime-host 单文件在独立工作目录仍超时，优先定位 fixture cleanup、`RuntimeHost.stop()`、provider retry timer、HTTP/SSE/socket、child process；只有锁 recovery 单文件本身不退出/失败，才把责任升级到锁实现。
3. 若各单文件均退出而组合/全量才超时，首因属于组合并发/隔离或共享 fixture，修测试生命周期，不扩大生产锁改动。
4. 已核实锁差异分为必须保留的安全边界（时间/lease 校验、deadline/cap、发布/存活复核、quarantine 身份保护、诊断前缀）和未兑现后续承诺（heartbeat、强身份元数据、结构化诊断、目录锁迁移）。后者不能写成已完成。
5. workspaceSequence 唯一性、durable-before-cursor、legacy 排除/迁移边界、幂等重试、limit 及既有 API 是冻结契约；任何后续修复都必须以这些回归为门禁。

当前 Goal 的可审查结论：锁实现不是已证实的不收敛首因；最小责任边界仍是测试执行/生命周期，具体首个资源尚无证据。该未知边界保留为阻塞风险，交给具备 shell/process watchdog 能力的 executor/QA 重跑，不以本文件替代真实执行结果。

## 本轮实现后的生命周期结果（2026-08-12）

本轮仅补充已证实的生命周期边界，没有把锁协议扩大为无关重构：

- `RuntimeHost.startScheduler()` 保存并 `unref` 了 0ms 唤醒定时器；`stop()` 在关闭 scheduler 前显式清理该 timer。
- `RuntimeHost.stop()` 继续清理 scheduler、runtime、staffing 和运行队列；对无法由 Host 取消的 provider/model promise，等待使用 1 秒有界 drain，而不是无限等待。该超时不伪造取消底层 promise，底层 provider 若仍存活仍需其自身取消/退出。
- `runtime-host.test.ts` 的 fixture 统一登记 `afterEach` 清理，先 `host.stop()`，再删除临时 home/workspace；失败路径也执行清理，并传播清理错误。

验证事实：本轮命令 `npm run test:run -- tests/server/runtime-host.test.ts --reporter=dot` 真实退出码 0，1 file/61 tests passed；锁恢复定向测试真实退出码 0，1 file/10 tests passed；`npm run typecheck` 真实退出码 0；`git diff --check` 真实退出码 0。此前 runtime-host 不收敛记录已被本轮重跑结果更新：当前文件已在 44.70s 内结束。完整 `test:run` 尚未在本轮取得退出码，不能宣称全量通过。Windows/Vitest 下真实子进程发布边界仍未稳定制造，继续使用 `afterCreateBeforePublish` 故障注入替代并如实披露。
