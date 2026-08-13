# EventLedger quarantine 恢复竞争方案（delivery-v1）

## 1. 事实与问题边界

当前实现入口是 `src/server/storage/event-ledger.ts`。`append()` 在 canonical
`path.resolve(workspaceRoot)` 下取得 workspace 级 `event-append.lock`，完成事件扫描、
workspaceSequence 分配、事件 fsync、cursor 原子替换和 EventBus 发布后释放锁。
当前 owner 是 regular JSON lock file，首次 `open(lockFile, "wx")` 建立独占，再写入
v1 owner JSON；release 以 token 校验后调用 `quarantineRemove()`。

已确认的竞争缺陷：POSIX/Windows 的普通 `rename(source, target)` 不是“目标存在则失败”
的可移植 no-overwrite 原语；尤其 Windows 可能替换目标，且 `restoreQuarantine()` 的
`EEXIST` 分支不能作为跨平台保证。因此旧 quarantine 不能直接 rename 回当前路径，
也不能先 `read(lockFile)` 再 `rm(lockFile)`。

本设计只改变锁恢复/清理内部实现，不改变 EventLedger 对外 API、事件 JSONL、cursor、
sequence、EventBus 或 runtime-host 生命周期契约。

## 2. 三个必须分开的身份

- **旧 quarantine**：旧 owner 的原始 lock bytes 被原子地从 canonical
  `event-append.lock` 移走后形成的唯一临时路径，例如
  `event-append.lock.quarantine-<process>-<uuid>`。它只属于本次清理尝试，不代表当前锁。
- **当前 lockFile**：唯一的 canonical acquisition pathname。它可能不存在，也可能已由
  replacement owner 以 `open("wx")` 创建并写入新 owner record。
- **新 owner token**：replacement owner JSON 中的 opaque token。它和旧 token、PID、
  quarantine 名称都不同；任何旧路径不得凭 PID 或业务数据认领新 token。

推荐把内部结果建模为有限结果（名称可按现有代码风格调整）：
`removed`、`target-absent`、`target-exists-preserved`、`restored-old`、`quarantined-for-diagnosis`
和 `failed`。每次恢复只允许一次 quarantine claim，后续 retry 由 acquire 的既有 deadline
驱动，不得使用无界循环。

## 3. 状态机与三类结果

### 3.1 旧 owner 进入 quarantine

1. 读取并保存旧 lock 的 exact bytes、解析出的旧 token/owner 摘要；只对同机且可证明
   PID 已死亡的 owner 取得 cleanup 授权。lease 过期本身不是授权。
2. 在 canonical 路径上执行一次**同目录、原子、唯一目标**的 quarantine claim：
   `rename(lockFile, uniqueQuarantine)`。quarantine 名称由随机 UUID 生成，不使用测试 ID、
   event ID 或业务条件；目标不可能预先存在。
3. claim 成功后，canonical `lockFile` 短暂不存在，旧 bytes 只存在于 quarantine。
   claim 失败：`ENOENT` 表示别的 contender 已处理，返回 `target-absent`/继续 acquisition；
   `EACCES`、`EPERM`、`EXDEV` 或未知错误返回 `failed`，保留可诊断上下文。
4. claim 后重新读取 quarantine，必须与 expected bytes/token 一致；不一致时不得删除，
   进入 `quarantined-for-diagnosis`（或安全 restore，见 4），并报告 `identity-changed`。

### 3.2 replacement owner 重建 lockFile

另一个 contender 只对 canonical pathname 使用 `open(lockFile, "wx")`。因此 replacement
owner token 只能在 `lockFile` 不存在时创建；它不读取旧 quarantine，也不覆盖目标。
写入、sync、close、重新读取并校验自身 token 后才进入 `ready`。

### 3.3 旧 cleanup/release 恢复

旧清理者在 quarantine 校验失败、删除失败，或发现 canonical 路径已被新 owner 占用时，
不得执行 `rename(quarantine, lockFile)`。它只能：

- 目标不存在：尝试一次**独占创建/安全恢复**（见第 4 节）；成功才可恢复旧 bytes，
  随即按旧 owner token 继续合法清理；若恢复操作失败，保留 quarantine 并返回
  `failed`/`quarantined-for-diagnosis`。
- 目标已存在：读取仅用于诊断并记录 replacement token/bytes digest；绝不覆盖、unlink、
  rename 替换或修改目标。旧 quarantine 保留到安全清理策略允许时，结果为
  `target-exists-preserved`。
- 目标检查或恢复失败：不把失败当成目标不存在，不重试到无界；返回 `failed`，目标和
  quarantine 均保持原状，供后续 bounded acquire/诊断处理。

## 4. 可证明的 no-overwrite 恢复算法

### 首选：不恢复到 canonical，安全隔离旧 quarantine

在目标已存在场景，最安全且跨平台一致的结果是 `target-exists-preserved`：新 owner
继续持有 canonical lockFile，旧 quarantine 不再参与锁所有权；记录旧 token hash、
replacement token hash、路径、原因，保留 quarantine。这样完全不依赖 rename 的目标
语义，也不会删除新 owner。

### 目标不存在时的可选等价恢复

若既有契约明确要求把旧 bytes 放回 canonical（通常 cleanup/release 并不需要），必须
通过底层独占创建保证 no-overwrite：

1. 先以 `open(lockFile, "wx", 0o600)` 创建空目标；这一步是唯一获得 canonical
   pathname 的原子独占动作，目标已存在时返回 `EEXIST`，绝不覆盖。
2. 将 quarantine bytes 写入该已独占 handle，`sync()`、close；重新读取 canonical 并
   比较 exact bytes/token。
3. 校验失败时只删除自己刚创建且 token/bytes 仍匹配的目标，或将其安全隔离；不得
   删除期间出现的 replacement。若无法证明身份，保留两者并返回 `failed`。
4. 成功后才可 unlink quarantine；unlink 失败不是删除 canonical 的理由，保留 quarantine
   并返回可诊断失败。

更好的实现是根本不 restore：旧清理者只对自己已 claim 的 quarantine 做 unlink；下一个
acquire 直接 `wx` 建立新 owner。这是本次推荐方案，因为恢复旧 lock 没有业务价值且会
延长竞争窗口。

不要使用普通覆盖式 rename、裸 `read-rm`、`access` 后再创建、依赖 `rename` 的 EEXIST
行为，或“先删目标再恢复”。

## 5. cleanup 与 release 两条路径

### cleanup（stale/dead owner recovery）

触发点：acquire 的 `open(lockFile, "wx")` 收到 `EEXIST`，且 owner 是同机、合法且
`process.kill(pid, 0)` 明确返回 `ESRCH`；或 publication grace 后具备同样可证明的死亡
信息。流程是 guarded quarantine claim → bytes/token 复核 → 目标状态分类。

- `target-absent`：旧 quarantine 可 unlink；acquire 再以 `wx` 创建 replacement。
- `target-exists-preserved`：只记录竞争诊断；旧 quarantine 默认保留，不影响 replacement
  生命周期。后续可由同一 lock-recovery housekeeping 在明确 TTL、非活跃且不在恢复窗口
  时清理；TTL 清理只 unlink quarantine 文件，不触碰 canonical lockFile。
- `failed`：保留 quarantine，错误带 `lockPath`、旧 token 摘要、replacement token 摘要
  （只 hash，不泄漏完整 token）、elapsed、attempts、OS error；在 acquire deadline 到期
  返回稳定 `workspace_lock_timeout`/现有 Error 形状。

### release（当前 owner 正常结束）

触发点：append 的 finally，或未来 runtime-host teardown 触发的 owner 释放。release
首先读取 canonical lockFile；只有 `current.token === heldToken` 才允许对 canonical
执行 guarded quarantine claim。`ENOENT` 是成功；token 改变（包括 replacement owner）
是 no-op 成功；malformed/foreign/读取失败不得按旧 token 删除。

release claim 成功后，旧 owner只 unlink 自己的 quarantine。若 canonical 在 claim 后
被 replacement 重新创建，仍不 restore、不触碰新文件。quarantine unlink 失败只产生
诊断并保留该文件，不能使 release 删除或覆盖新 owner；是否向调用者抛错遵循现有
release/finally 错误契约，append 的原有业务错误不能被恢复清理错误静默改写。

### quarantine 生命周期

- 创建：仅由一次成功的 guarded claim 创建，命名唯一。
- 短期保留：目标已存在、身份校验失败、unlink 权限/IO 失败时保留。
- 清理：只允许对 quarantine 自身做 unlink；cleanup 不得扫描 canonical 后删除，不能
  依赖测试 ID。可设有界 TTL housekeeping（例如进程启动/定期单次扫描），但必须遵守
  路径前缀、regular-file 类型和 TTL，且不处理当前 lockFile；若无法确认安全条件则保留。
- 诊断：每次结果包含 `quarantineOutcome`，并允许运维按路径/摘要清理。禁止自动把
  “目标存在”解释为旧 quarantine 可恢复。

## 6. POSIX / Windows 兼容边界

共享协议只依赖：同目录移动旧 pathname 的原子性、`open(wx)` 的独占创建、文件 handle
sync/close，以及对**自己持有的唯一 quarantine pathname** 的 unlink。实现必须禁止依赖
“rename 目标存在时失败”。

- POSIX：同一文件系统同目录 rename claim 通常原子；`open("wx")` 映射为 `O_CREAT|O_EXCL`。
  目录 fsync 可用于 durability，但锁恢复安全性不依赖目录 fsync。
- Windows：`open("wx")` 必须映射为不覆盖创建；同目录 rename 用于把旧 canonical
  移到唯一 quarantine，但 quarantine→canonical 禁止使用 rename。Windows 文件句柄占用
  可能使 rename/unlink 返回 `EPERM`/`EACCES`，按失败保留 quarantine，不强制删除。
- 两平台：`EEXIST`/`ERROR_FILE_EXISTS` 统一为 `target-exists-preserved`；`ENOENT` 仅说明
  该路径当前不存在，不能据此删除其他路径；未知 OS 错误保守失败。不得用
  `process.platform` 分支改变业务结果，只允许在底层 fs adapter 映射错误码/能力。
- 既有 regular lock file 格式继续支持。若未来引入 lock directory，必须版本化/能力探测，
  在迁移期分别处理 file 与 directory，不能把 regular file 当目录删除，也不能在本 Ticket
  偷换协议格式。

## 7. EventLedger 与 runtime-host 不变范围

必须保持：公开 `EventLedger.append/read/readWorkspaceSince` 签名；task-run `sequence`；
workspaceSequence 的扫描分配与唯一性；事件 fsync 先于 cursor；cursor 原子替换与 legacy
/unknown cursor limit 语义；幂等 event id 与冲突检查；EventBus 仅在 durable 后发布。

runtime-host 只保持现有 teardown 修复：`stop()` 先停止 scheduler/timers、注销 scheduler、
清 provider backoff，再 dispose loops/staffing，并以 1 秒有界 drain 等待既有 scheduler/agent
runs 和 operation tail。锁方案不应把 EventLedger release 绑到不可取消的 provider promise，
不延长 stop 的等待，也不改 runtime-host 的任务/Agent 状态迁移、scheduler 注册或 staffing
协议。

不应改动：事件 schema、cursor schema、路径规范、workspace sequence 分配、runtime-host
scheduler/tick/retry/stop 逻辑、业务事件分支、测试 ID 特判、memory/经验系统、Git commit。

## 8. 确定性测试与观测点

### 测试安排

为避免依赖时间或调度运气，测试提供内部 fs seam（仅测试注入，不改变业务分支）或
受控 barrier：

1. 旧 owner lockFile 写入固定旧 token；cleanup 在完成 exact-read/PID-death 检查后暂停。
2. cleanup 执行 `rename(lockFile, uniqueQuarantine)`，并在 claim 完成后触发 barrier。
3. 第二个 ledger 在 barrier 内取得 canonical `open(lockFile, "wx")`，发布固定新 token
   （测试通过 fs seam/owner writer 注入，不让生产代码读取测试 ID）。
4. 恢复动作被释放；断言旧 quarantine 存在或被安全 unlink，canonical lockFile 仍存在，
   其字节和新 token 与恢复前完全相同；旧路径不曾覆盖/删除新 owner。

至少有四组断言：

- **目标已存在**：cleanup/release 均返回 `target-exists-preserved` 或等价安全结果；
  replacement bytes/token 前后一致，文件存在；旧 quarantine 保留或只被独立安全清理。
- **目标不存在**：cleanup 可安全处置 quarantine，replacement 随后用 `wx` 创建；不存在
  覆盖窗口，结果为 `target-absent`/`removed`。
- **恢复失败**：注入 `EACCES`、`EPERM`、`EXDEV`、identity mismatch 或 unlink 失败；
  断言 canonical 不被修改，新 owner 不被删除，quarantine 保留，错误有界且带诊断字段。
- **release token replacement**：旧 token release 面对新 token 是 no-op；新 owner 内容和
  生命周期保持不变。

测试不得以固定 test ID 触发生产分支，不得用 sleep 作为唯一同步手段，不得捕获后无限
重试。测试结束要清理临时 workspace；若故意保留 quarantine，显式断言其路径并由 fixture
在最后安全 unlink。

### 可观测字段与 QA 断言

内部 recovery result/diagnostic 至少包含：`operation`（cleanup/release）、`state`
（old-quarantine/current-lock/replacement-owner）、`oldTokenHash`、`replacementTokenHash`
（若可解析）、`targetState`（absent/present/changed）、`outcome`、`errorCode`、`lockPath`,
`quarantinePath`、`attempts`、`elapsedMs`、`platform`。对外仍可维持现有
`WorkspaceLockTimeoutError` 名称和字符串前缀；结构化字段可作为内部日志/测试 seam，不能
改变 API。

QA 必须拿到真实退出码并覆盖：lock-recovery 定向、EventLedger 定向、runtime-host 定向、
全量 `test:run`、`typecheck`、`build`。运行时阻塞时用有界 watchdog 分组定位，不以人工中断
或启动日志代替成功；POSIX 验证关注原子 rename/`O_EXCL`/目录 fsync，Windows 验证关注
exclusive create、占用句柄下的 `EPERM`/`EACCES`、rename 不覆盖保证及 child-process
teardown。

## 9. 实施交接

开发只需修改 EventLedger 内部的 cleanup/release 适配与测试 seam；首选删除
`restoreQuarantine()` 的 canonical 覆盖式恢复路径，改为目标存在时保留 quarantine、
目标不存在时直接安全清理，再让下一轮 acquire 通过 `wx` 建立 owner。若业务确实要求
restore，则必须实现 `open(wx)` + 写入 + fsync + token/bytes revalidation，不能使用普通
rename。

QA 先验证 deterministic barrier 的四组结果，再跑既有 EventLedger 10 tests 和
runtime-host 相关测试，最后执行全量门禁。任何 failure 都应先区分目标状态、旧
quarantine 身份、OS 错误和 teardown 资源泄漏，避免通过延长 timeout 掩盖竞争。
