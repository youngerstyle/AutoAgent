# Company Evolution 实施计划

依据：`docs/superpowers/specs/2026-08-14-company-evolution-v1.md`

## 当前进度（2026-08-14）

- Milestone A：已完成 Candidate ledger、内容寻址 artifact、契约校验、Agent 只提案权限和无 Evaluation 禁止晋升。`ready_for_eval` 由绑定不可变 Eval Suite 的 `candidate.evaluation_requested` 账本事件产生，不再是队列推断状态；validation 会把每个 sourceRef 解析到 Evidence、Trace、Goal、Ticket 或 Mission 权威存储，只有语法正确但事实不存在的引用会被拒绝。
- Milestone B：已完成；包括确定性 Episode projector、typed failure attribution、append-only Experience Store、权威存储 reconcile、extraction job lease/heartbeat/backoff/dead-letter、入库前 secret redaction、基于多 Episode 同因证据且遇 counter-evidence 即隔离的 scoped Memory candidate consolidation，以及可回放的 usage/stale/archive/pin 生命周期。Organization Memory 使用源 scope 点名目标、目标 trust allowlist 点名源、organization id 一致的双边授权；撤销 trust 会使 Pi 会话下一轮重建，多源内容冲突 fail closed。
- Milestone C：已完成；包括内容寻址且版本不可变的 EvalSuite、historical/sealed-holdout 分区、Node Permission Model 真实隔离进程、静态 Skill Scanner/manifest、evaluation job lease/recovery、Evidence Ledger 校验、确定性 metric gate，以及由 lineage、独立审批和 canary telemetry 驱动的 shadow→canary→production/rollback。成本与延迟为不可省略的强制门禁；observation 同时支持 token、返工、重复工具调用、人工介入、证据完整度和仅从 sealed holdout 计算的泛化成功率。
- Milestone D：实现完成，自动化与代码级验收通过；已建立带 generation 的 canary/production active pointer、治理 API 与 Evol 管理页。Pi Runtime 对 production 执行严格 scope/manifest/scanner/content hash/lifecycle 校验，并对 active canary 按稳定 assignment key 做 1–25% 小流量分桶；role、provider、model、task type 与 tool scope 不匹配时 fail closed。Agent context trace 记录 selected/control cohort 和 provider token usage，Coordinator 从真实终态 Episode 自动构造 canary telemetry，门槛失败时以系统身份自动回滚 canary；未知美元成本记为 inconclusive，不伪造零成本。Production 晋升会以 append-only `superseded` 事件关闭同源 canary 的账本状态。Organization trust model、跨 Workspace Production Memory 投影、撤销会话重建与冲突隔离已通过端到端验证。独立 Evolution Coordinator 随服务恢复启动，即使没有活跃 RuntimeHost 也会执行经验对账、Memory 维护，并在服务器配置受信 evaluator 后消费持久化评测队列。带 automation selector 的 Suite 会驱动确定性 validation、Suite 绑定、持久化评测和分级晋升；只有低风险 Memory 可在独立评测与实测 telemetry 全部通过后自动到 production，Skill 自动流程止于 shadow。真实 Pi Agent 会话已验证 production Skill 加载与 rollback 后移除。管理页已通过类型检查与生产构建；浏览器视觉验收因当前浏览器插件初始化错误尚未执行，单独列为人工验收项，不计作已通过。
- Local Plugin：Bundle/scanner/Host/runtime mount 原型已存在；现按第四类本地 Evol 资产重新验收。默认必须由内置跨平台子进程 Host 运行，不要求 WSL、PowerShell 或外部 Sandbox Provider。
- Milestone E–H：按 `2026-08-14-self-mutation-activation-v1.md` 收口 Memory、Prompt、Skill、Local Plugin 的 next-turn/next-session 激活、inheritance proof 与 rollback。软件交付不属于该控制面。

## Milestone A：Candidate Control Plane

1. 重写 shared evolution contracts 与 runtime parser。
2. 建立 append-only `EvolutionLedger`，覆盖幂等和损坏行拒绝。
3. 实现 `CandidateStore`：create revision、validate contract、list/get。
4. 实现 Evaluation/Promotion 占位协议：没有有效 Evaluation 一律拒绝晋升。
5. 将 Pi runtime 工具改为 `propose_evolution_candidate`，只能 propose/status。
6. 重写路由和测试；删除自动激活行为。

退出标准：全量测试、类型检查、构建通过；旧原型不存在任何自动生产写入路径。

## Milestone B：Experience Pipeline

1. 定义 `ExperienceSourcePort`，读取 Ticket/Goal/Decision/Evidence 权威事实。
2. 构建 deterministic Episode projector。
3. 实现失败分类和 sourceRefs 完整性校验。
4. 实现 extraction jobs、lease/backoff 和幂等。
5. 输出 scoped episodic memory candidates。
6. 所有可持久化诊断文本先经版本化 secret-redaction policy；失败作业进入 bounded retry 或 dead-letter。

退出标准：完成、返工、Provider 故障、Policy 拒绝四类 fixture 可稳定重建；不得跨 workspace 读取。

## Milestone C：Evaluation Gate

1. Skill artifact manifest 和内容寻址存储。
2. 静态 Skill Scanner。
3. Versioned Eval Suite。
4. baseline/candidate runner port 与 deterministic result store。
5. Promotion policy、active release pointer、rollback record。
6. EvalRunner 只接受服务端注册的 sandbox executor；外部 API 不接收自报 observation/score。
7. Node evaluator 使用 Permission Model：临时目录读写白名单，默认禁用 network、child process 和 worker，并对超时、输出大小及输出 schema fail closed。
8. 父进程把本地 Evidence Ledger Fact 校验、裁剪、脱敏后物化为 evaluator schemaVersion 2 输入；sandbox 不拥有 Workspace 读取权，缺失/跨域/超限 Evidence 直接拒绝。

退出标准：评测缺失、hash 不匹配、安全失败、回归退化均确定性拒绝；通过 fixture 可 shadow 发布并回滚。

## Milestone D：Runtime Projection

1. Runtime 只加载 active release。
2. 使用记录和 outcome telemetry。
3. stale/archive/pin。
4. Evol 管理 API/客户端投影。
5. 恢复、并发和真实 Agent 验收。
6. active pointer 采用原子 JSON 投影和单调 generation；同一 promotion 重放不得增加 generation，production 晋升后关闭对应 canary pointer，rollback 恢复前一 production 或明确置为 inactive。
7. Evolution Coordinator 独立于任务 RuntimeHost；评测程序仅可由服务端 `AUTOAGENT_EVOLUTION_EVALUATOR_PROGRAM` 注册，Agent/API 不得提供可执行路径；未配置状态必须通过健康接口和管理页显式暴露。
8. Canary 使用 promotion 固化的 salt 与 1–25% rollout percentage 对 `threadId:goalId` 做稳定分桶；selected/control assignment 必须进入 context trace。Coordinator 只以终态 Episode 和该 trace 生成 telemetry，失败 gate 自动回滚 canary。
9. Canary 进入 production 后追加 `superseded` 事件；provider token usage 持久化，美元成本未知时门禁保持 inconclusive。
10. Eval Suite automation selector 驱动 Coordinator 幂等完成 validation、`ready_for_eval` 账本绑定、持久化评测与安全分级晋升；低风险 Memory 可自动到 production，Skill 自动推进止于 shadow。
11. Evaluation 与 Canary Telemetry 强制执行 cost/latency 门禁，并记录 token、QA return、重复工具调用、人工介入、证据完整度和 sealed-holdout 泛化成功率；未知成本不得以零值通过。

退出标准：重启、并发评测、并发 promotion、回滚和旧版本运行均通过；管理页浏览器视觉验收作为独立人工检查项记录，不得以构建通过冒充视觉通过。

## Milestone E：四类本地资产生命周期

1. Memory、Prompt、Skill 在下一 turn 解析新的 active generation，并记录实际继承。
2. Local Plugin 在下一 session 重建工具面，不热插入当前 session。
3. rollback 生成新的 restoration generation，并在相同边界由后续运行证明。
4. 模型 Provider 沿用现有配置；外部 delivery provider 状态不进入 Evol 健康判断。

退出标准：四类资产分别通过真实 Episode/Candidate、后续运行加载和 rollback 端到端验收。

## Milestone F：Local Plugin 默认 Host

1. 未配置任何外部 launcher 时使用内置跨平台子进程 Host。
2. Bundle scanner、独立评测、human approval 和 capability broker 仍然是强制门禁。
3. 外部 container/WSL/gVisor/Firecracker 仅作为不受信多租户部署的可选执行 adapter。

退出标准：默认本地环境可以完成 Plugin 下一 session 加载、调用与 rollback，不要求外部执行环境。
