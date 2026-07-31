# 人才池与老板驱动的动态项目团队

## 产品结论

AutoAgent 是全自动团队，不是让 human 代替负责人配置排班的管理后台。

- human 只负责创建项目、给出目标以及处理不可替代的授权或事实输入。
- 组织人才池保存长期存在的 Agent 档案。
- 创建项目时只实例化一个长期存在的项目负责人；默认负责人由人才档案能力标记唯一确定。
- human 发布的目标作为普通消息进入该负责人的项目会话，由负责人自行判断是否需要加人、招聘、追问或启动 Mission。
- 平台不根据角色名、关键词或固定流程选择成员，只提供人才池事实、结构化工具和机械校验。
- 项目团队确定后生成不可变 TeamBinding，Mission 与 Ticket 才开始运行。
- 第一版采用预先招聘：缺少人才时，老板提交招聘请求并暂停启动；后续可由招聘 Agent 自动完成招聘。

“项目由哪些人完成”是老板的业务判断，不是 human 的配置责任，也不是平台代码的推断责任。

## 三个独立引擎与启动胶水

### Agent Engine

Agent Engine 是通用的单 Agent loop。项目负责人和其他成员使用同一种线程、消息、Goal、工具调用与上下文压缩机制。负责人接收：

- human 按时间顺序发出的原始消息；
- 当前组织人才池的结构化快照；
- 当前项目、已有成员、历史 Mission、项目路径、安全策略和可用工具等事实。
- Ticket/Mission 引擎启动所需的结构化能力契约；这是接口事实，不是角色名单，负责人可选择任意满足能力的人。

平台不得为本次目标拼接“组建团队”“必须选择某岗位”“按复杂度裁剪”等业务提示。负责人如何理解目标和组织团队来自可编辑的 Soul、Identity、Agent 档案以及连续项目会话。

负责人需要启动工作时，可自主调用通用组织工具 `staff_project`，提交：

- 选中的 `profileId`；
- 每个人在本项目中的责任；
- 选择理由；
- 若人才不足，需要招聘的能力与原因。

工具调用只是负责人的组织决策提案。Agent Engine 不直接创建项目成员，也不启动 Mission。

### Mission Control

Mission Control 负责启动前后两个状态域：

1. 把 human 消息投递给项目中唯一的负责人实例。
2. 接收已通过机械校验的组队提案。
3. 创建项目级 WorkspaceAgent 实例。
4. 冻结 TeamBinding。
5. 创建 Mission，并把控制权交给 Ticket Engine。

Staffing Request 是 Mission Control 对负责人组织工具调用的持久化执行记录，不是另一个 Agent、业务决策者或 Ticket。它不得改变负责人收到的消息，也不得替负责人选择成员。

### Ticket Engine

Ticket Engine 只在 TeamBinding 已形成后工作：

- PM 或其他具备规划能力的 Agent 自主设计 Ticket DAG；
- Ticket 按 `principalId` 或 `requiredCapabilities` 分配；
- 已冻结 TeamBinding 是该 Mission 的唯一人员事实；
- Ticket Engine 不招聘、不选人、不按角色名路由。

## 数据模型

### AgentProfile

组织级长期人才档案，包含：

- Soul：稳定特质、注意力模式与判断风格；
- Identity：岗位责任、协作边界与组织身份；
- Agent：工作方法、交付标准与专业能力；
- Capabilities：供组队与 Ticket assignment 使用的结构化能力；
- 默认模型、技能与工具权限。

同一档案可以实例化到多个项目，每个项目实例拥有独立 Session 和项目记忆。

### ProjectOwnerThread

项目创建时生成并长期复用：

- 属于项目负责人实例，而不是临时“组织老板”；
- human 目标、后续追问和负责人回复按时间顺序追加；
- 项目事实以结构化 context 消息注入；
- 不保存平台组装后的完整 Prompt，不递归复制历史；
- 多个 Mission 可以复用同一项目线程，但每个 Mission 使用独立 Goal。

### StaffingRequest

启动前的持久化工作项：

- `staffingRequestId`
- `workspaceId`
- `taskId`
- `objective`
- `staffingProfileId`
- `status`: `pending | running | blocked | completed | failed`
- `threadId` / `goalId`
- `proposal`
- `blockReason`
- `createdAt` / `updatedAt`

它必须可恢复、可审计、幂等。服务重启后继续同一请求，不能重新创建另一套团队。

### StaffingProposal

```json
{
  "status": "staffed",
  "members": [
    {
      "profileId": "prof_xxx",
      "responsibility": "本项目中的责任",
      "rationale": "为什么目标需要此人"
    }
  ],
  "recruitmentRequests": []
}
```

人才不足时：

```json
{
  "status": "recruitment_required",
  "members": [],
  "recruitmentRequests": [
    {
      "capabilities": ["需要的结构化能力"],
      "reason": "为什么现有人才不能可靠完成目标"
    }
  ]
}
```

平台只校验：

- `profileId` 确实存在于本次提供的人才池快照；
- 同一档案在一个项目中没有重复实例；
- 字段满足契约；
- 项目与安全策略允许实例化；
- 负责组队的 Agent 具备 `team:staff`。

平台不得补全成员、改写责任、根据角色名称决定必需岗位，也不得把能力缺口偷偷转换成固定团队。

### WorkspaceAgent

由已接受的 StaffingProposal 创建，包含：

- `profileId`
- `workspaceId`
- 独立 Agent Session 与运行状态；
- 项目级模型、技能和工具权限覆盖。

### TeamBinding

Mission 启动时从项目实例生成的不可变快照：

- `teamBindingId` 表示 Ticket Policy 授权的团队域，不承载成员版本；
- `contentHash` 固化该 Mission 的成员、能力和工具权限快照；
- Ticket Engine 只按 `principalId` 与 `requiredCapabilities` 分配工作；
- Mission 运行期间不被人才池或项目页面的后续修改偷偷改变；
- Mission 结束后下一次目标重新发起 Staffing Request，可复用、增减或重组成员。

## 完整启动时序

1. human 创建项目，系统仅实例化一个长期项目负责人。
2. human 发布目标。
3. Mission Control 将原始目标作为 human 消息追加到负责人的项目线程，并附加当前项目事实。
4. Agent Engine 正常运行该负责人；平台不插入本次任务的组队指令。
5. 负责人可以继续对话、请求不可替代输入、调用 `staff_project` 增加成员并启动 Mission，或提交招聘缺口。
6. 负责人调用 `staff_project` 后，Mission Control 才进入组织执行。
7. Mission Control 对提案做机械校验。
8. 若 `staffed`，创建 WorkspaceAgent、冻结 TeamBinding、创建 Mission。
9. Mission 中的规划 Agent 基于目标与 TeamBinding 自主创建 Ticket DAG。
10. 若 `recruitment_required`，任务停在组队阶段，UI 明确显示老板提出的人才缺口；不创建虚假 Mission 或 Ticket。

项目负责人的初始化不依赖 `role === "boss"`：

- 只有一个 `team:staff` 候选时使用该候选；
- 多个候选时优先使用具备 `team:staff:default` 的唯一候选；
- 无唯一负责人时暴露组织配置缺口，不由平台猜测。

## UI

### 人才

- 展示组织人才池并支持预先招聘。
- 能力标签中可配置 `team:staff` 与 `team:staff:default`。
- 新人才不会自动进入已有项目。

### 项目

- 创建后只有一个项目负责人，不预装 PM、架构师、开发或 QA。
- 项目成员列表是老板组队后的结果，不把“添加成员”作为发布目标的前置操作。
- 保留人工调整入口用于组织管理员维护和故障恢复，但必须明确标记为人工管理操作。

### 办公室

- 发布目标后立即显示同一个项目负责人的运行状态，不投影第二个虚拟老板。
- 组队完成后，办公室只显示真实项目成员。
- 人才不足时在负责人头像上显示待处理标记，并展示原始招聘请求。

## 非目标

- 平台根据“前端”“设计”等自然语言关键词硬编码岗位选择。
- 平台在每次目标中注入组队业务提示词。
- 临时创建 `organization-agent` 或其他负责人影子实例。
- 固定老板、PM、开发、QA 流程。
- 自动生成不存在的人才档案。
- 运行中 Mission 偷偷修改 TeamBinding。
- 为旧项目数据增加兼容路由或双轨启动流程。
