# Ticket Engine、Agent Engine 与 Mission Control 边界设计

日期：2026-07-10

状态：设计复核完成，待用户确认

## 1. 文档目的

AutoAgent 的运行核心由两个可独立运行的系统和一个协调层组成：

- Ticket Engine 是通用工单与工作流系统。
- Agent Engine 是通用、消息交互式、可使用工具并可跨多个 turn 追求 Goal 的 Agent Runtime。
- Mission Control 是连接两者的 process manager，不是隐藏的 PM、经理、状态机或业务判断器。

本设计解决当前架构中的根本混淆：一次 LLM 返回、一次 Agent turn、一次 Agent Goal、一次 Ticket 和整个 Mission 被当成了同一件事，导致 Mission Control 通过角色、阶段、关键词、工具结果和默认后继规则替 Agent 与 Ticket Engine 做业务决定。

本设计将这些概念彻底分开，并规定唯一的数据流、状态所有权和完成判断协议。

## 2. 与旧文档的关系

本设计是运行核心边界的最新总设计。发生冲突时，以本文为准。

保留：

- `2026-07-06-real-ticket-flow-design.md` 中“Ticket 是唯一 workflow 事实来源”“平台不从自然语言猜业务动作”“只按合法工单拓扑流转”的原则。
- `2026-07-08-ticket-agent-long-run-design.md` 中执行片 yield、运行预算不等于业务失败、完整 trace 与模型上下文分离的原则。
- `2026-07-09-codex-like-agent-thread-runtime-design.md` 中 AgentThread 是 Agent 时间序事实来源、Session 是模型可见投影、LoopTrace 是完整审计证据的原则。
- `2026-07-09-ticket-graph-contract.md` 中 DAG 结构、依赖、无环、可交接和可验收等结构性校验原则；其角色枚举、ticket type 到角色的映射、老板/QA 固定终点和“机器实现为最终标准”的声明被本文替代。

废止或重新定义：

- `AgentRuntime.runAssignment()` 返回后即把 Assignment 标为完成。
- Mission Control 根据 `phase`、角色、`passed`、`accepted`、工具错误或交付物路径判断下一张 Ticket。
- Ticket Engine 内置“QA 通过后创建老板验收”“人工测试失败后创建开发返工”等固定团队流程。
- `TaskRun.phase`、`nextPhase` 或固定角色顺序参与真实路由。
- 私聊、human follow-up 或 resume review 作为 AgentThread 之外的第二条模型上下文通道。
- 为旧 TaskRun 保留两套并行路由或兼容性 fallback。
- 旧 `TicketGraphContract v1` 中 `type -> role`、固定 `boss_acceptance`、固定 `qa`、phase 和 human_action 节点语义继续作为新 Engine contract 的规范来源。

旧运行记录可以只读展示，但新的运行核心不得继续执行旧 phase 路由。

新运行的字段迁移是明确删除或结构映射，不做双写兼容：

| 旧字段/概念 | 新协议 |
|---|---|
| `phase`、`resumePhase`、`targetPhase` | 删除 |
| `ticketType -> targetRole` | 删除；使用 `assignment.principalId/requiredCapabilities` |
| `dependsOnTicketIds` | `PlannedTicketGraph.dependencyEdges` |
| `parentTicketId` | 保留为直接父关系，但与依赖边分开 |
| `human_action` Ticket | 删除；human 消息进入目标 AgentThread，Ticket 可处于 blocked |
| `Assignment` 完成状态 | 由 AgentGoal 与 Ticket 两个独立状态替代 |
| `MissionState` 内嵌 Ticket/inbox | 迁移到 Ticket Engine durable aggregate |
| role-specific result schema | 由 Ticket outputContract 注入 Agent Goal |

## 3. 核心结论

### 3.1 Agent 必须知道自己是否完成

Agent Engine 不应认识 Ticket，但 Agent 必须知道：

- 自己正在追求什么 Goal；
- Goal 的完成标准是什么；
- 当前有哪些证据；
- 是否还需要继续工作；
- 是否已经完成、阻塞或失败。

“Agent Engine 通用”不等于“Agent 没有目标”。正确模型是 Codex 风格的持久 Goal：一次 turn 结束不代表 Goal 完成，只要 Goal 仍为 active，Agent Engine 就可以继续下一次 turn。

### 3.2 Agent 提出结论，Ticket Engine 正式提交

完成有两个不同含义：

1. Agent 判断：“我认为当前 Goal 已经完成。”
2. Ticket Engine 判断：“这份结论是否构成一次合法的 Ticket 状态变更。”

Agent 拥有第一个判断权；Ticket Engine 拥有第二个提交权。

Mission Control 不拥有任何一个判断权。它只传递 Agent 的 Goal Resolution Proposal，并把 Ticket Engine 的接受或拒绝结果返回给同一个 Agent Goal。

### 3.3 Mission 完成不是某个 Agent 的一句话

一个 Agent 只能解决自己当前的 Goal。整个 Mission 是否完成，由 Ticket Engine 根据当前 workflow 的完成策略和实际 Ticket 状态得出。

最终验收可以由老板 Agent 完成一张验收 Ticket，但“老板验收”属于 workflow 定义或团队策略，不应硬编码在 Mission Control 或通用 Ticket Engine 中。

## 4. 总体架构

```text
┌─────────────────────────────────────────────────────────────┐
│                         Product/API                         │
│  开始任务、暂停、继续、停止、私聊、查询运行状态             │
└─────────────────────────────┬───────────────────────────────┘
                              │
                    ┌─────────▼─────────┐
                    │  Mission Control  │
                    │  process manager  │
                    └──────┬──────┬─────┘
                           │      │
              Ticket Port │      │ Agent Port
                           │      │
              ┌────────────▼─┐  ┌─▼────────────────┐
              │ Ticket Engine│  │   Agent Engine   │
              │              │  │                  │
              │ DAG / Queue  │  │ Thread / Goal    │
              │ Lease        │  │ Turn / Tool      │
              │ Transition   │  │ Session / Trace  │
              │ Workflow     │  │ Context / Compact│
              └──────────────┘  └──────────────────┘
```

依赖规则：

- Agent Engine 不导入 Ticket、Task、Mission、Phase 或团队角色类型。
- Ticket Engine 不导入 Agent Runtime、Provider、Prompt、Tool 或 Session 类型。
- Mission Control 可以依赖两个 Engine 的公开协议，但不能读取其内部存储并自行推导业务结论。
- UI 查询使用独立 read projection；Mission Control 不负责拼装全部页面状态。

## 5. 四层运行模型

AutoAgent 必须明确区分四个生命周期：

```text
Mission
└── Ticket Workflow (DAG)
    └── Ticket
        └── Agent Goal
            └── Turn 1
            └── Turn 2
            └── Turn N
                └── LLM / Tool / Observation steps
```

### 5.1 Mission

用户希望团队最终达成的目标。Mission 负责聚合整体运行状态，不直接承载 Agent 对话或业务路由逻辑。

### 5.2 Ticket

Workflow 中可领取、可依赖、可阻塞、可打回、可完成的工作单元。Ticket 是团队协作和数据流转的事实来源。

### 5.3 Agent Goal

某个 Agent 为完成当前 Ticket 而追求的持久目标。一个 Ticket 在同一次有效领取期间对应一个 Agent Goal。

Agent Goal 可以跨多个 turn，服务重启后可以恢复。正常模型回复不会自动结束 Goal。

### 5.4 Turn

一次模型上下文组装、推理、工具调用和回复周期。Turn 可以结束、yield、失败或被中断，但这些都不自动等于 Goal 完成。

## 6. Agent Engine 设计

### 6.1 定位

Agent Engine 是一个可单独运行的通用 Agent 产品内核，能力应与 Codex、Claude Code 这一类 message-interactive coding agent 同构：

- 长期 AgentThread；
- 可选的持久 Goal；
- 时间序消息；
- 多 turn 连续工作；
- 每个 turn 内的 LLM/tool loop；
- 工具注册、权限和执行；
- Session、上下文组装和压缩；
- 完整 LoopTrace；
- 暂停、继续、停止、预算与用量边界；
- human 消息在下一可用 turn 生效。

### 6.2 Agent Engine 不知道什么

Agent Engine 不知道：

- 当前 Goal 来源于 Ticket；
- Ticket 的父子关系和 DAG；
- PM、开发、QA、老板的固定顺序；
- Mission 何时完成；
- 某个 domain outcome 应该解锁哪张 Ticket；
- “QA 失败”“老板驳回”等业务语义。

Agent 的 Identity、Soul、能力和工具策略可以包含岗位信息，但 Agent Engine 的运行代码不按角色分支。

### 6.3 Agent Engine 知道什么

Agent Engine 只需要知道通用 `AgentGoalSpec`：

```ts
interface AgentGoalSpec {
  id: string;
  threadId: string;
  objective: string;
  successCriteria: string[];
  contextRefs: ContextRef[];
  outputContract?: OutputContract;
  externalRef?: string;
  createdAt: string;
}

interface StartAgentGoalRequest {
  agentId: string;
  threadId: string;
  spec: AgentGoalSpec;
}

interface EnsureAgentThreadRequest {
  agentId: string;
  scopeId: string;
  idempotencyKey: string;
}

interface SendAgentMessageRequest {
  messageId: string;
  threadId: string;
  goalId?: string;
  senderPrincipalId: string;
  content: string;
  createdAt: string;
}

interface AgentThreadSnapshot {
  threadId: string;
  agentId: string;
  scopeId: string;
  version: number;
  items: Array<{
    itemId: string;
    sequence: number;
    kind: "message" | "goal" | "model" | "tool" | "observation" | "control";
    createdAt: string;
    payloadRef: string;
  }>;
}
```

`externalRef` 对 Agent Engine 是不透明标识。Mission 模式下可保存 Ticket ID，独立运行时可以为空。

`ensureThread` 允许在没有 Ticket、Goal 或历史 Thread 时，按 agentId + scopeId 幂等创建普通对话 Thread。`sendMessage` 按 messageId 幂等，AgentThread 在同一 threadId 内分配单调 sequence。human、model、tool 和 control item 使用同一排序规则，不存在独立的 human 消息列表。

### 6.4 Agent Goal 状态

```ts
type AgentGoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "resolving"
  | "completed"
  | "failed"
  | "cancelled"
  | "budget_limited"
  | "usage_limited";

interface AgentGoal {
  spec: AgentGoalSpec;
  version: number;
  status: AgentGoalStatus;
  activeProposalId?: string;
  updatedAt: string;
}
```

状态控制权：

| 状态 | 控制者 |
|---|---|
| `active` | 创建 Goal 的 host、用户恢复或合法的 Agent 继续 |
| `paused` | 用户或 host |
| `blocked` | Agent 提出并经 host 接受 |
| `resolving` | Agent 已提交结论，等待 host 确认 |
| `completed` | host 接受 Agent 的完成结论后 |
| `failed` | host 接受不可完成结论后 |
| `cancelled` | 用户或 host |
| `budget_limited` | Agent Engine 运行保护 |
| `usage_limited` | Provider/系统用量边界 |

Agent 不能用普通文本直接改变 Goal 状态。必须显式提交 `GoalResolutionProposal`。

合法转换与 activeProposalId 规则：

```text
active --submit proposal------------> resolving（设置 activeProposalId）
resolving --accepted complete-------> completed（清除）
resolving --accepted block----------> blocked（清除）
resolving --accepted fail-----------> failed（清除）
resolving --correctable-------------> active（清除）
resolving --stale/workflow terminal-> cancelled（清除）
resolving --host_error--------------> paused（清除，修复后 resume -> active）
active --control pause--------------> paused（resume -> active）
resolving --control pause-----------> paused（保留；resume -> resolving）
blocked --human message + resume----> active
budget_limited/usage_limited --边界解除-> active
active/resolving/paused/blocked --cancel-> cancelled
```

`settle:false/retry_later` 不发生状态转换，也不清除 activeProposalId。

### 6.5 Turn 与 Goal 的关系

```text
收到消息或 Goal 被激活
  -> 开始 Turn
  -> 组装稳定配置 + Goal + 时间序 Thread + 工具观察
  -> LLM
  -> 需要工具：执行工具并继续当前 Turn
  -> 当前 Turn 结束
      -> Goal 已被 host 接受为终态：停止
      -> Goal 仍 active：持久化并启动后续 Turn
      -> Goal paused/blocked/limited：等待外部事件
```

普通私聊且没有 active Goal 时，一次自然语言回复可以结束当前 turn，不会自动创建 Goal。

### 6.6 Goal Resolution Proposal

```ts
interface GoalResolutionProposal<TDomainOutcome = unknown> {
  proposalId: string;
  goalId: string;
  expectedGoalVersion: number;
  resolvingGoalVersion: number;
  status: "completed" | "blocked" | "failed";
  summary: string;
  evidence: EvidenceRef[];
  domainOutcome?: TDomainOutcome;
  createdAt: string;
}
```

Agent 负责生成 `summary`、`evidence` 和符合 host 注入 schema 的 `domainOutcome`。

Agent Engine 负责：

- 要求显式提交；
- 校验基础 schema；
- 持久化 proposal；
- 将 Goal 标为 `resolving`；
- 调用 host 的 `GoalResolutionPort`；
- 根据 host 结果完成、阻塞、失败或恢复 active；
- 将拒绝原因作为正常 tool/system observation 写回 AgentThread。

proposal 提交使用 Goal version 做 CAS：只有 `active` Goal 的当前 version 可以创建 proposal；持久化 proposal 与 `Goal -> resolving` 在同一事务中完成，并把新 version 写入 `resolvingGoalVersion`。同一个 proposalId 重放返回原 proposal；同 ID 不同内容是协议冲突。

### 6.7 Goal Resolution Port

```ts
interface GoalResolutionPort<TDomainOutcome = unknown> {
  resolve(
    goal: AgentGoal,
    proposal: GoalResolutionProposal<TDomainOutcome>
  ): Promise<GoalResolutionAttemptResult>;
}

type GoalResolutionDecision =
  | {
      accepted: true;
      committedState: "completed" | "blocked" | "failed";
      domainResult?: unknown;
    }
  | {
      accepted: false;
      disposition: "correctable";
      reason: string;
    }
  | {
      accepted: false;
      disposition: "stale_claim" | "workflow_terminal";
      reason: string;
    }
  | {
      accepted: false;
      disposition: "host_error";
      reason: string;
      incidentId: string;
    };

type GoalResolutionAttemptResult =
  | { settle: true; decision: GoalResolutionDecision }
  | {
      settle: false;
      pending: "retry_later";
      reason: string;
      retryAfter: string;
    };

interface SettleProposalRequest {
  decisionId: string;
  proposalId: string;
  expectedGoalVersion: number;
  decision: GoalResolutionDecision;
}

type SettleProposalResult =
  | { applied: true; goal: AgentGoal }
  | { applied: false; code: "version_conflict"; goal: AgentGoal }
  | { applied: false; code: "goal_terminal"; goal: AgentGoal }
  | { applied: false; code: "idempotency_conflict"; goal: AgentGoal };

interface AgentGoalControlRequest {
  requestId: string;
  goalId: string;
  expectedGoalVersion: number;
  action: "pause" | "resume" | "cancel";
  reason: string;
}
```

处理规则是固定的：`correctable` 把 Goal 恢复为 active 并写入 observation；`stale_claim` 或 `workflow_terminal` 取消旧 Goal，禁止继续提交；`host_error` 暂停 Goal 并报告平台故障，不把协议错误伪装成 Agent 的业务失败。`settle:false/retry_later` 不是 decision，不调用 `settleProposal`，Goal 与 activeProposalId 保持 resolving，由 host 幂等查询/重试。

最终 decisionId 必须可重建：`hash(proposalId + commandId + canonicalFinalResult)`；若 proposal 在 Ticket Engine 前被 output contract 拒绝，则 commandId 仍由 proposalId 确定生成。MissionLink 保存 lastDecisionId 只用于审计，恢复可以重新计算。`settleProposal` 按 decisionId 和 proposalId 幂等：相同 ID、相同 decision 重放返回第一次结果；相同 ID、不同 decision 返回 idempotency conflict。pause 可以改变 Goal version，但不能清除 activeProposalId；Mission Control 发现 version conflict 后只能在确认 activeProposalId 仍相同时，用最新 Goal version 重试原 final decision。cancelled/completed/failed Goal 不接受新的不同 decision。

独立 Agent 模式可以使用默认 port：接受显式且 schema 合法的 proposal，并让 `committedState` 与 proposal.status 一致。

Mission 模式使用 Ticket adapter port：把 domain outcome 转为 Ticket Command，并以 Ticket Engine 的提交结果作为决定。

## 7. Ticket Engine 设计

### 7.1 定位

Ticket Engine 是独立的工单、队列和 workflow/DAG 内核。没有 Agent Engine 时，它仍可以由 human worker 或其他执行器领取并完成工单。

### 7.2 Ticket Engine 负责

- Ticket 创建和不可变身份；
- DAG、父子关系和依赖；
- pending/ready/running/blocked/completed/returned/failed/cancelled；
- inbox、lease、续租、过期恢复、优先级和幂等；
- assignee/principal/capability 授权；
- Ticket Command 的结构性校验；
- 乐观版本校验；
- workflow completion policy；
- 独立、持久化的 Ticket 与 Workflow 状态；
- 与状态提交原子关联的 audit/outbox 事件。

### 7.3 Ticket Engine 不负责

- 调用 LLM；
- 组装 prompt；
- 判断 Agent 的自然语言是什么意思；
- 根据工具结果判断工作是否真实完成；
- 根据固定角色或阶段生成下一张 Ticket；
- 知道开发之后必然是 QA、QA 之后必然是老板；
- 决定 human 消息是否表示批准、通过或失败。

### 7.4 公共 Graph、policy 与 claim contract

新协议只保留通用结构，不保留 role/type 路由字段：

```ts
type TicketStatus =
  | "pending"
  | "ready"
  | "running"
  | "blocked"
  | "completed"
  | "returned"
  | "failed"
  | "cancelled";

interface PlannedTicketGraph {
  schemaVersion: 2;
  nodes: PlannedTicketNode[];
  dependencyEdges: Array<{ fromKey: string; toKey: string }>;
}

interface PlannedTicketNode {
  key: string;
  parentKey?: string;
  revisionOfKey?: string;
  title: string;
  objective: string;
  successCriteria: string[];
  assignment: {
    principalId?: string;
    requiredCapabilities?: string[];
  };
  outputContract: OutputContract;
}

interface PlannedWorkflowCompletionPolicy {
  requiredTerminalKeys: string[];
  failurePolicy: "fail_fast" | "require_resolution";
  blockedPolicy: "wait";
}

interface TicketGraphSnapshot {
  schemaVersion: 2;
  nodes: Array<{
    nodeKey: string;
    ticketId: string;
    active: boolean;
    revisionOfTicketId?: string;
    supersededByTicketId?: string;
  }>;
  dependencyEdges: Array<{ fromTicketId: string; toTicketId: string }>;
}

interface WorkflowPolicyRef {
  policyId: string;
  policyVersion: number;
  contentHash: string;
}

interface WorkflowAuthorizationPolicy {
  ref: WorkflowPolicyRef;
  grants: Array<{
    principalId?: string;
    teamBindingId?: string;
    capabilities: string[];
  }>;
}

interface WorkflowPolicyPort {
  getPolicy(ref: WorkflowPolicyRef): Promise<WorkflowAuthorizationPolicy | undefined>;
}
```

WorkflowPolicyPort 属于 Ticket Engine 公共 contract，不属于 Mission contract。Ticket Engine 按不可变 `WorkflowPolicyRef` 读取并校验 policy contentHash，再判断 principal 是否拥有 `ticket:claim`、`ticket_graph:create`、`workflow:control` 或 `blocked_ownership:transfer` 等 capability。角色名称可以存在于 Agent 档案和 UI，但不参与 Engine 授权代码。

`PlannedTicketNode.key` 是一次 Workflow 内稳定且永不复用的逻辑键。命令侧的 graph/policy 全部用 key；Ticket Engine 在创建或 amend 事务内为新 key 分配 Ticket ID，把已有 key 解析为当前 Ticket ID，并持久化 `TicketGraphSnapshot`。调用方不能把 key 当作 Ticket ID。新 revision 必须使用新 key，并以 `revisionOfKey` 指向已有 key；Ticket Engine 校验一条旧 revision 同时最多有一个 active successor，再在 snapshot 双向记录 `revisionOfTicketId/supersededByTicketId`。

领取和 ownership 操作使用显式幂等请求：

领取必须返回不可伪造、可失效的 ClaimReceipt：

```ts
interface ClaimReceipt {
  requestId: string;
  claimId: string;
  workflowId: string;
  ticketId: string;
  ticketVersion: number;
  principalId: string;
  fencingToken: number;
  leaseUntil: string;
}

interface BlockedOwnershipReceipt {
  ownershipId: string;
  workflowId: string;
  ticketId: string;
  ticketVersion: number;
  principalId: string;
  fencingToken: number;
}

type TicketExecutionAuthority =
  | { kind: "claim"; claimId: string; fencingToken: number }
  | { kind: "blocked_owner"; ownershipId: string; fencingToken: number };

interface ClaimRequest {
  requestId: string;
  workflowId: string;
  ticketId: string;
  expectedTicketVersion: number;
  principalId: string;
  leaseDurationMs: number;
}

interface RenewClaimRequest {
  requestId: string;
  claimId: string;
  fencingToken: number;
  extendByMs: number;
}

interface ReleaseClaimRequest {
  requestId: string;
  claimId: string;
  fencingToken: number;
  reason: "goal_cancelled" | "agent_unavailable" | "operator_release";
}

interface TransferBlockedOwnershipRequest {
  requestId: string;
  ownershipId: string;
  fencingToken: number;
  toPrincipalId: string;
}
```

同一 Ticket 每次重新领取或转移 ownership，`fencingToken` 单调递增。所有改变 Ticket 的执行命令必须携带当前 `TicketExecutionAuthority`。旧 Goal 即使晚到，也无法提交状态。

当 Ticket 合法进入 blocked 时，运行 lease 结束，但 Ticket Engine 返回 `BlockedOwnershipReceipt`。它保留同一个 owner 处理 human 回复的权利，不依赖无限续租；workflow cancel、明确移除/修订该 Ticket 的 graph amendment 或显式 ownership transfer 会使该 token 失效并递增 fencingToken。

`claimReady`、`renewClaim`、`releaseClaim` 和 `transferBlockedOwnership` 都按 requestId 幂等；同 ID 不同内容拒绝。`releaseClaim` 原子执行 `running -> ready` 并递增 fencingToken；ownership transfer 保持 Ticket blocked，但生成新 receipt 并使旧 token 失效。

Ticket 不单独保存 `claimed` 业务状态。`claimReady()` 原子地完成：

```text
Ticket ready -> running
创建 ClaimReceipt
写入 TicketClaimed outbox event
```

### 7.5 Ticket Command

Mission 模式下，Agent Goal 的 domain outcome 使用明确的 Ticket Command：

```ts
interface TicketCommandEnvelope<TPayload extends TicketCommandPayload> {
  commandId: string;
  proposalId: string;
  workflowId: string;
  ticketId: string;
  expectedTicketVersion: number;
  actorPrincipalId: string;
  executionRef: string;
  authority: TicketExecutionAuthority;
  issuedAt: string;
  payload: TPayload;
}

type TicketCommandResult =
  | {
      accepted: true;
      commandId: string;
      proposalId: string;
      ticketStatus: "blocked" | "completed" | "returned" | "failed";
      ticketVersion: number;
      workflowStatus: WorkflowStatus;
      workflowVersion: number;
      nextAuthority?: TicketExecutionAuthority;
    }
  | {
      accepted: false;
      commandId: string;
      proposalId: string;
      code:
        | "invalid_command"
        | "policy_violation"
        | "version_conflict"
        | "stale_authority"
        | "workflow_terminal"
        | "idempotency_conflict";
      reason: string;
      currentTicketVersion?: number;
      currentWorkflowVersion?: number;
    };

type TicketCommandPayload =
  | {
      type: "complete";
      result: unknown;
      evidence: EvidenceRef[];
    }
  | {
      type: "complete_with_graph";
      result: unknown;
      evidence: EvidenceRef[];
      expectedWorkflowVersion: number;
      graph: PlannedTicketGraph;
      completionPolicy: PlannedWorkflowCompletionPolicy;
      cancelTicketIds: string[];
    }
  | {
      type: "block";
      reason: string;
      requiredInput?: string;
    }
  | {
      type: "return_to_parent";
      parentTicketId: string;
      expectedWorkflowVersion: number;
      reason: string;
      evidence: EvidenceRef[];
    }
  | {
      type: "fail";
      reason: string;
      evidence: EvidenceRef[];
    };
```

`complete_with_graph` 必须在一个 Ticket Engine 事务中同时完成当前规划 Ticket、校验 key、为新节点分配 Ticket ID、持久化 `TicketGraphSnapshot`，并把 `requiredTerminalKeys` 解析成 runtime `requiredTerminalTicketIds`；不能出现“规划 Ticket 已完成但图或 policy 只创建一半”的状态。

独立的 workflow 管理使用另一组命令：

```ts
type WorkflowCommand =
  | { type: "create"; definition: WorkflowDefinition }
  | { type: "pause"; expectedWorkflowVersion: number }
  | { type: "resume"; expectedWorkflowVersion: number }
  | { type: "cancel"; expectedWorkflowVersion: number; reason: string }
  | {
      type: "amend";
      expectedWorkflowVersion: number;
      graph: PlannedTicketGraph;
      completionPolicy: PlannedWorkflowCompletionPolicy;
      cancelTicketIds: string[];
    };

interface WorkflowCommandEnvelope<TCommand extends WorkflowCommand = WorkflowCommand> {
  commandId: string;
  workflowId: string;
  actorPrincipalId: string;
  issuedAt: string;
  payload: TCommand;
}

type WorkflowCommandResult =
  | {
      accepted: true;
      commandId: string;
      workflowStatus: WorkflowStatus;
      workflowVersion: number;
    }
  | {
      accepted: false;
      commandId: string;
      code:
        | "invalid_definition"
        | "policy_violation"
        | "version_conflict"
        | "workflow_terminal"
        | "idempotency_conflict";
      reason: string;
      currentWorkflowVersion?: number;
    };
```

`WorkflowDefinition` 是产品层选择的版本化数据，不是 Mission Control 临时拼出来的流程：

```ts
interface WorkflowDefinition {
  definitionId: string;
  definitionVersion: number;
  initialGraph: PlannedTicketGraph;
  completionPolicy: PlannedWorkflowCompletionPolicy;
  policyRef: WorkflowPolicyRef;
}
```

所有 WorkflowCommand 也使用包含 `commandId`、`actorPrincipalId` 和 `issuedAt` 的 envelope。是否允许某个 principal 创建或修订 TicketGraph，由 workflow/team policy 和当前 Ticket 授权决定，不能通过 `role === "pm"` 的代码分支判断。当前最小团队策略可以只授权 PM 实例，但 Ticket Engine 只消费 capability，例如 `ticket_graph:create`。

Ticket Engine 必须持久化每个命令的确定结果。相同 `commandId` 或 `proposalId` 携带相同内容再次提交时，返回第一次的结果；相同 ID 携带不同内容时返回 idempotency conflict，绝不重复执行。`proposalId` 只能对应一个 Ticket Command。

### 7.6 Ticket 状态机

```text
create ------------------------------> pending / ready
pending --dependencies satisfied----> ready
ready --claimReady-------------------> running
running --renew----------------------> running
running --releaseClaim---------------> ready（旧 fencingToken 失效）
running --block----------------------> blocked
running --complete-------------------> completed
running --return_to_parent-----------> returned
running --fail-----------------------> failed
blocked --block----------------------> blocked（更新阻塞结论）
blocked --complete-------------------> completed
blocked --return_to_parent-----------> returned
blocked --fail-----------------------> failed
running --lease expired-------------> ready（旧 fencingToken 失效）
pending/ready/running/blocked --cancel workflow--> cancelled
```

`completed`、`returned`、`failed`、`cancelled` 是不可变终态。后续工作只能创建新 Ticket，不能原地改写已完成 Ticket。

### 7.7 Workflow 状态机与 policy

```ts
type WorkflowStatus =
  | "active"
  | "paused"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";
```

合法状态变化是：

```text
create(valid definition) ----------------------> active
active --pause---------------------------------> paused
paused --resume--------------------------------> active
active --required failure + require_resolution-> blocked
active --amend---------------------------------> active / blocked / completed
paused --amend---------------------------------> paused（保存重算结果）
blocked --amend--------------------------------> active / blocked / completed
active/paused/blocked --cancel-----------------> cancelled
active --completion policy satisfied----------> completed
active --required failure + fail_fast----------> failed
```

具体语义：

- `create` 先完整校验 graph、policy、principal capability 和引用，再原子创建 Workflow 与初始 Tickets；校验失败只返回 command rejected，不产生一个半初始化的 Workflow。
- `pause` 禁止产生新 claim。已有有效 authority 的 Ticket Command 仍可提交，以处理 pause 与正在结束的 turn 之间的竞态；Ticket 状态可以更新，但 Workflow 在 paused 期间不计算 completed/failed。Mission Control 在 turn 边界暂停仍未 settle 的 Goal，并继续续租；若 claim 先过期，则按正常过期规则回收。
- `resume` 先重新计算 failure/completion policy，再恢复领取 ready Ticket 和仍有有效 claim 的 Goal；它不复活已过期的 Goal。若恢复瞬间已满足终态条件，可在同一事务中直接进入 completed/failed。
- `cancel` 在同一 Ticket Engine 事务中将所有非终态 Ticket 置为 cancelled，并使 claim、blocked ownership 和未提交命令的 authority 全部失效。Mission Control 根据明确的 TicketCancelled/WorkflowCancelled 事件取消对应的非终态 Goal。
- `failurePolicy="fail_fast"` 时，active Workflow 的 required Ticket 进入 failed 会原子地把 Workflow 置为 failed、取消剩余非终态 Ticket并使 authority 失效。若 Workflow 正 paused，则保持 paused 并写 `deferredOutcome=failed`，resume 时执行同一终态事务。Mission Control 只根据这些已提交事件取消对应 Goal。
- `failurePolicy="require_resolution"` 时，active Workflow 的 required Ticket 进入 failed 会把 Workflow 置为 blocked 并停止新 claim；若 Workflow 正 paused，则写 `deferredOutcome=blocked`。已有 authority 与 Goal 保留但在 turn 边界暂停，运行 claim 继续续租。竞态中已发出的合法命令可更新 Ticket，但 Workflow 保持 blocked/paused，直到授权 principal 以新 Ticket/revision branch 修订 graph。修订后 policy 再次存在合法终点时才回到 active，或在 paused 状态更新 deferredOutcome，待 resume 恢复 Goal。
- `amend` 允许在 active、paused、blocked Workflow 上执行，terminal Workflow 拒绝。它必须同时校验 `expectedWorkflowVersion`，并在一个事务中原子提交 graph、key-to-ID 映射与 completion policy；不能只更新图或只更新终点。
- `complete_with_graph/amend.cancelTicketIds` 是取消可选/废弃工作的唯一图修订入口：只允许列出非终态 Ticket，并要求调用 principal 具备 `ticket_graph:create` 或 `workflow:control`；事务内把它们置为 cancelled、撤销 authority、发布 TicketCancelled，并从 active graph 移除。若新 graph 省略仍 active 的旧 key 却没有显式列出对应 Ticket ID，整个命令被拒绝，避免隐式删单。
- paused Workflow amend 后仍 paused，并保存重算结果供 resume 使用；active/blocked Workflow amend 后按当前 required closure 原子重算为 active、blocked 或 completed。
- invalid create/amend 是命令拒绝，不是可运行的 Workflow 状态；amend 被拒绝时原 Workflow 原样保留。

Mission Control 只能投影这里提交的 WorkflowStatus，不能自行把“暂时没有 ready Ticket”解释成 paused、blocked、failed 或 completed。

### 7.8 return_to_parent 的确定语义

`return_to_parent` 不是“跳转到某个角色”，而是 Ticket Engine 的通用 DAG 修订操作。提交成功时必须原子完成：

1. 当前 Ticket 进入 `returned`。
2. 校验目标确实是直接父 Ticket。
3. 原父 Ticket 保持不可变。
4. 创建父 Ticket 的新 revision Ticket，复制原负责人、工作定义和上游依赖，并附带 return reason/evidence。
5. 克隆从父 Ticket 到当前 returned Ticket、再到其 required terminal descendants 的验证路径，生成新的 revision branch。
6. 新路径使用由 Engine 生成的新 node key 与 Ticket ID，并通过 `revisionOfTicketId/supersededByTicketId` 关联对应旧 Ticket；依赖全部重连到新 revision branch。
7. 把 completion policy 中指向被克隆 terminal 的旧 Ticket ID 原子替换为对应 revision Ticket ID；未被克隆的 terminal 保持不变。
8. 与该返回路径无关的已完成并行分支保持有效，不重复执行。

因此 QA 打回开发只是“子 Ticket 返回直接父 Ticket”的一个实例。Ticket Engine 不需要知道哪一个是 QA 或开发，也不会修改旧 Ticket。

`return_to_parent` 必须携带 `expectedWorkflowVersion`；它与 `WorkflowCommand.amend` 或其他 graph 修订并发时，只有一个版本能够成功。revision branch 是 Ticket Engine 按原图机械复制的系统修订，不允许调用 Agent 任意指定新负责人、新依赖或绕过 `ticket_graph:create` capability，因此不等于任意 Agent 获得了规划权限。

若图无法唯一确定需要克隆的 required terminal path，Ticket Engine 拒绝命令并要求授权的 planner 先提交明确 graph amendment；Mission Control 不补猜测。

### 7.9 Ticket Engine 的提交校验

Ticket Engine 只做可证明、确定性的校验：

- Ticket 存在；
- command envelope 字段完整，`commandId` 与 `proposalId` 尚未应用；
- actorPrincipalId 与当前 ClaimReceipt 或 BlockedOwnershipReceipt 一致；
- TicketExecutionAuthority 与当前 claim 或 blocked owner 一致；运行态 claim 的 lease 仍有效；
- expectedTicketVersion 未过期；
- graph-changing command 的 expectedWorkflowVersion 未过期；
- 当前状态允许该动作；
- `return_to_parent` 只指向真实直接父 Ticket；
- 新图无环、引用存在、目标 assignee/capability 合法；
- 已完成 Ticket 不被原地修改；
- 依赖和 completion policy 保持一致。

Ticket Engine 不校验“这个测试报告专业上是否正确”。这由负责 QA、验收或其他审查 Ticket 的 Agent 判断。

## 8. Mission Control 设计

### 8.1 定位

Mission Control 是一个持久化 process manager/saga。它连接两个 Engine，但不成为第三套业务状态机。

### 8.2 Mission Control 负责

- 接收产品层的开始、暂停、继续和停止命令；
- 接收产品层已经选择并版本化的 `WorkflowDefinition`，原样提交给 Ticket Engine；
- 从 Ticket Engine 消费 `TicketReady`；
- 选择目标 Agent 实例并领取 Ticket；
- 把 Ticket 投影为 `AgentGoalSpec`；
- 建立 Ticket 与 Agent Goal 的关联；
- 启动、恢复、暂停或取消 Agent Goal；
- 把 Agent Goal proposal 映射为 Ticket Command；
- 把 Ticket Engine 的接受/拒绝结果返回 Agent Engine；
- 在 Engine 之间提供幂等、重试和崩溃恢复；
- 根据 Ticket Engine 返回的 workflow status 投影 Mission 状态；
- 发布供 UI 使用的集成事件。

### 8.3 Mission Control 绝对不能做

- 从自然语言、关键词或正则推断 Ticket 动作；
- 根据角色、phase 或 ticket type 决定后继；
- 根据 `passed:false`、`accepted:false`、文件路径或工具失败自行创建 Ticket；
- 判断 Agent 是否真的完成；
- 把一次 Turn 结束当成 Ticket 完成；
- 在 Ticket Engine 之外保存另一份 workflow 真相；
- 在 AgentThread 之外保存另一份会影响模型的消息历史；
- 自动把拒绝、失败或人工测试映射到某个固定 Agent；
- 为旧 phase 路由保留 fallback。

### 8.4 Mission Link

胶水层需要持久化关联事实，但这些不是业务 flow：

```ts
interface MissionLink {
  dispatchId: string;
  missionId: string;
  workflowId: string;
  ticketId: string;
  ticketVersion: number;
  agentId: string;
  agentPrincipalId: string;
  claimRequestId: string;
  goalStartKey: string;
  agentThreadId?: string;
  agentGoalId?: string;
  authority?: TicketExecutionAuthority;
  status:
    | "dispatching"
    | "starting"
    | "running"
    | "blocked"
    | "resolving"
    | "paused"
    | "settled"
    | "cancelled"
    | "recovering";
  lastProposalId?: string;
  lastCommandId?: string;
  lastDecisionId?: string;
  updatedAt: string;
}
```

MissionLink 必须在 claim 前以 `dispatching` 状态落盘。`dispatchId` 由 missionId + ticketId + ticketVersion 确定性生成，`claimRequestId` 与 `goalStartKey` 也从 dispatchId 派生。状态字段约束是：

| Link 状态 | 必须存在 |
|---|---|
| `dispatching` | agentId、agentPrincipalId、claimRequestId、goalStartKey；不得要求 authority/goalId |
| `starting` | authority；goalId 可以尚未写回 |
| `running/blocked/resolving/paused` | authority、agentThreadId、agentGoalId |
| `settled/cancelled` | 最终 Ticket/Goal 引用 |

MissionLink 的作用是：服务重启后知道一次 Ticket dispatch 走到哪一步，以及某次 proposal 是否已经提交。它不能保存“下一阶段是 QA”之类业务判断。同一个 Ticket version 只能有一个非终态 dispatch link。

初始 workflow 的来源必须明确：

```ts
interface MissionStartRequest {
  missionId: string;
  objective: string;
  workflowDefinition: WorkflowDefinition;
  teamBindingId: string;
  requestedByPrincipalId: string;
}

interface WorkflowDefinitionRegistryPort {
  resolve(input: {
    templateId: string;
    templateVersion?: number;
    teamBindingId: string;
  }): Promise<WorkflowDefinition>;
}

interface MissionRecord {
  missionId: string;
  workflowId: string;
  workflowCreateCommandId: string;
  status: "starting" | "linked" | "start_failed";
}
```

产品层可以从版本化模板（例如当前最小真实团队模板）生成 `WorkflowDefinition`，也可以未来由用户选择模板。Mission Control 不能在收到目标后自行拼出“老板 -> PM -> 开发 -> QA”拓扑；它只提交定义。运行中的 Agent 只能通过自己 Ticket proposal 内的 `complete_with_graph` 扩展 DAG；`WorkflowCommand.amend` 只供拥有 `workflow:control` capability 的产品/管理员控制面调用，不伪装成 Agent proposal。

### 8.5 Mission Control 最小接口

```ts
interface TicketPort {
  createWorkflow(command: WorkflowCommandEnvelope): Promise<WorkflowCommandResult>;
  applyWorkflow(command: WorkflowCommandEnvelope): Promise<WorkflowCommandResult>;
  getWorkflow(workflowId: string): Promise<WorkflowSnapshot>;
  getTicket(ticketId: string): Promise<TicketSnapshot | undefined>;
  getClaim(claimId: string): Promise<ClaimReceipt | undefined>;
  getClaimByRequestId(requestId: string): Promise<ClaimReceipt | undefined>;
  getWorkflowCommandResult(commandId: string): Promise<WorkflowCommandResult | undefined>;
  getTicketCommandResult(commandId: string): Promise<TicketCommandResult | undefined>;
  claimReady(input: ClaimRequest): Promise<ClaimReceipt | undefined>;
  renewClaim(input: RenewClaimRequest): Promise<ClaimReceipt>;
  releaseClaim(input: ReleaseClaimRequest): Promise<TicketSnapshot>;
  transferBlockedOwnership(input: TransferBlockedOwnershipRequest): Promise<BlockedOwnershipReceipt>;
  applyTicket(command: TicketCommandEnvelope<TicketCommandPayload>): Promise<TicketCommandResult>;
  readEvents(input: { workflowId: string; after?: EventCursor; limit: number }): Promise<EventPage<TicketEvent>>;
}

interface AgentPort {
  ensureThread(input: EnsureAgentThreadRequest): Promise<AgentThreadSnapshot>;
  getThreadForAgent(agentId: string, scopeId: string): Promise<AgentThreadSnapshot | undefined>;
  startGoal(input: StartAgentGoalRequest & { idempotencyKey: string }): Promise<AgentGoal>;
  getGoalByStartKey(idempotencyKey: string): Promise<AgentGoal | undefined>;
  getGoal(goalId: string): Promise<AgentGoal | undefined>;
  getProposal(proposalId: string): Promise<GoalResolutionProposal | undefined>;
  getThread(threadId: string): Promise<AgentThreadSnapshot>;
  sendMessage(input: SendAgentMessageRequest): Promise<void>;
  controlGoal(input: AgentGoalControlRequest): Promise<AgentGoal>;
  settleProposal(input: SettleProposalRequest): Promise<SettleProposalResult>;
  readEvents(input: { agentId: string; after?: EventCursor; limit: number }): Promise<EventPage<AgentEvent>>;
}
```

事件消费使用 aggregate-partitioned durable cursor，不依赖仅存在于进程内的 callback subscription。Ticket 事件按 workflowId 分区，Agent 事件按 agentId 分区；Mission Control 为每个 `ticket:<workflowId>` 与 `agent:<agentId>` 分区分别保存最后提交 cursor 和 applied aggregateVersion。事件允许至少一次交付，consumer 必须按 eventId 幂等；不同分区的 cursor 不能混用。

开始、暂停、继续、停止的协议顺序：

```text
start  : 先保存 MissionRecord -> Ticket Engine create workflow -> 消费 TicketReady -> 先建 dispatch link 再 claim/startGoal
pause  : Ticket Engine pause workflow  -> Agent Engine 在 turn 边界 pause linked goals
resume : Ticket Engine resume workflow -> Agent Engine resume linked goals / 继续领取 ready tickets
cancel : Ticket Engine cancel workflow -> 按 Ticket snapshot 取消仍非终态的 linked goals
```

若中途崩溃，Mission Control 通过 workflow snapshot、Goal/proposal snapshot、command result 和 MissionLink reconciliation 继续未完成步骤，不反向撤销已提交的 Engine 事实。

Mission Control 的主流程应由事件和命令组成，不由一个 1900 行函数读取所有内部状态并连续分支。

### 8.6 Lease、续租与失效 Goal

- Mission Control 是运行 claim 的续租者。只要 MissionLink 持有 kind=`claim` 的 authority 且处于 `starting`、`running`、`resolving` 或 `paused`，它就在 `leaseUntil` 前请求续租；续租间隔是运行配置，不是 Agent turn 次数或业务结论。
- `block` 提交成功时，Ticket Engine 原子结束运行 claim、生成 `BlockedOwnershipReceipt`，并在 command result 中返回新 authority。Mission Control 必须先持久化这次 authority 切换，才能把 Goal settle 为 blocked。
- blocked ownership 没有运行 lease。human 唤醒同一个 Goal 时仍使用该 ownership；只有 workflow cancel、明确移除/修订该 Ticket 的合法 graph amendment 或显式 ownership transfer 能使它失效。
- Ticket Engine 是 lease 是否过期的唯一裁判。过期时它原子执行 `running -> ready`、递增 fencingToken 并发布 `ClaimExpired`；Mission Control 看到该事实后取消旧 Goal 的执行资格。
- 旧 Goal 的 Thread 与历史仍保留，但它不能再提交 Ticket Command。晚到 proposal 必须得到 `stale_claim`，不得重新激活 Ticket。
- Ticket 被重新领取时创建新 Goal；若仍分配给同一个 Agent，可继续使用同一个 AgentThread，并通过 ContextRef 引用旧 Goal 的摘要和证据，但不能复用旧 authority。
- 暂时性续租错误只触发基础设施重试。只有 Ticket Engine 已确认过期，才执行 stale Goal 处理。

## 9. 两阶段完成协议

### 9.1 唯一合法映射

Mission adapter 只允许以下映射，不能自行组合：

| Goal proposal status | Ticket payload | Ticket Engine 提交结果 | Agent Goal 最终状态 |
|---|---|---|---|
| `completed` | `complete` | Ticket `completed` | `completed` |
| `completed` | `complete_with_graph` | 当前 Ticket `completed`，图与 policy 原子更新 | `completed` |
| `blocked` | `block` | Ticket `blocked` | `blocked` |
| `completed` | `return_to_parent` | 当前 Ticket `returned`，revision branch 已创建 | `completed`，domainResult=`returned` |
| `failed` | `fail` | Ticket `failed` | `failed` |

任何其他组合都在进入 Ticket Engine 前按 output contract 拒绝，并作为 `correctable` observation 返回同一个 Agent。例如 proposal.status=`completed` 但 payload.type=`block` 不允许提交。

Ticket Engine 接受后的 committedState 也必须与此表一致。Mission Control 不能把 Ticket `returned` 映射成 Agent Goal `failed`，也不能把 Ticket `blocked` 映射成 completed。

### 9.2 正常完成

```text
1. Agent 在多个 turn 中工作。
2. Agent 显式提交 GoalResolutionProposal(completed, TicketCommand.complete)。
3. Agent Engine 持久化 proposal，Goal -> resolving。
4. Mission Control 使用 proposalId 生成幂等 commandId。
5. Ticket Engine 校验 owner、version、状态和命令结构。
6. Ticket Engine 提交 Ticket completed，并发布 TicketCompleted。
7. Mission Control 将 accepted 返回 Agent Engine。
8. Agent Goal -> completed，MissionLink -> settled。
9. Ticket Engine 根据 DAG 发布新的 TicketReady 或 WorkflowCompleted。
```

### 9.3 Ticket Engine 拒绝

```text
1. Agent 提交非法跨层 return_to_parent 或过期版本。
2. Ticket Engine 返回 rejected(reason, currentVersion)。
3. Mission Control 原样传回，不改写原因，不选择新路线。
4. Agent Engine 追加 tool/system observation。
5. 若 disposition=`correctable`，Agent Goal resolving -> active。
6. 若 disposition=`stale_claim` 或 `workflow_terminal`，旧 Goal cancelled，不能继续提交。
7. 若 resolution attempt=`settle:false/retry_later`，不调用 settle，Goal 保持 resolving，Mission Control 使用同一个 commandId 重试或查询已提交结果。
8. 查到确定结果后派生唯一 decisionId，并只提交一次 final decision。
9. 若 disposition=`host_error`，Goal paused，平台记录 incident，等待系统恢复或管理员处理。
10. 同一个仍有有效 authority 的 Agent 在后续 turn 修正结论或继续工作。
```

Ticket adapter 对确定性结果只允许以下映射：

| Ticket/基础设施结果 | GoalResolutionDecision |
|---|---|
| `invalid_command`、`policy_violation` | `correctable`，附结构化校验错误 |
| `version_conflict` 且 authority 仍有效 | `correctable`，附当前 Ticket/Workflow 版本引用 |
| `stale_authority` | `stale_claim` |
| `workflow_terminal` | `workflow_terminal` |
| provider、网络或存储暂时不可达，尚不知命令是否提交 | 先按 commandId 查询；仍未知返回 `settle:false/retry_later`，不结算 proposal |
| `idempotency_conflict` 或 Engine invariant violation | `host_error` |

这张表只翻译协议结果，不判断业务文本。reason 原文进入 LoopTrace；给 Agent 的 observation 可以结构化展示，但不能改写成另一种业务结论。

拒绝不是 Mission 失败，也不是 human-in-loop。

### 9.4 阻塞和 human-in-loop

```text
Agent 提交 blocked proposal
  -> Ticket Engine 接受 Ticket blocked
  -> Agent Goal blocked
  -> UI 在该 Agent 上显示需处理标记
  -> human 消息进入同一个 AgentThread
  -> Mission Control 只请求 Agent Engine 恢复同一个 Goal
  -> Ticket 仍保持 blocked，owner 和关联关系不变
  -> 下一 turn 读取按时间排序的 human 消息
  -> Agent 提交新的 complete/block/return/fail proposal
  -> Ticket Engine 再根据明确 command 改变 Ticket 状态
```

human 消息只唤醒被选中的 Agent/Goal。它本身不 reopen Ticket，也不构成 Ticket Command。Mission Control 不解释消息是否等于批准、测试通过或失败。

若 Workflow lifecycle 正处于 paused 或 policy-level blocked，消息仍立即按 sequence 写入 AgentThread，但 Goal resume 延迟到 Workflow 允许执行；不能绕过 workflow pause。

Agent 收到消息后重新判断，并提交新的 Goal Resolution Proposal。

### 9.5 向父 Ticket 打回

Agent 提出 `return_to_parent`，Ticket Engine 只校验直接父关系并提交：

```text
当前 Ticket -> returned
直接父 Ticket -> 按 workflow 规则重新可处理或生成修订工作
当前 Agent Goal -> completed(domain outcome = returned)
```

具体新分支由第 7.8 节定义的 revision branch 规则创建；已完成父 Ticket 不重新激活，Mission Control 也不能创建“看起来合适”的新 Ticket。

### 9.6 pause、cancel 与 settle 的并发裁决

Ticket Engine 的事务顺序决定 Ticket 事实，Agent Engine 的 version/decisionId 保证 Goal 只结算一次：

1. Ticket Command 先提交、workflow cancel 后提交：Ticket 的既有终态不被 cancel 改写；Mission Control 必须先用已提交 command result settle 该 Goal，只取消 Ticket 被置为 cancelled 的其他 Goal。
2. workflow cancel 先提交：authority 已失效，晚到 Ticket Command 返回 `workflow_terminal`/`stale_authority`，随后旧 Goal cancelled。
3. workflow pause/block 与 Ticket Command 竞态：已有有效 authority 的 command 可提交；Goal 即使先进入 paused，只要 activeProposalId 相同，accepted decision 仍可 settle。Workflow 终态计算按第 7.7 节延迟。
4. Mission 模式下，用户取消单个 Agent Goal 必须先经 Mission Control `releaseClaim` 或转移 blocked ownership，再取消 Goal；不能只取消 Agent 而把 Ticket 留在 running/blocked。
5. Mission Control 不根据乱序 event 直接 cancel Goal；它先读取 Ticket/Workflow snapshot 和 command result，再按 aggregateVersion 执行上述规则。

这些是并发与所有权规则，不是业务后继规则。

## 10. Mission 完成策略

Mission Control 不使用：

```ts
if (qaPassed) createBossAcceptance();
if (allTicketsLookDone) missionCompleted();
```

Ticket workflow 创建时必须携带明确的 `WorkflowCompletionPolicy`：

```ts
interface WorkflowCompletionPolicy {
  requiredTerminalTicketIds: string[];
  failurePolicy: "fail_fast" | "require_resolution";
  blockedPolicy: "wait";
}
```

`WorkflowCompletionPolicy` 是 Ticket Engine 解析 key 后的 runtime policy；命令输入使用 `PlannedWorkflowCompletionPolicy.requiredTerminalKeys`。

required 语义必须可计算：

```text
required closure =
  当前 active graph 中，从 requiredTerminalTicketIds 沿 dependencyEdges 反向可达的全部 Ticket
  + requiredTerminalTicketIds 自身
```

`required failure` 是 required closure 中 status=failed 的 Ticket。它只有在一次合法 amend/return 事务同时满足以下条件时才算 resolved：

1. failed Ticket 已通过 `supersededByTicketId` 指向一个 active revision，revision 链最终进入当前 required closure；
2. failed Ticket 本身已不在当前 required closure；
3. requiredTerminalTicketIds 已原子指向新 revision path 的终点；
4. 新 required closure 仍有到达全部 required terminal 的合法 DAG 路径。

仅从 policy 删除 terminal、仅把 failed node 标为 inactive，或创建没有 revision/supersession 关系的新节点，都不能解除 required failure。`amend`/`return_to_parent` 事务按上述定义重算：仍有 unresolved required failure 为 blocked；无 failure 且满足完成条件为 completed；否则为 active。paused Workflow 只保存同一重算结果，等 resume 再提交 lifecycle 变化。

当前最小真实团队可以生成一张老板验收 Ticket，并把它声明为 required terminal Ticket。但这是 workflow 数据，不是 Engine 代码规则。

Ticket Engine 只有在以下条件都成立时发布 `WorkflowCompleted`：

- 所有 required terminal Tickets 均 completed；
- 整个 Workflow 不存在 pending/ready/running/blocked Ticket；不需要执行的可选工作必须先被显式取消，不能悬空；
- 没有未解决的 required failure；
- Workflow 当前是 active；paused/blocked 状态只记录 Ticket 结果，终态判断延迟到 resume/amend；
- workflow 版本在检查和提交期间没有变化。

Mission Control 收到 `WorkflowCompleted` 后仅投影 Mission 为 completed。

其他 Workflow 结果同样只做一一投影：

- `paused` -> Mission paused；
- `blocked` -> Mission blocked，并显示需要哪项 graph/policy resolution；
- `failed` -> Mission failed；
- `cancelled` -> Mission cancelled。

这里的 blocked 指 WorkflowStatus blocked（required failure 等待 graph/policy resolution）。单张普通 Ticket blocked 不改变 Workflow lifecycle，只产生 UI `waiting_for_human` activity。

不存在“没有 ready Ticket 所以完成”或“Agent 都在等待所以失败”的推断。invalid create/amend 只是对应命令失败；已有 Workflow 不被改写，新 Mission 在 create 失败时也不能进入 running。

## 11. 消息与上下文

### 11.1 单一时间线

每个 Agent 的所有模型可见消息必须先进入同一个 AgentThread：

- human 私聊；
- Goal 激活与更新；
- Ticket 投递摘要；
- Agent 回复；
- 工具调用和观察；
- Ticket Command 接受或拒绝；
- pause/resume/limit 等系统事件。

SessionStore 是 AgentThread 的模型可见投影，不是第二个事实源。

### 11.2 不进入模型上下文的内容

- 完整 prompt；
- 完整 raw tool 输出；
- UI 聚合卡片；
- Mission 快照；
- 全部 Ticket 事件；
- 其他 Agent 的 Thread；
- `latestHumanMessage` 一类旁路字段。

这些保存在 trace/read model，需要时按明确引用提取。

### 11.3 Prompt cache

稳定前缀按以下顺序组装：

```text
Soul -> Identity -> Agent Definition -> Tool Schemas -> Goal Protocol
```

动态部分在后：

```text
Goal -> compacted Thread history -> latest messages -> tool observations
```

这样既保持 Agent 人格和能力稳定，也有利于 provider prompt cache。

## 12. 长时间运行与恢复

### 12.1 Yield 只结束执行片

预算、墙钟、暂停检查或调度公平性可以结束当前执行片：

```text
Turn/Execution Slice -> yielded
Agent Goal -> active
Ticket -> running，claim 仍有效
Mission -> running
```

yield 不创建 human-in-loop，不完成 Ticket，不改变 DAG。

### 12.2 服务重启

重启恢复顺序：

1. Ticket Engine 从自己的 durable aggregate/snapshot 恢复 Workflow、Ticket、inbox、claim 和命令结果。
2. Agent Engine 从 AgentThread、Goal、Session checkpoint 恢复。
3. Mission Control 从 MissionRecord 与 MissionLink 恢复 workflow 创建和跨 Engine 关联。
4. 对 `dispatching`、`starting`、`resolving`、`recovering` link 做幂等 reconciliation。
5. 已提交的 commandId/proposalId 不重复应用。
6. active Goal 和有效 claim 继续；过期 claim 由 Ticket Engine 自己回收。

Mission Control 不通过扫描 UI phase 猜测从哪里继续。

### 12.3 明确的崩溃窗口

| 崩溃位置 | 恢复依据 | 恢复动作 |
|---|---|---|
| MissionRecord 已保存，create workflow 尚未提交 | `workflowCreateCommandId` | 查询结果；未知则以同一 commandId 重试 create |
| workflow 已创建，TicketReady 尚未处理 | durable Ticket cursor + workflow snapshot | 重放 TicketReady 或扫描 snapshot 中 ready Ticket |
| dispatch link 已保存，claim 尚未提交 | `claimRequestId` + `MissionLink.dispatching` | 以同一 requestId 调用 `claimReady` |
| claim 已提交但响应/link 写回丢失 | `getClaimByRequestId` | 找回同一 ClaimReceipt，补 authority，进入 starting |
| claim 已提交，Goal 尚未创建 | ClaimReceipt + `goalStartKey` | 使用同一 idempotencyKey 再次 `startGoal` |
| Goal 已创建，link 尚未写回 goalId | `getGoalByStartKey` | 找回同一个 Goal，补全 link |
| proposal 已持久化，Ticket Command 尚未提交 | `getProposal` + `MissionLink.resolving` | 生成同一个 commandId 并提交 |
| Ticket Command 已提交，Agent Goal 尚未 settle | `getTicketCommandResult` | 从 proposalId + commandId + canonical result 重建 decisionId，将 final decision 传给 `settleProposal` |
| Agent Goal 已 settle，link 尚未 settled | Goal snapshot + Ticket snapshot | 只补 link 和 projection |
| event 已处理，cursor 尚未提交 | eventId + aggregateVersion | 幂等重放，不重复产生命令 |

恢复只补齐尚未完成的协议步骤，不撤销另一 Engine 已经提交的事实，也不新建“补偿 Ticket”来掩盖基础设施中断。

## 13. 并发、幂等和一致性

公开 snapshot 与事件 envelope 至少包含以下并发字段；实现可以增加字段，不能删掉这些字段：

```ts
interface TicketSnapshot {
  ticketId: string;
  workflowId: string;
  version: number;
  status: TicketStatus;
  parentTicketId?: string;
  activeAuthority?: TicketExecutionAuthority;
}

interface WorkflowSnapshot {
  workflowId: string;
  version: number;
  status: WorkflowStatus;
  deferredOutcome?: "active" | "blocked" | "completed" | "failed";
  graph: TicketGraphSnapshot;
  completionPolicy: WorkflowCompletionPolicy;
  policyRef: WorkflowPolicyRef;
}

interface EngineEventEnvelope<TPayload> {
  eventId: string;
  aggregateType: "workflow" | "ticket" | "agent_thread" | "agent_goal";
  aggregateId: string;
  aggregateVersion: number;
  occurredAt: string;
  payload: TPayload;
}

interface EventCursor {
  source: "ticket" | "agent";
  partitionId: string;
  position: string;
}

interface EventPage<TEvent> {
  events: TEvent[];
  nextCursor: EventCursor;
}

type TicketEventPayload =
  | { type: "TicketReady"; ticketId: string; ticketVersion: number }
  | { type: "TicketClaimed"; ticketId: string; claimId: string }
  | { type: "ClaimExpired"; ticketId: string; claimId: string }
  | { type: "TicketBlocked"; ticketId: string; requiredInput?: string }
  | { type: "TicketTerminal"; ticketId: string; status: "completed" | "returned" | "failed" | "cancelled" }
  | { type: "AuthorityRevoked"; ticketId: string; fencingToken: number }
  | { type: "WorkflowStatusChanged"; workflowId: string; status: WorkflowStatus };

type AgentEventPayload =
  | { type: "MessageAppended"; threadId: string; messageId: string; sequence: number }
  | { type: "TurnStatusChanged"; threadId: string; turnId: string; status: string }
  | { type: "GoalStatusChanged"; goalId: string; status: AgentGoalStatus }
  | { type: "GoalProposalCreated"; goalId: string; proposalId: string };

type TicketEvent = EngineEventEnvelope<TicketEventPayload>;
type AgentEvent = EngineEventEnvelope<AgentEventPayload>;
```

Ticket event payload 至少区分 `TicketReady`、`TicketClaimed`、`ClaimExpired`、`TicketBlocked`、`TicketTerminal`、`AuthorityRevoked` 和 `WorkflowStatusChanged`；Agent event payload 至少区分 `MessageAppended`、`TurnStatusChanged`、`GoalStatusChanged` 和 `GoalProposalCreated`。每个 payload 只携带所属 aggregate 的事实，不复制另一 Engine 的内部状态。

两个 Engine 独立持久化意味着不能依赖一次跨存储原子事务。Mission Control 必须使用 process manager/saga 语义：

- 每个事件有 eventId；
- 每个 proposal 有 proposalId；
- 每个 Ticket Command 有 commandId；
- Ticket 使用 expectedVersion；
- consumer 至少一次投递；
- Engine 处理命令必须幂等；
- MissionLink 记录最后成功步骤；
- 崩溃后重放不会产生重复 Ticket、重复完成或错误解锁。

V1 不要求完整 event sourcing。每个 Engine 的 durable aggregate/snapshot 是本 Engine 的当前事实源；状态提交事务同时写 audit record 与 transactional outbox。outbox 用于可靠投递、审计和 read projection，不要求仅靠事件重建全部状态。

事件顺序只在同一 aggregate 内保证，并携带 aggregateVersion。消费者忽略低于或等于已应用版本的乱序/重复事件；出现版本缺口时暂停该 aggregate 的投影并通过 snapshot reconciliation 补齐。跨 Agent、跨 Ticket 的全局时间线用于 UI，不作为业务正确性的前提。

## 14. 错误边界

| 错误 | 所有者 | 结果 |
|---|---|---|
| Provider 临时失败 | Agent Engine | retry/yield，Goal 保持 active |
| Tool 执行失败 | Agent Engine | observation 回到同一 Goal |
| Session/Thread 写入失败 | Agent Engine | turn 失败，不提交 Ticket |
| Ticket command 非法 | Ticket Engine | rejected，Goal 恢复 active |
| Ticket lease 过期 | Ticket Engine | 回收并重新投递 |
| MissionLink 写入失败 | Mission Control | reconciliation，不重做已幂等提交 |
| human 未回复 | Ticket + Agent Goal | Ticket/Goal blocked；Workflow lifecycle 不变，UI attention=`waiting_for_human` |
| create/amend 后 workflow 无合法终点 | Ticket Engine | command rejected；不创建或不修改 Workflow |
| Agent 明确不可完成 | Agent + Ticket Engine | failed proposal 经提交后生效 |

任何基础设施错误都不得被改写成“QA 不通过”“老板驳回”或其他业务结论。

## 15. Read Model 与 UI

UI 从独立 projection 读取：

- Ticket Engine 事件投影为原始工单、DAG、状态和依赖；
- Agent Engine 事件投影为 Agent 对话、当前 Goal、turn 和工具活动；
- Mission 集成事件投影为关联关系和整体状态；
- LoopTrace 提供 prompt、LLM、工具和提交协议的调试详情。

Mission 的权威生命周期与运行注意力必须分开：

```ts
interface MissionProjection {
  missionId: string;
  lifecycle: "starting" | "start_failed" | WorkflowStatus;
  activity: "idle" | "running" | "waiting_for_human";
  workflowVersion?: number;
}
```

`lifecycle` 只来自 MissionRecord 的 create result 或 Ticket Engine 的 WorkflowStatus。`activity` 是 read model 对显式事实的确定投影：存在 running turn 为 running；不存在 running turn但存在带 requiredInput 的 blocked Ticket/Goal 为 waiting_for_human；否则为 idle。activity 只控制 UI 高亮和提醒，绝不解锁 Ticket、改变 Workflow 或决定后继。

Canvas 上的状态必须来自实际所有者：

- Agent turn running：绿色运行态；
- Agent Goal blocked：黄色感叹号；
- Ticket 在队列但 Agent 未运行：等待态；
- proposal resolving：显示“正在提交结论”，不能显示完成；
- Ticket command rejected：显示在对应 Agent 对话中，不影响其他 Agent；
- WorkflowCompleted：才显示 Mission 完成。

## 16. 当前代码与目标设计的差距

### 16.1 Agent Runtime

当前 `AgentRuntime.runAssignment()`：

- 直接依赖 Assignment、Ticket、TaskRun 和角色；
- provider 没有更多工具调用时即把 Assignment 标为 completed；
- 没有独立持久 Agent Goal；
- 没有显式、可被 host 接受或拒绝的 resolution proposal。

目标：改为通用 Thread/Goal/Turn Runtime，Ticket 通过 adapter 注入。

### 16.2 Ticket Runtime

当前 Ticket Runtime：

- 内置 human manual test 行为；
- 硬编码通过后创建老板验收、失败后创建开发返工；
- Ticket 与 inbox 主要从 MissionState 快照重建，不是独立 durable aggregate。

目标：只处理通用 Ticket Command、DAG、lease、状态和 workflow policy。

### 16.3 Mission Control

当前 Mission Control：

- 同时负责 API、状态存储、调度、Agent 调用、Ticket 创建、角色选择、业务判断、上下文旁路、UI 快照和恢复；
- 包含 phase 映射、QA/老板/开发特殊分支、交付证据推断、工具错误路由和默认后继；
- 一个文件接近 1900 行。

目标：收缩为事件驱动的 process manager，并把 read projection、workflow policy、Agent Goal 和 Ticket 状态分别交还所属模块。

## 17. 不变量

实现必须始终满足：

1. 自然语言本身不改变 Ticket 或 Mission 状态。
2. Turn 结束不等于 Goal 完成。
3. Goal 完成提案不等于 Ticket 已完成。
4. Ticket command 只有 Ticket Engine 可以提交。
5. Mission Control 不产生业务后继。
6. Ticket Engine 不调用 LLM。
7. Agent Engine 不导入 Ticket/Mission/Phase/团队角色类型。
8. human 消息只进入目标 Agent 的同一时间序 Thread。
9. Ticket command 被拒绝后，同一个 Agent Goal 继续，不唤醒其他 Agent。
10. workflow 完成只能由 Ticket Engine 的 completion policy 得出。
11. 运行预算只影响执行片，不产生业务失败或阻塞。
12. 所有跨 Engine 操作可幂等重放。
13. 新运行只使用新协议，不保留 phase fallback。

## 18. 测试边界

### 18.1 Agent Engine 独立测试

- 无 Ticket 类型即可启动普通对话。
- 无 Ticket 类型即可创建持久 Goal。
- 一次 turn 结束但 Goal active 时自动继续。
- 显式 proposal 才能结束 Goal。
- host 拒绝 proposal 后 Goal 恢复 active。
- proposal 和 settle 分别按 proposalId/decisionId 幂等；同 ID 不同内容冲突。
- pause 与 settle 竞态时，activeProposalId 相同的 accepted decision 只应用一次。
- human 消息按时间序进入下一 turn。
- yield、pause、resume、compaction 和服务重启保持同一个 Goal。

### 18.2 Ticket Engine 独立测试

- 无 Agent Runtime 即可由测试 principal 创建、领取和完成 Ticket。
- DAG、依赖、lease、过期恢复和 command 幂等。
- 非 owner、过期 version、跨层 return 均被拒绝。
- 同一 commandId/proposalId 重放只得到第一次结果；ID 相同但内容不同被拒绝。
- lease 过期后，旧 fencingToken 和晚到 proposal 永远不能改变 Ticket。
- blocked ownership 可以继续同一 Ticket，但 transfer/cancel/amend 后立即失效。
- pause 后不产生新 claim；resume 不复活过期 claim。
- paused/blocked workflow 中已有有效 command 可以 settle Ticket，但 workflow 终态判断延迟。
- cancel 原子取消非终态 Ticket 并使全部 authority 失效。
- `fail_fast` 与 `require_resolution` 产生各自定义的 Workflow 终态或阻塞态。
- invalid create/amend 不留下半张图；graph 与 completion policy 始终原子更新。
- planned key 在同一事务解析为 Ticket ID；snapshot 可追溯 key、ticketId 和 revision，policy 不引用未创建 ID。
- complete_with_graph/amend 的 cancelTicketIds 原子取消可选非终态 Ticket；省略 key 不会隐式删单。
- required failure 只有被当前 required closure 中的 revision chain 显式 supersede 后才解除。
- return revision branch 不改写已完成 Ticket，也不重跑无关并行分支。
- return 与 graph amend 并发时 expectedWorkflowVersion 只允许一方成功，并原子替换 terminal IDs。
- Ticket Engine 不自动生成固定角色后继。
- workflow completion policy 是数据驱动的。

### 18.3 Mission Control 合约测试

- TicketReady 只激活目标 Agent。
- 一个 Ticket 只建立一个有效 Agent Goal link。
- workflow create 响应丢失、claim 响应丢失和 Goal start 响应丢失均能按稳定 ID 找回原结果。
- proposal 接受后恰好提交一次 Ticket Command。
- 暂时未知的 command result 不 settle proposal；查明最终结果后使用可重建 decisionId 只 settle 一次。
- proposal 拒绝后反馈同一个 Agent，不创建新 Ticket。
- 崩溃发生在任意 saga 步骤后均可恢复。
- Ticket Command 已提交但 Goal 尚未 settle 时，恢复只 settle 原 proposal，不重复命令。
- Goal 已创建但 MissionLink 尚未写回时，idempotencyKey 找回同一个 Goal。
- 事件重复、乱序和 cursor 重放不会回退 Ticket、Goal 或 Mission 状态。
- claim 过期后旧 Goal 被取消执行资格；重新领取创建新 Goal，但可复用同一 Thread。
- blocked Agent 收到 human 消息时只恢复该 Goal，Ticket 仍 blocked，直到新 proposal 提交。
- pause、resume、cancel 均按 Ticket Engine 事实传播到关联 Goal。
- workflow terminal 与 Ticket completion 竞态按 Ticket snapshot/aggregateVersion 结算，不会错误取消已提交 Goal。
- Agent 私聊不会唤醒 PM 或其他 Agent。
- 没有 WorkflowCompleted 时 Mission 不得 completed。

### 18.4 禁止回归测试

- 禁止 `phase -> next phase` 路由。
- 禁止从字符串关键词判断通过、失败、授权或返工。
- 禁止 `role === "qa"`、`role === "boss"` 等决定 workflow 后继。
- 禁止 AgentRuntime import Ticket/Mission 类型。
- 禁止 TicketRuntime import Provider/Prompt/Tool/Session 类型。

## 19. 迁移原则

本次重构不采用双路由兼容和止血 fallback。

- 先为现有行为建立事实测试和事件样本。
- 新建 Engine contract 和独立存储。
- 新 TaskRun 直接切换到新协议。
- 旧 TaskRun 不进入新调度器；开发阶段可以要求重新创建任务。
- 当新路径验收通过后，删除 phase 路由、角色特殊分支和旧 context 消息旁路。
- UI read model 最后切换，但不能反向驱动 workflow。

实施必须拆成五个可独立审查和验收的计划，不能把三套内核一次性混改：

1. **公共契约与不变量**：冻结 Goal、Ticket、Workflow、Command、authority 和事件 envelope；先建立 contract test 与禁止依赖测试。
2. **Ticket Engine**：实现独立 durable aggregate、DAG、command、claim/fencing、workflow policy、事务 outbox；用无 Agent 的 worker 测通。
3. **Agent Engine**：实现独立 AgentThread/Goal/Turn/Tool runtime 与 Goal Resolution Port；用无 Ticket 的 host 测通。
4. **Mission Control**：实现 MissionLink、adapter、续租、两阶段 settle、durable cursor 和 crash reconciliation；不加入角色后继规则。
5. **Read Model 与切换**：切换 UI projection 和新 TaskRun，完成浏览器验收后删除旧 phase/assignment/旁路 context 路径。

每个计划通过本层的单元测试、合约测试和独立代码审查后，下一层才能接入。详细文件拆分、迁移批次和提交顺序在本设计由用户确认后单独编写实施计划。

## 20. 非目标

本设计暂不决定：

- 完整动态招聘算法；
- 多 Workspace 跨项目共享同一 Agent 的调度公平性；
- 分布式消息队列产品选型；
- 可视化 DAG 编辑器；
- Agent-to-Agent 自由聊天；
- 多个 Agent 共同拥有同一 Ticket；
- 生产级计费和配额产品策略。

这些能力以后可以建立在三个边界稳定的模块之上，不应阻塞当前根架构修正。

## 21. 上线验收标准

设计落地后，必须能够证明：

- Agent Engine 可在完全没有 Ticket Engine 的测试中独立对话和追求 Goal。
- Ticket Engine 可在完全没有 Agent Engine 的测试中独立运行 workflow。
- Mission Control 不包含角色/阶段后继判断。
- 一个 Ticket 可以驱动一个跨多 turn 的 Agent Goal。
- Agent 普通回复不会意外完成 Ticket。
- Agent 显式提交完成后，Ticket Engine 接受才正式完成。
- Ticket Engine 拒绝时，同一个 Agent 能看到原因并继续。
- human 私聊只触发目标 Agent 的下一 turn。
- yield、服务重启和上下文压缩不会改变业务状态。
- workflow completion policy 未满足时 Mission 永不显示完成。
- 全部状态变化可以从 durable state、命令结果和 audit/outbox 记录解释。
- 单元测试、集成测试、类型检查、构建和浏览器端到端验证全部通过。

## 22. Codex Goal 参考结论

本设计借鉴 Codex 的核心不是复制它的字段，而是采用它的控制边界：

- Goal 独立持久化在 Thread 生命周期上；
- 一个 Goal 包含多个普通 turn；
- thread idle 且 Goal active 时自动继续；
- 普通 turn 停止不完成 Goal；
- 模型显式提交 complete/blocked；
- 用户或系统控制 pause/resume/usage/budget；
- 完成前按目标和证据做审查；
- 完整 rollout 与模型可见上下文分离。

参考：

- https://github.com/openai/codex/blob/main/codex-rs/ext/goal/src/runtime.rs
- https://github.com/openai/codex/blob/main/codex-rs/ext/goal/src/spec.rs
- https://github.com/openai/codex/blob/main/codex-rs/ext/goal/src/extension.rs
- https://github.com/openai/codex/blob/main/codex-rs/ext/goal/templates/goals/continuation.md
- https://github.com/openai/codex/blob/main/codex-rs/state/src/model/thread_goal.rs

AutoAgent 在此基础上增加 host commit：Agent 负责提出 Goal 结论，Ticket Engine 负责提交 workflow 事实，Mission Control 负责可靠地连接二者。
