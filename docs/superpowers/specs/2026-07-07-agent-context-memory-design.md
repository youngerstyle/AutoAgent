# Agent Context and Memory Design

Date: 2026-07-07

## Goal

AutoAgent must stop treating unbounded session history as model memory. The runtime needs a production-grade context system that separates audit history, active model context, compressed session state, project memory, and UI observability.

This design upgrades the earlier Hermes/OpenClaw-inspired session skeleton into a real context and memory layer.

## Problem

The current implementation persists per-agent session files, but earlier versions treated those session files as both model memory and debug transcript. That caused recursive prompt growth: prior assembled prompts were stored as `user` messages, then reinserted into later prompts.

The important distinction is:

- Agent session is the bounded, model-visible history for the next turn.
- Human messages to an Agent are session messages. They are not a parallel context channel.
- Loop trace is the raw audit trail: full prompts, full LLM responses, tool IO, errors, usage, and timing.
- Active context is the bounded input sent to the LLM, assembled from session, memory, ticket state, and current observations.
- Memory is curated, compressed, or retrieved state derived from raw facts.
- Loop debug is for human inspection, not automatic prompt input.

The existing character caps are a guardrail, not the architecture.

## External References

The target design follows the common pattern across mature agent systems:

- OpenAI Agents examples describe trimming and compression as separate context management techniques, and recommend compaction at meaningful workflow boundaries.
- Anthropic compaction summarizes older context as a conversation approaches the window limit, keeping the active context small for long-running tasks.
- Claude Code distinguishes startup memory, session history, tool/file reads, skills, and compaction survival rules. It also suggests delegating large reads to keep main context clean.
- OpenHands uses a Context Condenser that keeps recent messages intact, summarizes older history, and preserves goals, technical specifications, and critical files.
- OpenClaw documents that context is the current model window while memory is durable disk state. `MEMORY.md` is compact curated state; daily memory files are working notes and are not injected wholesale every turn.
- AutoGen exposes memory as a protocol that can add relevant facts into context, instead of replaying full history.
- Hermes advertises `/compress`, `/usage`, session search, and LLM summarization for cross-session recall.
- Codex-style compaction records an explicit compacted item plus replacement history: the raw transcript remains auditable, while future context reconstruction uses the replacement history plus later suffix instead of replaying the old raw messages.

## Core Principles

1. Raw logs are never the prompt.

Loop trace files keep full prompts, full LLM responses, full tool results, provider events, usage, and timestamps. They are append-only audit material. They can be shown in loop debug and used for offline replay, but must not be copied directly into new model input.

Agent session files are not raw audit logs. They keep only the model-visible conversation state that may be used by a future `ContextAssembler` call: compact task input, assistant output, bounded tool summaries, timestamps, usage, and references to trace records.

2. Context is assembled through one boundary.

Only `ContextAssembler` may create model input. `AgentRuntime` may not manually concatenate session, tool results, or assignment text into prompts.

3. Messages are time-ordered; side channels are audit-only.

Every model-visible message belongs to one ordered conversation timeline for the target workspace Agent and task run. This includes:

- the compact task/assignment message created by `AgentRuntime`;
- the assistant response;
- bounded tool observations;
- human messages sent directly to that Agent;
- human replies that resume a blocked ticket owned by that Agent.

The platform may still record `human.agent_message`, `human.followup`, ticket events, and UI chat rows in `events.jsonl` or `state.json`, but those records are not a second prompt input path. They are audit and projection data. If a human message should affect the next Agent turn, it must first be appended to the target Agent session as a `user` message with metadata such as `source: "human.agent_message"` or `source: "human.followup"`.

This mirrors Codex-style reconstruction: durable raw events remain auditable, while the next model context is reconstructed from the model-visible timeline plus compaction replacement history. AutoAgent must not inject arrays like `agentDirectMessages` or `humanFollowups` wholesale into dynamic context.

4. Compaction has thresholds, checkpoints, and replacement history.

When active session context exceeds a configured threshold, old message groups are summarized into a checkpoint. Recent turns remain verbatim. The model-visible session file is not rewritten by compaction. The checkpoint must also persist `replacementHistory`: a synthetic compaction summary message followed by retained recent messages. This gives restart/replay code a concrete "use this instead of old history" boundary, similar to Codex's compacted replacement history.

5. Memory is layered.

AutoAgent uses three practical layers for V1:

- Session summary: per workspace-agent and task-run. Captures what this agent already learned in this run.
- Workspace memory: durable project facts, conventions, paths, known commands, and recurring decisions.
- Ticket context: current work item, dependencies, blockers, human follow-ups, and handoff facts.

6. Tool observations are traced fully but injected compactly.

Full tool output remains in loop trace and event logs. Session receives only a bounded tool observation summary. The prompt receives a bounded observation summary with paths, status, key snippets, and references to raw trace records when needed.

7. Prompt cache stability is a design constraint.

Stable content must come first: agent soul, identity, capability manual, tool protocol, schemas, and static policy. Dynamic content comes later: current ticket, recent context, and tool observations. Human messages are not a dynamic side channel; they enter through the ordered session history. This improves OpenAI automatic prefix caching and Anthropic cache breakpoints.

8. The UI must show why a prompt is large.

Loop debug must show context sections, original size, injected size, truncation or compaction reason, and whether a checkpoint was used.

## Storage Model

Workspace-local storage becomes:

```text
<workspace>/.autoagent/
  agents/<workspaceAgentId>/
    agent.json
    memory.json
    sessions/<taskRunId>.json
    context/<taskRunId>.json
  tasks/<taskId>/runs/<taskRunId>/
    events.jsonl
    loop-trace.jsonl
    state.json
    artifacts/
```

### `sessions/<taskRunId>.json`

Model-visible agent history. It is intentionally not full-fidelity and must never store an assembled prompt.

```ts
interface AgentSession {
  id: string;
  workspaceAgentId: string;
  messages: AgentSessionMessage[];
  usage?: ProviderUsage;
  updatedAt: string;
}
```

Human-originated session messages use the same `messages` array:

```ts
interface AgentSessionMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  timestamp: string;
  metadata?: {
    source?: "assignment" | "human.agent_message" | "human.followup" | "tool";
    humanMessageId?: string;
    ticketId?: string;
    taskRunId?: string;
  };
}
```

The `content` should be the user-facing message, not a serialized state object. Extra routing data belongs in metadata and event logs.

### `loop-trace.jsonl`

Append-only full loop evidence for UI debugging and offline review. This file is the place where complete assembled prompts belong.

```ts
interface LoopTraceRecord {
  id: string;
  taskId: string;
  taskRunId: string;
  assignmentRunId?: string;
  agentId: string;
  actor: string;
  kind: "prompt" | "llm" | "tool";
  turn: number;
  timestamp: string;
  title: string;
  content: string;
  detail?: string;
  metadata?: Record<string, unknown>;
}
```

### `context/<taskRunId>.json`

Derived context state.

```ts
interface AgentContextState {
  id: string;
  workspaceAgentId: string;
  taskRunId: string;
  summary?: ContextSummary;
  checkpoints: ContextCheckpoint[];
  lastAssembled?: ContextReport;
  updatedAt: string;
}

interface ContextCheckpoint {
  id: string;
  reason: string;
  summary: string;
  replacementHistory: AgentSessionMessage[];
  originalChars: number;
  summaryChars: number;
  createdAt: string;
}
```

### `memory.json`

Workspace-agent memory. This is not raw chat history.

```ts
interface WorkspaceAgentMemory {
  workspaceAgentId: string;
  durableFacts: string[];
  projectConventions: string[];
  knownCommands: string[];
  recentLessons: string[];
  updatedAt: string;
}
```

## Context Budget

V1 uses a deterministic character estimator first, with a clear upgrade path to model tokenizers. The estimator uses four characters per token by default.

Default production budget:

```ts
interface ContextBudget {
  maxInputTokens: number;
  reservedOutputTokens: number;
  staticPromptTokens: number;
  ticketTokens: number;
  memoryTokens: number;
  sessionSummaryTokens: number;
  recentTurnTokens: number;
  toolObservationTokens: number;
}
```

Initial defaults:

- `maxInputTokens`: 64,000
- `reservedOutputTokens`: 4,000
- `staticPromptTokens`: 12,000
- `ticketTokens`: 8,000
- `memoryTokens`: 4,000
- `sessionSummaryTokens`: 8,000
- `recentTurnTokens`: 12,000
- `toolObservationTokens`: 12,000

The assembled prompt must fail closed into a compacted context before it exceeds budget.

## Message Groups

Compaction must preserve logical groups:

- User prompt and assistant response from the same model turn.
- Assistant tool request and the matching tool results.
- Tool observation loop follow-up and its response.

Removing only one side of a group creates misleading history. The compactor summarizes whole groups.

## Context Assembly

The assembled prompt has ordered sections:

1. Stable agent header
   - role, soul, identity, capability manual
   - policy
   - tool protocol and structured output contract
2. Current assignment
   - workspace name/path
   - task goal
   - current ticket/assignment brief
   - expected artifact
3. Workspace memory
   - durable facts and conventions
4. Session summary
   - previous progress in this task-run for this agent
5. Recent turns
   - latest compact message groups only
6. Tool observations
   - current loop observations, bounded and summarized
7. Dynamic context
   - current ticket state, upstream results, run metadata

Dynamic context must not carry full human message arrays. Human messages that matter to the Agent are already in the session timeline. Dynamic context may carry identifiers and summaries such as current ticket id, blocker type, allowed resume actions, and references to event ids.

`ContextAssembler` returns both `prompt` and `ContextReport`. The complete `prompt` is written to loop trace before the provider call. It is never written back into agent session.

```ts
interface AssembledContext {
  prompt: string;
  report: ContextReport;
}
```

## Compaction Trigger

Compaction can run in three situations:

1. Before a model call if estimated active context exceeds threshold.
2. After a major workflow boundary, such as assignment completion.
3. Before a user-visible reset/retry when the current run would otherwise lose context.

Threshold policy:

- Warn at 60% of active input budget.
- Compact at 75%.
- Hard truncate only as a final backstop at 90%, and record an explicit warning.

Compaction output must include:

- current goal
- current ticket/assignment
- files read or written
- decisions made
- blockers and unresolved questions
- test/QA evidence
- human instructions
- next action

Human instructions here means the compacted semantic result of prior human messages. It does not mean replaying `state.context.humanFollowups` or `state.context.agentMessages` outside the session compaction path.

## Provider Interaction

Provider adapters should receive an assembled prompt and context metadata, not unbounded session data. Later provider-specific cache support can be added without changing agent logic:

- OpenAI: keep stable prefix identical and record cached token usage when available.
- Anthropic: support automatic caching first; explicit breakpoints can be added around stable header and workspace memory.

## UI and Debugging

Loop debug is built from flow events plus `loop-trace.jsonl`, not from agent session messages. It should include context reports as first-class entries:

- Prompt final injected length.
- Original model-visible session length.
- Session summary length.
- Recent turn count.
- Tool observation original/injected sizes.
- Compaction checkpoint id.
- Threshold that triggered compaction.

The user should be able to tell whether a bad model response came from:

- wrong model-visible session fact,
- bad summary,
- missing retrieval,
- tool observation truncation,
- prompt contract,
- provider behavior,
- or ticket routing.

## Acceptance Criteria

1. Loop trace remains complete and readable after multiple turns.
2. Agent session never stores an assembled prompt.
3. Model prompt never directly re-injects a prior assembled prompt.
4. Large tool results do not enter session or prompt unbounded.
5. Context has explicit budget and report metadata.
6. Session compaction creates checkpoints without relying on raw trace replay.
7. Recent model-visible turns stay readable while older turns become summary.
8. Workspace-agent memory is stored separately from session.
9. Loop debug exposes context reports and raw prompt/LLM/tool evidence from trace.
10. Direct human-to-Agent messages are appended to that Agent session in timestamp order and are not injected again through `dynamic_context`.
11. Blocked-ticket human follow-ups are appended to the blocked ticket owner session before the resume-review turn.
12. Tests cover prompt recursion, tool observation compaction, checkpoint creation, trace preservation, human message ordering, and session hygiene.
13. `npm.cmd run test:run`, `npm.cmd run typecheck`, and `npm.cmd run build` pass.

## Non-Goals

- Vector database retrieval is deferred.
- Cross-workspace semantic memory is deferred.
- Automatic memory editing by hidden background agents is deferred.
- Provider-specific prompt cache APIs are deferred beyond prompt ordering and report metadata.
