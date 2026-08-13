# EventLedger 锁协议/测试收敛审查（delivery-v1）

审查基线：当前工作区源码、回归测试、协议/QA/复盘文档。本文只记录本轮可观察事实，不把文档声明当成命令执行证据。

## 1. 差异清单

### 已由当前工具结果直接证明

- `src/server/storage/event-ledger.ts` 是实现入口；公开 `EventLedger.append/read/readWorkspaceSince` 签名未因锁修复改变。
- append 在 `path.resolve(workspaceRoot)` 后使用 workspace 级锁；事件文件先 `appendDurable()`（handle.sync/close），再写 cursor，最后发布 EventBus，再释放锁。
- workspace sequence 在扫描所有持久化事件后取正整数最大值加一；legacy（无 workspaceSequence）按 0 排除。请求 id 在分配新 sequence 前查重，内容冲突报错。
- cursor 使用临时文件、sync、rename；Windows 目录 fsync 错误被有意忽略。此处没有看到 cursor 先于事件持久化的路径。
- 锁 acquire 有总 deadline，默认 `5_000ms`；默认 publication grace `250ms`、retry delay `10ms`，上限不是协议所述的 100ms（实现每次直接使用注入的 retry delay，未实现 capped+jitter）。leaseUntil 写死为 `now + 30_000ms`。
- owner 发布流程是 `open(wx)` 后写 JSON、sync、close、重新读取并按 token 校验；故障注入点为 `afterCreateBeforePublish`，异常时锁文件故意保留。
- 已实现的状态判断：空/不可解析 owner 在 deadline 内返回 `WorkspaceLockTimeoutError`；同机 owner 使用 `process.kill(pid, 0)`，成功或非异常视为存活，`EPERM` 也视为存活；死亡同机 owner 尝试恢复；foreign host 不做本机 PID 探测且最终超时；lease 是否过期目前不参与判断，因此同机存活 owner 即使 lease 过期也受保护。
- 清理不是裸 `read -> rm`：`guardedRemove` 再次探测 PID 后以 rename 到唯一 quarantine 路径，再校验原始字节/token，最后 unlink。释放也只对当前 token 执行；token 不匹配不删除。
- `tests/server/event-ledger-lock-recovery.test.ts` 当前包含：四类 malformed lock 的 100ms deadline 断言、死亡同机 owner 恢复、发布边界故障注入恢复、存活 owner（过期 lease）不得删除、两实例 8 次竞争下 sequence 唯一。
- `tests/server/event-ledger.test.ts` 当前包含：task-run sequence、单实例并发、terminal tail、timestamp/id 倒序发现、未知 cursor 的 limit、legacy 排除、跨实例 sequence 唯一、durable-before-cursor 后幂等、id 冲突和重建。
- `docs/event-ledger-qa-handoff.md` 明确记载 events-ledger 定向测试退出码 0、typecheck 退出码 0；runtime-host 一次只得到启动信息；全量 test:run 与 build 未在该交接中宣称通过。
- `docs/event-ledger-lock-retrospective.md` 明确记载全量 `npm run test:run -- --reporter=dot` 仅有启动与点号、被终止、没有退出码；并明确真实子进程发布边界在当前 Windows/Vitest 未稳定控制，采用故障注入替代且未伪造为真实证据。

### 仅由协议/QA/复盘文档描述、源码尚未兑现或尚未命令验证

- 协议要求严格校验 `version === 1`、UTC timestamp 可解析、`leaseUntil >= heartbeatAt`、完整 owner 状态；当前 `parseOwner` 只严格检查 token/hostname/pid，并在 version=1 时检查 state/两个字段为字符串，未解析时间、未校验 lease 关系；`version` 缺失的 legacy 记录被接受，符合兼容意图但没有单独的 legacy 分类诊断。
- 协议要求 heartbeat/revalidation `5_000ms`；当前没有 heartbeat 刷新或长 append revalidation。当前 append 短路径不会自动续租，因而这是未兑现的协议承诺，不应声称已有租约心跳语义。
- 协议要求 retry delay 10ms 起、100ms cap、jitter；当前无 cap/jitter，参数可直接注入，实际默认 10ms。
- 协议要求清理前后重探 owner、比对 identity metadata（token 之外的 inode/dev/size/mtime），并在清理竞争失败时保守重试；实现只在 rename 前做 PID 探测，quarantine 后只比较 bytes/token，没有 inode/dev/mtime，也没有 quarantine 后再次 PID 探测。rename 本身保护了原路径不被替换锁误删，但 PID reuse/owner 状态变化边界仍未达到文档的最强承诺。
- 协议要求 structured observability 字段与稳定错误码；实现只拼接字符串错误，未见结构化字段、`foreign_owner`/`malformed` 等独立错误码。
- 协议写明读者应支持文件与目录锁迁移格式；当前实现只处理 regular lock file，未实现目录格式。
- QA/复盘写的“定向 events-route 回归、typecheck/build 既有通过证据”不等于本轮工具调用重新取得退出码；当前工具结果只直接读取了源码和文档，没有取得新的命令 stdout/exit code。

### 仍需验证

- 全量测试不收敛的首个阻塞文件/资源：现有事实只证明 `runtime-host.test.ts` 曾出现启动后无退出码，以及全量点号运行无退出码；没有当前命令级隔离证据能判定是锁恢复、并发锁测试、runtime-host，还是 Vitest/测试基础设施。
- 需要分别以有界 watchdog 运行：锁恢复文件、event-ledger 文件、events-route 文件、runtime-host 文件、其余测试分组；记录退出码、最后输出和活动句柄/子进程。不能用增大 timeout 或 `--passWithNoTests` 等放宽门禁替代。
- Windows 下真实子进程在 `wx` 后、owner 完整发布前以及 sync 后边界的稳定时序控制仍未证明；必须保留 `afterCreateBeforePublish` 故障注入，并至少覆盖空/截断/非法 JSON、死亡 owner、存活 owner、token replacement 竞争。

## 2. 协议固定边界（供后续实现/QA）

- 固定默认值：lease 30s、publication grace 250ms、acquire deadline 5s、retry 10ms 起并应 cap 100ms；heartbeat 5s 只有在真正实现刷新/revalidation 后才可写入“已兑现”。测试可注入更短 deadline，但不得无限等待。
- owner 状态：publishing（空/不完整/非法，在 grace 内）、ready（完整 v1）、legacy（旧 `{token,pid,hostname}`）、foreign-owner、malformed、dead-same-host、live-same-host。
- 同机存活：仅在 hostname 可证明为本机时探测 PID；kill(0) 成功或 EPERM=存活，明确 ESRCH=死亡；未知错误、无效 PID、foreign host=不可证明，保守失败。lease 过期只是 stale hint，不能覆盖“同机 PID 存活”。
- 清理授权：只有同机死亡可证明（或未来明确安全的租约策略）才可回收；不因旧 lease、非法文本或测试 ID 删除。清理必须身份保护，竞争/ENOENT 则放弃本次删除并在 deadline 内重试。
- 释放授权：只删除持有者 token 对应的锁；ENOENT 成功、token 改变 no-op、replacement 不得被旧 owner 删除。

## 3. 全量不收敛的责任边界与最小修复方向

当前责任应先归为“验证基础设施/测试隔离未完成”，而不是直接归因 EventLedger 锁。已有锁/ledger 定向测试通过记录与 runtime-host 启动后不退出记录并不能互相证明因果。

最小修复顺序：

1. 用 watchdog 分组运行并取得真实退出码，先确认单文件是否收敛；不要改变生产锁 deadline。
2. 若仅 runtime-host 或其 fixture 留下 server/fetch/SSE/socket/timer，修复该测试的 `afterEach`/server close/agent stop/child process cleanup；若单文件通过而组合失败，修复 Vitest 并发隔离或 fixture 资源泄漏。
3. 若锁恢复竞争单独失败，修复测试竞争窗口/清理身份保护，而不是提高无限等待；保留明确超时断言。
4. 只有出现锁测试本身在单文件也不退出，才把责任归到锁实现，并检查 release/quarantine、promise tail 和未关闭句柄。
5. 全量命令必须最终拿到真实退出码 0；人工中断、点号输出和单测替代均不算通过。

## 4. 实施边界

后续修复不得改变公开 EventLedger API、task-run `sequence`、workspaceSequence 唯一性、event durable-before-cursor、legacy migration/exclusion、幂等重试、timestamp/id 倒序发现和 `limit`（`limit <= 0` 返回空，正数按既有发现顺序截取）。不引入按测试 ID/事件 ID/事件 type 的分支，不用无限循环，不执行 Git commit。
