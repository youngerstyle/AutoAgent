# Agent / Project / Company Evolution 完成审计

日期：2026-08-15  
权威规范：`2026-08-15-company-project-evolution-promotion-v1.md`  
实现计划：`../plans/2026-08-15-company-project-evolution-promotion-implementation.md`

> 2026-08-19 复核结论：本文件证明的是各机制和隔离规则已有自动化覆盖，不能再解释为“默认配置下真实项目已完成端到端进化”。真实 Provider 验收中，Practice-derived Workflow Candidate 停在 `validated`，因为没有自动 EvaluationPlan/EvalSuite，且 EvaluationJob 仍依赖额外的 `AUTOAGENT_EVOLUTION_EVALUATOR_PROGRAM`。新的完成口径和修复计划见 `2026-08-19-five-framework-and-evolution-release-closure.md` 与 `../plans/2026-08-19-evolution-release-closure-implementation.md`。在其真实验收标准完成前，Evol 状态是 **机制基本完备、默认发布链未闭合**。

本审计只把“权威事实 → 开放 Practice → Runtime Binding → 不可变 Release → 后续生命周期实际继承/测量/回滚”称为进化。生成一段文本、运行一次脚本、修改当前 turn，均不计为完成。

| # | 完成定义 | 实现与自动化证据 |
|---|---|---|
| 1 | 稳定 company identity 与私有部署隔离 | `company-identity-store.test.ts`；`evolution-shared-release.test.ts` 的双 home/company 隔离与新项目默认值用例。 |
| 2 | AgentProfile 是个人，WorkspaceAgent 是项目实例 | `workspace-agent-profile-migration.test.ts`；`evolution-shared-release.test.ts` 证明相同 profile 跨 Workspace 继承 Agent 层、其他 profile 不继承。 |
| 3 | 开放式 Practice | `evolution-reflection.test.ts` 证明真实 Provider reflector 可从成功 Episode 归纳任意 procedure；证据不足返回空，不选预设规则。 |
| 4 | Practice、Revision、Binding 分离且不可变 | `evolution-dream.test.ts` 证明同一 practiceId 从 v1 产生带 previousRevision 的 v2；`evolution-practice-binding.test.ts` 证明 Binding 独立引用版本化 Practice/Candidate。 |
| 5 | agent-project / agent / project 继承、测量、回滚 | `evolution-evaluation.test.ts`、`evolution-activation.test.ts`、`evolution-shared-release.test.ts`、`evolution-scope-promotion-compiler.test.ts`。 |
| 6 | 扩 scope 只能新建 Proposal | `evolution-scope-promotion.test.ts` 拒绝非法扩张；共享发布复制 artifact/Practice，不改写源 Release。 |
| 7 | 实际效果后才可进入公司评审 | `evolution-scope-promotion-evidence.test.ts` 校验 active production Release、真实 inheritance proof 与 passing telemetry，拒绝伪造引用。 |
| 8 | 公司 trial 使用其他 Agent/项目及 selected/control | `evolution-company-trial.test.ts` 使用另一个 Workspace/profile，自动收集至少 5+5 样本并关闭 trial pointer。 |
| 9 | Company 默认与个人/项目 override | `evolution-workflow-layering.test.ts`、`evolution-runtime-config-layering.test.ts`、`evolution-scope-resolution.test.ts`、`evolution-shared-release.test.ts`。 |
| 10 | 四层 rollback 独立并产生后续 proof | `evolution-activation.test.ts` 与 `evolution-shared-release.test.ts` 证明本地和共享层 rollback/restoration ledger；运行时只观察所属层。 |
| 11 | Policy 只能收窄 | `evolution-agent-profile-governance.test.ts` 证明布尔权限 AND、工具/命令 allowlist 交集，不能借 Evol 放宽。 |
| 12 | UI 完整 provenance | Evolution 管理面展示 Workspace/profile/Episode、Practice revision/Binding、效果 refs、Promotion、五项公司评审、Trial、共享/本地 activation/proof/rollback 与 phase jobs。生产构建验证类型与渲染路径。 |
| 13 | 非阻塞捕获与独立可恢复阶段 | `evolution-extraction-jobs.test.ts`、`evolution-phase-jobs.test.ts`、`evolution-evaluation-jobs.test.ts`；Signal、ReflectionJob、ConsolidationJob 分账并各自 lease/retry/dead-letter。 |
| 14 | 混合时机而非固定凌晨 | `evolution-coordinator.test.ts` 与 `evolution-signals.test.ts` 证明 P0-P4、高显著性快速反思、threshold、真实 Runtime idle、可配置 UTC maintenance window、manual trigger 和公平预算。 |
| 15 | 冻结 snapshot 与 next boundary（机制覆盖） | `evolution-runtime-projection.test.ts`、`evolution-plugin-runtime.test.ts`、`evolution-workflow-layering.test.ts`、`evolution-runtime-config-layering.test.ts` 分别覆盖 next-turn、next-session、next-task、next-restart；尚不能替代默认配置下从真实 Practice 自动到达 Release 的验收。 |

## 关键边界

- Provider 始终是正常运行依赖；Evol 不替代 Provider。未配置真实 Provider 时，开放成功经验反思和 Plugin authoring 保持 pending/无产物，绝不伪造结果。
- GitHub、CI、Kubernetes、源码自修改都不是本地 Evol 的前置条件。
- Company、Agent、Project、agent-project 数据都只存在当前私有部署的 home/workspace；公司晋升不会影响另一私有部署。
- Local Plugin 只在 scanner、评测、人工批准后于 next-session 加载；生成代码本身不等于进化完成。
