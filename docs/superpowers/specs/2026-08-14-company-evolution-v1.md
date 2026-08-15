# AutoAgent Company Evolution（Evol）设计

日期：2026-08-14
状态：Corrected；Self-Mutation/Activation 语义由 `2026-08-14-self-mutation-activation-v1.md` 规范
范围：建立可审计的可继承资产变异、验证、激活、观测与回滚闭环。

## 1. 结论

Evol 不是“Agent 可以写 `SKILL.md`”，也不是“执行一段新脚本”，而是一个独立控制面：

> 从不可变运行事实中提取经验，修改系统未来会继承的版本化资产，在冻结基线上验证，由独立策略激活到明确的生命周期边界，并用后续运行事实决定保留或回滚。

AutoAgent 已有 Agent Trace、Evidence Ledger、Goal Proposal/Decision、Ticket Handoff 和 Mission Settlement。Evol 必须消费这些事实，不能另建一套猜测任务结果的旁路状态。

首个生产可用里程碑已支持两类产物：

1. `memory`：从多个 Episode 提炼的、带适用范围和来源引用的经验；
2. `skill`：版本化 Skill 包，包含 `SKILL.md` 以及可选 references/scripts/templates。

下一阶段把 `agent_profile`、`prompt`、`workflow`、`runtime_config` 和 `source_patch` 纳入同一候选协议，并分别在 next session、next turn、next task、next restart 和 next deployment 生效。`plugin` 与 `harness` 是可被治理的扩展资产，但它们的执行宿主属于独立基础设施；是否支持插件不能作为 Evol 是否完成的判据。

## 2. 设计来源

本设计综合以下实践：

- Codex：rollout extraction 与 global consolidation 两阶段 Memory、任务租约、失败退避、使用率选择、秘密脱敏、受限 consolidation agent 和 Git baseline；
- DeepSeek Harness：插件树、typed events、reversible effects 与动态组合，作为扩展系统参考，不作为 Evol 本体定义；
- Qwen Code：`/learn`、项目/个人/扩展 Skill 分层、成功使用记录、stale/archive/pin 生命周期；
- QwenPaw：持久 Skill Pool、Workspace runtime copy、跨会话文件 Memory 与自动加载；
- OpenGitOps：desired state 必须声明式、版本化不可变、由运行时自动拉取并持续对账；
- Git protected branches/status checks：源码变更绑定 commit，经独立检查和审查后才能合并；
- Reflexion / ExpeL / Voyager：从外部反馈形成 episodic insight、跨任务经验归纳、环境反馈与自验证后进入 Skill Library；
- Agent Lightning / DSPy：trajectory/span 观测、credit assignment、优化资源与执行框架解耦、基于冻结数据集和指标比较候选。

## 3. 非目标

V1 明确不做：

- 不训练或微调基础模型权重；
- 不允许 Agent 绕过凭据、审计、权限、审批和 Evol Gate；Evol Gate 自身的源码变化只能走最高风险 `source_patch` 流程，V1 默认禁止自动批准；
- 不把普通聊天中的“我觉得更好了”视为评测；
- 不因一次失败立即形成全局 Memory 或生产 Skill；
- 不在没有基线对照和回归证据时自动启用候选；
- 不让同一个 Agent 同时担任 proposer、evaluator 和 approver；
- 不把 Evol 状态写回 Ticket/Agent Engine 伪装成业务完成事实。

## 4. 术语与边界

### 4.1 Experience Episode

一次可独立分析的历史执行单元。通常对应一个 Ticket Attempt / Agent Goal，引用而不复制权威事实。

Episode 只做派生投影，可随时从以下事实重建：

- Agent Thread 和 Trace；
- Evidence Ledger；
- Goal Proposal 与 Decision；
- Ticket completion、return、failure、blocker；
- Mission Link 和 Settlement；
- 人工反馈和 QA 结论。

### 4.2 Attribution

对 Episode 的失败或低效进行结构化归因。归因不是自由文本标签，至少包含：

- `symptom`：可观察现象；
- `component`：memory / prompt / skill / tool / provider / plan / policy / environment / unknown；
- `cause`：基于证据的原因；
- `confidence`：0..1；
- `sourceRefs`：直接支持归因的权威引用；
- `counterEvidenceRefs`：反例或不确定性；
- `scope`：workspace、role、task type、tool、model/provider 等适用边界。

Provider 502、权限拒绝、用户凭据缺失不得被错误归因为 Skill 缺陷。

### 4.3 Insight

从一个或多个 Episode 中提炼的候选经验，分为：

- episodic：只帮助相似重试；
- procedural：可复用操作方法；
- semantic：稳定项目事实或约束；
- preference：明确的人类偏好。

Insight 默认进入候选区。只有证据充分、无冲突且 scope 明确的低风险 Memory 才可自动晋升。

### 4.4 Evolution Candidate

对某个版本化产物的不可变候选修改。候选创建后内容由 `contentHash` 固定；修改必须创建新 revision。

候选类型：`memory | skill | agent_profile | prompt | workflow | runtime_config | source_patch | plugin | harness`。

每个候选必须包含：

- 来源 Episode / Attribution / Evidence 引用；
- 当前版本 `baseVersion`；
- 候选 artifact manifest 与内容哈希；
- 明确的 `hypothesis`；
- 预计改善的 metrics；
- 适用 scope；
- 风险等级；
- proposer 身份；
- 回滚策略；
- 明确的 `activationBoundary` 与预期被哪些后续运行继承。

### 4.5 Evaluation Run

在冻结 Eval Suite 上对 baseline 与 candidate 执行同构任务。Evaluator 读取产物与结果，但不能修改候选。

有效评测必须记录：

- suite version 与 case IDs；
- baseline/candidate artifact hash；
- model/provider/runtime/policy 快照；
- 每个 case 的可重放输入和结果引用；
- quality、task success、safety、cost、latency、tool error 等 metric；
- grader 版本与原始证据；
- contamination 声明；
- final gate decision。

### 4.6 Promotion

将已评测候选发布到指定 scope。Promotion 是独立命令，不是 Candidate 的副作用。

## 5. 权威所有权

| 数据 | 权威所有者 | Evol 权限 |
| --- | --- | --- |
| Agent Thread / Goal / Proposal / Decision | Agent Engine | 只读引用 |
| Ticket / Plan / Handoff / QA 结论 | Ticket Engine | 只读引用 |
| Mission Link / Settlement | Mission Process | 只读引用 |
| Tool Evidence | Evidence Ledger | 只读引用 |
| Experience / Attribution / Insight | Evol Experience Store | 创建派生投影 |
| Candidate / Evaluation / Promotion | Evol Control Plane | 独占写入 |
| Active Skill/Memory release | Evol Artifact Registry | 只能由 Promotion 命令改变 |

Evol 不得根据 Trace 猜测 Ticket 成败；必须读取权威终态和 Decision。

## 6. 分层 Memory

Memory 采用五层而不是一个全局文件：

1. `working`：当前 Thread 上下文，仍由 Agent Engine 管理；
2. `episodic`：按 Ticket/Goal 保存的经验摘要；
3. `workspace`：项目事实、约束和 runbook；
4. `role`：某一岗位可复用方法；
5. `organization`：跨 workspace 的稳定偏好和治理规则。

检索优先级：current episode → workspace + role → organization。跨 workspace 内容不得默认注入；必须显式命中 scope。

Organization 层使用双边授权而不是共享目录：源 Workspace 必须归属稳定 organization id，且高风险、人工提出的 Memory scope 必须显式列出目标 Workspace；目标 Workspace 必须属于同一 organization，并把源 Workspace 加入 `trustedMemoryWorkspaceIds`。任一侧 organization identity 变化、目标撤销 trust 或源不再存在时，新投影立即 fail closed；现有 Pi 会话会在下一轮检查到 trust fingerprint 变化并安全重建。多个受信源对同一 Memory target 给出不同 content hash 时全部不注入，并记录 organization conflict。

Memory 使用以下生命周期：

- candidate → active → stale → archived；
- 支持 pin；
- 使用成功会更新 `usageCount/lastUsedAt`；
- 长期未使用或产生冲突时进入 stale；
- consolidation 发现任何权威 counter-evidence 时将整个证据簇隔离，不生成候选；
- archived 不物理删除，可恢复；
- 原始 Episode 永远保留为来源事实，Memory 只是可重建索引。

## 7. 可继承资产与扩展边界

Skill 不是单个 Markdown 字符串，而是版本化目录：

```text
skill-package/
  manifest.json
  SKILL.md
  references/
  scripts/
  templates/
  evals/
```

`manifest.json` 至少包含 name、version、scope、requiredTools、riskLevel、sourceRefs、content hashes 和 compatibility。

安全检查分三层：

1. 静态：路径、frontmatter、密钥、数据外传、提示注入、危险命令、依赖声明；
2. 动态：在隔离 workspace 中执行脚本和 Eval Case；
3. 行为：检查实际工具调用、文件访问、网络、成本和越权尝试。

Memory、Skill、Agent Profile、Prompt 与 Workflow 都必须写入版本化 desired-state registry；Runtime 只在各自激活边界拉取 active release。源码候选必须保存 base commit、patch hash、目标分支、required checks 与 deployment attestation，不能直接覆写当前服务进程正在执行的文件来冒充生效。

Plugin/Harness 使用独立规范定义的扩展宿主与能力代理。它可以作为 Evol 的一种候选资产，但“运行扩展”不是“发生进化”；只有其版本被持久激活并被后续 Runtime 继承，才构成一次进化结果。扩展沙箱不属于 Evol Control Plane 的必需依赖。

## 8. 状态机

```text
observed
  -> attributed
  -> proposed
  -> validated
  -> ready_for_eval
  -> evaluating
  -> rejected | shadow
  -> canary
  -> promoted
  -> rolled_back | retired
```

约束：

- `proposed -> validated` 只验证契约、安全和来源，不评价效果；
- `validated -> ready_for_eval` 必须追加不可变的 `candidate.evaluation_requested` 账本事件，并绑定内容寻址、版本不可变的 Eval Suite；队列或 UI 的瞬时状态不得冒充该状态；
- `evaluating -> shadow` 必须存在 baseline/candidate 对照结果；
- `shadow -> canary` 需要策略批准；
- `canary -> promoted` 需要线上指标达到阈值；
- 任意 active release 可由安全事件或回归触发 rollback；
- canary assignment 使用 promotion 固化 salt 的确定性哈希分桶，同一 thread/goal 不得跨 cohort 漂移；rollout 限制为 1–25%，并同时校验 role、provider、model、task type 与 tool scope；
- selected/control cohort 必须写入 Agent context trace，线上 telemetry 只能从该 trace 与终态 Episode 对账生成；失败 gate 由系统 monitor 自动回滚 canary；
- rejected Candidate 不可原地修改，必须创建 revision；
- 相同 commandId 幂等，相同 ID 不同内容是冲突。

## 9. 评测与晋升策略

### 9.1 Eval Suite

每个候选至少需要三类 case：

- target：候选要改善的历史问题；
- regression：过去正常成功的任务；
- safety：越权、提示注入、路径逃逸、密钥和数据外传。

历史失败 case 与 sealed holdout 必须分离，避免只记住已知失败。

### 9.2 Metrics

默认指标：

- task success / criterion satisfaction；
- QA return rate；
- tool failure / repeated call rate；
- policy denial / safety violation；
- token、provider cost、wall time；
- human intervention count；
- evidence completeness；
- generalized success on holdout。

晋升是多目标约束，不把所有维度压成一个由模型随意解释的分数。

所有 Evaluation 与 Canary Telemetry 都强制包含 `cost_usd` 和 `latency_ms` 门禁，候选不能通过省略指标绕过约束。`costMeasured=false` 或缺少可信计价来源时，成本结果必须是 unmeasured/inconclusive，绝不能把未知成本记成零。标准 observation 还可携带 input/output/total tokens、QA return、重复工具调用、人工介入和证据完整度；`generalized_success_rate` 只允许由 sealed holdout case 计算。

Eval Suite 可以声明受治理的 automation selector（artifact kind、target、baseline/runtime/policy refs）。Coordinator 可据此确定性地完成 validate、绑定 Suite、入持久化评测队列并消费结果；自动晋升仅限低风险 Memory，且仍须通过独立评测和有可信成本的线上 telemetry。Skill 最多自动进入 shadow，canary/production 始终要求独立的人类或治理策略批准。

### 9.3 风险等级

| 产物 | 默认风险 | 自动晋升 |
| --- | --- | --- |
| scoped episodic Memory | low | 满足证据/冲突策略时允许 |
| workspace/role Memory | medium | 需要独立 consolidation gate |
| instruction-only Skill | medium | 仅允许进入 shadow；生产晋升需策略批准 |
| executable Skill | high | 需要安全扫描、隔离评测、QA 批准 |
| prompt/workflow/agent_profile | high | 需要完整回归、显式激活边界和 canary |
| runtime_config | high/critical | 只允许非凭据配置；next restart 生效，安全根配置禁止自动批准 |
| source_patch | critical | 只生成 branch/patch；required checks、独立审查、合并与部署缺一不可 |
| plugin/harness | critical | 禁止自动晋升；canary/production 必须 human 批准并在隔离 Host 运行 |
| policy | critical | 禁止自动晋升 |

### 9.4 职责隔离

- Proposer：Agent 或 background learner；
- Validator：确定性代码与安全扫描器；
- Evaluator：独立 runner/grader，不能修改 Candidate；
- Approver：human 或明确授权的 governance policy；
- Runtime：只消费 active release，不读取未晋升 Candidate。
- Runtime 投影必须重新验证 release manifest、promotion id、scope、scanner provenance 与 artifact content hash；Skill 从不可变 `SKILL.md` 加载，Memory 以有界参考上下文注入，任何验证失败均 fail closed；

## 10. 数据契约

```ts
type EvolutionArtifactKind = "memory" | "skill" | "agent_profile" | "prompt" | "workflow" | "runtime_config" | "source_patch" | "plugin" | "harness";

interface EvolutionSourceRef {
  kind: "trace" | "evidence" | "goal_proposal" | "goal_decision" | "ticket" | "mission" | "human_feedback";
  ref: string;
  workspaceId: string;
  taskId?: string;
  taskRunId?: string;
  agentId?: string;
}

interface ExperienceEpisode {
  episodeId: string;
  workspaceId: string;
  taskId: string;
  taskRunId: string;
  ticketId: string;
  attemptId: string;
  goalId: string;
  agentId: string;
  outcome: "succeeded" | "returned" | "failed" | "blocked" | "cancelled";
  sourceRefs: EvolutionSourceRef[];
  startedAt: string;
  endedAt: string;
  contentHash: string;
}

interface EvolutionCandidate {
  candidateId: string;
  revision: number;
  kind: EvolutionArtifactKind;
  target: string;
  baseVersion?: string;
  artifactRef: string;
  contentHash: string;
  hypothesis: string;
  sourceRefs: EvolutionSourceRef[];
  scope: EvolutionScope;
  expectedMetrics: MetricExpectation[];
  riskLevel: "low" | "medium" | "high" | "critical";
  status: EvolutionCandidateStatus;
  proposedBy: PrincipalRef;
  createdAt: string;
}

interface EvaluationRun {
  evaluationId: string;
  candidateId: string;
  candidateHash: string;
  suiteRef: VersionedRef;
  baselineRef: VersionedRef;
  runtimeSnapshotRef: string;
  caseResults: EvaluationCaseResult[];
  aggregateMetrics: MetricResult[];
  decision: "pass" | "fail" | "inconclusive";
  evaluatorPrincipal: PrincipalRef;
  createdAt: string;
}

interface PromotionRecord {
  promotionId: string;
  candidateId: string;
  evaluationId: string;
  fromRelease?: VersionedRef;
  toRelease: VersionedRef;
  stage: "shadow" | "canary" | "production";
  scope: EvolutionScope;
  approvedBy: PrincipalRef;
  policyRef: VersionedRef;
  createdAt: string;
}
```

实际 TypeScript contract 必须使用运行时 parser 校验，不能只依赖类型断言。

## 11. 存储与恢复

工作区内：

```text
.autoagent/evolution/
  episodes.jsonl
  attributions.jsonl
  insights.jsonl
  candidates.jsonl
  evaluations.jsonl
  promotions.jsonl
  releases/
  artifacts/
  eval-suites/
  leases/
```

原则：

- JSONL ledger 是权威事实，projection/index 可重建；
- Candidate 的每个 `sourceRef` 在 validation 时都必须解析到对应权威存储：Evidence/human feedback、Trace、Goal proposal/decision、Ticket、Mission 均不得只做字符串格式检查；无法解析即拒绝进入评测；
- artifact 内容寻址，使用 SHA-256；
- mutation 使用 commandId 幂等；
- extraction/evaluation job 使用 lease、heartbeat、retry backoff；
- extraction failure 与 attribution 文本在持久化前经过版本化 secret redaction，脱敏次数随 Attribution 保存；
- EvalSuite 采用内容寻址、不可变版本；EvalRunner 通过 sandbox executor port 运行 baseline/candidate，普通 API 不接受自报分数；
- EvalSuite 必须明确区分 historical 与 sealed holdout，禁止同一 suite id/version 原地改写内容；
- 默认 Node evaluator 使用 Permission Model 子进程，文件系统仅开放一次性目录，network/child process/worker 默认拒绝；评测结果由父进程校验并写入 Evidence Ledger；
- promotion 先写 release，再原子切换 active pointer；
- active pointer 使用单调 generation；promotion replay 不改变 generation，production 切换后关闭同源 canary，rollback 恢复前一 production 或置为 inactive；
- production 必须引用同 Candidate 的 active canary，并具备至少五条互不复用 Evidence Fact 的通过 telemetry window；
- production 晋升会给同源 canary 追加 `superseded` 账本事件，使 release ledger 与 active pointer 保持同一语义；
- Provider token usage 进入 `provider_response` Trace 并可用于 `token_count` 门禁；没有可信计价来源时 `costUsd` 必须标记为 unmeasured，成本门禁结果为 inconclusive，禁止用零值通过；
- rollback 是新的 PromotionRecord，不删除历史；
- 服务重启后能识别 evaluating/promoting 中间态并继续同一个 operation。
- Evolution 后台协调器必须独立于业务任务 RuntimeHost；即使公司当前没有活跃任务，也必须能够恢复租约、消费已到期评测作业并维护 Memory 生命周期。
- Coordinator 对 automation selector 的处理必须可幂等重放：确定性验证、`candidate.evaluation_requested`、evaluation job、shadow/canary/production 均使用稳定 command identity；低风险 Memory 可在全部 gate 通过后自动推进，Skill 自动流程止于 shadow；
- evaluator 可执行程序只能由服务端部署配置注册，候选、Agent 和 HTTP API 均不得提交或覆盖 evaluator 路径；未配置 evaluator 时必须显式报告 unavailable，而不是伪造评测结果。

### 11.1 Sandbox evaluator 部署契约

- 通过 `AUTOAGENT_EVOLUTION_EVALUATOR_PROGRAM` 配置绝对路径；只接受 `.js/.mjs/.cjs` 文件。
- 进程调用为 `node <program> <input.json> <output.json>`；输入 schemaVersion 为 2。
- Eval Case 的 `inputRef` 必须引用当前 Workspace 的 Evidence Ledger。父进程先验证存在性、移除 Workspace 路径等宿主元数据、执行 `evolution-secret-redaction/v1`，再把 `materializedInput.evidence` 和 redaction provenance 写入一次性只读输入；sandbox 不直接读取 Workspace。
- 输入还包含 case、`baseline|candidate` variant、候选 artifact（candidate variant）与 runtimeSnapshotRef。输出必须包含完整 `EvaluationObservation`；断言明细和 telemetry 可选。
- sandbox 默认拒绝 network、child process 和 worker，仅允许读 evaluator 程序/临时目录、写临时输出；缺失 Evidence、超限输入、超时、非零退出、超限输出或 schema 错误全部 fail closed。

## 12. API 与 Agent 工具

### 12.1 API

- `GET /api/workspaces/:workspaceId/evolution/episodes`
- `GET/POST /api/workspaces/:workspaceId/evolution/candidates`
- `POST /api/workspaces/:workspaceId/evolution/candidates/:id/validate`
- `POST /api/workspaces/:workspaceId/evolution/candidates/:id/evaluations`
- `POST /api/workspaces/:workspaceId/evolution/candidates/:id/promotions`
- `POST /api/workspaces/:workspaceId/evolution/releases/:id/rollback`
- `GET /api/workspaces/:workspaceId/evolution/releases`
- `GET /api/workspaces/:workspaceId/evolution/worker`
- `PATCH /api/workspaces/:workspaceId/organization-memory-trust`

### 12.2 Agent tools

V1 只提供：

- `propose_evolution_candidate`：提交候选，必须引用 sourceRefs；
- `query_evolution_status`：读取状态。

Agent 不获得 validate、evaluate、promote、rollback 工具。它可以请求评测，但不能宣称自己的候选已通过。

## 13. 分阶段实施

### Phase 0：治理边界与候选仓库

- 将当前静态 Skill 原型重构为 Candidate Store；
- 移除 `evolve_skill` 的自动 validate/promote/activate；
- 新增 sourceRefs、scope、risk、expectedMetrics、revision；
- 使用 append-only ledger 和幂等命令；
- active runtime 不加载 Candidate；
- API 明确分离 propose、validate、evaluate、promote。

验收：Agent 只能提出；未评测 Candidate 无法晋升；任何失败不改变 active Skill。

### Phase 1：Experience Pipeline 与 Memory

- 从权威 Ticket/Goal/Decision/Evidence 组装 Episode；
- outcome 和 provider/tool/policy failure 分类；
- stage-1 episode extraction；
- stage-2 scoped consolidation；
- Memory 使用、冲突、stale/archive/pin 生命周期；
- lease、backoff、secret redaction。

验收：同一历史事实可重建同一 Episode；无 Ticket 终态不得猜测 outcome；跨 workspace Memory 不泄漏。

### Phase 2：Skill Evaluation Gate

- Skill package/manifest；
- 静态安全扫描；
- frozen Eval Suite；
- baseline/candidate 同构 runner；
- deterministic metrics；
- shadow release；
- promotion policy 和 rollback。

验收：候选只有在 target 改善、regression 不退化、safety 无违规时才可进入 shadow；重启不重复评测或晋升。

### Phase 3：Canary 与线上学习

- 按 role/workspace/task type 路由一部分任务；
- 成功使用、成本、延迟、返工、人工介入遥测；
- 自动降级/回滚；
- stale/archive/pin；
- 防止同一失败被过度学习。

### Phase 4：Self-Mutation 与 Activation

- 将 Memory、Prompt、Skill 与 Local Plugin 建模为不可变本地 Candidate/Release；
- Memory、Prompt、Skill 声明 next-turn 边界，Local Plugin 声明 next-session 边界；
- Runtime generation/revision 对账并在边界重建，不改变进行中的原子执行；
- 每次执行 Trace 记录实际继承的本地 release refs 与 runtime surface hash；
- Local Plugin 保存为不可变 Bundle，经 scanner、独立评测和 human approval 后只在下一 session 挂载；
- 激活后继续收集 selected/control telemetry，失败时恢复 previous active release。

验收：变更必须被后续运行实际继承并能从 Trace 证明；临时执行候选代码、只写 Candidate 文件或只通过 Eval 均不得宣称进化完成。

### Local Plugin 执行基础设施

`2026-08-14-plugin-harness-evolution-v1.md` 定义 Local Plugin 的 Bundle、Host 与 session mount。Host 本身不是进化证据；只有 production release 被下一 session 实际加载并留下 inheritance proof 才算进化。内置跨平台子进程 Host 是默认路径，WSL/container 等外部隔离器仅是多租户部署的可选加固。

## 14. 当前代码处置

现有未提交的 `EvolutionStore` 有备份和回滚的可复用思路，但状态机和权限模型不合格：它把 proposer、validator、approver 合并到同一个 runtime tool，并在静态格式检查后直接写 active Skill。

处理方式：

1. 保留路径安全、内容哈希和 artifact backup 的实现思路；
2. 删除自动晋升和自动激活；
3. 将存储从可变 `proposals.json` 改成 append-only Candidate ledger；
4. 将 `SKILL.md` 字符串改成 artifact package；
5. 没有 EvaluationRecord 时，Promotion API 必须确定性拒绝；
6. 直到 Phase 4 完成且后续运行的 inheritance proof 可验证，不得对外宣称“自进化已完成”。

## 15. 完成定义

Company Evolution 只有同时满足以下条件才能称为完成：

- 能从真实历史执行自动构造可追溯 Experience；
- 能区分外部故障、权限问题与 Agent 能力缺陷；
- 候选变更有不可变内容、证据、scope 和假设；
- 有独立、可重放的 baseline/candidate 评测；
- 有安全、回归、质量、成本和延迟门槛；
- 有 shadow/canary/production 分级发布；
- 有自动监控、衰减、归档和回滚；
- proposer 不能给自己的候选批准上线；
- 服务重启不重复或丢失评测/晋升；
- 所有 UI 状态都能追溯到权威 Evol ledger；
- 每个 active 资产都有明确激活边界，进行中的原子执行不被热切换破坏；
- 后续 Trace 能证明它实际继承了哪个 Memory、Prompt、Skill 和 Local Plugin revision；
- Local Plugin 只有在下一 session 实际挂载对应 Bundle/tool surface 后才算 activated；
- 临时执行脚本、创建 Candidate 或通过离线评测本身都不算进化完成。

Source Patch、远端 SCM/CI/CD 和应用部署属于可选团队/SaaS 软件交付项目，不是本地 Company Evolution V1 的完成或失败条件。OpenAI、Anthropic、Mock 等模型 Provider 仍由现有模型服务配置管理，不与“交付 Provider”混为一谈。
