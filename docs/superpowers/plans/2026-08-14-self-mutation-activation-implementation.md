# Evol Self-Mutation 与 Activation 实施计划

依据：`docs/superpowers/specs/2026-08-14-self-mutation-activation-v1.md`

状态：In progress

## 2026-08-14 实施进度

- [x] MutationSet、ActivationBoundary、ActivationRecord、InheritanceProof 与 append-only ledger；
- [x] Promotion 与 Activation 分离，UI/API 不再把晋升显示成已生效；
- [x] Memory/Prompt/Skill 的 next-turn 投影与证明；
- [x] Agent Profile 的 next-session 投影、provider/model/policy 权威校验与证明；
- [x] Workflow 的 next-task 持久快照、证明与回滚边界；
- [x] Runtime Config 的受限 schema、启动快照冻结与 next-restart 证明；
- [x] 平台无关 SCM/Build/Deployment Provider contracts；
- [x] Source Patch 的 base commit、required checks、review、merge、build、canary、production、实际 commit 证明与可恢复交付 ledger（本地真实 Git + 测试 Provider）；
- [x] 回滚创建新的 restoration generation，后续运行需再次证明恢复版本，而不是把历史 Release 直接改回 active；
- [x] 明确归因的重复 Prompt/Skill Episode 自动形成最小 Candidate，未知归因不变异资产；
- [x] Prompt 从真实终态 Episode 形成 Candidate，经独立评测与人类批准，由后续 Pi turn 继承，并被真实 cohort telemetry 回滚；
- [x] Evol 管理页区分 requested、pointer changed、activated、health 与 rolled back，并展示 actual runtime proof；
- [ ] 接入生产 SCM/CI/CD adapter 并完成真实托管环境部署演练；
- [ ] 补齐 Workflow/Source Patch 的主动升级策略，并证明只有低风险资产不足时才升级；
- [x] 完成全量回归、生产构建与文档一致性审计（94 files / 712 tests）。

实现口径：Evol 主链是“版本化变更 -> 生命周期边界切换 -> 后续运行继承 -> 效果衡量/恢复”。本地 Git、测试命令或未来托管 runner 只是 Source Patch Provider 的实现，不是 Evol 本身；WSL、PowerShell 和 sandbox 均不进入核心状态机。

## Milestone E：统一 Mutation 与 Activation Contract

1. 扩展 artifact kind：`agent_profile`、`prompt`、`workflow`、`runtime_config`、`source_patch`。
2. 引入 `MutationSet`、`ActivationBoundary`、`ActivationRecord`、`InheritanceProof`。
3. 把 Promotion 与 Activation 分离；pointer changed 不再等同 runtime active。
4. UI/API 区分 approved、waiting_for_activation、activated、degraded 与 rolled_back。

退出标准：没有 inheritance proof 的 release 不能显示“已生效”。

## Milestone F：Turn/Session/Task Inheritance

1. Memory/Prompt/Skill generation 在 next turn 重建 projection。
2. Agent Profile generation 在 next session 重建 Runtime Agent。
3. Workflow revision 在 TaskRun 创建时冻结，已有任务不热更新。
4. Trace 持久记录所有实际继承的 release refs 和 snapshot hash。
5. Rollback 使用相同边界恢复 previous release。
6. 恢复动作创建新的 `rollback_restore` generation，必须由新的后续运行留下恢复 proof。

退出标准：三种边界均有端到端激活、继承证明和回滚测试。

## Milestone G：Source Patch Delivery Pipeline

1. 建立平台无关 `ScmProvider`、`BuildProvider`、`DeploymentProvider` contracts。
2. Source Patch Candidate 绑定 base commit、path scope、unified diff 和 rollback deployment。
3. 本地 adapter 在独立 worktree/branch 应用 patch并运行 checks，不修改当前服务 checkout。
4. checks/review/merge/build/deploy attestation 独立持久化，proposer 无权伪造。
5. Runtime boot report source commit/deployment id；匹配后生成 inheritance proof。

退出标准：Source Patch 从 Candidate 到新部署继承可完整追踪；任一 gate 失败不改变 active deployment。

## Milestone H：主动选择与效果闭环

1. Coordinator 根据 Attribution 选择最小可变资产。
2. 先尝试 Memory/Prompt/Skill，再升级到 Agent Profile/Workflow/Source Patch。
3. 激活后按 cohort 聚合后续 Episode/Telemetry。
4. 形成 retain/refine/stale/rollback 决策，并防止重复学习同一失败。
5. Evol 管理页展示 mutation lineage、activation boundary、inheritance proof 和效果窗口。

退出标准：至少一个非 Memory 资产从真实 Episode 自动形成候选，经人类批准后被后续运行继承，并能依据真实效果回滚。Prompt 已满足该链路；Milestone H 仍需完成 Workflow/Source Patch 的证据化升级策略。

## 明确不在本计划主线

- WSL/PowerShell/bubblewrap Launcher；
- Plugin/Harness invocation protocol；
- 模型权重训练；
- Agent 自动批准自身源码；
- 在当前运行进程中热替换源码模块。

这些能力可以作为独立 adapter 或后续项目存在，但不能替代 Self-Mutation 与 Activation 的完成标准。
