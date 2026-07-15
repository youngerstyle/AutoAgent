# Codex 风格 Agent Engine Turn 协议修复

日期：2026-07-13

状态：已确认方向，作为本轮 Agent Engine 修复的实现依据。

## 1. 问题结论

当前 Agent Engine 的 Provider 边界是错误的：平台把系统说明、Goal、历史和工具规则拼成一个字符串，把它作为单条 user message 发给模型；模型再被要求返回包含 `message`、`toolIntents`、`goalResolution` 的文本 JSON。平台通过 `JSON.parse` 从助手文本里猜测工具调用和 Goal 结论。

这会直接导致：

- 同一个 JSON 被模型重复输出时整轮无法解析；
- 助手自然语言中出现 JSON 时可能被误认为控制协议；
- 工具调用没有稳定的 `callId`，工具结果无法和请求形成一一对应关系；
- 工具结果只能等下一次外层调度重新拼 prompt，而不是在同一 turn 中返回模型；
- 完整 prompt 和历史文本混在一起，容易递归膨胀；
- “解析失败”被误判为 Agent 没有继续工作，造成空转、暂停和不可信状态。

这不是提示词问题，也不能通过重试、正则或兼容解析修复。必须替换 Provider/Turn 协议。

## 2. Codex 源码采用的边界

本设计以本机 Codex 源码为事实参考：

- `codex-rs/protocol/src/models.rs`：模型输出是带类型的 `ResponseItem`，消息、函数调用、函数结果是不同变体。
- `codex-rs/core/src/session/turn.rs`：一个 turn 内循环采样；收到工具调用后执行工具，把结果加入历史，再继续同一个 turn；只有不再需要 follow-up 时才结束 turn。
- `codex-rs/core/src/stream_events_utils.rs`：先持久化结构化工具调用，再执行；无效调用以工具结果/错误返回模型，不从助手文本猜测。
- `codex-rs/core/src/context_manager/history.rs`：持久化历史和模型可见历史分离；发送前进行规范化，并保持工具调用与结果配对。

AutoAgent 不照搬 Codex 的 Rust 类型，但采用同一控制边界。

## 3. Engine 边界保持不变

本轮只修 Agent Engine：

- Agent Engine 仍然独立管理 AgentThread、Goal、Turn、工具执行和 `GoalResolutionProposal`。
- Ticket Engine 不导入 Agent/Provider 类型，也不在本轮修改。
- Mission Control 仍只接收已持久化的 `GoalResolutionProposal`，并把 host 决定返回 Agent Engine。
- Agent Engine 不认识 Ticket、角色流转、阶段或团队拓扑。

## 4. Provider 原生结构化协议

Provider Adapter 接收的不是一个拼好的 `prompt`，而是：

```ts
interface AgentModelTurnInput {
  model: string;
  provider: ProviderName;
  instructions: string;
  history: AgentModelItem[];
  tools: AgentToolDefinition[];
}
```

统一的模型条目：

```ts
type AgentModelItem =
  | { type: "user_message"; content: string }
  | { type: "assistant_message"; content: string }
  | { type: "tool_call"; callId: string; name: string; arguments: unknown }
  | { type: "tool_result"; callId: string; content: string; isError: boolean };
```

Provider 返回：

```ts
interface AgentModelTurnResult {
  items: Array<
    | { type: "assistant_message"; content: string }
    | { type: "tool_call"; callId: string; name: string; arguments: unknown }
  >;
  usage?: ProviderUsage;
}
```

映射规则：

- OpenAI/OpenAI-compatible Chat Completions：使用 `tools`、`message.tool_calls` 和 `role:"tool"`。
- Anthropic Messages：使用 `tools`、`tool_use` 和 `tool_result` content block。
- Mock Provider：直接返回相同的规范化条目，用于无费用测试。
- 助手文本永远只作为消息，哪怕文本长得像 JSON，也不能触发工具或 Goal 结算。
- 工具参数必须通过工具 schema 校验；无效参数作为带相同 `callId` 的错误结果返回模型。

## 5. Goal 结算也是原生工具

`goal_resolution` 是 Agent Engine 提供的内部工具，不是文本输出格式：

```ts
goal_resolution({
  status: "completed" | "blocked" | "failed",
  summary: string,
  evidence: Array<{ kind: string; ref: string }>,
  domainOutcome?: unknown
})
```

规则：

- 仅在存在活动 Goal 时注册该工具。
- 调用经过 schema 校验后生成 `GoalResolutionProposal`。
- Proposal 先原子持久化，再交给 `GoalResolutionPort`。
- Host 拒绝或要求修正时，决定作为时间序 observation 追加到同一 Thread；下一 turn 可见。
- 普通助手回复、工具调用完成、turn 结束都不能改变 Goal 终态。

## 6. 一个 Turn 的真实循环

```text
读取 Thread + Goal
  -> 投影 bounded model history
  -> provider 原生响应
  -> 持久化 assistant_message / tool_call
  -> 若有 tool_call：执行并持久化 tool_result
  -> 把 tool_result 加入同一 turn 的下一次 provider 请求
  -> 重复，直到只剩普通回复、提交 goal_resolution、外部中断或明确错误
```

重要约束：

- 工具 follow-up 属于同一个 turn，不依赖 Mission Control 再次“猜测要不要继续”。
- 一个响应可以包含消息和多个工具调用，按 Provider 返回顺序持久化。
- 每个工具调用必须有稳定 `callId`，每个结果必须引用该 `callId`。
- 不再存在 `toolIntents`、`structured`、`parseJsonObject`、`visibleModelMessage` 这条文本控制路径。
- 工具调用数量限制只作为单 turn 的资源保险丝；触发时应形成明确的 `yielded` 控制事实，不能伪装成完成或失败。

## 7. Thread、审计与模型上下文

AgentThread 是严格时间序的持久化事实源：

```text
human 原始 Mission 目标
platform 下发的当前 Goal（目标、成功标准、输出契约）
system 当前 Goal 的稳定约束
human/user message
assistant message
tool call
tool result
host observation
control fact
```

模型上下文由 Thread 投影产生，不是把 Thread 重新渲染为一大段“聊天文本”：

- SIA、工具定义、当前 Goal 是稳定 instructions；
- human 和 assistant 保留消息角色；
- tool call/result 保留结构化配对；
- control/audit 项默认不进入模型；
- 超预算时使用 replacement history + 较新的后缀；
- 完整 prompt、Provider 原始响应、token 用量只进入 Trace，不回灌 Thread。

面向用户的 Agent 对话同样从这条时间线投影，不能跳过 Goal，也不能让内部约束成为第一条可见消息。首屏必须先说明 human 要完成什么、当前 Agent 收到什么工作及如何验收，再显示系统约束和执行过程。

现有旧项目的文本 JSON 历史不做协议兼容执行。它可以继续作为只读审计记录，但新 turn 只使用新结构化条目。

## 8. 错误语义

- Provider 网络/额度错误：turn `execution_blocked`，Goal 保持原状态，不自动重试到失控。
- 工具参数错误：写入 tool_result error，并允许模型在同一 turn 修正。
- `goal_resolution` 缺少输出契约要求的 `domainOutcome` 属于工具参数错误；必须在同一 turn 把错误返回模型修正，不能先把无效结果提交给 Mission Control 再阻塞整个 Ticket。
- 工具执行错误：写入 tool_result error，并允许模型决定重试、换方案或提交 blocked/failed。
- Provider 返回普通文本但活动 Goal 未结算：当前 turn 正常结束，Goal 保持 active；由 Goal runner 在存在新的可执行事实时继续，不能把同一旧响应无限重放。
- Provider 违反原生协议：明确记录 protocol error，不从文本降级解析控制命令。

## 9. 测试门槛

Agent Engine 独立测试必须证明：

1. 助手文本中的 JSON 不能执行工具。
2. OpenAI 原生 `tool_calls` 能执行工具，并把 `role:"tool"` 结果带入同一 turn 的下一次请求。
3. Anthropic `tool_use/tool_result` 具有同样语义。
4. 无效工具参数以关联 `callId` 的错误结果返回模型。
5. 多工具调用严格按响应顺序写入 Thread。
6. `goal_resolution` 是唯一能创建 Proposal 的模型行为。
7. 普通回复不会完成 Goal，也不会无限重放。
8. human、assistant、tool call、tool result 严格按发生时间进入同一 Thread。
9. 上下文压缩保持 tool call/result 配对，不把完整 prompt 递归写入历史。
10. Provider 额度错误不会自动产生无界重试。
11. 全部测试使用 fake/mock Provider，不产生真实模型费用。

完成上述 Agent Engine 验证和独立代码审查后，才开始只读审计 Ticket Engine 与 Mission Control；若发现问题，另列问题和修复范围，不在 Agent Engine 提交中顺手修改。
