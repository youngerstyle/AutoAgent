# AutoAgent Evol Self-Mutation 与 Activation V1

日期：2026-08-14
状态：Accepted for implementation
取代：此前把 Plugin/Harness 执行等同于自进化的定义

实现状态说明：本文是完成定义，不以“接口存在”代替端到端完成。当前实现进度与尚未完成项以对应 implementation plan 为准。

## 1. 定义

Evol 是对系统可继承资产的闭环优化：

```text
Observe -> Attribute -> Mutate -> Validate -> Evaluate -> Approve
        -> Activate at boundary -> Inherit -> Measure -> Retain/Rollback
```

一次变化只有同时满足以下条件才算进化：

1. 修改被保存为不可变、版本化资产；
2. 存在明确的 previous/base version；
3. 变更通过与风险相称的验证和批准；
4. 后续运行在规定边界继承新版本；
5. Trace 能证明实际继承的版本；
6. 效果由后续事实衡量并可回滚。

创建 Candidate、通过离线 Eval、临时执行脚本或在当前进程内试跑新代码都不等于进化完成。

## 2. 设计依据

- QwenPaw 将 Skill Pool 与 Workspace runtime copy 分离，并从持久目录自动加载；长期 Memory 以跨会话文件保存。这证明能力资产与运行实例应分层。
- Qwen Skill Self-Play 采用“技能库 -> 验证任务 -> frontier feedback -> refinement/pruning/induction -> 写回技能库”的闭环；关键是更新可复用库，而不是一次执行。
- OpenGitOps 要求 desired state 声明式、版本化且不可变，由软件自动拉取并持续对账。Evol activation 使用相同的 desired/actual reconciliation 思路。
- Git protected branches 与 required status checks 把源码 mutation、独立验证和合并权限分离；源码自进化不得直接覆盖运行中生产文件。
- Evolutionary Architecture 使用小步变化与 fitness functions 持续反馈；Evol 的 Eval/Telemetry 是可执行 fitness functions，而不是模型自评。

参考：

- https://qwenpaw.agentscope.io/docs/skills/
- https://qwenpaw.agentscope.io/docs/memory/
- https://github.com/Qwen-Applications/skill-self-play
- https://opengitops.dev/blog/1.0-announcement/
- https://docs.github.com/en/pull-requests/reference/status-checks
- https://martinfowler.com/articles/evo-arch-forward.html

## 3. 两个控制面

### 3.1 Mutation Control Plane

负责 Experience、Attribution、Candidate、Validation、Evaluation、Approval 和 Release。它只能产生 desired state，不能把“候选已写入”冒充“Runtime 已采用”。

### 3.2 Activation/Reconciliation Plane

负责在生命周期边界比较 desired revision 与 actual revision，原子切换 active release，重建需要重建的 Runtime，并写入 inheritance proof。

Mutation 与 Activation 必须是两个独立命令和账本事件。同一 Agent 可以提出 Candidate，但不能伪造 Evaluation、Approval、Deployment 或 Inheritance。

## 4. 可进化资产与激活边界

| Asset kind | 持久形态 | 默认激活边界 | Actual proof |
| --- | --- | --- | --- |
| `memory` | 内容寻址 Memory release | `next_turn` | Turn Trace 的 memory release refs |
| `prompt` | 版本化 prompt fragment/template | `next_turn` | Turn context snapshot hash |
| `skill` | 版本化 Skill package | `next_turn`；含 session state 时 `next_session` | resolved skill refs/tool surface hash |
| `agent_profile` | Soul/Identity/model/tool-policy desired state | `next_session` | Agent session profile revision |
| `workflow` | Workflow template/DAG revision | `next_task` | TaskRun template revision |
| `runtime_config` | 非凭据、非根安全策略配置 | `next_restart` | process boot/config revision |
| `source_patch` | base commit + patch/branch + checks | `next_deployment` | deployment id + source commit |
| `plugin/harness` | 扩展 release | `next_session` | extension release refs；执行设施另行定义 |

边界规则：

- in-flight turn、session 中的原子工具调用、已实例化 TaskRun 和当前进程代码不得被中途替换；
- `next_turn` 在开始下一 turn 前比较 generation，不一致则重建 context/tool projection；
- `next_session` 只影响新 session，旧 session 在安全边界结束或被显式 drain；
- `next_task` 只影响新 TaskRun，已有 DAG 保持创建时快照；
- `next_restart` 必须由新进程报告 boot revision；
- `next_deployment` 只有运行实例报告目标 source commit/deployment id 后才算 activated。

## 5. Candidate 与 MutationSet

每个 Candidate 除现有证据、scope、hypothesis、metrics 和 content hash 外，还必须包含：

```ts
type ActivationBoundary =
  | "next_turn"
  | "next_session"
  | "next_task"
  | "next_restart"
  | "next_deployment";

interface MutationSet {
  assetKind: EvolutionArtifactKind;
  target: string;
  baseRef: { id: string; revision: string; contentHash: string };
  candidateRef: { id: string; revision: string; contentHash: string };
  representation: "full" | "json_patch" | "unified_diff";
  activationBoundary: ActivationBoundary;
  compatibility: Record<string, string>;
  rollbackRef: { id: string; revision: string; contentHash: string };
}
```

Validator 必须拒绝：base 不存在、base 已漂移、边界与 asset kind 不兼容、目标越出 scope、rollbackRef 不可解析、Candidate 修改未声明文件或字段。

## 6. Activation Ledger 与 Inheritance Proof

Promotion 只产生受批准的 Release；Activation 才改变 desired active pointer。最少事件：

```text
release.approved
activation.requested
activation.pointer_changed
runtime.reconciled
runtime.inheritance_observed
activation.healthy | activation.degraded
activation.rolled_back
```

`runtime.inheritance_observed` 必须引用真实 Turn/Session/TaskRun/Process/Deployment，并记录：

- desired generation；
- actual generation；
- asset kind/target/release/content hash；
- Runtime snapshot hash；
- observedAt 与权威 Trace ref。

UI 只有在看到 inheritance proof 后才能显示“已生效”。Pointer 已改变但 Runtime 尚未对账时显示“等待生效”，不能显示 active。

## 7. 各资产的激活语义

### 7.1 Memory、Prompt 与 Skill

- active pointer 改变 generation；
- 下一 turn 开始前读取 generation；
- 如果变化，销毁旧 context projection 并从 active release 重建；
- 本 turn 使用的 release refs 写入 Trace；
- rollback 同样通过 generation 在下一 turn 生效。

### 7.2 Agent Profile

- Profile mutation 不直接修改正在执行的 Agent object；
- 新 session 按 active revision 建立 Soul、Identity、model selection、tool policy；
- tool permission 扩大默认视为 critical，必须 human approval；
- 旧 session 可 drain，但不得静默混用两个 revision。

### 7.3 Workflow

- Workflow revision 只在创建 TaskRun 时解析一次；
- TaskRun 保存完整 template revision 和 DAG hash；
- 已创建任务不因新 revision 改变拓扑；
- 效果比较以不同 revision 的后续 TaskRun cohort 为单位。

### 7.4 Source Patch

源码自进化不是让运行进程执行 patch，而是软件交付流程：

```text
Candidate(base commit + patch)
 -> clean worktree/branch
 -> deterministic checks
 -> independent review
 -> merge protected branch
 -> build immutable artifact/image
 -> deploy canary
 -> process reports source commit
 -> inheritance proof
 -> production/rollback
```

规则：

- patch 必须绑定精确 base commit；base 漂移则重新生成 revision；
- Candidate 只能写 Evol policy 允许的 repository/path scope；
- 不允许直接修改当前生产 checkout、active binary 或进程内模块缓存；
- tests/build/security checks 必须绑定 candidate commit；
- proposer 不得写入自己的 check result 或 approval；
- merge/deploy 由外部受信 SCM/CD adapter attestation；
- V1 不自动批准触及认证、凭据、审计、权限根、Evol Gate 或部署控制面的 patch；
- rollback 指向已知良好的 previous deployment，不依赖反向生成 patch。

## 8. 主动进化循环

Evol Coordinator 独立于业务任务运行：

1. 周期性从权威终态组装 Episode；
2. 聚合同因失败、成本、延迟、返工和人工反馈；
3. 识别最小可变资产，不默认选择源码；
4. 生成最小 MutationSet 和可证伪 hypothesis；
5. 按风险运行 deterministic validation、frozen Eval 和 reviewer；
6. 激活后等待真实 inheritance proof；
7. 从 selected/control 后续事实计算效果；
8. retain、refine、stale 或 rollback。

选择顺序遵循最小有效变化：Memory -> Prompt/Skill -> Agent Profile/Workflow -> Source Patch。更高层变更只有在证据表明低风险资产无法解决问题时才提出。

## 9. 风险与权限

- low-risk scoped Memory 可以在证据、冲突和 telemetry gate 下自动激活；
- Prompt、Skill、Agent Profile、Workflow 默认不得由 proposer 自批；
- 权限扩大、根治理配置、Plugin/Harness 与 Source Patch 为 critical；
- Agent 只有 propose/status 权限；Validator、Evaluator、Approver、Activator 分权；
- Activator 只能激活已批准的精确 content hash；
- Runtime 只拉取 active release，不读取 Candidate 工作区；
- Evol 不能将 Ticket/Goal 状态改写为自己的“成功证据”。

## 10. SaaS 与跨平台边界

Evol Control Plane、Artifact Registry、Activation Ledger 和 Runtime reconciliation contract 必须平台无关。它们不得依赖 WSL、PowerShell、bubblewrap、Docker socket 或某个本地可执行路径。

外部能力通过 adapter 接入：

- `ScmProvider`：branch、commit、PR、review/status attestation；
- `BuildProvider`：构建不可变 artifact/image；
- `DeploymentProvider`：canary/production/rollback 与 deployment revision；
- `SandboxProvider`：仅用于需要执行不可信 Candidate 的评测或扩展运行，不是 Evol 核心依赖。

本地开发 adapter 可以调用本机 Git/进程；SaaS production adapter 可以调用 GitHub/GitLab、CI/CD、Kubernetes 或托管 runner。核心状态机不因 adapter 改变。

## 11. 完成定义

Self-Mutation V1 只有在以下端到端场景全部成立后完成：

1. Memory release 激活后，同一 Thread 下一 turn 继承新 revision，Trace 可证明；rollback 后下一 turn 恢复旧 revision。
2. Skill/Prompt release 激活后，下一 turn 的 context/tool surface hash 改变，当前 turn 不受影响。
3. Agent Profile 激活后，新 session 使用新 revision，已有 session 不被中途混合。
4. Workflow 激活后，新 TaskRun 使用新 DAG revision，已有 TaskRun 保持原快照。
5. Source Patch 生成绑定 base commit 的 branch/patch；checks 或审查失败时不能 merge/activate。
6. 部署完成前 UI 只显示 approved/deploying；Runtime 报告目标 commit 后才显示 activated。
7. 每次执行都有 inheritance proof，可回答“这次行为继承了哪些进化资产”。
8. 后续 telemetry 能驱动 retain/rollback，回滚恢复 previous known-good release/deployment。
9. 控制面和数据契约不依赖 WSL/PowerShell；任何本地执行器都只是 adapter。
10. 创建或执行一个临时脚本不能通过任何 API/UI 路径被标记为 evolution activated。
