# Evol 发布闭环实施计划

日期：2026-08-19  
依据：`../specs/2026-08-19-five-framework-and-evolution-release-closure.md`

## 当前事实

- 已有 Episode -> PracticeDraft -> Practice -> Binding -> Candidate。
- 已有 Candidate validation、EvalSuite、EvaluationJob、Promotion、Release、Canary telemetry、rollback、next-boundary projection 和 inheritance proof。
- 已有真实 Provider reflector 和 Plugin authoring。
- Workflow Candidate 已能在后续独立 holdout Episode 出现后自动形成 suite，并通过平台正常的 RuntimeHost/Mission 路径运行 paired trial；真实 Provider 仍是该任务的执行 Provider。
- `AUTOAGENT_EVOLUTION_EVALUATOR_PROGRAM` 只保留为可选适配器，不再是默认产品链的隐藏前置条件。
- 真实项目的 Production inheritance、冷重启恢复与 rollback boundary 已于 2026-08-19 使用用户现有 Provider 完成；结论来自真实 Mission/Ticket/Agent/QA 运行与持久化账本，不只来自机制测试。
- 2026-08-19 的真实 Provider 验收已发现并修复：权威 trial input 不应只限 Evidence Ledger、并发 Staffing context 必须冻结、OpenAI-compatible Provider 应关闭不普适的 24h cache retention 扩展、基础设施失败必须支持新 generation 重派。
- 真实验收还证明 paired qualification Episode 会污染 Dream，且并发 challenger 会争抢执行容量；现已增加 qualification 流量排除和 `kind + target + scope` 单一在途 challenger 门禁。
- 真实验收发现 Provider 生成的自然语言指标无法由 metric gate 测量；现已建立固定指标注册表、创建前 fail-fast、成本类指标安全方向校验，以及候选不可放宽的资产生命周期资源/延迟预算。旧 Candidate/Trial 保留审计，新指标必须形成 immutable Candidate revision。
- 重启验收发现终态 Paired Trial 的 Runtime task 会从仍 active 的 Mission/Plan 复活；现已增加 trial-owner 对账、Runtime task 终态权威规则、终态上下文冷恢复和 scheduler 终态短路。旧污染任务在重启后保持 cancelled，工作集峰值显著下降。
- Windows 真实并发验收发现多个 StaffingRequestStore 实例会在读改写之间丢失串行性并触发原子 rename `EPERM`；现已统一到 path-scoped `updateJson` 临界区并延长可恢复 rename 重试，失败 generation 保留审计并由 paired trial transient retry 生成新一代任务。
- Candidate revision 5 已证明 frozen Workflow 能改变真实 DAG，但其“多个角色独立确认”程序超出单一 PM Ticket 的授权，Agent 正确拒绝伪造证据。revision 6 已改用平台原生 handoff 且未伪造确认，但真实最终验收进一步证明：只有嵌套 handoff 描述、没有绑定当前 Goal/attempt 的 Evidence Ledger 引用，仍不能形成 criterion-level assurance。revision 7 因而要求一次最小只读平台观察并把 evidenceId 写入正式完成提案。
- 新 EvalSuite 曾触发已有 fail Evaluation 的历史 Candidate 自动重评并争抢资源；现已要求自动 evaluation planner 跳过已有 Evaluation 的 Candidate，以及所有 paired trials 均已终态失败/不确定且未显式重评的 Candidate。新版 suite 不再复活已解决 challenger。
- 真实试验还补齐两个运行边界：连续三次 Mission 合同拒绝会进入可恢复的 agent stall，避免“内容略变但语义同错”的无限 Provider 循环；trial 中 blocked/completed/failed/cancelled Plan 可直接形成终态观察，不等待普通用户任务才需要的人工恢复。
- Binding compiler 升级采用新的不可变 binding/candidate revision；历史上不符合现行指标/资产合同的 poison Practice 只隔离自身，不能中断同 workspace 后续有效 Practice 的编译。
- revision 7 的真实目标任务发现 evaluation objective 曾把历史人工干预原文再次当作当前验收合同；这会要求 Agent 完成平台没有授权接口的逐角色确认，并把正确的 fail-closed 行为误判为候选失败。目标组现只执行冻结 assertions，历史事实仅以 source ref 解释样本来源；回归/安全组仍重放原任务，避免为了让 Candidate 通过而削弱回归门禁。
- EvalSuite v4 复验确认目标合同隔离生效：baseline 因无法产出候选专属 handoff 而阻塞，candidate 的 Practice Ticket 独立完成并留下当前 Goal evidenceId。复验同时发现两项 harness 偏差：回归 source 的完整 Ticket 序列化可能在 24k 字符处截断 assertions；target outcome 又被无关的下游通用 planning 完成状态绑架。现已改为可解析的有界“正式基线 + 定义 + 摘要”回放，并让 target 只以候选绑定、权威 Practice handoff 和冻结 assertion 命中判定，regression/safety 仍要求整个任务完成。
- EvalSuite v5 证明有界回放合同生效，并暴露 Plan/Staffing 的职责倒置：Plan Compiler 曾要求当前 team snapshot 已有 implementation/verification/acceptance 人员，否则拒绝形成 DAG；并发 arm 因人员正忙而出现假失败。现改为已有合适成员时冻结 principal/tools，没有成员时只声明 requiredCapabilities，由 Mission Control 的 StaffingRequest 正常复用或招聘。这不增加第五框架，Organization & Talent 仍是 Mission Control 的供给适配器。
- EvalSuite v6 的六个真实 Provider arm 全部形成终态，回归/安全 baseline 与 candidate 均成功，candidate 的 token proxy 资源成本和延迟均优于 baseline；正式 gate 仍 fail-closed，因为 Practice 的平台 evidenceId 使用了评估器未识别的合法 handoff 布局。评估器现同时验证顶层和 concrete result 内的 `authoritativeEvidence[{ evidenceId }]`，grader 升级为 v2，旧 Evaluation `eval_c241421c81c448ff` 保留不可变审计。
- 发布门禁已按职责分层：paired trial 证明冻结候选在历史目标和 sealed holdout 上有收益；后续 Canary 只验证真实流量中的安全、质量/成功率非回退及资源/延迟预算，不要求五对小样本再次达到离线 minimumDelta。否则会把同质量安全 rollout 误判为无效，同时混淆 efficacy 与 rollout guardrail。
- Paired trial 文件面已完成物理隔离：每个 generation 从同一冻结 snapshot 派生六个独立 arm root；Runtime/Mission/Ticket/Agent/Staffing/Evidence 状态不再写入原项目或另一 arm。终态先汇聚每个 arm 的完整 Evidence Ledger 和 generation manifest/hash，再释放 host 并清理副本；重启从 dispatch 账本中的 arm root 恢复。
- 招聘不提升为第五运行框架：Organization & Talent 保持业务域，`StaffingRequest` 是 Mission Control 的供给/恢复协议；本期不扩招聘实现。

## 实施顺序

### Phase 0：纠正完成口径与可观测性

- [x] 完成审计区分“机制测试覆盖”和“真实生命周期已闭合”。
- [x] Worker status 暴露 candidate/evaluation/release 阶段阻塞原因，而不是只给 `evaluatorConfigured`。
- [x] UI 显示 validated 之后为什么没有进入 trial。

### Phase 1：评估工作端口与平台适配器

- [x] 在 Evol 内核定义 `EvolutionTrialPort`，只认识冻结试验请求与结果，不导入 Agent/Ticket/Mission 实现。
- [x] 增加 workspace-scoped paired trial 幂等账本、恢复状态与只读 API；适配器缺失时保持 pending，不伪造结果。
- [x] 在 `evolution-adapters` 实现平台适配器，把 baseline/candidate 两个受控任务交给现有 RuntimeHost/Mission Control。
- [x] 试验请求固定 Candidate hash、baseline release、runtime/policy snapshot 和输入 Evidence refs；资源门禁在有价格时使用实际 cost，否则使用实测 token proxy。
- [x] Provider 故障进入可恢复 job，不写假的失败/通过结果。

### Phase 2：Practice 自动评估计划

- [ ] 为 Practice-derived Memory/Prompt/Skill/Workflow 生成版本化 EvaluationPlan（Workflow 已完成；Memory/Prompt/Skill 待接各自 trial override）。
- [x] historical evidence 只用于构造任务；sealed holdout 必须来自未参与 Candidate 归纳的后续 Episode。
- [x] 静态 qualification 与真实 comparative trial 分账。
- [ ] executable Plugin/Harness 继续使用独立受控 evaluator adapter 和人工批准。

### Phase 3：项目内 Canary 与 Production

- [x] 真实 paired trial 通过后，按 Company policy 决定自动/人工进入 Canary；高风险 Workflow 由 human release governor 批准。
- [x] Canary assignment 写入下一任务冻结 snapshot；selected 加载候选 Workflow，对照组继续使用 Production/builtin 基线。
- [x] 自动收集最少样本、质量、成功率、成本、安全与人工干预指标；Workflow assignment 由任务 snapshot + Mission Goal 事实投影并可反向验证，不接受自报。
- [x] pass -> Production；fail -> rollback；inconclusive -> 延长或停止，不猜测。

Paired target case 的收益判定也已收紧：baseline/candidate 都到达 `completed` 不等于 Candidate 有效。候选必须证明冻结 Candidate hash 被加载、学习步骤成为真实 Ticket、对应 Ticket 已完成且覆盖 suite assertion；regression/safety case 继续使用独立任务终态与违规事实。

### Phase 4：真实项目验收

- [x] 用用户现有 Provider 和平台服务跑 A/B/C/D：paired baseline/candidate、Canary selected/control、Production inheritance 和 rollback boundary。
- [x] 重启服务后验证 jobs、pointer、snapshot 与 proof 可恢复。
- [x] 运行 focused tests、full tests、build 和真实 acceptance。

当前验收账本（进行中）：

- [x] Provider status 使用用户现有 OpenAI 配置，未替换为 mock；
- [x] paired baseline/candidate 经 RuntimeHost -> Staffing -> Mission -> Ticket -> Agent Loop 真执行；
- [x] Candidate task 冻结 `stage=trial` Workflow snapshot，Baseline 未加载候选；
- [x] Provider 可选缓存参数自动降级，Staffing 六任务重启恢复后完成；
- [x] 终态 Trial task 重启不复活；终态历史保持冷加载且 scheduler 不重开 Mission；
- [x] Staffing 跨实例并发写入使用共享原子 update，失败 generation 可自动 transient retry；
- [x] qualification Episode 不再进入 Experience/Dream；污染候选保留失败审计但取消其试验任务；
- [x] focused tests、116 files / 822 tests full suite、typecheck、production build 通过；
- [x] EvalSuite v2 对 revision 5 形成正式 fail Evaluation `eval_922196a8fdc4479c`；失败原因是跨角色确认超出单一 Ticket 授权，未误晋升；
- [x] 平台原生 revision 6 `evo_a27181e7b91b4a9b` 使用 EvalSuite v3 完成 paired trial 和正式 fail Evaluation `eval_61e62e1299304a1a`：回归/安全组全部成功，目标组因 Practice handoff 未绑定 criterion-level Evidence 而未提升，且资源成本门禁正确拒绝；
- [x] revision 7 `evo_54e8a29410844147` 已由 compiler 自动形成并通过结构验证；它要求 Practice Ticket 以当前 Goal/attempt 的只读平台 evidenceId 锚定权威 handoff；
- [x] revision 7 已在 target/regression/safety 三个 candidate Mission 中独立产出带 criterion-level evidenceId 的 `evolution-practice-result-v1`；同时暴露并修正 target objective 的历史合同污染，当前 Trial 继续保留为升级前真实审计，不重写结果；
- [x] EvalSuite v4 的目标 baseline/candidate 使用相同的隔离后 objective 真执行；Candidate Practice 成功而 baseline fail-closed。v4 的回归/安全 arm 因旧 24k 截断风险被正常停止，旧 Trial 保留审计；v5 使用有界合法 JSON 回放重新验收；
- [x] EvalSuite v5 确认回放 JSON 与 assertions 完整，并以真实并发任务发现 Plan Compiler 把能力空缺误判为规划失败；修复已通过 Plan/Mission/Staffing 38 项测试，v5 保留为旧职责边界审计；
- [x] EvalSuite v6 / paired trial `paired_trial_04198bf77fa85e17faa4b0dadec97670` 完成全部六臂真实执行并生成 `eval_c241421c81c448ff`；它验证 Staffing 修复、重启恢复、回归/安全成功和资源改善，同时发现 Practice evidence Schema seam，旧 fail 不改写；
- [x] grader-v2 paired trial `paired_trial_13ca40cb05b04d6a9b2e94a0f89b0a8a` 完成但保留 fail 审计：它暴露了 evaluator 合法 evidence 布局与 target 文本匹配偏差，没有被改写为通过；
- [x] grader-v3 paired trial `paired_trial_e34ad74241e94e2f2ad291e5cf908c91` 形成正式 pass Evaluation `eval_a6864db9dc444a72`：target baseline=false/candidate=true，回归与安全组均通过，质量与成功率 +0.3333，资源与延迟均在 Workflow 预算内；
- [x] Shadow `promotion_badb6527a6424d01` 后由 human release governor 批准 25% Canary `promotion_b4111640fc3d4255`；真实对照任务 `task_43b97579d70a4297` 冻结 builtin/selected=false，实验任务 `task_ef60562f7c9848e7` 冻结 evolution/selected=true，二者均经独立 QA 完成；
- [x] 5 对独立 Agent Episode 形成 passing telemetry `telemetry_622a5e4192de4da2`：成功率、质量、证据完整度均 1.0，token proxy delta +0.043834，平均延迟 delta -2101.8ms，无工具、策略或安全违规；
- [x] human release governor 批准 Production `promotion_8778f32d828a465c` / `release_debe5ddbe6f8cc19805c37a21ec9d02b`；冷重启后的新任务 `task_890419debb6c41f7` 冻结 `stage=production` 并完成实践宣讲、规划、实现、独立 QA 与最终验收；
- [x] Production 完成真实继承验收后执行 rollback rehearsal，指针 generation 1 -> 2、`active=false`、发布状态 `rolled_back`；再次冷重启后的 `task_fedea61c2aa34639` 恢复 builtin Workflow 并完成，证明回滚只影响下一边界且不破坏原主链。验收 workspace 故意停留在安全 baseline，不把演练 Release 留作生产默认。

## 架构约束

```text
src/server/evolution/*
  -> contracts + Evol ports + Evol stores
  -X-> providers / runtime / tickets / mission-process / staffing

src/server/evolution-adapters/*
  -> implements Evol ports using platform frameworks
```

架构测试必须继续禁止 Evol 内核导入 Agent Loop、Ticket Engine、Mission Control 和 Organization & Talent。

## 测试计划

| 层级 | 必须证明 |
|---|---|
| Unit | trial state machine、hash/snapshot 不变性、重试和幂等 |
| Contract | EvolTrialPort 不泄漏平台类型；适配器拒绝 scope/company 不匹配 |
| Integration | paired missions 产生可验证 Evidence 和 EvaluationRun |
| Runtime | Canary 只在后续 task/turn/session 边界加载 |
| Recovery | 服务重启后 pending/running trial 可恢复，重复 pass 不重复发任务 |
| Acceptance | 真实 Provider 的 A/B/C/D 项目链，能观察改进或安全失败 |

## 本期不做

- Organization & Talent 的领域迁移与 UI；
- 公司级自动批准；
- AutoAgent 源码自修改或自动部署；
- 用 embeddings/BM25 改造 Memory Retrieval（继续由 backlog 单独推进）；
- 让 Plugin 绕过人工批准。

## 第一提交切片

第一提交先完成 Phase 0，并建立 `EvolutionTrialPort`、持久化 Trial job/state 和架构测试；不在没有真实执行证据时伪造 EvaluationRun。第二提交接平台适配器和 paired task 执行，第三提交闭合 Canary/Production 与真实验收。
