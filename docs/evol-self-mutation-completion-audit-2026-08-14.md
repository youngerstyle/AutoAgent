# Evol Self-Mutation + Activation V1 完成审计

日期：2026-08-14  
依据：`docs/superpowers/specs/2026-08-14-self-mutation-activation-v1.md`  
结论：**未完成**。完成定义 1–5、7、9、10 已有代码与自动化证据；第 6 的真实托管 deployment/Runtime report 尚未执行，因此第 8 的真实 deployment rollback 也没有生产证据。测试 Provider 或 loopback Gateway 不计作托管部署证明。

## 审计方法

- 以当前 Git worktree、append-only ledger 实现、Runtime 调用路径和实际测试输出为准。
- 接口存在、类型检查通过或构造 Fake Provider，不单独视为端到端证明。
- “activated” 必须同时存在 pointer change、后续生命周期 actual observation 和 inheritance proof。
- Source Patch 的本地真实 Git 测试可证明 branch/check/review/merge 语义，不能证明外部 CI、deployment 或运行实例。

## 完成定义逐项证据

| # | 要求 | 状态 | 权威证据与判断 |
| --- | --- | --- | --- |
| 1 | Memory 下一 turn 继承；rollback 后下一 turn 恢复旧 revision | 已证明 | `evolution-runtime-projection.test.ts` 的 “restores the previous Memory revision for a later turn and records a new proof” 使用两个不可变 Memory release，恢复 generation 3，并写入新的 turn inheritance proof。 |
| 2 | Skill/Prompt 下一 turn 改变 context/tool surface，当前 turn 不受影响 | 已证明 | `PiAgentRuntime.requireSession` 只在 turn 开始比较 `runtimeEvolutionStateFingerprint`，不会修改正在执行的 prompt/tool batch；`evolution-evaluation.test.ts` 的 Prompt Episode 闭环证明后续 Pi turn 实际继承，`evolution-runtime-projection.test.ts` 证明 Skill/Prompt active projection 与 hash 校验。 |
| 3 | Agent Profile 只影响新 session，旧 session 不混用 | 已证明 | `evolution-evaluation.test.ts` 的 “drains an existing Pi session before an activated Agent Profile is inherited” 在同一 Thread 两个 turn 间激活 Profile，验证 session ID 改变且只有新 session 写入 Profile inheritance proof；敏感 provider/model/policy 另由 `evolution-agent-profile-governance.test.ts` 验证 critical authority。 |
| 4 | Workflow 只影响新 TaskRun，已有 TaskRun 冻结 | 已证明 | `runtime-host.test.ts` 的 “freezes the inherited Workflow release and DAG hash in each new TaskRun” 验证旧 TaskRun 保留 revision/hash，新 TaskRun 使用新 generation；快照持久化在 `RuntimeTaskRecord.workflowSnapshot`。 |
| 5 | Source Patch 绑定 base；checks/review 失败不能 merge/activate | 已证明（本地 SCM 范围） | `evolution-local-git-provider.test.ts` 使用真实 Git bare repository、disposable worktree、精确 base、check 和独立 review；失败时 protected ref 不变。`evolution-source-patch-delivery.test.ts` 验证 base drift 与任一 gate 失败不产生 pointer/proof。 |
| 6 | 部署前 UI 仅 approved/deploying；Runtime 报告目标 commit 后才 activated | **未证明（生产）** | 状态机、UI 和测试 Provider 已证明该不变量；HTTPS Provider Gateway 已接线且未配置时返回 503。但当前没有 Gateway URL/Token、外部 CI/deployment target 或运行实例 actual report，不能声称真实托管演练完成。 |
| 7 | 每次执行可回答继承了哪些资产 | 已证明（支持的 Runtime 边界） | Pi context Trace 写入 Skill/Memory/Prompt/Profile/extension refs 与 snapshot；TaskRun、process boot、deployment 分别写入 task/process/deployment proof。`evolution-activation.test.ts` 验证无 proof 时状态只能 waiting，proof 后才 activated。 |
| 8 | telemetry 驱动 retain/rollback，恢复 previous known-good | 部分证明；生产 deployment 未证明 | Prompt 的真实 terminal Episode cohort 在 `evolution-evaluation.test.ts` 驱动 degraded + rollback；Memory/Prompt restoration generation 与 proof 已验证；Source Patch 测试 Provider 验证 previous deployment rollback，但真实托管 deployment 尚无外部证据。 |
| 9 | 核心契约不依赖 WSL/PowerShell | 已证明 | 核心 Provider contracts 与 HTTPS Gateway 无 shell；`LocalGitScmProvider` 使用 `spawn(program,args,{shell:false})`，仅是本地 adapter。全仓核心 Evol 文档明确 sandbox/launcher 不参与 active pointer 或继承判断。 |
| 10 | 临时脚本不能被标记为 activated | 已证明 | `EvolutionActivationStore.observe` 要求已存在且 pointer-changed 的精确 release/generation；Source Patch 在外部 delivery actual commit 前不写 pointer。API 未配置 production provider 时 fail closed 503，不能回退到脚本或 Fake Provider。 |

## Runtime Config 补充要求

虽然不在第 11 节十条编号中，目标显式包含 Runtime Config。`evolution-runtime-config.test.ts` 的 “freezes config at boot and only activates a later promotion on the next boot” 证明当前 process 不热更新，新 boot 才报告 config revision 和 process proof；schema 禁止凭据、provider/model、路径和根安全策略。

## 当前外部状态

- Git remote：`https://github.com/youngerstyle/AutoAgent.git`，远端 HEAD 为 `codex/agent-thread-runtime`。
- 本机未安装 GitHub CLI，当前进程无 GitHub/GitLab/Kubernetes/Evol delivery 配置。
- 仓库只有 `.github/workflows/linux-node.yml`，它验证 Linux Node；没有 build artifact、canary/production deployment 或 Runtime actual-report workflow。
- 因此不能安全推断部署平台，也不能把 push + Linux CI 当作 Source Patch production 演练。

## 关闭目标仍需的外部证据

1. 配置实现 `docs/evolution-delivery-provider-gateway-v1.md` 的真实 HTTPS Gateway。
2. 在受控外部仓库创建 Evol branch/PR，取得 required checks 与独立 review evidenceRef。
3. 构建内容寻址 artifact/image，部署 canary 后由运行实例报告 merge commit 和 runtime snapshot。
4. 晋升 production，确认 UI/ledger 从 deploying 变为 activated。
5. 对该 deployment 执行 rollback，运行实例报告 previous deployment，并生成新的 `rollback_restore` generation/proof。

在这五项完成前，实施计划保持 `In progress`，Goal 不得标记 complete。
