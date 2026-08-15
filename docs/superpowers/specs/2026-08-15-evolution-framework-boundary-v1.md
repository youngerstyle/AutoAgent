# Evol 第四框架解耦设计

日期：2026-08-15

状态：第一阶段已实现；剩余依赖按本文完成定义继续迁移

## 1. 定位

AutoAgent 有四个并列领域框架：Mission Control、Ticket、Agent Loop 与 Evol。Memory 不是第五个框架，而是 Evol 内部的学习、检索和生命周期模块。

Evol 可以与平台同进程部署，也可以以后独立进程部署；“独立”由依赖方向、数据所有权和端口契约决定，不由进程数或目录名决定。

## 2. 依赖规则

```text
Ticket / Mission / Agent Loop
          │ normalized observations
          ▼
  EvolutionObservationPort
          ▼
         Evol
          │ versioned capability snapshot
          ▼
AgentEvolutionRuntimePort / EvolutionPlatformPort
          ▼
 Agent Loop / Mission Runtime
```

- Evol 核心不得读取 TicketStore、MissionStore、AgentStore、AgentTraceStore；平台适配器负责归一化事实。
- Agent Loop、Mission Runtime 不得 import Evol Store、Projection、ActivationStore 或 PluginHost；它们只依赖自己拥有的端口。
- 适配器可以同时依赖两侧，且只能位于 `src/server/evolution-adapters`。
- 关闭 Evol 时，前三个框架继续使用 builtin workflow、基础 profile、基础 skills/tools 正常工作。
- 启用 Evol 时，Memory/Prompt/Skill 在下一 turn、Workflow 在下一 task、Plugin/Harness/Agent Profile 在下一 session 生效。

## 3. 已落地边界

- `EvolutionObservationPort`：Evol 接收 Episode facts 与 Memory usage observations；
- `PlatformEvolutionObservationAdapter`：唯一负责组合 Ticket、Mission、Agent 与 Evidence 事实；
- `AgentEvolutionRuntimePort`：Agent Loop 获取快照、扩展工具并记录继承；
- `EvolutionPlatformPort`：Mission Runtime 获取 Workflow 与 Agent Profile；
- disabled/null 实现：不创建 Evol 数据、不改变前三个框架状态；
- Runtime projection 数据契约移动到 shared contracts，不再由 Evol 实现文件拥有；
- 架构测试阻止核心消费者重新 import Evol implementation。

## 4. 尚未完成的内核纯化

以下依赖仍在 Evol 目录内，不能据此宣称整个第四框架已经完全物理解耦：

- Candidate sourceRef 验证仍直接解析 Agent/Ticket/Mission 具体存储；
- Canary 与 Company Trial reconciler 仍直接读取 Agent trace；
- Signal ingestor 仍直接读取 Agent aggregate；
- 多个评测组件仍从历史路径读取 Evidence Ledger；
- Plugin Host 和进程管理实现仍引用 Agent Tool Runtime 类型。

这些项目必须迁移为 Source Verification、Telemetry Observation、Signal Observation、Evidence Repository 与 Tool Host 端口。完成前，状态只能称为“第四框架边界已建立，迁移进行中”。

## 5. 完成定义

- `src/server/evolution` 不 import `agent-engine`、`tickets`、`mission-process` 或具体 Runtime Store；
- `agent-engine`、Mission 与 Ticket 核心不 import `evolution` 或 `evolution-adapters`；
- 所有跨框架事实都有版本化 schema、幂等 identity 和来源引用；
- disabled Evol 的三框架端到端测试通过；
- enabled adapter 的 Memory、Skill、Prompt、Workflow、Plugin 生命周期回归全部通过；
- 架构依赖扫描纳入测试，防止反向依赖复发。
