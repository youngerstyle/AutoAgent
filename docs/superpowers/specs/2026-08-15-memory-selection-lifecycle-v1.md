# Evol Memory 选择与生命周期 V1

日期：2026-08-15

状态：已实现

## 1. 目标

Memory 是经过证据、评测和发布流程形成的本地 Evol 资产。Runtime 在下一 turn 只从当前主体有权继承的 active release 中选择 Memory，并留下可解释的选择证据。选择算法不能让“固定”“公司级”或“最近被尝试”直接等同于“当前任务必须注入”。

## 2. 两阶段选择

第一阶段是不可被分数绕过的硬约束：

- scope、角色、task type、tool、provider 和 model 必须匹配；
- release、pointer、内容 hash、validation 和 safety provenance 必须有效；
- production Memory 的生命周期必须为 `active`；
- 同一 target 先按 `agent_project > project > agent > company` 解析所有权覆盖；
- 同一所有权层内 Canary、generation 和 release identity 按确定性规则解决冲突。

第二阶段才对已授权结果排序并取前 20 条。V1 评分为：

```text
score =
  0.30 * scopeSpecificity
+ 0.30 * effectiveness
+ 0.20 * evidenceConfidence
+ 0.15 * freshness
+ 0.05 * exploration
```

- `scopeSpecificity`：company=0.40、agent=0.65、project=0.80、agent_project=1.00；
- `effectiveness`：只以 succeeded 对 failed/returned 的 Beta(1,1) 平滑成功率计算；
- `evidenceConfidence`：5 个有结果 Episode 达到 V1 满置信度；blocked/cancelled 不伪装成成功或失败；
- `freshness`：以最后成功时间为锚点，30 天半衰期；从未成功则以注册时间为锚点；
- `exploration`：仅给已通过 Canary 路由的 Memory 0.05 上限探索奖励。

分数相同按 target、releaseId 排序，保证相同输入得到相同顺序。评分组件、策略版本和证据计数进入 Runtime context trace。

## 3. 生命周期

```text
registered -> active -> stale -> archived
                    \-> human restore -> active
```

- 默认 30 天没有成功使用：`active -> stale`；
- 默认 90 天没有成功使用：`stale -> archived`；
- failed、returned、blocked、cancelled 只更新观测，不刷新有效期；
- production Runtime 不加载 stale/archived Memory；
- pinned 只禁止自动淘汰，且非人工主体不能将其下线；pin 不参与选择评分，也不强制每 turn 注入；
- 恢复必须是显式生命周期事件，下一 turn 才重新解析。

一次使用只有在终态 Episode 与 Goal-scoped Runtime trace 同时证明对应 release 被加载时才记账。幂等 command identity 防止重复 Episode 重复累计。

## 4. V1 边界

V1 是无外部向量服务依赖、可回放、可解释的本地选择基线。它没有宣称完成任务正文语义相关度、embedding 检索、MMR 去重、token-budget packing 或在线权重学习；这些项目进入 Evol 待实现清单与技术债务账本。

## 5. 验收

- 失败使用不会延后 stale；
- pinned 与 unpinned 在其他输入相同时分数相同；
- 更具体、效果更好、证据更多、更新鲜的 Memory 得分更高；
- Canary 只有有界探索奖励；
- 排序稳定且最多注入 20 条；
- trace 可以解释每条 Memory 为什么入选。
