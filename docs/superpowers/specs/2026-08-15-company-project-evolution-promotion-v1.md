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

参考：

- https://www.iso.org/standard/68683.html
- https://github.com/Qwen-Applications/skill-self-play
- https://www.w3.org/TR/prov-o/
- https://sre.google/workbook/canarying-releases/
- https://openfeature.dev/specification/sections/evaluation-context/
- https://mlflow.org/docs/latest/ml/model-registry/workflow

## 3. 三类对象必须分开

### 3.1 Practice

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
  agentIdentityIds?: string[];
  roles?: string[];
  taskTypes?: string[];
  predicates?: Record<string, string | number | boolean>;
}
```

`statement`、`trigger`、`procedure` 和适用范围由 Agent 从 Episode 中归纳，不来自有限枚举。系统不得因为某个预设模板存在，就反向把所有经验归入该模板。

### 3.2 Binding

Binding 决定一条 Practice 如何影响 Runtime。执行接缝是有限的，但学习内容不是：

- Memory：作为任务判断所需的经验注入；
- Prompt：改变 Agent 的决策约束；
- Skill：提供可复用操作程序；
- Workflow：增加、删除或重排协作步骤；
- Local Plugin：静态资产无法完成时增加本地工具能力。

一条 Practice 可以有多个 Binding；Binding 可以迭代而不篡改 Practice 的原始证据。

### 3.3 Release

Release 是 Practice + Binding 的不可变可执行版本。active pointer 只选择 Release，不指向草稿 Practice。

## 4. Agent 身份不是 Profile 模板

系统必须区分：

- `AgentProfile`：可复用的角色/能力模板，例如“开发”“测试”；
- `CompanyAgentIdentity`：公司中持续存在、可以成长的具体 Agent；
- `WorkspaceAgentAssignment`：该 Agent 在某个项目中的一次任职关系。

多个 Agent 可以使用同一 Profile，但不能因此共享个人 Memory、Prompt、Skill 或成长历史。同一个 Company Agent 可以参与多个项目，并在公司边界内携带经过 scope 校验的个人能力。

```ts
interface CompanyAgentIdentity {
  agentIdentityId: string;
  companyId: string;
  profileId: string;
  status: "active" | "inactive";
  createdAt: string;
}

interface WorkspaceAgentAssignment {
  workspaceAgentId: string;
  workspaceId: string;
  agentIdentityId: string;
  role: string;
}
```

个人成长归属于 `agentIdentityId`，不能归属于 Profile，也不能只归属于临时的 `workspaceAgentId`。

## 5. 四种进化作用域

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

## 6. 个人与项目进化

Agent 可以从自己的重复 Episode 中提出任意 Practice hypothesis。系统先选择能解释证据的最窄 scope，默认从 `agent_project` 开始，不得因为一次个人成功直接改变整个项目或公司。

试验必须声明：

- 当前问题与来源事实；
- 新做法及适用条件；
- treatment 和 control 如何区分；
- 预计改善指标和不可退化指标；
- 观察窗口和最小有效样本；
- 当前 scope 的 rollback reference。

Practice 通过评测后成为对应 scope 的 release。Memory、Prompt、Skill 在下一 turn 生效；Workflow 在下一 task 生效；Local Plugin 在下一 session 生效。

允许的晋升路径：

```text
agent_project -> agent      # 对同一 Agent 的多个项目都有效
agent_project -> project    # 对同项目的其他 Agent 也有效
agent         -> company    # 个人方法经多 Agent/多项目验证后公司化
project       -> company    # 项目实践经跨项目验证后公司化
```

每次扩大 scope 都必须创建新的 Promotion Proposal 和效果窗口；不得修改原 release 的 scope。

## 7. 公司推广不是复制

项目效果好后，系统创建 `CompanyPromotionProposal`，不能直接写公司 active pointer：

```ts
interface CompanyPromotionProposal {
  proposalId: string;
  companyId: string;
  origin: { ownerLevel: "agent_project" | "agent" | "project"; projectId?: string; agentIdentityId?: string };
  originReleaseRef: VersionedEvolutionRef;
  practiceRef: VersionedEvolutionRef;
  inheritanceProofRefs: string[];
  effectWindowRefs: string[];
  proposedCompanyScope: PracticeScope;
  generalizationRisks: string[];
  status: "proposed" | "reviewed" | "trial" | "approved" | "rejected";
}
```

公司评审回答的不是“原项目有没有成功”，而是：

1. 成功是否可能来自其他同时变化的因素；
2. 做法对哪些任务、角色和项目成立；
3. 哪些项目不适用；
4. 是否需要把项目特有信息脱敏或参数化；
5. 公司推广后的风险、成本和回滚是什么。

## 8. 公司试验与推广

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

## 9. 解析优先级

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

## 10. 示例：任务前文档宣讲

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

## 11. 完成定义

Agent/Project/Company Evol 只有在以下条件全部成立后完成：

1. 同一私有部署具有稳定 company identity，两个部署之间的 Evol 数据完全隔离。
2. Profile、Company Agent identity 和 Workspace assignment 被明确分离，两个共享 Profile 的 Agent 不会共享个人成长。
3. Agent 能从开放式 Episode 归纳 Practice，而不是只能选择预设规则。
4. Practice 与其 Runtime Binding 分离并分别版本化。
5. agent-project、agent、project Release 都能在正确生命周期边界实际继承、测量和回滚。
6. scope 扩大只能通过新的 Promotion Proposal，原 release 不被原地改写。
7. 有实际效果的个人或项目 Release 只能通过 CompanyPromotionProposal 进入公司评审。
8. 公司 trial 使用其他 Agent、其他代表性项目和 selected/control 事实验证可泛化性。
9. 公司 active release 成为匹配 Agent、项目和新项目的默认值，个人/项目 pin 与 override 保持更高优先级。
10. company、agent、project、agent-project rollback 相互独立，并由后续运行留下新的 inheritance proof。
11. 强制 policy 逐层取交集，任何个人成长都不能放宽公司/项目安全约束。
12. UI 能展示 Practice 从具体 Agent 和项目、局部实验、scope 晋升、公司评审、company trial 到 company active 的完整 provenance。

在这些条件完成前，现有 Workspace 级资产生命周期只能称为底层能力，不能宣称 Agent/Project/Company Evolution 完成。
