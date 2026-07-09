# Codex-like Agent Thread Runtime Design

Date: 2026-07-09

Status: Draft for human review. This is a design document only; no implementation is implied until the design is approved.

## Goal

AutoAgent should treat each workspace Agent as a long-lived, message-interactive runtime, similar to a Codex thread scoped to one Agent. When a user selects "开发", "测试", "老板", "产品/项目", or any recruited Agent, the bottom panel should show that Agent's real working thread: human messages, ticket handoffs, model replies, tool observations, platform ticket outcomes, and resumable continuation points in chronological order.

The current system already has important pieces:

- `TicketRuntime` owns ticket state, inbox messages, leases, completion, blockers, returns, and follow-up tickets.
- `MissionControl` chooses runnable tickets, calls the Agent runtime, and interprets structured Agent results into ticket actions.
- `AgentRuntime` calls the model, executes tool intents, writes session messages, and writes loop trace records.
- `SessionStore` holds bounded model-visible messages.
- `LoopTraceStore` holds full prompt, LLM, and tool audit records.
- UI `AgentDirectChatBox` and `BlockedAgentChatBox` show selected-Agent communication, but they are currently projections from separate state paths.

The missing layer is an explicit **Agent Thread Runtime**: the durable, ordered conversation/event stream for a single Agent in a single task run.

## Why This Matters In This Project

The product goal is not a simple chat app. It is a visual automated team where:

- Ticket Engine is the workflow/DAG system.
- Agent Engine is the worker brain and tool loop.
- MissionControl is the orchestrator that translates between tickets and agents.
- The user can be "human in the flow" globally, and "human in the loop" with any selected Agent.

Many of the confusing behaviors so far come from not having a single ordered Agent thread:

- Human messages can appear in `state.context.agentMessages`, session history, event logs, and UI bubbles as separate projections.
- Ticket state changes can appear in the right-side event list, while the selected Agent chat does not clearly show whether that Agent saw the state.
- A user can message QA, but another Agent may be woken if the pending message selection is not clearly tied to the selected Agent's thread.
- Agent replies can sound like they directly changed ticket state, while the real state change belongs to TicketRuntime.
- Loop trace has the real prompt/LLM/tool evidence, but it is separated from the Agent's conversational view.

The correct fix is not more keyword rules. The fix is to make Agent Engine natively message-interactive, and make all model-visible communication enter through one ordered thread.

## Mature Practice References

This design follows the same architectural direction used by mature agent systems, adapted to AutoAgent's ticketed team model.

### Codex

Codex describes a thread as a single session with multiple prompts, model outputs, and tool calls. A prompt starts a model/tool loop, and follow-up prompts continue the same thread. Codex also gathers context from file contents, tool output, and what it has done, but long-running work is kept within the model context by compaction.

Relevant local reference:

- `C:/Users/xieyizhi/AppData/Local/Temp/openai-docs-cache/codex-manual.md`
- `C:/Users/xieyizhi/Documents/Codex/2026-07-07/co-d/work/codex-src/AGENTS.md`
- `C:/Users/xieyizhi/Documents/Codex/2026-07-07/co-d/work/codex-src/codex-rs/protocol/src/protocol.rs`
- `C:/Users/xieyizhi/Documents/Codex/2026-07-07/co-d/work/codex-src/codex-rs/core/src/session/mod.rs`

Key lessons for AutoAgent:

- A thread is the user-facing unit of interaction.
- Model-visible context is not the full raw log.
- Full prompts and raw evidence are auditable, but bounded projections feed the model.
- Compaction creates a replacement history rather than recursively replaying all old raw content.
- Codex source guidance says model-visible context must be incremental, bounded, and cache-stable.

### OpenHands

OpenHands is useful because it separates an event stream from LLM messages. User messages, agent actions, tool results, and observations are events, and the system decides how to convert relevant events into model input. This is close to what AutoAgent needs.

Key lesson:

- Keep append-only event history as the durable truth, but use a converter/projector to make model-visible messages.

### LangGraph

LangGraph commonly stores conversation in graph state under `messages`, and uses reducers such as add/update semantics to control how new messages affect state. This avoids hidden side channels and makes the state transition explicit.

Key lesson:

- Message state should be explicit, typed, append-oriented, and controlled by one reducer/projection boundary.

### AutoGen

AutoGen's ConversableAgent model treats agents as entities that receive and send messages. The core concept is not "call a role function once", but "agents converse, call tools, and optionally involve humans."

Key lesson:

- Agent interaction should be message-native; tool execution and human participation are part of the same conversation runtime.

## Core Decision

AutoAgent should introduce an **Agent Thread Runtime** with this contract:

```text
Ticket Engine
  -> emits ticket events and inbox deliveries
  -> MissionControl appends those events to the target Agent thread
  -> Agent Thread Runtime turns the thread into bounded model context
  -> AgentRuntime runs model/tool loop
  -> structured Agent decision returns to MissionControl
  -> MissionControl validates and applies ticket action
  -> platform outcome is appended back to the Agent thread
```

This means Agent Engine becomes message-interactive, but Ticket Engine remains the workflow source of truth.

## Architecture

### 1. TicketRuntime stays the workflow/DAG engine

`TicketRuntime` remains responsible for:

- `Ticket` creation.
- `AgentInboxMessage` delivery.
- `claimNext`.
- `ack`.
- `blockTicket`.
- `yieldTicket`.
- `completeHumanAction`.
- `cancelOpenDescendants`.
- dependency checks and lease recovery.

It does not assemble prompts, call LLMs, interpret natural language, or render chat.

### 2. AgentThreadStore becomes the Agent conversation source

Add a durable per-Agent, per-task-run thread file:

```text
<workspace>/.autoagent/
  agents/<workspaceAgentId>/
    threads/<taskRunId>.jsonl
```

Each line is an `AgentThreadEvent`.

```ts
interface AgentThreadEvent {
  id: string;
  taskId: string;
  taskRunId: string;
  workspaceAgentId: string;
  sequence: number;
  timestamp: string;
  source: "human" | "ticket" | "agent" | "tool" | "platform" | "system";
  kind:
    | "human_message"
    | "ticket_received"
    | "ticket_claimed"
    | "ticket_blocked"
    | "ticket_returned"
    | "ticket_completed"
    | "ticket_created"
    | "agent_message"
    | "agent_decision"
    | "tool_call"
    | "tool_result"
    | "context_compacted"
    | "turn_yielded"
    | "turn_failed";
  visibility: {
    ui: boolean;
    model: "include" | "summarize" | "reference" | "exclude";
    trace: boolean;
  };
  ticketId?: string;
  assignmentRunId?: string;
  humanMessageId?: string;
  traceId?: string;
  payload: Record<string, unknown>;
}
```

The thread is append-only. Status can be projected, but old events are not edited.

### 3. SessionStore becomes a model-visible projection, not the UI chat source

Current `SessionStore` can stay, but its role must be narrowed:

- It is the compact, model-visible projection of the Agent thread.
- It is not the full chat UI source.
- It is not the full debug log.
- It never stores assembled prompts.

In V1, `SessionStore.appendUserMessage` and `appendTurn` can still write session messages. The important change is that every such write must correspond to an `AgentThreadEvent`, and future rebuilds should be possible from the thread.

Eventually:

```text
AgentThreadEvent[] -> ModelMessageProjector -> AgentSession.messages
```

### 4. LoopTraceStore remains full audit

`loop-trace.jsonl` remains the raw evidence store for:

- full assembled prompt;
- full LLM response;
- provider events and token usage;
- full or large tool outputs;
- context report;
- parser output;
- ticket action mapping result.

Loop trace records should link back to `AgentThreadEvent.traceId` where useful.

The UI can show "查看原始 prompt / 查看原始 JSON / 查看工具结果", but these raw records are not replayed into model context by default.

### 5. ContextAssembler becomes the only model-input boundary

`ContextAssembler` already exists and should stay the only prompt construction boundary.

It should receive:

- stable prompt sections: soul, identity, ability manual, tool policy, output contract;
- current ticket summary;
- bounded Agent session projection;
- compact ticket facts relevant to the current Agent;
- compact tool observations;
- compaction checkpoint if present.

It must not receive raw `agentMessages`, `humanFollowups`, full `events.jsonl`, or full `loop-trace.jsonl`.

## Event To Message Projection

The key rule is:

> All important input first becomes an AgentThreadEvent. Only then may it become model-visible context.

### Human message to selected Agent

When the user types in the selected Agent panel:

```text
UI composer
  -> POST /agent-message
  -> append AgentThreadEvent(kind=human_message, source=human)
  -> append SessionStore user message through ModelMessageProjector
  -> enqueue/mark direct Agent turn
```

If the Agent is idle, MissionControl can run a direct Agent turn.

If the Agent is currently inside a provider/tool call, the message remains queued and visible as "已送达，等待下一轮处理". It must not be injected into the in-flight prompt.

### Ticket delivery to Agent

When TicketRuntime creates or claims a ticket for an Agent:

```text
TicketRuntime deliver/claim
  -> MissionControl append AgentThreadEvent(kind=ticket_received/ticket_claimed)
  -> ContextAssembler projects compact ticket facts
  -> AgentRuntime runs assignment
```

Example model-visible projection:

```text
平台投递工单：
类型：开发执行
标题：根据老板验收失败修复 game.ts 玩家更新和射击绑定问题
预期产物：修复后的交付物
上游：老板验收未通过
```

This should be a platform/ticket event, not a fake human message.

### Agent model response

When LLM returns:

```text
providerResult.text -> AgentThreadEvent(kind=agent_message)
providerResult.structured -> AgentThreadEvent(kind=agent_decision)
LoopTraceStore records raw prompt and raw LLM response
SessionStore appends assistant message
```

The natural-language reply is shown in the Agent thread. The structured decision is used by MissionControl.

### Tool calls and tool results

Tool calls and results become thread events:

```text
tool_call: compact display row, model include/reference depending on size
tool_result: compact observation for model; full output in loop trace
```

Large file contents and command output must not become giant chat bubbles. UI shows a compact card with "查看详情".

### Ticket action outcome

After MissionControl interprets the Agent decision and mutates TicketRuntime:

```text
MissionControl applies ticket action
  -> append platform event to global ledger
  -> append AgentThreadEvent(kind=ticket_completed/ticket_created/ticket_returned/...)
```

This lets the Agent chat say:

```text
平台结果：老板验收未通过，原验收工单已 returned，已创建开发返工工单。
```

The Agent may then say:

```text
我看到返工工单已创建，接下来会检查 game.ts 的玩家更新逻辑。
```

The distinction is visible: platform facts are platform events; Agent replies are Agent replies.

## UI Design

The selected Agent bottom panel becomes an Agent Thread window.

### Default View

Default view shows readable events:

- human messages;
- Agent replies;
- current ticket received/claimed;
- important platform outcomes;
- compact tool observations;
- manual test cards;
- yielded/waiting states.

It should not show raw prompt or huge JSON unless expanded.

### Debug Expansion

Each turn can expand:

- Prompt summary and section sizes.
- Raw prompt.
- Raw LLM return.
- Parsed structured decision.
- Tool calls and tool results.
- Ticket action mapping and validation result.

This replaces the confusing split between "运行记录" and "聊天框". The right-side timeline can remain a compact run index, but the selected Agent panel becomes the detailed per-Agent thread.

### Composer Semantics

The composer is always scoped to the selected Agent.

It should show one of these states:

- `发送给开发`: Agent idle or waiting.
- `发送给开发（下一轮处理）`: Agent currently running.
- `回复测试`: manual test or blocked owner Agent.
- disabled when no Agent is selected.

Global task control remains separate. Global input must not look like selected-Agent chat.

### Agent Avatar State

Agent avatar state is projected from thread + ticket facts:

- green/running: current in-flight assignment belongs to this Agent.
- yellow/needs reply: this Agent owns a blocked ticket or waiting manual test/human authorization.
- neutral/waiting: no in-flight assignment and no blocked owner state.
- badge: unread important thread events since the user last selected this Agent.

## Ticket Engine Integration

The Ticket Engine should not directly talk to LLMs. It emits structured events and accepts validated actions.

MissionControl remains the integration boundary:

```text
TicketRuntime state change
  -> append AgentThreadEvent
  -> AgentRuntime turn
  -> structured result
  -> MissionControl validates allowed action
  -> TicketRuntime state change
```

Allowed Agent decisions should be represented as explicit structured outputs, such as:

```ts
type AgentDecision =
  | { action: "complete"; summary: string; artifact?: unknown }
  | { action: "block_self"; blockerType: TicketBlockerType; reason: string }
  | { action: "return_to_parent"; reason: string; defects?: unknown[] }
  | { action: "create_child_tickets"; tickets: PlannedChildTicket[] }
  | { action: "yield"; reason: string }
  | { action: "fail"; reason: string };
```

Existing fields such as `passed:false`, `accepted:false`, `status:"manual_test_required"`, and `target_ticket_type` can be supported as legacy provider-normalization inputs, but internally MissionControl should normalize them into `AgentDecision`.

This prevents business logic from spreading across prompt fragments and ad hoc `if` branches.

## Context And Compaction

Agent thread may be long. The model-visible context must be bounded.

Rules:

1. Stable sections first: agent soul, identity, ability manual, tool policy, output contract.
2. Current work next: current ticket, parent/child facts, dependency status.
3. Conversation projection next: recent human/agent messages and compact platform events.
4. Tool observations last: compact, bounded summaries.
5. Full prompt and full tool results only in loop trace.

Compaction should produce:

```ts
interface AgentThreadCompaction {
  id: string;
  message: string;
  replacementHistory: AgentSessionMessage[];
  compactedThroughSequence: number;
  createdAt: string;
}
```

This mirrors Codex's `CompactedItem` pattern:

- raw thread events remain auditable;
- future context uses `replacementHistory + later suffix`;
- old raw events are not replayed wholesale.

## Storage Model

Target V1 storage:

```text
<workspace>/.autoagent/
  agents/<workspaceAgentId>/
    agent.json
    memory.json
    sessions/<taskRunId>.json        # model-visible projection
    threads/<taskRunId>.jsonl        # AgentThreadEvent append-only source
    context/<taskRunId>.json         # summaries/checkpoints/replacement history
  tasks/<taskId>/runs/<taskRunId>/
    state.json                       # ticket/run state snapshot
    events.jsonl                     # global run event ledger
    loop-trace.jsonl                 # full raw debug trace
```

## Migration From Current Code

### Current code to preserve

- `TicketRuntime` should mostly stay.
- `LoopTraceStore` should stay.
- `ContextAssembler` should stay and become stricter.
- `SessionStore` should stay as model-visible projection.
- `MissionControl.runUntilIdle` can remain the outer loop.

### Current code to replace or narrow

- `state.context.agentMessages` should stop being the UI source of truth.
- `agentDirectMessageQueue` should become pending `AgentThreadEvent` processing state or an index over thread events.
- `AgentDirectChatBox` should render thread projection instead of `snapshot.agentMessages`.
- `runAgentDirectMessageTurn` should become a normal Agent thread turn triggered by a `human_message` event.
- `humanLoopSnapshot` should become a projection over blocked ticket owner thread events, not a separate conceptual chat.

### Compatibility step

During migration, current `agentMessages` can be populated from AgentThreadStore for old UI code. But new writes should go to AgentThreadStore first.

## Failure Handling

### Agent says a platform action happened, but TicketRuntime did not do it

UI should show it as Agent speech only. Platform outcome cards are generated only from TicketRuntime/MissionControl events.

### TicketRuntime creates a follow-up ticket

MissionControl appends a platform event to the source Agent thread and a ticket received event to the target Agent thread.

### Human sends a message while Agent is running

The message is appended immediately to the Agent thread and marked pending for the next turn. UI shows it as delivered, not processed.

### Agent turn fails

Append `turn_failed` event to the Agent thread, keep ticket state according to TicketRuntime rules, and show an actionable error card.

### Context grows too large

ContextAssembler compacts or refuses to assemble without bounded replacement history. It must never dump entire raw thread events into prompt.

## What This Design Does Not Do Yet

- It does not allow free Agent-to-Agent chat outside tickets.
- It does not replace TicketRuntime with an LLM planner.
- It does not make the right-side run timeline disappear immediately.
- It does not require implementing streaming tokens in V1.
- It does not introduce browser/computer tools.

## Acceptance Criteria

The design is implemented correctly when:

1. Selecting any Agent shows a single chronological thread for that Agent.
2. Human messages to an Agent always enter that Agent's ordered thread and model-visible projection.
3. Ticket deliveries and platform outcomes appear as platform/ticket events in the target Agent thread.
4. Raw prompt, raw LLM, and raw tool details are available through debug expansion, not default chat bubbles.
5. No prompt receives `agentMessages`, `humanFollowups`, full events, or full loop trace through dynamic side channels.
6. Sending a message to QA cannot wake PM unless a ticket event explicitly routes work to PM.
7. Human messages sent while an Agent is running are queued for the next turn and shown as pending.
8. Ticket Engine remains the workflow source of truth; Agent replies can reference platform facts but cannot create platform facts by natural language alone.
9. Context compaction preserves a replacement-history style projection and does not recursively grow prompts.

## Recommended Implementation Direction

Implement in small vertical slices:

1. Add `AgentThreadStore` and thread event types.
2. Write thread events for human direct messages while still maintaining existing session behavior.
3. Project selected Agent UI from thread events.
4. Write ticket received/claimed/completed/returned/created events into owner and target Agent threads.
5. Route direct Agent turns from pending thread events instead of `agentDirectMessageQueue`.
6. Update ContextAssembler to project from thread/session without side channels.
7. Add compaction replacement history for Agent thread/session projection.
8. Remove old `state.context.agentMessages` as a write path.

Do not implement all of this as one large refactor. The first useful milestone is:

> human sends message to selected Agent -> event appended to AgentThreadStore -> appears in selected Agent thread -> next Agent turn uses it from session/projection -> no other Agent wakes.

