# Agent 多模态消息与 Skill 运行时设计

## 目标

把当前 Agent Engine 从“纯文本 + 固定工具”升级为可用于真实工作的通用 Agent 运行时：

- human 与 Agent 的消息都按同一条时间线持久化，消息可以同时包含文字和图片。
- Agent 可以按档案启用符合 Agent Skills 标准的 Skill，并由 Pi 负责渐进式披露。
- 浏览器自检由 Agent 通过 Skill 和受控工具完成，截图、控制台与交互结果成为可审计证据。
- Ticket Engine 只管理工作、依赖和状态；Mission Control 只负责投递与结算；两者都不知道图片格式、Skill 名称或浏览器命令。

## 不是目标

- 不在平台代码里判断某张图片是否通过验收。
- 不根据角色名写死 Skill 或工具。
- 不把图片路径伪装成文本消息。
- 不让 Skill 绕过 Agent 权限、工作区边界或命令策略。
- 不让上传文件、Skill 内容或浏览器日志递归写入 system prompt。

## 一、消息模型

### 1.1 内容块

`SendAgentMessageRequest` 保留文本字段，并在同一条消息上增加附件引用：

```ts
interface SendAgentMessageRequest {
  content: string;
  attachments?: Array<{
    type: "image";
    attachmentId: string;
    mimeType: string;
    fileName: string;
    size: number;
  }>;
}
```

纯文本消息只是 `attachments` 为空的同一契约，不维护第二套消息语义。文本和图片共享一个 messageId、turnId 与时间位置。

### 1.2 附件存储

- 二进制不进入 `rollout.jsonl`。
- 文件写入工作区 `.autoagent/attachments/<sha256>`，元数据单独保存。
- 附件 ID 使用内容摘要，天然去重；每次读取都校验工作区归属。
- 第一版只接受 PNG、JPEG、WebP、GIF，单文件上限 10 MiB。
- API 返回的下载地址不暴露本地绝对路径。

### 1.3 时间序与上下文

- human 图片和文字组成同一个 message、同一个 turnId，不创建旁路记录。
- Pi turn 使用 `session.prompt(text, { images })` 原生传递图片。
- 历史恢复保留图片引用；上下文组装时只解析预算内的消息。
- 压缩只摘要文字，不复制图片二进制；图片保留引用和可读说明。
- 不支持视觉输入的模型必须在发送前给出明确错误，不能静默忽略图片。

## 二、Skill 模型

### 2.1 Skill 是资源，不是权限

Skill 解释“如何完成某类工作”；Tool 提供“实际能执行什么”。有效能力始终是：

```text
已启用 Skill 的指导
∩ Agent 已启用工具
∩ Workspace 安全策略
∩ 命令与路径边界
```

启用 `agent-browser` 不会自动授予 `shell`，也不会绕过项目根目录限制。

### 2.2 发现与启用

- 使用 Pi `loadSkills` / `DefaultResourceLoader`，遵循 Agent Skills 标准。
- 平台扫描全局 `~/.agents/skills` 和工作区 `.agents/skills`，展示名称、描述、来源和诊断。
- Agent 档案保存 `defaultSkills: string[]`，Agent 实例可在后续增加覆盖配置。
- 只把档案显式启用的 Skill 传给 Pi；不默认把机器上的全部 Skill 注入所有 Agent。
- Pi 在 system prompt 中只放 Skill 名称、描述和文件位置，模型需要时再读取 `SKILL.md`，避免完整内容常驻上下文。

### 2.3 信任和审计

- 全局 Skill 由本机用户安装，视为用户级资源。
- 工作区 Skill 仍受工作区安全策略、工具权限和路径边界约束。
- 加载失败、重名、缺少依赖显示为诊断，不悄悄降级。
- trace 记录本轮可用 Skill 清单；实际文件读取和工具调用仍通过普通 Agent 事件审计。

## 三、浏览器自检

第一版复用已安装的 `agent-browser` Skill，但补齐真正闭环所需的工具能力：

1. Agent 用 `startService` 启动项目。
2. Agent 按 Skill 调用 `agent-browser` CLI 打开页面、获取可交互快照、点击、输入和截图。
3. Agent 使用 `readImage` 读取工作区内截图，工具结果以 Pi image content 返回给视觉模型。
4. Agent 根据成功标准自行判断并提交 `goal_resolution`；平台只校验结算协议和证据引用。
5. 若当前模型不支持视觉，Agent 可以使用 DOM/console/快照证据；只有不可替代的视觉判断才请求 human。

`agent-browser` 命令仍由 `shell` 的工作区 cwd 和命令策略约束。未来可以替换为原生 Browser Tool，但不改变消息、Skill、Ticket 或 Mission 契约。

## 四、三大 Engine 边界

### Agent Engine

- 保存时间序 thread、附件引用、Goal、工具事件和 trace。
- 组装模型上下文，加载启用的 Skill，执行多模态 turn。
- 串行处理同一 thread 的消息。

### Ticket Engine

- 保存 Ticket DAG、负责人要求、成功标准、状态和证据引用。
- 不识别 `agent-browser`、图片、模型或具体工具。

### Mission Control

- 把 Ticket 交付契约转换为 Agent Goal。
- 把 Agent resolution 提案交回 Ticket Engine 结算。
- 只传递附件/证据引用，不解释内容、不替 Agent 判断。

## 五、上线验收

### 自动测试

- 图片上传的类型、大小、摘要去重、越权读取和删除工作区隔离。
- text + image 同一消息追加、幂等、重启恢复和 turn 串行。
- Pi prompt 收到文字与图片，非视觉模型明确拒绝。
- Skill 发现、显式启用、未启用隔离、诊断和权限交集。
- `readImage` 只能读取工作区图片并返回图片内容。
- Ticket 与 Mission 合约中不得出现具体 Skill、图片 MIME 或浏览器命令。

### 真实验收

- 在 Agent 聊天中发送游戏截图，确认预览、发送、刷新后仍可见，Agent 能描述图中问题。
- 给 QA 档案启用 `agent-browser`，由 QA 启动真实 Web 项目、打开页面、执行交互、读取截图并产出证据。
- 验证整个过程不需要平台硬编码“测试通过/不通过”，也不会自动向 human 索要本可自行取得的证据。
