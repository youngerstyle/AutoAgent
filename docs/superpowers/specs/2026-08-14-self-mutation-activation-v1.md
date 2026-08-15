# AutoAgent Evol 本地资产自进化与生命周期激活 V1

日期：2026-08-15

状态：Accepted for implementation

取代：把自进化错误扩张为源码交付、远端 CI/CD 或托管部署的设计

## 1. 定义

Evol 是本地 Agent 系统对可复用运行资产的持续改进：

```text
Observe -> Attribute -> Mutate -> Validate -> Evaluate -> Approve
        -> Publish local release -> Inherit at boundary -> Measure -> Retain/Rollback
```

V1 的核心资产只有：

- Memory
- Prompt
- Skill
- Local Plugin

一次变化同时满足以下条件才算完成一次进化：

1. 从真实 Episode、Trace、人工反馈或 telemetry 识别可复现问题；
2. 变化保存为本地、不可变、版本化的资产，并引用 previous/base revision；
3. 通过与风险相称的验证、评测和批准；
4. active pointer 在安全生命周期边界改变；
5. 后续 turn 或 session 实际重新加载该 revision；
6. Trace 留下 inheritance proof；
7. 后续事实可以保留、改进或回滚该 revision。

写一个脚本并执行一次不是进化；修改本地 Skill/Memory/Prompt/Plugin 库，并被后续运行自动继承，才是进化。

## 2. V1 不是什么

以下能力都不是本地 Evol 的前提：

- GitHub/GitLab 身份；
- PR、远端 CI、镜像构建；
- Kubernetes、托管部署或 Runtime deployment report；
- WSL、PowerShell、bubblewrap、Docker；
- 修改 AutoAgent 自身源码。

远端 SCM/CD 可以作为团队版或 SaaS 的可选软件交付能力，但不得出现在本地自进化完成定义中，也不得让管理页在未配置时显示 Evol 失败。

这里移除的是错误引入的“交付 Provider”依赖，不是模型 Provider。OpenAI、Anthropic、Mock 等模型 Provider 仍由现有模型服务配置和 Agent Profile 选择；Evol 可以在调用模型时沿用它们，但不得把“换模型 Provider”偷换成 Memory/Prompt/Skill/Plugin 自进化，也不得要求配置某个模型 Provider 才能加载本地进化资产。

## 3. 行业依据

- QwenPaw 将持久 Skill Pool 与运行时加载副本分开，并把长期 Memory 写入跨会话存储；核心是“更新本地资产库，后续运行重新加载”。
- Qwen Skill Self-Play 使用任务反馈持续 refinement、pruning、induction，再写回 Skill 库；不是要求每次能力改进都发布一版应用。
- Agent harness/plugin 系统把新能力保存为本地扩展包，由下一 session 发现和挂载；扩展宿主是实现细节，不是自进化本身。
- Evolutionary Architecture 的 fitness function 对应本地 Eval 与后续 telemetry；模型不能用自评代替运行事实。

参考：

- https://qwenpaw.agentscope.io/docs/skills/
- https://qwenpaw.agentscope.io/docs/memory/
- https://github.com/Qwen-Applications/skill-self-play
- https://martinfowler.com/articles/evo-arch-forward.html

## 4. 两个控制面

### 4.1 Mutation Control Plane

负责 Experience、Attribution、Candidate、Validation、Evaluation、Approval 和本地 Release。Candidate 写入不等于 Runtime 已采用。

### 4.2 Activation/Reconciliation Plane

负责维护本地 active pointer。新的 turn/session 比较 generation，重新加载对应本地资产，并写入 inheritance proof。

Mutation 与 Activation 是两个独立事件。同一 Agent 可以提出 Candidate，但不能伪造独立评测、批准、后续继承或效果数据。

## 5. 资产与边界

| Asset | 持久形态 | 激活边界 | Actual proof |
| --- | --- | --- | --- |
| `memory` | 内容寻址 Memory release | `next_turn` | Turn Trace 的 memory release refs |
| `prompt` | 版本化 prompt fragment/template | `next_turn` | Turn context snapshot 与 prompt release ref |
| `skill` | 本地版本化 Skill package | `next_turn` | resolved Skill refs 与 tool/context surface hash |
| `plugin` | 本地版本化 Plugin bundle | `next_session` | 新 session 的 plugin/tool refs 与 bundle hash |

扩展资产 `agent_profile`、`workflow`、`runtime_config` 可以继续复用统一 MutationSet，分别在 next session、next task、next restart 生效；它们不是本地 Evol V1 关闭目标的阻塞条件。

边界不变量：

- 正在执行的 turn、工具调用和 session 不热替换；
- Memory/Prompt/Skill 在下一 turn 开始前比较 generation；
- Plugin 变化会 drain 旧 session，并在新 session 重建工具面；
- rollback 也产生新 generation，在相同边界由后续运行继承；
- 没有后续 inheritance proof 时 UI 只能显示“等待生效”。

## 6. MutationSet

```ts
interface MutationSet {
  assetKind: "memory" | "prompt" | "skill" | "plugin";
  target: string;
  baseRef: { id: string; revision: string; contentHash: string };
  candidateRef: { id: string; revision: string; contentHash: string };
  representation: "full" | "json_patch";
  activationBoundary: "next_turn" | "next_session";
  compatibility: Record<string, string>;
  rollbackRef: { id: string; revision: string; contentHash: string };
}
```

Validator 必须拒绝：base 不存在或漂移、目标越出 workspace scope、资产 hash 不一致、声明边界错误、Plugin Bundle 文件未声明、Plugin 权限与实际静态扫描不一致。

## 7. 本地 Release 与 Inheritance Proof

最少事件：

```text
candidate.proposed
candidate.validated
release.approved
activation.requested
activation.pointer_changed
activation.inherited
activation.health_observed
activation.rolled_back
```

`activation.inherited` 必须记录：

- desired/actual generation；
- asset kind、target、release id、content hash；
- turn 或 session ref；
- Runtime context/tool snapshot hash；
- 权威 Trace ref 与 observedAt。

## 8. 四类资产语义

### 8.1 Memory

- 从重复、明确归因的终态 Episode 形成 scoped Memory Candidate；
- 低风险 Memory 可在独立评测与 telemetry gate 后自动晋升；
- 下一 turn 重建 Memory projection；
- stale/conflict/rollback 后下一 turn 移除或恢复 previous revision。

### 8.2 Prompt

- 只有明确 `component=prompt` 的重复归因才能改变 Prompt；
- Candidate 保存最小 prompt fragment，不重写整个 Agent；
- 下一 turn 重建 context；当前 turn 不受影响；
- selected/control 后续 Episode 驱动 retain/rollback。

### 8.3 Skill

- 只有明确 `component=skill` 的重复归因才能生成 Skill；
- Skill 保存为本地 `SKILL.md` package，并带 provenance、适用条件和验证步骤；
- 下一 turn 自动从 active Skill release 重新加载；
- 回滚后下一 turn 的 Skill/tool surface 恢复。

### 8.4 Local Plugin

- Plugin 是本地版本化 Bundle，不修改 AutoAgent 源码；
- Bundle 必须有 manifest、入口文件、content hash、权限声明和静态扫描报告；
- Plugin 在独立本地子进程 Host 中运行，只能调用 manifest 与 Candidate scope 共同允许的 broker capability；
- 默认 Host 不继承模型密钥和业务环境变量，不开放网络、子进程或任意 Workspace 写入；
- 新 production release 只在下一 session 挂载贡献的工具；旧 session 不热插入；
- rollback 后下一 session 卸载坏版本，或恢复 previous known-good Plugin release；
- 外部 OS 隔离器可以作为高安全部署的可选加固，但不是本地 Plugin 激活前提。

## 9. 主动选择

Evol Coordinator 按最小变化原则工作：

```text
Memory -> Prompt/Skill -> Local Plugin
```

未知归因不生成资产。Plugin 只有在证据表明静态 Prompt/Skill 无法提供所需工具能力时才进入 authoring；Plugin Candidate 不因被生成就自动获得批准。

## 10. 风险与权限

- scoped Memory 为 low risk；
- Prompt/Skill 需要独立评测，默认不能由 proposer 自批；
- Plugin 为 critical：可以由 Agent 编写，但 production 激活需要独立评测、静态扫描和 human approval；
- Runtime 只加载 active release，不读取 Candidate 工作区；
- Plugin 能力请求全部经过现有 AgentToolRuntime 权限与 Evidence Ledger；
- Evol 不得把 Ticket/Goal 状态改写为自己的成功证据。

## 11. 完成定义

本地 Evol V1 只有在以下场景全部成立后完成：

1. Memory 从真实 Episode 形成版本化 Candidate，后续 turn 继承；rollback 后后续 turn 恢复 previous revision。
2. Prompt 从明确归因的真实 Episode 形成 Candidate，后续 turn 继承，真实 cohort telemetry 可触发 rollback。
3. Skill 从明确归因的真实 Episode 形成本地 package，后续 turn 自动加载；rollback 后后续 turn 不再加载坏版本或恢复旧版本。
4. Plugin Bundle 由本地 Candidate 产生，经过扫描、独立评测与批准后，下一 session 真实看到并调用新工具。
5. Plugin rollback 后，同一 Thread 的下一 session 不再看到坏工具，或恢复 previous known-good Plugin revision。
6. 当前 turn/session 不被中途修改；每次边界切换都有 inheritance proof。
7. Evol UI 能区分 Candidate、approved、waiting、activated、degraded、rolled back，并展示实际 turn/session proof。
8. 整个闭环不要求 GitHub、CI、Kubernetes、WSL、PowerShell 或外部 deployment Provider。

Source Patch、远端 SCM/CD 和应用部署另立项目，不计入本地 Evol V1 完成或失败。
