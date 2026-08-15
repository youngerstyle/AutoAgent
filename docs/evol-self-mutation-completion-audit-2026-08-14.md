# Evol 本地资产自进化 V1 完成审计

日期：2026-08-15

依据：`docs/superpowers/specs/2026-08-14-self-mutation-activation-v1.md`

结论：**本地 Evol V1 完成。** Memory、Prompt、Skill 和 Local Plugin 均已有版本化 Candidate/Release、后续生命周期实际继承和 rollback 证据。旧审计把 Source Patch、托管 CI/CD 和 Runtime deployment report 当成关闭条件，这是错误的，已废止。

## 审计口径

- 唯一核心资产是 Memory、Prompt、Skill、Local Plugin。
- Memory/Prompt/Skill 由下一 turn 重新加载；Local Plugin 由下一 session 重新加载。
- Candidate、测试中构造的 projection 或一次性脚本执行都不等于自进化完成。
- “activated” 同时要求 active pointer change、后续真实运行 observation 和 inheritance proof。
- rollback 在相同生命周期边界被后续运行观察，并留下 restoration/unmount 事实。
- 模型 Provider 继续正常存在；远端交付 Provider 未配置不影响本地 Evol 健康。

## 完成定义逐项证据

| # | 要求 | 结论 | 权威证据 |
| --- | --- | --- | --- |
| 1 | Memory：真实 Episode -> Candidate -> 下一 turn -> previous release rollback | 已证明 | `evolution-evaluation.test.ts` 的 “evolves Memory from terminal Episodes and restores the previous release in a later Pi turn” 从两条终态 Episode 形成 Memory Candidate，先后发布两个不可变 release，后续 Pi turn 继承新版本，rollback 后下一 Pi turn 恢复旧版本并记录 generation 3 proof。 |
| 2 | Prompt：明确归因 -> Candidate -> 下一 turn -> telemetry rollback | 已证明 | 同文件的 “evolves a Prompt from terminal Episodes, inherits it in a later Pi turn, and rolls it back from real cohort telemetry” 使用真实终态 Episode、后续 Pi context 和 selected/control cohort telemetry 完成自动回滚。 |
| 3 | Skill：明确归因 -> 本地 package -> 下一 turn -> rollback | 已证明 | 同文件的 “evolves a Skill from terminal Episodes, loads it in a later Pi turn, and unloads it after rollback” 形成真实 Skill package，经 validation/evaluation/promotion 后由后续 Pi turn 继承；rollback 后再下一 turn 不再加载。 |
| 4 | Local Plugin：Bundle -> scan/eval/approval -> 下一 session 调用 | 已证明 | `evolution-plugin-runtime.test.ts` 在未配置外部 launcher 时发布 Plugin Bundle；真实 Pi session 看到并调用 namespaced tool，Activation Store 写入 session inheritance proof。 |
| 5 | Plugin rollback 后下一 session 卸载 | 已证明 | 同一 Plugin runtime 测试在同一 Thread rollback 后触发 session fingerprint 重建，下一 session 不再暴露坏工具。 |
| 6 | 当前 turn/session 不热修改，切换有 actual proof | 已证明 | turn projection 只在 turn 开始解析 generation；Plugin 只在 session fingerprint 重建时挂载。`evolution-activation.test.ts` 验证 pointer change 只能进入 waiting，actual observation 后才 activated。 |
| 7 | UI 区分生命周期状态并展示 proof | 已证明 | Evol 页面展示 Candidate、promotion、waiting、activated、degraded、rolled back、generation、boundary 和 actual runtime snapshot；核心指标只统计四类本地资产。类型检查与生产构建通过。 |
| 8 | 不依赖 SCM/CI/K8s/WSL/PowerShell/外部交付或沙箱 Provider | 已证明 | Plugin scanner/canary/runtime/host 测试显式清空外部 launcher 后通过；worker API 不再暴露 delivery/sandbox configured 健康字段；可选源码交付面板仅在确有记录时出现。 |

## 安全与权限结论

- Runtime 只加载 active immutable release，不读取 Candidate 草稿。
- Plugin 使用内置本地子进程 Host、最小环境、deadline、协议上限、Node Permission Model 和 broker capability；外部强隔离 Host 是不受信多租户部署的可选加固。
- Plugin production 仍要求 scanner、独立 evaluation 与 human approval；Agent 不能自批。
- 模型 Provider 保留现有 OpenAI、Anthropic、Mock 配置，不与可选软件交付 Provider 混淆。

## 明确不计入 V1 的能力

- 修改或发布 AutoAgent 自身源码；
- GitHub/GitLab branch、PR、CI、build artifact 或 reviewer；
- Kubernetes、canary/production 应用部署与 Runtime source revision report；
- WSL、PowerShell、bubblewrap、container、gVisor 或 Firecracker；
- 远端 Source Patch Delivery Gateway。

这些能力可以作为未来团队/SaaS adapter 独立演进，但未配置时不能改变本地 Evol 的状态或完成结论。

## 最终验证

- `npm.cmd run typecheck`：通过。
- `npm.cmd test -- --run`：96 个测试文件、721 项测试全部通过。
- `npm.cmd run build`：通过；Vite client 与 TypeScript server production build 成功。
- `git diff --check`：通过。
