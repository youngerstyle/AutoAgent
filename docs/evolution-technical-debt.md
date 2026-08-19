# Evol 技术债务账本

更新时间：2026-08-19

## TD-EVOL-EVAL-001：默认发布链依赖外部 evaluator 程序

- 严重度：阻断
- 当前状态：开放，已进入 P0 实施
- 现状：`AUTOAGENT_EVOLUTION_EVALUATOR_PROGRAM` 是 EvaluationJob 的唯一执行入口；真实 Provider 可以完成任务、反思和候选生成，却不能直接完成评估。Practice-derived Workflow 也不会自动获得 EvalSuite。
- 风险：平台会把“已生成 validated Candidate”误报为自进化完成；真实用户配置 Provider 后仍无法观察下一任务加载。
- 临时控制：完成审计已降级为“机制覆盖”，管理面不得把 validated 当作 active Release。
- 偿还路径：`EvolutionTrialPort` + 平台 paired-task adapter + 自动 EvaluationPlan，详见 `superpowers/plans/2026-08-19-evolution-release-closure-implementation.md`。

## TD-EVOL-EVAL-002：结构资格与效果评估共用 EvaluationRun 语义

- 严重度：高
- 当前状态：开放
- 现状：静态格式/安全检查与 baseline/candidate 效果门禁没有独立的领域记录，容易把“能加载”误解为“有效”。
- 风险：自生成资产可能通过自评或 fixture 直接进入发布阶段。
- 偿还路径：拆成 Structural Qualification、Paired Real Trial、Canary Telemetry 三类不可互相替代的证据；前者最大只能到 Shadow。

## TD-EVOL-ARCH-001：Evol 内核仍有平台 Store 依赖

- 严重度：最高
- 当前状态：核心业务边界已偿还；物理打包待完成
- 已偿还：Experience/Memory、Signal、Canary/Company Trial 输入统一改为 `EvolutionObservationPort`；Candidate 验证改为 `EvolutionSourceVerificationPort`；Agent Loop 改为 `AgentEvolutionRuntimePort`；Mission Runtime 改为 `EvolutionPlatformPort`；平台知识集中到 `evolution-adapters`。`evolution` 目录已由架构测试禁止导入三大框架实现。
- 基础设施归属：Evidence Ledger 与 managed process tree 已提升为中立共享模块，旧 Agent Loop 路径仅保留兼容导出。
- 剩余：Evol 仍与当前仓库共享 contracts、storage paths、Provider interfaces，尚未发布成独立 package 或独立进程。
- 偿还路径：先提取 workspace-scoped storage/provider 端口与 package exports，再评估是否需要进程级部署；进程化不是本地下一 turn/session 生效语义的前提。

## TD-EVOL-MEM-001：Runtime 缺少任务正文相关度

- 严重度：高
- 当前状态：开放
- 现状：Memory Selection V1 只有 scope、效果、样本置信度、时间衰减和 Canary 探索；`RuntimeEvolutionContext` 只有 task type 与 tools，没有规范化 objective。
- 风险：不同 target 的 Memory 即使与当前任务无关，也可能因历史表现较好进入前 20。
- 临时控制：严格 scope 硬过滤、最多 20 条、完整选择 trace。
- 偿还路径：Evol 待实现清单中的 Memory Retrieval V2。

## TD-EVOL-MEM-002：固定条数而非 Token Budget

- 严重度：中
- 当前状态：开放
- 现状：Runtime 最多选择 20 条，每条系统提示最多截取 8,000 字符。
- 风险：上下文成本不可预测，长 Memory 可能挤压任务上下文。
- 临时控制：单条截断和总条数上限。
- 偿还路径：加入总 token budget、单条预算、边际价值排序和未选原因。

## TD-EVOL-MEM-003：时间评分使用会话构建时钟

- 严重度：中
- 当前状态：开放
- 现状：freshness 在 Runtime projection 构建时计算；进行中的 session 使用冻结 snapshot，直到 Evol ledger/fingerprint 改变才重建。
- 风险：长寿命 session 内分数不会随自然时间连续变化。
- 决策：符合“当前 turn/session 不热变更”原则，不在 V1 内引入定时热切换。
- 偿还路径：在 next-turn snapshot 边界引入显式 selection epoch，并将 epoch 纳入 fingerprint，而不是在 turn 中途改变。

## TD-EVOL-MEM-004：V1 权重是人工策略

- 严重度：中
- 当前状态：开放
- 现状：五项权重和五次 Episode 满置信度是版本化代码常量，尚未经过不同 Company 工作负载的系统校准。
- 风险：某些私有化公司可能更重视局部适用性，另一些更重视长期成功证据。
- 临时控制：策略版本写入 trace；评分只排序已通过硬门禁的 Memory；不能覆盖同 target 的 scope 规则。
- 偿还路径：先建立离线 replay 与 Company-local telemetry，再把权重变更作为可评测、可回滚的 policy candidate，禁止静默在线自调。

## TD-EVOL-MEM-005：缺少内容级去重与矛盾检测

- 严重度：高
- 当前状态：部分缓解
- 现状：同 target 的跨组织内容冲突会 fail closed，但不同 target 的同义、包含或矛盾 Memory 尚不能识别。
- 风险：重复注入浪费上下文；矛盾建议可能同时进入提示。
- 临时控制：同 target 覆盖规则、组织冲突隔离、人工评审和数量上限。
- 偿还路径：本地索引、内容簇、MMR、多条冲突图与显式人工裁决。

## TD-EVOL-REFLECT-001：时间顺序不是因果证明

- 严重度：高
- 当前状态：部分缓解
- 现状：Reflection 已能读取“错误/停滞 → 人工干预 → 成功”的脱敏时间线，并被要求只形成窄范围候选假设，不宣称因果成立。
- 风险：一次成功恢复可能来自 Provider 自然恢复、外部状态变化或其他未观测因素；单 Episode 立即晋升会形成错误经验。
- 临时控制：单 Episode 只生成 `PracticeDraft`，不直接加载；Dream 至少需要两个独立 Episode，之后仍需评测、审批和下一 turn/session 继承证明。
- 偿还路径：增加干预前后 effect window、同类失败 control、反事实/混杂因素标注，并把因果置信度作为 Dream 与晋升门禁。

## TD-EVOL-REFLECT-002：历史低质量草稿治理

- 严重度：中
- 当前状态：开放
- 现状：新 Reflection 已避免在成功恢复场景中为每个瞬时错误生成泛化草稿，并对同类归因去重；升级前已经写入 ledger 的重复或泛化草稿仍会保留。
- 风险：历史草稿可能污染 Dream 聚类和管理界面。
- 偿还路径：增加可审计的 draft rejection/supersession、同义聚类与迁移工具；不得直接重写 append-only ledger。
