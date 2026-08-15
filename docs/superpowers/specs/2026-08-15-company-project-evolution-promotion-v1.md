# AutoAgent Agent、项目与公司分层进化 V1

日期：2026-08-15

状态：Accepted for implementation

## 1. 产品定义

一次私有化部署代表一家公司。公司内每个持续存在的 Agent、每个项目以及公司整体都可以进化。某个 Agent 在某个项目中学到的做法先属于该 Agent 与该项目的交集；它可以被证明为 Agent 的长期能力、项目共享实践，最终也可以经过公司评审和跨项目验证成为公司默认实践。

Evol 不预设“正确做法是什么”。系统只预设治理协议：

```text
Observe work
-> Induce an open-ended Practice hypothesis
-> Choose the narrowest Agent/Project scope
-> Run a bounded experiment
-> Measure actual effect
-> Adopt or rollback at the same scope
-> Propose company promotion
-> Review generalizability
-> Trial on representative projects
-> Publish as company default
-> Continue measuring, override, refine or rollback
```

预设的是证据、权限、生命周期和回滚规则；被学习到的实践内容、适用条件和执行形式都来自真实工作。

## 2. 行业依据

不存在一个单独标准完整定义“Agent 公司自进化”。V1 组合以下成熟模式：

- ISO 30401 Knowledge Management Systems：组织知识来自人与工作、信息和环境的互动，并需要持续建立、维护、评审和改进。对应 Company Practice Library，而不是全局静态 Prompt。
- Qwen Skill Self-Play：聚合失败、新样本、成功率和 utility 信号，触发 skill refinement、pruning 与 induction。对应从运行反馈发现、修订或淘汰实践。
- W3C PROV-O：用 Entity、Activity、Agent 以及 derived/revision/source 关系表达来源链。对应 Episode、Experiment、Practice、Release、Reviewer 的可追溯关系。
- Google SRE Canary：先对有限、限时的对象应用变化，与 control 比较后决定扩大或回滚。V1 借用的是渐进式验证原则，不引入软件部署系统。
- OpenFeature Evaluation Context：全局上下文为低优先级，调用级上下文为高优先级，并支持 targeting。对应公司默认、Agent/项目覆盖以及按 identity/role/task type 匹配。
- MLflow Registry aliases：不可变版本与可移动 alias 分离，切换 champion 不修改历史版本，后续消费者解析新 alias。对应 project/company active pointer 与 rollback。
- Hermes Agent：在复杂任务成功、绕过错误/死路、用户纠正或发现非平凡流程后立即提出或修订 Skill。对应高显著性事件的快速反思，但不照搬“当场直接改 active Skill”。
- Letta sleeptime：按 step count 或 context compaction 触发后台 reflection，并可选择 reminder 或 auto-launch。对应不阻塞前台的 checkpoint trigger。
- ReasoningBank / Reflexion：在轨迹完成并得到结果反馈后抽取成功洞察或失败反思，再进入持续 consolidation。对应先保留 Episode，再形成可复用 Practice。
- Generative Agents：累积近期事件的重要性达到阈值时才反思。对应 salience/novelty/重复度驱动，而不是每一轮都调用模型学习。

参考：

- https://www.iso.org/standard/68683.html
- https://github.com/Qwen-Applications/skill-self-play
- https://www.w3.org/TR/prov-o/
- https://sre.google/workbook/canarying-releases/
- https://openfeature.dev/specification/sections/evaluation-context/
- https://mlflow.org/docs/latest/ml/model-registry/workflow
- https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/skills.md
- https://github.com/letta-ai/lettabot/blob/main/docs/configuration.md#sleeptime-background-reflection
- https://research.google/blog/reasoningbank-enabling-agents-to-learn-from-experience/
- https://arxiv.org/abs/2303.11366
- https://hci.stanford.edu/publications/paper.php?id=482

## 3. 进化时机：事实捕获、反思、整合、决策、生效必须分开

Evol 不是一个“凌晨任务”，也不是在业务任务结束时直接改 active 资产。一次进化有五个不同时间：

```text
Capture authoritative fact
-> Reflect on one salient Episode
-> Consolidate across Episodes
-> Evaluate / approve / promote
-> Activate at the next lifecycle boundary
```

### 3.1 第一层：同步事实捕获

以下事件发生时，业务系统先照常追加其不可变权威事实；同步路径不得调用模型、生成 Skill、双写 Evol 状态或改变 active release：

- Ticket/Mission 进入权威终态；
- 用户明确纠正 Agent；
- Agent 经历错误或死路后找到可验证的工作路径；
- 已有 Practice 被使用、拒绝、绕过或证明过时；
- canary/control 产生新的效果事实；
- turn context 即将 compaction；
- 人工显式请求“记录这次经验”或“立即运行 Evol”。

Ticket/Mission、Evidence Ledger、Agent Thread/Trace 和 release telemetry 是 capture source。Evol ingestor 使用耐久 cursor 从这些来源幂等派生 `EvolutionSignal` 和 Episode/source refs；即使后台 worker 停止，恢复后也能从权威来源补齐。业务任务的响应不等待 Evol，也不承担跨账本双写。

```ts
interface EvolutionSignal {
  signalId: string;
  companyId: string;
  workspaceId?: string;
  profileId?: string;
  trigger: "terminal_outcome" | "user_correction" | "recovered_failure" | "novel_success"
    | "practice_feedback" | "context_compaction" | "effect_observation" | "manual";
  sourceRefs: string[];
  salience: number;
  novelty: number;
  occurredAt: string;
}
```

### 3.2 第二层：事件驱动的快速反思

复杂成功、用户纠正、解决过的失败、已有 Practice 失效等高显著性信号，在当前业务任务结束后立即进入异步 reflection queue。它可以形成 `PracticeDraft`、补充反例或建议修订，但不能跳过 consolidation/evaluation 直接覆盖 active release。

普通成功只记 Episode，不逐条反思，避免把偶然步骤写成长期规则。`context_compaction` 是一个 checkpoint：它促使系统保存尚未归档的显著事实，但本身不证明发生了学习。

### 3.3 第三层：阈值与空闲窗口驱动的 Dream consolidation

Dream 的职责是跨 Episode 聚类、去重、寻找矛盾、归纳适用条件、选择最窄 scope，并决定 create/refine/merge/prune/no-op。它由以下任一条件触发：

- 同一问题簇达到 company policy 规定的独立 Episode/Agent/Project 证据阈值；
- 高显著性或高风险信号要求尽快整合；
- Runtime 进入有资源预算的 idle window；
- 到达公司配置的 maintenance window；
- 管理员手动触发。

“凌晨”只能是某家公司的可选 maintenance window。跨平台私有部署和 24 小时运行的 SaaS 不能假设存在统一夜间；系统正确性也不能依赖定时任务恰好运行。默认优先使用 durable queue + idle budget，定时窗口负责低优先级整理、衰减、冲突检测和摘要。

### 3.4 第四层：评测、晋升与紧急回滚

候选形成后，评测由独立 worker 持续消费，不等待下一个 Dream。scope 晋升由证据阈值和评审触发，不由时间触发。canary 出现不可接受回归时应立即进入 rollback 决策路径；紧急回滚不等待夜间整合。

### 3.5 第五层：生命周期边界生效

学习完成的时间不等于 Runtime 生效时间：

- Memory、Prompt、Skill：批准后下一 turn 解析；
- Workflow：批准后下一 task 解析；
- Local Plugin：批准后下一 session 解析；
- Company/Agent/Project pointer rollback：后续对应生命周期重新解析。

当前正在执行的 turn/task/session 使用冻结 snapshot，不因后台 Dream 完成而被中途改变。

Memory 的 active 过滤、使用证据、过期语义与可解释排序以 `2026-08-15-memory-selection-lifecycle-v1.md` 为准；尚未实现的语义检索和策略学习分别记录在 `docs/evolution-backlog.md` 与 `docs/evolution-technical-debt.md`，不得从现有固定排序推断为已完成。

### 3.6 调度优先级

```text
P0  canary regression / safety rollback
P1  user correction / recovered failure / explicit manual Evol
P2  terminal complex task / novelty threshold reached
P3  repeated ordinary Episode cluster
P4  scheduled hygiene / decay / merge / archive
```

队列必须持久化、幂等、可恢复、按 company/workspace/agent 做公平调度，并受并发、token、费用和最大运行时预算约束。任何触发都只决定“何时分析”，不预设“应该学到什么”。

## 4. 三类对象必须分开

### 4.1 Practice

Practice 是从工作中学到的开放式做法，不等同于 Prompt、Skill 或 Workflow。

```ts
interface EvolutionPractice {
  practiceId: string;
  version: number;
  statement: string;
  trigger: string;
  procedure: string;
  expectedOutcome: MetricExpectation[];
  applicability: PracticeScope;
  contraindications: string[];
  sourceEpisodeRefs: string[];
  provenanceHash: string;
}

interface PracticeScope {
  companyId: string;
  ownerLevel: "agent_project" | "agent" | "project" | "company";
  projectIds?: string[];
  profileIds?: string[];
  roles?: string[];
  taskTypes?: string[];
  predicates?: Record<string, string | number | boolean>;
}
```

`statement`、`trigger`、`procedure` 和适用范围由 Agent 从 Episode 中归纳，不来自有限枚举。系统不得因为某个预设模板存在，就反向把所有经验归入该模板。

### 4.2 Binding

Binding 决定一条 Practice 如何影响 Runtime。执行接缝是有限的，但学习内容不是：

- Memory：作为任务判断所需的经验注入；
- Prompt：改变 Agent 的决策约束；
- Skill：提供可复用操作程序；
- Workflow：增加、删除或重排协作步骤；
- Local Plugin：静态资产无法完成时增加本地工具能力。

一条 Practice 可以有多个 Binding；Binding 可以迭代而不篡改 Practice 的原始证据。

### 4.3 Release

Release 是 Practice + Binding 的不可变可执行版本。active pointer 只选择 Release，不指向草稿 Practice。

## 5. AgentProfile 是稳定个人身份，WorkspaceAgent 是项目实例

当前产品中的 `AgentProfile` 已经是公司人才中心里长期存在的具体智能体员工：它包含名字、identity、soul、Agent.md、能力和默认 Skill，并被多个项目实例引用。V1 不再引入一套重复的 `CompanyAgentIdentity`。

- `AgentProfile`：稳定的公司级个人 Agent，`profileId` 是个人长期成长的 owner；
- `WorkspaceAgent`：该 Agent 在一个 Workspace/项目中的运行实例，通过 `profileId` 指向同一个人；
- `roleInWorkspace` 和项目 override：该 Agent 在当前项目的任职与局部配置，不创建新身份。

这里的共享规则是：

| 资产归属 | 谁会继承 | 是否跨项目 |
| --- | --- | --- |
| Agent (`profileId`) | 该 Agent 的所有 Workspace instances | 是 |
| Agent × Project (`profileId + workspaceId`) | 该 Agent 在该项目中的 instance | 否 |
| Project (`workspaceId`) | 该项目内所有匹配 Agent | 不适用 |
| Company (`companyId`) | 公司内所有匹配 Agent/项目 | 是 |

因此，同一个 `profileId` 参与多个项目时，其 agent-level Memory、Prompt、Skill 和成长历史必须共享给这些项目实例。不能自动共享的是尚未证明可泛化的 agent-project 资产。两个不同 `profileId` 是两个不同 Agent，不混合个人证据和成长。

```ts
interface WorkspaceAgent {
  workspaceAgentId: string;
  workspaceId: string;
  profileId: string;
  role: string;
}
```

个人长期成长归属于 `profileId`，不能只归属于项目内的 `workspaceAgentId`。项目内的个人经验归属于复合键 `(profileId, workspaceId)`；当它在该 Agent 的其他项目中验证有效后，通过 `agent_project -> agent` 晋升，之后由同一 Agent 的所有 Workspace instances 继承。

如果未来确实需要“多个不同 Agent 共享同一岗位模板”，应另建 `AgentArchetype` 并让多个 AgentProfile 引用它；这不是 Agent/Project/Company Evol V1 的前置条件。

## 6. 四种进化作用域

```text
Company
├── Company Practice Library
├── Company Release Registry
├── Company review/evaluation policy
├── Agent Libraries
│   └── Agent long-term Practices/Releases
└── Projects
    ├── Project shared Practices/Releases
    ├── Agent × Project Practices/Releases
    ├── Project Experiences
    └── Project overrides
```

- `AUTOAGENT_HOME` 是公司数据边界，并持久化稳定 `companyId`。
- 公司 Agent 身份与个人长期资产保存在公司边界内；离开该私有部署不能被其他公司发现。
- Workspace 是项目边界，保存本项目原始 Episode、实验和项目 Release。
- `agent_project` 是最窄作用域，只对一个 Agent 在一个项目中的匹配任务生效。
- `agent` 是该 Agent 跨项目可携带的长期能力，但必须满足目标项目 policy。
- `project` 是项目所有匹配 Agent 共享的实践。
- `company` 是现有项目和新项目默认继承的实践。
- 公司库保存经过推广的 Practice/Release 以及跨项目聚合证据。
- 不同私有化部署之间没有发现、读取、推广或继承通道。

## 7. 个人与项目进化

Agent 可以从自己的重复 Episode 中提出任意 Practice hypothesis。系统先选择能解释证据的最窄 scope，默认从 `agent_project` 开始，不得因为一次个人成功直接改变整个项目或公司。

试验必须声明：

- 当前问题与来源事实；
- 新做法及适用条件；
- treatment 和 control 如何区分；
- 预计改善指标和不可退化指标；
- 观察窗口和最小有效样本；
- 当前 scope 的 rollback reference。

Practice 通过评测后成为对应 scope 的 release。Memory、Prompt、Skill 在下一 turn 生效；Workflow 在下一 task 生效；Local Plugin 在下一 session 生效。

Local Plugin 不允许由固定脚本模板伪装成“自进化”。只有 Practice 的权威归因明确落在 tool capability 时，Binding 才创建 Plugin authoring job；配置的真实 Provider 根据该 Practice 编写最小权限 PluginBundle。生成物只成为 `critical` 风险 Candidate，必须经过不可变来源校验、静态 scanner、独立评测和人工批准，之后才可在下一 session 加载。Provider 不可用时 job 保持 pending；生成或扫描失败进入可重试/死信状态，绝不降级为自动执行源码或普通 Skill。

允许的晋升路径：

```text
agent_project -> agent      # 对同一 Agent 的多个项目都有效
agent_project -> project    # 对同项目的其他 Agent 也有效
agent         -> company    # 个人方法经多 Agent/多项目验证后公司化
project       -> company    # 项目实践经跨项目验证后公司化
```

每次扩大 scope 都必须创建新的 Promotion Proposal 和效果窗口；不得修改原 release 的 scope。

## 8. 公司推广不是复制

项目效果好后，系统创建 `CompanyPromotionProposal`，不能直接写公司 active pointer：

```ts
interface CompanyPromotionProposal {
  proposalId: string;
  companyId: string;
  origin: { ownerLevel: "agent_project" | "agent" | "project"; projectId?: string; profileId?: string };
  originReleaseRef: VersionedEvolutionRef;
  practiceRef: VersionedEvolutionRef;
  inheritanceProofRefs: string[];
  effectWindowRefs: string[];
  evidenceVerification: {
    verifierId: string;
    verifiedAt: string;
    originRootId: string;
    inheritanceProofCount: number;
    effectWindowCount: number;
  };
  proposedCompanyScope: PracticeScope;
  generalizationRisks: string[];
  status: "proposed" | "reviewed" | "trial" | "approved" | "rejected";
}
```

`inheritanceProofRefs` 和 `effectWindowRefs` 不是调用方可自由填写的说明文字。创建提案时，服务端必须重新解析：来源必须仍是当前 active、validated、immutable 的 production Release；每个继承证明必须存在于 Activation Ledger、指向该 Release，并保留实际运行的 workspace/Agent/profile；每个效果窗口必须存在于 Telemetry Ledger、属于同一 Candidate 内容且结论为 pass。任何缺失、失败、串用其他 Release 或伪造的引用都拒绝创建提案。共享 Agent/Company Release 的激活证明写回其共享层账本，而不是错误写入当前项目账本。

公司评审回答的不是“原项目有没有成功”，而是：

1. 成功是否可能来自其他同时变化的因素；
2. 做法对哪些任务、角色和项目成立；
3. 哪些项目不适用；
4. 是否需要把项目特有信息脱敏或参数化；
5. 公司推广后的风险、成本和回滚是什么。

## 9. 公司试验与推广

通过评审后先进入代表性项目 trial：

```text
project_production
-> eligible_for_company
-> company_reviewed
-> company_trial
-> company_active
```

- trial 选择与目标 scope 匹配、但来源不同的项目；
- selected/control 必须记录 Practice 和 Release refs；
- 只有跨项目效果保持、回归与安全门禁通过，才写公司 active pointer；
- 公司 active release 是默认值，不覆盖项目显式 pin/override；
- 新项目创建后默认解析匹配的公司 active releases；
- 公司 rollback 创建新 generation，后续 turn/task/session 重新解析 previous company release。

个人 Practice 也可以作为公司推广来源，但 company trial 必须由其他 Agent 执行，避免把某个 Agent 的个人优势误判成可复用公司方法。

实现约束：`reviewed -> trial` 不能由一个裸状态迁移完成。系统必须先创建不可变 `CompanyEvolutionTrial`，把来源 Release 作为受限 `agent_project` canary 部署到非来源 Workspace 的其他稳定 `profileId` 实例，并声明确定性 selected/control rollout、观察单位和每组最小样本。Runtime Trace 记录每个任务的 assignment；selected 样本必须同时存在对应 Release 的 Activation inheritance proof，control 样本必须证明未加载该 Release。后台 reconciler 只能从完成的 Episode、Trace、Activation Ledger 和 Evidence Ledger 派生效果，达到两组最小样本且改善、回归、安全门禁通过后才附加不可变 trial evidence。效果窗口结束立即关闭 trial pointer；`trial -> approved` 必须存在 passing trial evidence，不能通过 API 手填结果或直接修改状态绕过。

## 10. 解析优先级

Runtime 使用与 OpenFeature context merging 相似的确定性覆盖顺序：

```text
built-in default
< company active release
< agent long-term release
< project shared release
< agent-project release
< current invocation safety restriction
```

这是行为默认值的优先级。公司和项目的强制 policy 不参与覆盖，而是逐层取交集；个人层永远不能放宽公司或项目 policy。每次运行必须留下最终解析出的 company/agent/project/agent-project release refs 和 snapshot hash。

## 11. 示例：任务前文档宣讲

项目 A 的多次任务显示信息不同步导致返工。Agent 提出 Practice：

> 当任务涉及多人协作且存在新的权威文档时，在执行前向所有参与者完成一次带确认回执的简报。

系统没有预设这条规则。它通过以下链路产生：

1. Agent A 的 Episode 归因发现返工与参与者未获知文档相关；
2. 先形成 `Agent A × 项目 A` Practice Candidate；
3. Binding 暂时选择 Workflow pre-task briefing + Prompt confirmation；
4. Agent A 在项目 A 的后续任务记录返工率、首次通过率、耗时和人工介入；
5. 如果只对 Agent A 有效，可晋升为 Agent A 的长期 Practice；
6. 如果项目 A 的其他 Agent 试用也有效，可晋升为项目 A 的共享 Practice；
7. 公司推广提案移除 Agent A、项目 A 的具体人名、文档路径和团队结构；
8. 在其他 Agent 和其他适用项目 trial；
9. 公司评审批准后成为公司默认 Practice；
10. 新项目自动继承，已有项目在下一 task 生效；个人或项目仍可显式 override；
11. 后续效果退化时公司 rollback，不删除 Agent A 和项目 A 的历史实验与证据。

## 12. 完成定义

Agent/Project/Company Evol 只有在以下条件全部成立后完成：

1. 同一私有部署具有稳定 company identity，两个部署之间的 Evol 数据完全隔离。
2. `AgentProfile/profileId` 被确认为稳定个人身份，`WorkspaceAgent` 被确认为项目实例：同一 profileId 的所有实例共享 agent-level 成长；agent-project 成长只留在对应项目实例。
3. Agent 能从开放式 Episode 归纳 Practice，而不是只能选择预设规则。
4. Practice 与其 Runtime Binding 分离并分别版本化。
   - Practice 晋升到 Agent 或 Company 后，共享层必须保存其不可变 Practice 快照及 Promotion provenance；不能只保存一个指回源项目的脆弱引用。
5. agent-project、agent、project Release 都能在正确生命周期边界实际继承、测量和回滚。
6. scope 扩大只能通过新的 Promotion Proposal，原 release 不被原地改写。
7. 有实际效果的个人或项目 Release 只能通过 CompanyPromotionProposal 进入公司评审。
8. 公司 trial 使用其他 Agent、其他代表性项目和 selected/control 事实验证可泛化性。
   - 进入 trial 前必须持久化人类完成的五项结构化评审：可泛化性、脱敏、适用范围、成本和风险；每项都必须明确通过并附证据说明，不能用一个 `reviewed` 状态代替评审内容。
9. 公司 active release 成为匹配 Agent、项目和新项目的默认值，个人/项目 pin 与 override 保持更高优先级。
10. company、agent、project、agent-project rollback 相互独立，并由后续运行留下新的 inheritance proof。
11. 强制 policy 逐层取交集，任何个人成长都不能放宽公司/项目安全约束。
12. UI 能展示 Practice 从具体 Agent 和项目、局部实验、scope 晋升、公司评审、company trial 到 company active 的完整 provenance。
13. 事实捕获不阻塞业务任务且不依赖后台在线；快速反思、Dream consolidation、评测、晋升和生效分别有独立可恢复状态。
   - `EvolutionSignal` 只代表捕获的事实；ReflectionJob 与 ConsolidationJob 必须分别持久化、租约执行、失败重试和进入 dead-letter，不能再用一个 signal 状态冒充所有阶段。
14. 高显著性事件可快速进入 reflection，普通事件按阈值/idle/maintenance 聚合，任何公司都不依赖固定“凌晨”才能进化。
15. 当前运行使用冻结 snapshot；后台完成的 release 只在声明的下一 turn/task/session 边界生效。

在这些条件完成前，现有 Workspace 级资产生命周期只能称为底层能力，不能宣称 Agent/Project/Company Evolution 完成。
