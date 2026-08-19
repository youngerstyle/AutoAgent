# Evol 发布闭环实施计划

日期：2026-08-19  
依据：`../specs/2026-08-19-five-framework-and-evolution-release-closure.md`

## 当前事实

- 已有 Episode -> PracticeDraft -> Practice -> Binding -> Candidate。
- 已有 Candidate validation、EvalSuite、EvaluationJob、Promotion、Release、Canary telemetry、rollback、next-boundary projection 和 inheritance proof。
- 已有真实 Provider reflector 和 Plugin authoring。
- 真实项目测试中 Workflow Candidate 停在 `validated`：没有自动 suite，没有 EvaluationRun，没有 Release，因此下一任务没有 Evol trace。
- `AUTOAGENT_EVOLUTION_EVALUATOR_PROGRAM` 当前是运行 EvaluationJob 的唯一执行路径；它不应是默认产品链的隐藏前置条件。

## 实施顺序

### Phase 0：纠正完成口径与可观测性

- [x] 完成审计区分“机制测试覆盖”和“真实生命周期已闭合”。
- [x] Worker status 暴露 candidate/evaluation/release 阶段阻塞原因，而不是只给 `evaluatorConfigured`。
- [x] UI 显示 validated 之后为什么没有进入 trial。

### Phase 1：评估工作端口与平台适配器

- [x] 在 Evol 内核定义 `EvolutionTrialPort`，只认识冻结试验请求与结果，不导入 Agent/Ticket/Mission 实现。
- [x] 增加 workspace-scoped paired trial 幂等账本、恢复状态与只读 API；适配器缺失时保持 pending，不伪造结果。
- [ ] 在 `evolution-adapters` 实现平台适配器，把 baseline/candidate 两个受控任务交给现有 RuntimeHost/Mission Control。
- [ ] 试验请求固定 Candidate hash、baseline release、runtime/policy snapshot、输入 Evidence refs 和预算。
- [ ] Provider 故障进入可恢复 job，不写假的失败/通过结果。

### Phase 2：Practice 自动评估计划

- [ ] 为 Practice-derived Memory/Prompt/Skill/Workflow 生成版本化 EvaluationPlan。
- [ ] historical evidence 只用于构造任务；sealed holdout 必须来自未参与 Candidate 归纳的任务或后续任务。
- [ ] 静态 qualification 与真实 comparative trial 分账。
- [ ] executable Plugin/Harness 继续使用独立受控 evaluator adapter 和人工批准。

### Phase 3：项目内自动 Canary 与 Production

- [ ] 真实 paired trial 通过后，按 Company policy 决定自动/人工进入 Canary。
- [ ] Canary assignment 写入下一任务冻结 snapshot；对照组继续使用基线。
- [ ] 自动收集最少样本、质量、成功率、成本、安全与人工干预指标。
- [ ] pass -> Production；fail -> rollback；inconclusive -> 延长或停止，不猜测。

### Phase 4：真实项目验收

- [ ] 用用户现有 Provider 和平台服务跑 A/B/C/D：两次学习、一次 Canary、一次 Production inheritance。
- [ ] 重启服务后验证 jobs、pointer、snapshot 与 proof 可恢复。
- [ ] 运行 focused tests、full tests、build 和真实 acceptance。

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
