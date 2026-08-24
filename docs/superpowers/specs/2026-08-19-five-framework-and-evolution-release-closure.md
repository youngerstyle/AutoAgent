# 四框架方向、组织人才边界与 Evol 发布闭环设计

日期：2026-08-19  
状态：Accepted，作为后续实现与验收基线

## 1. 决策摘要

AutoAgent 的长期运行内核确定为四个相互解耦的框架：

1. **Agent Engine / Agent Loop**：单个 Agent 的 turn、工具调用、上下文和结果。
2. **Ticket Engine**：工作项、依赖、领取、阻塞、完成事实。
3. **Mission Control**：把目标、团队与 Ticket 编排为可恢复的 Mission。
4. **Evol**：从真实经历形成可复用能力，评估、发布，并在后续边界加载。
**Organization & Talent 不是第五框架**。公司、岗位、人才、雇佣、招聘和任职是独立业务域；它通过人才供给端口服务 Mission Control，不拥有新的执行循环、调度内核或发布生命周期。`StaffingRequest` 属于 Mission Control 的任务启动/恢复协议，人才模块只是该协议的一个提供者。

本期选择 **HOLD SCOPE**：先闭合 Evol 的真实发布链；只冻结 Organization & Talent 业务域边界，不把招聘 UI 或人才市场混进本期代码。文件名中的 `five-framework` 是早期判断的历史痕迹，不再代表本设计结论。

Evol 不是源码自修改器，也不是部署系统。它管理的进化资产是 Memory、Prompt、Skill、Workflow 和本地 Plugin；资产只在声明的下一 turn、session 或 task 边界加载。GitHub、CI、Kubernetes 都只能是可选适配器，不是进化前置条件。

## 2. 为什么招聘不是第五框架

现有代码已经有 AgentProfile、WorkspaceAgent、TeamBinding、StaffingRequest 和基本 roster。这些证明“组织与人才”有真实业务领域，但不证明它需要与 Agent/Ticket/Mission/Evol 同级的运行框架。框架的判据是拥有独立、持续的状态机与运行生命周期；招聘是一段按需业务流程，其结果是人才事实和可用 Assignment，随后仍由 Mission Control 组队、Ticket 分工、Agent 执行。

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
最后让 Organization & Talent 业务模块使用这些能力事实做招聘与配置
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

指标同样属于发布契约，不是 LLM 自由文本：Practice/Candidate 只能声明平台注册且能从权威运行事实计算的指标；未知指标在不可变 Candidate 创建前直接拒绝。资源和延迟门禁始终存在，并按 Memory/Prompt、Skill/Plugin、Workflow 等资产的真实生命周期使用平台上限；候选可以声明更严格预算，不能放宽平台预算。当前使用绝对预算，后续再以版本化策略加入相对基线/置信区间。

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

## 6. Organization & Talent 业务域的冻结边界

该业务域拥有：

- Company、OrgUnit、RoleDefinition；
- TalentProfile / Employment / Assignment；
- RecruitmentRequest、Candidate、Assessment、HireDecision；
- 人才能力库存和任职生命周期。

它不拥有：

- Agent 的 turn 与工具执行；
- Ticket 状态和依赖；
- Mission 编排；
- Evol 的 Practice、Candidate、Release 或推广决策。

它与四个框架只通过端口和事实协作：

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
| Paired trial 产生 Episode | 只作为 Evaluation/Telemetry 事实，禁止进入 Experience -> Dream 学习池 |
| 同一 kind/target/scope 已有未决 challenger | 新 Practice binding 保持 proposed，前一 challenger 失败或进入 Production 后再编译 |
| Canary 指标下降 | 自动 rollback，记录 restoration proof |
| 下一边界未观察到新版本 | 状态保持 waiting_for_activation，不报告完成 |
| Company trial 无足够跨项目样本 | 不允许公司批准 |

## 8. 非目标

- 不让 Evol 修改 AutoAgent 自身源码、提交 Git 或触发部署。
- 不把 Provider、Memory 或招聘业务模型塞进四个框架内部；Mission Control 只持有稳定的人才供给端口和 Staffing 协议。
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

## 11. 真实试验隔离补充

Paired trial、Canary 与普通生产经历在数据用途上必须严格区分：

- paired qualification task 是“测量流量”，不得成为下一版 Candidate 的独立支持 Episode；
- Canary/Production later-task 才是“效果流量”，可以进入遥测，并在发布窗口结束后作为新的生产经验；
- 同一 `kind + target + scope` 采用 incumbent/challenger 单飞模型。新证据可以继续形成 Practice revision 和 proposed binding，但不能并发启动多个 challenger；
- Provider、Staffing 和 Agent Engine 的基础设施失败必须跨框架归因到 trial 的 `infrastructure_failed`，不得作为候选质量失败或 human business input；
- 每次干净重跑创建新的 immutable EvalSuite/Trial lineage，历史失败保留，不覆盖、不改写。
- 每个 paired generation 只冻结一次项目文件 snapshot，再为各 case 的 baseline/candidate 派生独立 physical execution root；逻辑 workspace identity 保持不变，Candidate/Release 从原项目只读解析。
- arm 内 Runtime、Mission、Ticket、Agent、Staffing 与 Evidence 状态不得在执行期写回原项目。终态汇聚该 arm 的完整 Evidence Ledger、generation manifest 和 snapshot hash，随后停止 host 并清理执行副本；进程重启必须从同一 arm root 恢复。

## 12. 2026-08-19 真实发布验收结论

本设计的第一阶段完成定义已由用户现有 Provider 和本地平台服务真实闭合：

- grader-v3 paired trial `paired_trial_e34ad74241e94e2f2ad291e5cf908c91` / Evaluation `eval_a6864db9dc444a72` 证明候选在 target 上把成功率与质量从 0.6667 提升到 1.0，并通过 sealed regression/safety 与资源、延迟门禁；
- 25% Canary 使用真实任务自然分桶：对照任务加载 builtin，实验任务加载 `7-canary`，两者均由完整四框架链和独立 QA 完成；
- Telemetry `telemetry_622a5e4192de4da2` 包含五对独立 Episode，成功率、质量、证据完整度均无回退，资源预算通过且平均延迟下降约 2.1 秒；
- Production Release `release_debe5ddbe6f8cc19805c37a21ec9d02b` 在冷重启后的新任务中以 `stage=production` 加载，并完成实践宣讲 -> 规划 -> 实现 -> 独立 QA -> 最终验收；
- 随后真实回滚把 Production 指针置为 inactive。再次冷重启的新任务加载 builtin 并完成，证明 Release 与 rollback 均在下一 session/turn 边界生效；验收环境最终停留在安全 baseline。

历史验收发生在文件面隔离落地前，因此其效果量仍按当时的限制解释；后续 paired generation 已使用独立 execution root，历史 Evaluation 不追溯改写。
