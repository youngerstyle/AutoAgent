# 人才池与动态项目团队设计

## 目标

AutoAgent 第一阶段采用“预先招聘、项目按需实例化”的团队模型：

- 人才池保存组织长期拥有的 Agent 档案。
- 项目团队只保存被明确加入该项目的 Agent 实例。
- 同一个人才可以加入多个项目，但每个项目实例拥有独立 Session、项目记忆和运行覆盖配置。
- 暂不自动招聘。能力不足时保持工单未领取并明确暴露能力缺口。

## 三层实体

### 人才档案 AgentProfile

人才档案是组织级长期实体，包含：

- Soul：个体稳定特质、注意力模式和判断风格。
- Identity：岗位责任、协作边界和组织身份。
- Agent：工作方法、交付标准和专业能力。
- Capabilities：供 Ticket assignment 匹配的结构化能力。
- 默认模型、技能和工具权限。

人才档案可以被创建和编辑，不属于任何具体项目。

### 项目实例 WorkspaceAgent

项目实例通过选择一个 AgentProfile 创建，包含：

- `profileId`：所继承的人才档案。
- `workspaceId`：实例所在项目。
- 独立的 Agent Session 和运行状态。
- 项目级模型、技能和工具权限覆盖。

同一人才在同一项目中最多存在一个实例。不同项目实例之间不共享可变 Session。

### 任务团队快照 TeamBinding

Mission 启动时，从当前项目实例生成不可变 TeamBinding：

- Ticket Engine 只按 `principalId` 和 `requiredCapabilities` 分配工作。
- Mission 运行期间新增或移除项目成员不会偷偷改变当前 Mission。
- 为保持审计一致性，第一版在存在运行中 Mission 时禁止修改项目团队。
- Mission 结束后可调整团队，下一次 Mission 使用新的 TeamBinding。

## 项目生命周期

1. 创建项目，初始团队为空。
2. 用户在“项目团队”中从人才池添加成员。
3. 发布任务前，平台只校验启动契约：
   - 至少一人具有 `mission:intake`。
   - 至少一人具有 `plan:plan`。
   - 至少一人具有 `delivery:accept`。
4. PM 根据目标和当前 TeamBinding 自主设计 Ticket DAG。
5. Ticket 所需能力无人满足时保持 Ready，不由平台猜测、改派或创建 Agent。
6. 用户回到人才池招聘，再在 Mission 结束后调整项目团队。后续版本可增加受控的 TeamBinding amendment。

启动契约不是固定岗位流程。具备多项能力的同一人才可以承担多个责任；PM 也可以根据项目规模省略架构、设计或其他非必要工单。

## API

### 人才池

- `GET /api/agent-profiles`
- `POST /api/agent-profiles`
- `PATCH /api/agent-profiles/:profileId`

创建人才时显式提交名称、岗位类别、Soul、Identity、Agent、Capabilities、模型、技能和权限。

### 项目团队

- `GET /api/workspaces/:workspaceId/agents`
- `POST /api/workspaces/:workspaceId/agents`，输入 `profileId`
- `PATCH /api/workspaces/:workspaceId/agents/:agentId`
- `DELETE /api/workspaces/:workspaceId/agents/:agentId`

GET 不得隐式创建任何成员。

## UI

### 人才

- 展示组织人才池，而不是固定角色模板。
- 提供“招聘人才”操作。
- 新人才创建后不会自动进入已有项目。

### 项目团队

- 左侧为当前项目成员列表。
- 提供“添加成员”，从尚未加入当前项目的人才中选择。
- 提供“移出项目”，只删除项目实例，不删除人才档案。
- 无成员时显示明确空状态和添加入口。

### 办公室

- 只展示当前项目实例。
- 多个相同岗位实例必须分别显示姓名，不能按角色重叠或合并。

## 非目标

- 自动招聘与自动生成人才档案。
- 运行中 Mission 的团队热变更。
- 招聘审批、面试、绩效和离职流程。
- 平台根据“前端”“设计”等自然语言硬编码岗位选择。

