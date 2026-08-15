# Evol 本地资产自进化实施计划

依据：`docs/superpowers/specs/2026-08-14-self-mutation-activation-v1.md`

状态：V1 completed（2026-08-15；可选增强见第 9 节）

## 1. 范围

V1 只交付四类本地、版本化资产：

| Asset | 形成方式 | 生效边界 | 回滚边界 |
| --- | --- | --- | --- |
| Memory | 真实 Episode 归纳为 scoped release | 下一 turn | 下一 turn 恢复 previous release |
| Prompt | 明确 prompt attribution 形成最小 fragment | 下一 turn | 下一 turn 恢复 previous release |
| Skill | 明确 skill attribution 形成本地 Skill package | 下一 turn | 下一 turn 卸载坏版本或恢复 previous release |
| Local Plugin | 生成本地 Bundle，经扫描、评测、批准 | 下一 session | 下一 session 卸载坏版本或恢复 previous release |

模型 Provider 保留现有配置与选择机制。它是模型调用依赖，不是本地 Evol 的“交付 Provider”，也不改变上述四类资产的生效边界。

AutoAgent 自身源码和软件交付不属于本计划，也不进入 Evol 的类型、状态、API、UI 或完成验收。

## 2. 核心不变量

1. Candidate、approved release、active pointer 和 runtime inheritance 是不同事实。
2. 当前 turn/session 不热替换；只在声明的下一生命周期边界重新解析 active generation。
3. Runtime 只从不可变本地 release store 加载，不从 Candidate 草稿目录加载。
4. 每次实际加载必须记录 release id、content hash、generation、turn/session ref 和 runtime surface hash。
5. rollback 创建新的 restoration generation，不能篡改历史 ledger。
6. 没有后续 inheritance proof 时，UI 只能显示“等待生效”，不能显示“已生效”。
7. 本地 Plugin 默认由 AutoAgent 内置跨平台子进程 Host 加载；外部 OS 隔离器是可选加固，不是激活前提。

## 3. Milestone A：统一本地 Mutation 与 Activation

- [x] 定义 Candidate、Release、active pointer、generation、ActivationRecord 和 InheritanceProof。
- [x] 将 promotion 与 activation 分离。
- [x] rollback 生成新的 restoration generation。
- [x] 删除软件交付 API/UI 与启动配置，确保它不进入本地 Evol 判断。

退出标准：任意资产都不能仅凭 Candidate 或 promotion 被展示为已生效。

## 4. Milestone B：Memory 与 Prompt 的 next-turn 闭环

- [x] Memory/Prompt 在 turn 开始时按 generation 重建 projection。
- [x] Prompt 可从真实终态 Episode 和明确归因形成 Candidate。
- [x] Prompt 后续 Pi turn 继承，并由真实 cohort telemetry 触发 rollback。
- [x] 补齐 Memory 从真实 Episode 形成 Candidate、后续 turn 继承、rollback 后恢复 previous revision 的单链路验收。

退出标准：Memory 和 Prompt 都有“真实 Episode -> Candidate -> release -> 下一 turn inheritance proof -> rollback/restoration proof”的端到端证据。

## 5. Milestone C：Skill 的 next-turn 闭环

- [x] 明确 `component=skill` 的重复归因可形成本地 Skill Candidate。
- [x] active Skill release 可进入后续 turn 的 context/tool projection。
- [x] 增加单链路验收：真实 Episode -> Skill package -> promotion -> 下一 Pi turn 加载 -> rollback -> 再下一 turn 卸载或恢复旧版本。
- [x] 验证 Skill 的 package hash、resolved refs 与 runtime surface hash 都进入 proof。

退出标准：不能只证明“生成了 SKILL.md”或“projection 单元测试通过”；必须证明真实后续 turn 使用了它，并证明回滚后的下一 turn 状态。

## 6. Milestone D：Local Plugin 的 next-session 闭环

- [x] 定义不可变 Plugin Bundle、manifest、文件 hash、权限声明与静态扫描。
- [x] Plugin Candidate 要求独立评测与 human approval，禁止 proposer 自批 production。
- [x] Pi runtime 按 session fingerprint 挂载命名空间隔离的 Plugin tools。
- [x] capability broker 复用 Workspace scope、Agent policy 与 Evidence 记录。
- [x] 让未配置任何 WSL/PowerShell/外部 sandbox launcher 的环境使用内置本地 Host 完成 canary、production 和真实调用。
- [x] 验证 production pointer 改变不会热插入旧 session，而是由下一 session 加载。
- [x] 验证 rollback 后下一 session 卸载坏工具或恢复 previous Plugin release。

退出标准：清空外部 launcher 配置后，真实 Pi session 仍能加载并调用本地 Plugin；回滚后的新 session 不再暴露坏工具；全过程有 session inheritance proof。

## 7. Milestone E：主动选择与效果闭环

- [x] 未知归因不生成资产。
- [x] Prompt/Skill 使用直接 component attribution，避免把模型、环境或 Provider 故障写进资产。
- [x] Coordinator 先运行 Memory、Prompt、Skill consolidation；Local Plugin 只能通过显式 Candidate authoring 进入，不会由未知归因自动生成。
- [x] Plugin production 必须经过 scanner、独立 evaluation 与 human approval，Agent proposal 本身不产生挂载。
- [x] Prompt 已由真实 cohort telemetry 自动 rollback；Memory、Skill 与 Plugin 的人工 rollback 均由后续 turn/session 证明实际恢复或卸载。

退出标准：Agent 可以提出本地改进，但不能用自评替代独立评测、实际继承和后续效果事实。

## 8. Milestone F：管理面与完成审计

- [x] 展示 Candidate、approved、waiting、activated、degraded、rolled back 与 actual proof。
- [x] 删除软件交付配置和状态表达。
- [x] 首页只围绕四类本地资产展示 active revision、边界、实际继承和回滚状态。
- [x] 运行四条端到端链、全量测试、类型检查、生产构建和文档一致性审计（93 files / 714 tests）。

退出标准：完成审计逐项对应主规范第 11 节八条要求；只能用本地资产的实际生命周期事实补足证据。

## 9. 非阻塞扩展

以下代码或设计可以保留，但必须明确标记为 V1 之外的可选 adapter：

- AutoAgent 自身源码与软件交付；
- WSL、bubblewrap、container、gVisor、Firecracker 等外部隔离器；
- Agent Profile、Workflow、Runtime Config 等扩展资产边界；
- 模型权重训练和当前进程热替换。

这些能力不属于本地 Memory/Prompt/Skill/Plugin Evol。
