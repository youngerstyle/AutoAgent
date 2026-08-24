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

## TD-EVOL-EVAL-003：Provider 价格不可用时缺少 USD 成本事实

- 严重度：中
- 当前状态：部分缓解
- 现状：Provider trace 始终记录 token usage，但本地/自定义模型通常没有可验证的 USD 单价，不能把 `costUsd: 0` 冒充实测成本。
- 当前策略：显式声明 `cost_usd` 的 Candidate 继续 fail closed；默认不可绕过的 `resource_cost` 门禁在双方都有实测 USD 时比较 USD，否则比较归一化的实测 token 数。
- 偿还路径：在 Provider 配置增加版本化 pricing snapshot；EvaluationRun 写明本次 resource gate 的计量单位与价格版本。

## TD-EVOL-METRIC-002：资源门禁仍使用绝对预算

- 严重度：中
- 当前状态：受控
- 现状：指标注册表已经禁止不可测的自由文本指标；资源和延迟门禁按资产生命周期使用平台上限，Candidate 只能收紧、不能放宽。但不同 Provider、模型和任务规模的绝对 token/毫秒差异较大。
- 偿还路径：引入版本化 MetricPolicy，支持相对基线比例、样本方差、置信区间和最小可检测效果；EvaluationRun/Telemetry 固化 policy version。迁移前不允许 LLM 或 Candidate 自行生成预算。

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

## TD-EVOL-RUNTIME-001：并行 Trial 的活跃上下文内存成本

- 严重度：高
- 当前状态：部分缓解
- 现状：终态 Runtime task 已改为启动时冷恢复，避免历史 Trial 全量 compose；但一个三 case 的 paired trial 仍会同时持有六个活跃 Mission/Agent 上下文，真实验收工作集约 1.5–2.5GB。
- 风险：更大 EvalSuite 或多个 workspace 同时试验可能触及 Node heap 上限；内存压力会被误归因成候选质量或 Provider 故障。
- 临时控制：全局 execution concurrency、单 scoped target challenger、终态 task 冷恢复、真实验收监测 working set。
- 偿还路径：将 paired case 改为有界 cohort/分批 dispatch；非运行 task 只保留轻量索引，AgentStore/trace 按 turn 懒加载；增加 trial 级内存/时间预算与可审计 cancellation port。

## TD-EVOL-TRIAL-001：Paired case 顺序观察存在队头阻塞

- 严重度：中
- 当前状态：已偿还
- 现状：Trial adapter 按 case 顺序观察；前一 case 仍 running 时，会延迟发现后一 case 已确定的 infrastructure failure。
- 风险：已无效 generation 继续消耗 Provider 与运行资源，transient retry 变慢。
- 临时控制：运维可通过正常 stop 接口终止该 generation 剩余任务，runner 随后保留审计并重派。
- 已偿还：每轮并行观察全部 case，任一后续 case 的基础设施失败可优先于前序 running case 短路并触发 generation retry。
- 剩余：generation-scoped cancel 尚未实现，失败代际中的其他运行任务只能由终态对账或正常 stop 收敛，计入 `TD-EVOL-RUNTIME-001`。

## TD-EVOL-TRIAL-002：相同 Suite 的 baseline arm 尚未跨 Candidate revision 复用

- 严重度：中
- 当前状态：开放
- 现状：同一 EvalSuite、baseline release、policy/runtime snapshot 和冻结输入在 Candidate revision 变化后会重新执行 baseline Mission；revision 6 到 revision 7 的真实验收因此再次派发三条 baseline 任务。
- 风险：重复消耗 Provider token、时间和内存，延长自进化反馈周期；若 workspace 外部事实发生变化，表面相同的 baseline 还可能不再可比。
- 临时控制：每个 EvaluationRun 固化 baseline、suite、runtime/policy snapshot 与输入 refs；没有完全相同的不可变键时禁止复用。
- 偿还路径：增加带有效期和 workspace-artifact snapshot hash 的 baseline observation cache；复用必须写明来源 Evaluation/Trial 与时间窗，任何输入、Provider/model、policy、runtime 或工作区事实变化均强制重跑。

## TD-EVOL-TRIAL-003：Paired arms 共用 workspace 文件面

- 严重度：最高
- 当前状态：已偿还
- 原问题：baseline/candidate 虽有独立 Runtime task、Mission、Ticket、Agent Goal 和 workflow snapshot，却曾在同一 workspace 根目录读写，同名交付文件可能互相污染。
- 已偿还：PlatformTrialAdapter 在每个 generation 开始时先形成一份冻结项目 snapshot，再为每个 case/arm 建立不同 physical execution root。RuntimeHost、Mission、Ticket、Agent、Staffing 与 Evidence 状态全部写入各自 arm；逻辑 workspaceId、Provider/policy snapshot 和 Candidate/Release 来源仍绑定原项目。`.git` barrier 阻止 trial Git 命令向上发现并修改真实仓库。
- 恢复与收口：dispatch 账本持久化 isolationId、execution root 与 snapshot hash；进程重启后从对应 arm root hydrate，同一 task 不重复创建。终态先把每个 arm 的完整 Evidence Ledger（不只评分器直接引用的记录）导入原项目 Evidence Ledger，并保存 generation manifest/hash，再停止隔离 host、删除执行副本；重复 observe 返回持久化结果并幂等重试清理。
- 有意排除：`.autoagent`、`.git`、`node_modules` 与 `dist` 不进入项目 snapshot；前两者避免控制面/仓库身份泄漏，后两者是可再生依赖和构建产物。试验代码不得把这些派生目录当作项目交付事实。

## TD-EVOL-TRIAL-004：Target objective 混入历史请求合同

- 严重度：高
- 当前状态：已偿还并通过真实复验
- 现状：早期 PlatformTrialAdapter 把完整历史 source 与当前 suite assertions 一并放入 target Mission objective。真实 revision 7 试验中，需求接收 Agent 因而把历史上“必须逐角色确认”的不可执行要求重新提升为当前 Mission 合同；Candidate 正确不伪造确认，却无法完成整个 target task。
- 风险：评估的被测对象从“候选 Practice 是否满足冻结断言”漂移成“能否重做历史请求的全部要求”，产生假阴性，也可能诱导 Candidate 针对历史文本过拟合。
- 已偿还：target objective 只包含冻结 assertions 与不可执行的 `historicalSourceRef`，并明确历史原请求不是当前验收合同；baseline/candidate 看到完全相同的 objective。regression/safety 仍包含原始 source，以继续验证原任务成功与安全边界。
- 复验结果：grader-v3 的真实 target baseline=false/candidate=true；target intake 未恢复历史合同，候选 Practice Ticket 以当前 Goal evidenceId 和冻结 Candidate hash 形成成功。旧 Trial 保留原样作为发现该问题的审计记录。

## TD-EVOL-TRIAL-005：回放上下文截断与 target outcome 错绑

- 严重度：高
- 当前状态：已偿还，待 v5 全组复验
- 现状：非 target case 曾对 `{source, assertions}` 的完整 JSON 直接做 24k 字符截断，可能得到无效 JSON 并截掉位于末尾的 assertions。target assessment 又曾强制要求整个通用 Mission `completed`，即使候选专属 Practice 已完整满足冻结断言，也会被下游无关 planning/staffing 缺口判失败。
- 风险：回归 Agent 看不到完整评估合同；target 将 harness 的后续计划能力错误归因给候选 Practice，产生资源浪费和假阴性。
- 已偿还：Ticket source 只回放正式 baseline、Ticket definition、完成摘要和 residual risks；过大来源使用带 sourceRef 的合法 JSON excerpt，assertions 永远保留。target candidate success 只依赖冻结 Candidate binding、权威 `evolution-practice-result-v1` 执行 handoff 与 assertion 命中；baseline 仍要求自身任务完成，regression/safety 始终要求整个任务完成。
- 复验要求：v5 证明 objective 可解析、assertions 完整、target candidate=true/baseline=false，且 regression/safety 任务终态不受该放宽影响。

## TD-EVOL-TRIAL-006：Practice 权威证据存在合法布局差异

- 严重度：高
- 当前状态：已偿还并通过 grader-v3 真实复验
- 现状：真实 Provider 曾分别把 `authoritativeEvidence` 写在 `evolution-practice-result-v1` 顶层和其 concrete `result` 内；两者都携带当前 Goal 的平台 `evidenceId`，但旧评估器只识别通用 handoff evidence 或 `evidence.references`，导致真实 Practice 被误判为无证据。
- 风险：评估器对单次模型输出布局过拟合，候选能力明明执行并留下权威证据仍产生假阴性。
- 已偿还：Practice 验证同时接受 handoff evidence、显式 authoritative references、顶层或 result 内的 `authoritativeEvidence[{ evidenceId }]`；仍强制 `executed=true`、非 `not_applicable`、候选 hash 绑定和 assertion 命中。paired deterministic grader 升级为 v2，旧 Evaluation 不重写。
- 复验结果：`eval_a6864db9dc444a72` 以真实 Provider handoff 得到 target candidate success；旧 grader-v2 fail 保留审计。缺 evidenceId、伪造 acknowledgement 或未执行的 handoff 仍由单元/集成门禁 fail-closed。

## TD-EVOL-CANARY-001：离线收益与在线小流量门禁曾混用同一 minimumDelta

- 严重度：高
- 当前状态：已偿还并通过真实 Canary 复验
- 现状：Candidate 的 `expectedMetrics` 同时用于 paired evaluation 和 Canary telemetry；例如离线要求 `quality_score +0.1` 时，五对 Canary 样本即使全部成功且质量相同也会被判 fail。
- 风险：小流量方差和成功任务的质量上限使安全 rollout 无法进入 Production；同时 Canary 被错误要求重新证明离线 efficacy。
- 已偿还：paired trial 保持原始 direction/minimumDelta 证明收益；Canary 将这些收益指标投影成零容忍非回退 guardrail，继续叠加资产级资源/延迟预算，安全/策略违规仍独立 fail-closed。
- 复验结果：`telemetry_622a5e4192de4da2` 使用五对真实 selected/control Episode；质量、成功率、证据完整度均保持 1.0，资源和延迟预算通过，无安全/策略违规，并据此获准 Production。回退、违规和超预算拒绝路径继续由回归测试覆盖。

## TD-EVOL-COMPILER-001：历史无效 Practice 缺少显式 rejected/superseded 状态

- 严重度：中
- 当前状态：部分缓解
- 现状：Binding compiler 已把不符合现行 4xx 指标/资产合同的历史 Practice 隔离，避免单条 poison record 阻断整个 workspace；但该 binding 仍停留在 proposed，并会在后续周期再次被检查。
- 风险：产生重复校验成本，管理面无法清楚区分“待编译”和“因合同升级被拒绝”。
- 偿还路径：为 PracticeBinding 增加 `rejected`/`superseded` 终态、reason code、compiler version 与迁移命令；保留 append-only 审计，不重写历史 Practice。

## TD-STAFFING-STORAGE-001：Staffing 快照仍依赖 Windows 原子 rename

- 严重度：高
- 当前状态：部分缓解
- 现状：跨实例读改写已统一到进程内 path-scoped 临界区，并对 Windows `EPERM/EBUSY` 保持原子 rename 的长窗口有界重试；真实六任务并发仍观察到扫描器/索引器持有目标文件超过 12 秒。
- 风险：高并发私有化部署中，长共享锁会把正常 Staffing 派发归因为 transient infrastructure failure，造成 trial generation 重派和额外 Provider 成本。
- 临时控制：不删除目标、不做非原子原地覆盖；延长有界 rename 等待，并由 paired trial generation retry 隔离基础设施失败。
- 偿还路径：把 StaffingRequest 改为 append-only event log + 可重建 projection（或事务型本地数据库）；单条 append 不替换热点目标文件，projection compaction 使用版本化快照和校验后指针切换。

## TD-STAFFING-PLAN-001：Plan Compiler 把人员空缺误判为计划不可执行

- 严重度：高
- 当前状态：已偿还，待 EvalSuite v6 复验
- 现状：Plan Compiler 曾对 implementation、independent verification、final acceptance 和可选 architecture 都调用 `memberForCapabilities`，当前 team snapshot 缺少对应成员就直接拒绝 PlanIntent。真实 paired 并发中，同一成员被另一 arm 使用或新项目尚未招聘时，候选任务因此阻塞。
- 风险：规划阶段和供给阶段耦合；项目不能先表达需要什么能力再由 Mission Control 招聘，造成并发假失败，也会诱导把招聘错误提升成“第五运行框架”。
- 已偿还：若 snapshot 中已有匹配成员，Plan 继续冻结 principalId 与 tools；若没有，只写 requiredCapabilities，不伪造 principal。后续 Ticket ready/running 边界由现有 Mission Control -> StaffingRequest -> Organization & Talent 适配器补齐人员。
- 复验要求：全新/并发 Mission 在缺少 delivery:implement、delivery:verify 或 delivery:accept 成员时仍能生成 DAG；Staffing 随后产生可审计供给事实，且无能力成员不会越权执行。
