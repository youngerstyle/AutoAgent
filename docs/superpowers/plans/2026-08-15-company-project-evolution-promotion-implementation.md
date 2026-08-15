# Agent/Project/Company Evolution Promotion 实施计划

依据：`docs/superpowers/specs/2026-08-15-company-project-evolution-promotion-v1.md`

状态：Planned

## 开工评审结论（2026-08-15）

### 已有能力直接复用

- 全局 `AgentProfile/profileId` 已是人才中心的长期 Agent 身份；`WorkspaceAgent` 已是项目实例。
- Ticket/Mission、Evidence Ledger、Agent Thread/Trace、telemetry 已保存权威事实，不建立平行业务事实库。
- `ExperienceReconciler`、`ExperienceStore` 和 projector 已完成终态 Episode 的幂等提取与秘密脱敏。
- Extraction/Evaluation job 已有 lease、retry、dead-letter 和 coordinator 恢复路径。
- Release registry、runtime projection、activation proof、canary telemetry 与 rollback 继续作为后续生命周期底座。

### 首个开发切片

```text
WorkspaceAgent(profileId)
        |
terminal Ticket + Goal + Evidence
        |
ExperienceReconciler
        v
Episode(profileId snapshot)
        |
durable trigger ingestion
        v
EvolutionSignal queue
```

1. 新 Episode 必须快照稳定 `profileId`；即使项目实例后来被移除，历史个人归属仍可追溯。
2. 从现有权威来源派生确定性、幂等的 EvolutionSignal，不修改业务提交路径。
3. 用有界 batch、lease/retry/dead-letter 和优先级验证 worker 可恢复性。
4. 先接入 terminal outcome、human correction/recovered failure 的信号；Dream、Practice 和 scope promotion 在同一目标的后续切片推进。

复杂度约束：首个切片不超过两个新服务、八个代码/测试文件；若需要突破，必须先证明不能复用现有 Experience/Job 基础设施。

### 测试数据流

```text
same profileId in workspace A/B ----> agent-level owner is identical
different workspaceAgentId --------> instance-level evidence remains distinct
removed WorkspaceAgent ------------> Episode still retains profileId
worker restart + same source ------> one deterministic EvolutionSignal
crash after claim -----------------> expired lease is reclaimed
P0 regression + P3 ordinary -------> P0 is consumed first
one stage failure -----------------> other independent stages continue
release created mid-turn ----------> current snapshot unchanged; next boundary reloads
```

### 生产失败模式与要求

- 历史实例被删除导致 identity lookup 失败：Episode 在提取时快照 profileId，并有回归测试。
- 重启后重复扫描导致重复学习：signal ID 来自 source ref + trigger + scope，store 强制幂等冲突检查。
- worker 在 claim 后崩溃：lease 到期可被其他 worker 恢复，重试耗尽进入 dead-letter 并可见。
- 普通历史增长导致全量扫描退化：ingestor 使用耐久 cursor 和有界 batch，不以每轮全表扫描作为最终实现。
- consolidation 失败阻断 rollback：不同 stage 独立排队；P0 rollback 不经过 Dream。
- 后台结果热修改运行中任务：Runtime 继续按 turn/task/session 冻结 snapshot，并用后续 inheritance proof 验证。

### 首个切片不在范围

- `AgentArchetype` 岗位模板：当前 AgentProfile 已满足稳定个人身份，模板不是 Evol 前置条件。
- Company promotion UI：先证明数据、队列与继承语义，避免 UI 伪装完成。
- GitHub/GitLab、CI、Kubernetes、源码交付：不属于本地 Agent/Project/Company Evol。
- 重写 Ticket/Mission 存储：现有账本是权威来源，只做增量读取。
- 多公司之间共享 Practice：违反私有部署隔离边界。

## Milestone A：公司与 Agent 身份

- [ ] 在 `AUTOAGENT_HOME` 持久化稳定 `companyId`。
- [ ] 明确复用现有全局 `AgentProfile/profileId` 作为稳定个人 Agent 身份，不建立第二套 identity store。
- [ ] 保持现有 `WorkspaceAgent.profileId` 引用，并迁移/校验历史实例映射。
- [ ] 证明同一 `profileId` 的多个 Workspace instances 共享 agent-level release，但不共享各自的 agent-project release。
- [ ] 建立 Company Practice/Release/Promotion ledger。
- [ ] 建立 Agent long-term Practice/Release ledger。
- [ ] 保留 Workspace Episode 与项目 Release store。
- [ ] 证明两个私有部署之间完全隔离，同一公司多个 Workspace 可被公司控制面发现。

## Milestone B：Evol 触发与调度

- [ ] 定义耐久 `EvolutionSignal`、ReflectionJob、ConsolidationJob 及幂等 command key。
- [ ] 复用 Ticket/Mission、Evidence Ledger、Agent Thread/Trace、telemetry 的现有耐久事实，不在业务提交路径双写 Evol。
- [ ] 实现带耐久 cursor 的 ingestor，从终态、用户纠正、recovered failure、Practice feedback、context compaction 和 effect observation 幂等派生 EvolutionSignal。
- [ ] 将当前固定轮询中混合的 extraction、consolidation、evaluation、promotion、telemetry reconciliation 拆成独立可恢复 worker。
- [ ] 实现 P0-P4 优先队列、company/workspace/agent 公平调度和资源预算。
- [ ] 支持 threshold、idle budget、可配置 maintenance window 与 manual trigger；不得把固定凌晨作为正确性依赖。
- [ ] 保证业务任务不等待 Evol，当前运行 snapshot 不被后台结果热修改。

## Milestone C：开放式 Practice

- [ ] 定义 Practice、PracticeRevision、Binding 和 provenance contracts。
- [ ] 从 Episode/Attribution 归纳开放式 hypothesis、trigger、procedure、scope 和 contraindications。
- [ ] 禁止无来源、单次偶然或预设模板反向归因生成 Practice。

## Milestone D：个人与项目实验

- [ ] 建立 project treatment/control assignment 与效果窗口。
- [ ] 支持 agent-project、agent、project 三类局部 active pointer 与独立 rollback。
- [ ] 将 Practice Binding 编译为 Memory/Prompt/Skill/Workflow/Plugin release。
- [ ] 在对应 next-turn/next-task/next-session 边界继承和回滚。

## Milestone E：公司推广

- [x] 支持 agent-project -> agent、agent-project -> project、agent/project -> company 的显式 Promotion Proposal，并用 active Release、Activation Proof、passing Telemetry 三类权威账本校验来源证据。
- [ ] 公司评审 generalizability、脱敏、适用范围、成本和风险。
- [ ] 在其他代表性项目运行 company trial。
- [ ] 通过跨项目效果门禁后发布 company active release。

## Milestone F：分层解析与管理面

- [ ] 实现 built-in < company < agent < project < agent-project < invocation safety 的行为解析顺序。
- [ ] 强制 policy 使用逐层取交集语义，任何下层资产不能放宽上层约束。
- [ ] 新项目自动继承公司默认；现有项目按生命周期边界重载。
- [ ] 项目 pin/override 与公司 rollback 相互独立。
- [ ] UI 展示完整实践发现、Agent/项目效果、scope 晋升、公司评审、trial、active 与 rollback lineage。

退出标准：主规范第 12 节十五条完成定义全部有真实多 Agent、多 Workspace 与双私有实例端到端证据。
