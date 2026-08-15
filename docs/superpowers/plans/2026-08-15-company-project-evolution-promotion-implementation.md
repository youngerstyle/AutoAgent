# Agent/Project/Company Evolution Promotion 实施计划

依据：`docs/superpowers/specs/2026-08-15-company-project-evolution-promotion-v1.md`

状态：Planned

## Milestone A：公司与 Agent 身份

- [ ] 在 `AUTOAGENT_HOME` 持久化稳定 `companyId`。
- [ ] 建立稳定 `CompanyAgentIdentity`，从 `AgentProfile` 和 `WorkspaceAgentAssignment` 解耦。
- [ ] 迁移现有 Workspace Agent 时保持身份映射可审计，不把共享 Profile 当成同一个 Agent。
- [ ] 建立 Company Practice/Release/Promotion ledger。
- [ ] 建立 Agent long-term Practice/Release ledger。
- [ ] 保留 Workspace Episode 与项目 Release store。
- [ ] 证明两个私有部署之间完全隔离，同一公司多个 Workspace 可被公司控制面发现。

## Milestone B：开放式 Practice

- [ ] 定义 Practice、PracticeRevision、Binding 和 provenance contracts。
- [ ] 从 Episode/Attribution 归纳开放式 hypothesis、trigger、procedure、scope 和 contraindications。
- [ ] 禁止无来源、单次偶然或预设模板反向归因生成 Practice。

## Milestone C：个人与项目实验

- [ ] 建立 project treatment/control assignment 与效果窗口。
- [ ] 支持 agent-project、agent、project 三类局部 active pointer 与独立 rollback。
- [ ] 将 Practice Binding 编译为 Memory/Prompt/Skill/Workflow/Plugin release。
- [ ] 在对应 next-turn/next-task/next-session 边界继承和回滚。

## Milestone D：公司推广

- [ ] 支持 agent-project -> agent、agent-project -> project、agent/project -> company 的显式 Promotion Proposal。
- [ ] 公司评审 generalizability、脱敏、适用范围、成本和风险。
- [ ] 在其他代表性项目运行 company trial。
- [ ] 通过跨项目效果门禁后发布 company active release。

## Milestone E：分层解析与管理面

- [ ] 实现 built-in < company < agent < project < agent-project < invocation safety 的行为解析顺序。
- [ ] 强制 policy 使用逐层取交集语义，任何下层资产不能放宽上层约束。
- [ ] 新项目自动继承公司默认；现有项目按生命周期边界重载。
- [ ] 项目 pin/override 与公司 rollback 相互独立。
- [ ] UI 展示完整实践发现、Agent/项目效果、scope 晋升、公司评审、trial、active 与 rollback lineage。

退出标准：主规范第 11 节十二条完成定义全部有真实多 Agent、多 Workspace 与双私有实例端到端证据。
