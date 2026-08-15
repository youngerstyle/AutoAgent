# Evol 本地资产自进化 V1 完成审计

日期：2026-08-15

依据：`docs/superpowers/specs/2026-08-14-self-mutation-activation-v1.md`

结论：**尚未完成，正在按四类本地资产重新验收。** 旧审计把 Source Patch、托管 CI/CD 和 Runtime deployment report 当成关闭条件，这是错误的，现已废止。

## 审计口径

- 唯一核心资产是 Memory、Prompt、Skill、Local Plugin。
- Memory/Prompt/Skill 必须由下一 turn 重新加载；Local Plugin 必须由下一 session 重新加载。
- Candidate、测试中构造的 projection 或一次性脚本执行都不等于自进化完成。
- “activated” 必须同时有 active pointer change、后续真实运行 observation 和 inheritance proof。
- rollback 必须在相同生命周期边界被后续运行观察，并留下 restoration proof。
- 模型 Provider 继续正常存在；远端交付 Provider 未配置不影响本地 Evol 健康。

## 当前证据账本

| 资产/要求 | 当前判断 | 已有证据 | 仍需补齐 |
| --- | --- | --- | --- |
| Memory：真实 Episode -> 下一 turn -> rollback | 部分证明 | 已有 Memory consolidation、next-turn projection、两个不可变 release 的 restoration generation/proof 测试 | 用单条真实链串起 Episode、Candidate、继承与恢复 |
| Prompt：明确归因 -> 下一 turn -> telemetry rollback | 已证明 | `evolution-evaluation.test.ts` 已覆盖真实终态 Episode、Candidate、后续 Pi turn inheritance 和真实 cohort rollback | 回归确认即可 |
| Skill：明确归因 -> 本地 package -> 下一 turn -> rollback | 部分证明 | 已有真实 attribution 生成 Skill Candidate，以及 active Skill projection/卸载测试 | 增加真实 Pi turn 的完整生成、加载、回滚单链路 |
| Local Plugin：Bundle -> 下一 session -> 调用 -> rollback | 待重新确认 | 已有 Bundle/scanner/eval/approval/Pi session/rollback 测试链 | 去掉外部 launcher 前提后，确认内置本地 Host 独立通过整条链 |
| 当前 turn/session 不热修改 | 已有结构性证据 | turn 开始解析 generation；Plugin fingerprint 变化重建 session | 随四条资产链回归验证 |
| UI 展示 actual proof，外部交付不影响健康 | 未完成 | 已能显示 activation proof 与 lifecycle 状态 | 删除源码交付 Provider 红色失败状态并重新审计 |

## 明确废止的旧结论

以下内容不再属于本地 Evol V1 的完成证据或阻塞项：

- GitHub/GitLab 可操作身份、branch、PR 或独立 reviewer；
- 外部 CI、build artifact、镜像仓库；
- Kubernetes、canary/production deployment；
- Runtime actual source revision report；
- WSL、PowerShell、bubblewrap 或外部 Sandbox Provider；
- 修改、构建、发布 AutoAgent 自身源码。

仓库里的 Source Patch 和远端 Delivery Gateway 实验代码可以作为未来团队/SaaS 软件交付 adapter 保留，但必须与本地资产自进化分栏、分状态、分验收，不能再冒充 Evol 核心。

## 关闭目标前的实际工作

1. 完成 Memory 真实 Episode 单链路验收。
2. 完成 Skill 真实 Pi turn 单链路验收。
3. 证明 Local Plugin 无任何外部 launcher 时在下一 session 加载并可回滚。
4. 清除 UI、README 和相关设计中“交付 Provider 未配置 = Evol 失败”的残留。
5. 通过四条聚焦验收、全量测试、类型检查和生产构建后，更新本审计为最终事实。
