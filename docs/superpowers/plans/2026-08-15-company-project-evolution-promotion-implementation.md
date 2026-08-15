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

- [x] 在 `AUTOAGENT_HOME` 持久化稳定 `companyId`。
- [x] 明确复用现有全局 `AgentProfile/profileId` 作为稳定个人 Agent 身份，不建立第二套 identity store。
- [x] 保持现有 `WorkspaceAgent.profileId` 引用；历史实例仅在角色唯一可映射时迁移，未知或重复 profile 映射拒绝启动。
- [x] 证明同一 `profileId` 的多个 Workspace instances 共享 agent-level release，但不共享各自的 agent-project release。
- [x] 建立 Company Practice/Release/Promotion ledger；共享层保存不可变 Practice 快照、Promotion provenance、Release、active pointer 与 activation ledger。
- [x] 建立 Agent long-term Practice/Release ledger；同一 profile 的共享层不依赖源 Workspace 继续存在。
- [x] 保留 Workspace Episode 与项目 Release store。
- [x] 证明两个私有部署之间完全隔离，同一公司多个 Workspace 可被公司控制面发现。

## Milestone B：Evol 触发与调度

- [x] 定义耐久 `EvolutionSignal`、ReflectionJob、ConsolidationJob 及幂等 command key；三类状态分账，Reflection/Consolidation 使用独立 lease、retry/backoff 与 dead-letter。
- [x] 复用 Ticket/Mission、Evidence Ledger、Agent Thread/Trace、telemetry 的现有耐久事实，不在业务提交路径双写 Evol。
- [x] 实现 Episode、Telemetry、Agent Thread 三类耐久 cursor，从终态、用户纠正、recovered failure、Practice feedback、context compaction 和 effect observation 幂等派生 EvolutionSignal。
- [x] 将 extraction、reflection、consolidation、evaluation、promotion、telemetry/trial reconciliation 拆为独立失败域；有任务形态的阶段使用独立耐久 job/lease，账本 reconciliation 从权威事实幂等恢复。
- [x] 实现 P0-P4 优先队列、单私有部署 company 边界、Workspace 轮转和同优先级 Agent least-recently-served 公平调度，并保留每 Workspace drain budget。
- [x] 支持 threshold、真实 Runtime idle budget、可配置 UTC maintenance window 与 manual trigger；高显著性即时进入 Reflection，普通事件延迟聚合，任何固定凌晨都不是正确性依赖。
- [x] 保证业务任务不等待 Evol，当前运行 snapshot 不被后台结果热修改。

## Milestone C：开放式 Practice

- [x] 定义 Practice、不可变 PracticeRevision、Binding 和 provenance contracts；新证据产生同一 practiceId 的下一版本，不能原地改写或借 revision 扩 scope。
- [x] 从 Episode/Attribution 归纳开放式 hypothesis、trigger、procedure、scope 和 contraindications；成功 Episode 可由配置的真实 Provider 从权威事实开放归纳，不使用规则目录。
- [x] Reflection 不再只接收 Episode 终态元数据。平台 Adapter 将 Goal、执行错误、人工干预、Evidence、执行模式和最终结果转换为 Evol 自有、脱敏、有时间顺序的 `EvolutionReflectionFact`；Evol 内核不反向读取 Ticket、Agent Loop 或 Mission Store。
- [x] 成功 Episode 中出现“错误/停滞 → 人工干预 → 成功”时，结构化错误归因与 Provider 过程反思并行评估；过程证据优先形成具体恢复 PracticeDraft，避免把每次瞬时错误机械改写成泛化规则。
- [x] Provider 反思输出执行严格字段校验，并允许一次带验证原因的结构修复；连续不合格仍进入 durable retry/dead-letter，不伪造草稿。
- [x] 同一 Episode 的同类 Attribution 在投影和 Reflection 阶段去重；Reflection Fact 与人工消息引用进入草稿 provenance，后续 Candidate 验证可回查原始消息。
- [x] 禁止无来源、单次偶然或预设模板反向归因生成 Practice；Dream 至少要求两个独立 Episode，Provider 证据不足必须返回空数组。

## Milestone D：个人与项目实验

- [x] 建立确定性 project treatment/control assignment 与由 Episode/Trace/Activation/Evidence 权威账本自动派生的效果窗口。
- [x] 支持 agent-project、agent、project 三类局部 active pointer 与独立 rollback。
- [x] 将 Practice Binding 编译为 Memory/Prompt/Skill/Workflow/Plugin release。
  - 已完成 Memory/Prompt/Skill/Workflow；Workflow 由 Practice 内容生成可验证的完整 Plan artifact，并在 next-task 边界按 company < agent < project < agent-project 解析。
  - Local Plugin 使用 durable authoring job 和配置的真实 Provider 生成最小权限 PluginBundle；无 Provider 时保持 pending，产物始终作为 critical Candidate 经过 scanner、评测、人工批准和 next-session 激活，不能用文本 Skill 冒充。
- [x] 在对应 next-turn/next-task/next-session 边界继承和回滚。

## Milestone E：公司推广

- [x] 支持 agent-project -> agent、agent-project -> project、agent/project -> company 的显式 Promotion Proposal，并用 active Release、Activation Proof、passing Telemetry 三类权威账本校验来源证据。
- [x] 公司评审 generalizability、脱敏、适用范围、成本和风险；五项均需人类逐项给出通过结论与说明并持久化，缺项或空说明不能进入 reviewed。
- [x] 将 reviewed Company 提案以受限 agent-project canary 部署到其他代表性项目和其他 Agent，并在窗口完成后自动关闭。
- [x] 只有跨项目 selected/control、继承、回归和安全证据通过后才允许批准并由既有发布 worker 写 company active release。

## Milestone F：分层解析与管理面

- [x] 实现 built-in < company < agent < project < agent-project < invocation safety 的行为解析顺序。
- [x] 强制 policy 使用单调收窄交集语义：布尔权限取 AND、工具取交集、命令 allowlist 取交集且空交集关闭命令执行；任何 Agent/Profile Evol 都不能放宽原项目有效策略。
- [x] 新项目自动继承公司默认；现有项目按生命周期边界重载。
  - Memory/Prompt/Skill/Plugin/AgentProfile 使用 turn/session snapshot；Workflow 使用 task snapshot；Company Runtime Config 使用 process boot snapshot，均从各自共享层账本记录激活证明。
- [x] 项目 Memory pin 与所有项目/agent-project active override 均位于本地层，层级优先于 Company；Company rollback 只修改 Company 共享层 pointer，互不改写。
- [x] UI 展示 Practice 的 Workspace/profile/Episode 来源与 revision、Binding/authoring、Agent/项目效果 refs、scope 晋升、结构化公司评审、trial、Company/Agent/local active、inheritance 与 rollback lineage，以及 Reflection/Dream 可恢复状态。
- [x] UI 直接展示尚未生效的 PracticeDraft、触发条件、具体做法、组件归因和 Episode 数量，并明确区分“已总结”与“已晋升生效”。

退出标准：主规范第 12 节十五条完成定义全部有真实多 Agent、多 Workspace 与双私有实例端到端证据。
