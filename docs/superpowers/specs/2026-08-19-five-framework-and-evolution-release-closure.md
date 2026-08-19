# 五框架方向与 Evol 发布闭环设计

日期：2026-08-19  
状态：Accepted，作为后续实现与验收基线

## 1. 决策摘要

AutoAgent 的长期产品边界确定为五个相互解耦的框架：

1. **Agent Engine / Agent Loop**：单个 Agent 的 turn、工具调用、上下文和结果。
2. **Ticket Engine**：工作项、依赖、领取、阻塞、完成事实。
3. **Mission Control**：把目标、团队与 Ticket 编排为可恢复的 Mission。
4. **Evol**：从真实经历形成可复用能力，评估、发布，并在后续边界加载。
5. **Organization & Talent**：公司、岗位、人才、雇佣关系、招聘、任职和组织级能力供给。

本期选择 **HOLD SCOPE**：先闭合 Evol 的真实发布链；只冻结 Organization & Talent 的边界，不把招聘 UI 或人才市场混进本期代码。

Evol 不是源码自修改器，也不是部署系统。它管理的进化资产是 Memory、Prompt、Skill、Workflow 和本地 Plugin；资产只在声明的下一 turn、session 或 task 边界加载。GitHub、CI、Kubernetes 都只能是可选适配器，不是进化前置条件。

## 2. 为什么不是现在直接做“招聘第五框架”

现有代码已经有 AgentProfile、WorkspaceAgent、TeamBinding、StaffingRequest 和基本 roster。这些证明“组织与人才”有真实领域，不是凭空增加框架；但当前最影响产品可信度的断点是 Evol：真实 Provider 任务已经形成 Practice 和 Candidate，Candidate 却停在 `validated`，没有进入真实评估、Canary 和下一任务加载。

如果此时先扩招聘，系统会多一个管理面，却仍不能证明“公司真的学会了”。因此顺序固定为：

```text
先闭合 Evol 项目内成长
        |
        v
用真实任务证明效果
        |
        v
再把有效能力推广到 Agent / Company
        |
        v
最后让 Organization & Talent 使用这些能力事实做招聘与配置
```

## 3. Evol 的完成定义

“观察到经验”不是完成，“生成 Candidate”不是完成，“校验 JSON/Markdown”也不是完成。一次本地进化必须经过以下链路：

```text
Episode / Trace / Evidence
          |
          v
PracticeDraft --独立复现--> Practice revision
          |
          v
Candidate (immutable artifact)
          |
          v
Structural Qualification ----fail----> rejected / revised
          |
          v
Shadow
          |
          v
Paired Real Trial: baseline vs candidate
          |
          +----fail/inconclusive----> stay shadow / revise
          v
Canary (small percentage of later real tasks)
          |
          +----degraded----> rollback
          v
Production pointer
          |
          v
next turn/session/task load + inheritance proof
```

三种门禁不能互相冒充：

| 门禁 | 回答的问题 | 最大权限 |
|---|---|---|
| Structural Qualification | 资产格式、来源、作用域、静态安全是否合格 | Shadow |
| Paired Real Trial | 在冻结输入上，候选是否比基线更好且没有回归 | Canary |
| Canary Telemetry | 在后续真实任务上是否持续有效、成本可接受 | Production |

外部 JS evaluator 保留为可选 Evaluation Adapter，适合公司自有基准或可执行扩展评估；平台不能再把它当作 Evol 是否可工作的必填配置。默认路径应通过 `EvolutionTrialPort` 把对照试验交给平台正常的 Agent/Ticket/Mission 运行链，继续使用用户已经配置的 Provider。

## 4. 自治与审批策略

默认策略按资产风险和推广范围分层：

- 项目内 Memory 可在通过真实试验后自动 Canary，并在 Telemetry 通过后自动 Production。
- Prompt、Skill、Workflow 可自动进入 Shadow；只有配置允许且真实对照试验通过时，才能在原项目/agent-project 小流量 Canary。
- 本地 Plugin 是可执行能力，始终需要静态扫描、受控评估和人工批准，且只在 next session 加载。
- 从 project/agent-project 扩大到 AgentProfile 或 Company 永远创建新的 ScopePromotionProposal；不得改写原 Release。
- Company 推广必须经过其他项目/Agent 的 selected-control trial 和公司评审。

自治意味着系统能自己发现、提出、试验、观察和回滚；不意味着它能跳过效果证据或擅自扩大影响面。

## 5. Agent、项目和公司的成长归属

同一个 `AgentProfile` 代表同一个长期个体，它的个人能力在该私有部署内跨项目共享。项目中的 `WorkspaceAgent` 只是这个人的项目实例，保存项目局部状态和覆盖层。

```text
Company defaults
   |
   +-- AgentProfile: Alice  <---- Alice 的长期个人成长，跨项目共享
   |      |
   |      +-- WorkspaceAgent(Alice, Project A)  <---- agent_project 局部成长
   |      +-- WorkspaceAgent(Alice, Project B)  <---- 另一个局部实例
   |
   +-- Project A practices <---- 项目公共成长
   +-- Project B practices
```

加载优先级由具体资产策略定义，但任何 override 都必须可追溯、可回滚且不能放宽上层安全策略。一个项目实例的偶然经验不会自动污染 Alice 的所有项目；只有通过 Agent scope promotion 后才成为 Alice 的长期个人能力。

## 6. Organization & Talent 的冻结边界

第五框架拥有：

- Company、OrgUnit、RoleDefinition；
- TalentProfile / Employment / Assignment；
- RecruitmentRequest、Candidate、Assessment、HireDecision；
- 人才能力库存和任职生命周期。

它不拥有：

- Agent 的 turn 与工具执行；
- Ticket 状态和依赖；
- Mission 编排；
- Evol 的 Practice、Candidate、Release 或推广决策。

框架间只通过端口和事实协作：

```text
Organization & Talent --TalentCatalogPort--> Mission Control staffing
Mission Control --------TeamBinding--------> Agent Loop execution
Execution facts --------ObservationPort----> Evol
Evol release facts -----CapabilityFactPort-> Organization & Talent
```

未来招聘 MVP 的真实验收不是“能创建候选人”，而是：某 Mission 缺少能力 -> 生成 RecruitmentRequest -> 招聘/评估/雇佣 -> StaffingRequest 恢复 -> 原 Mission 幂等继续并完成。

## 7. 失败与降级规则

| 失败 | 系统行为 |
|---|---|
| Provider 不可用 | Trial 保持 pending/retry，不伪造 EvaluationRun |
| 没有可比较基线 | 标记 inconclusive，不进入 Canary |
| Candidate/证据 hash 改变 | 原试验失效，新建 immutable revision |
| 对照任务失败或污染 | 隔离该 trial，保留原生产 pointer |
| Canary 指标下降 | 自动 rollback，记录 restoration proof |
| 下一边界未观察到新版本 | 状态保持 waiting_for_activation，不报告完成 |
| Company trial 无足够跨项目样本 | 不允许公司批准 |

## 8. 非目标

- 不让 Evol 修改 AutoAgent 自身源码、提交 Git 或触发部署。
- 不把 Provider、Memory 或招聘重新塞进四个现有框架内部。
- 不用 LLM 自评文本替代 paired trial 和 Runtime telemetry。
- 不在当前 turn 中热替换 Prompt/Skill/Workflow/Plugin。
- 不在本期实现人才市场、薪酬、绩效或完整招聘 UI。

## 9. 行业做法的取舍

- 采用 Hermes 的经验：复杂任务后即时归纳，空闲/后台再整理；Memory 放短事实，Skill 放按需加载的长流程。
- 采用 LangGraph/CoALA 的分类：语义、情景、程序性记忆分开，写入既支持 hot path 也支持 background。
- 采用 OpenHands 的层级作用域：本地/用户/组织技能分别加载，但 AutoAgent 额外要求版本化发布、试验和回滚。
- 不采用“Agent 写完 Skill 就立即视为生效”的弱完成定义；AutoAgent 的公司场景必须保留真实任务效果和 scope promotion 证据。

## 10. 验收标准

本设计只有在以下真实链路完成后才算第一阶段交付：

1. 使用现有真实 Provider 完成至少两次相似项目任务并形成一个 Practice/Candidate；
2. 系统自动生成评估工作，不要求额外 evaluator 程序路径；
3. baseline/candidate 对照任务产出独立证据；
4. 通过者进入项目内 Canary，下一任务 trace 显示选中 Release；
5. 满足样本数后进入 Production 或失败回滚；
6. 再下一任务产生 actual inheritance proof；
7. 全程不跨 workspace/company 泄漏，服务重启后可恢复。

