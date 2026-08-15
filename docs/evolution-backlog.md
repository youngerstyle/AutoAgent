# Evol 待实现清单

更新时间：2026-08-15

本文件记录已经确认有价值、但尚未达到完成定义的 Evol 能力。条目只有在代码、测试、后续真实生命周期加载证据和文档同时完成后才能移出。

## Memory Retrieval V2

状态：待实现

目标：在 V1 硬约束与可解释评分之上，引入与当前任务内容相关的检索，但继续保持私有化、本地优先、可禁用和可审计。

- 为 Runtime context 增加规范化的 task objective、约束和关键实体输入；
- 提供本地 lexical/BM25 baseline，不依赖外部 SaaS；
- embedding 作为可选本地 Provider adapter，未配置时不得影响 Evol 健康状态；
- 对候选做语义相关度评分，并记录 query、模型/索引版本和分数组件；
- 使用 MMR 或等价方法控制重复内容与覆盖多样性；
- 从固定 `top 20` 升级为 token budget packing，超预算时给出未选择原因；
- 将负面适用条件和冲突关系作为硬过滤，不交给相似度分数覆盖；
- 建立离线 replay suite，比较任务成功、召回、误注入、token 成本与稳定性。

退出标准：同一冻结输入和索引版本可重放得到同一选择；禁用语义检索时无损回退 V1；不能跨 Company/Project/Agent scope 泄漏。

## Memory Policy Learning V3

状态：待研究，未承诺自动上线

- 基于 selected/control Episode 学习评分权重，不允许直接改生产策略；
- 新权重作为版本化 policy candidate 进入评测、Canary、审批和 rollback；
- 防止热门任务、短期指标和单一 Agent 数据支配全公司策略；
- 检测反馈回路：被选中才有使用数据、未选中长期无法获得数据；
- 支持每个 Company 使用独立策略，不训练或推广到其他私有化部署。

## 生命周期增强

状态：待实现

- stale Memory 的受控再验证队列，而不是只能人工恢复；
- 重复/包含/冲突 Memory 的合并建议和证据迁移；
- 按 Company 配置半衰期、stale/archive 窗口和注入预算；
- 管理页展示评分拆解、未入选原因、生命周期时间线与恢复入口。

## Reflection 因果验证 V2

状态：待实现

- 对人工干预、自动恢复动作和最终结果建立显式 effect window；
- 从相似任务中构造未采用该 Practice 的本地 control，不跨 Company 取样；
- 标记 Provider 自然恢复、环境变化、人工补充输入等混杂因素；
- 为 PracticeDraft 增加因果置信度、支持证据和反证据，不让模型文字替代测量；
- 提供 draft reject/supersede 与同义合并，清理历史低质量草稿但保留审计事件。

退出标准：单 Episode 只能产生候选假设；只有独立复现和效果证据达到门禁后才能进入 Practice/Candidate，且所有结论可回查到本地 Episode、Trace、人工消息和 Evidence。
