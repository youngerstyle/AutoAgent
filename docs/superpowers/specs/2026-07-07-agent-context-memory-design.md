# Agent Context and Memory Design

Date: 2026-07-07

## Goal

AutoAgent must stop treating raw session history as model memory. The runtime needs a production-grade context system that separates audit history, active model context, compressed session state, project memory, and UI observability.

This design upgrades the earlier Hermes/OpenClaw-inspired session skeleton into a real context and memory layer.

## Problem

The current implementation persists per-agent session files, but `buildAgentPrompt` reads recent raw messages directly from the session and injects them into the next prompt. Tool observations are also folded into follow-up prompts. This caused recursive prompt growth: prior assembled prompts were stored as `user` messages, then reinserted into later prompts.

The important distinction is:

- Raw session is the audit trail.
- Active context is the bounded input sent to the LLM.
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

Raw session files keep full prompts, full LLM responses, full tool results, provider events, usage, and timestamps. They are append-only audit material. They can be shown in loop debug and used for offline replay, but must not be copied directly into new model input.

2. Context is assembled through one boundary.

Only `ContextAssembler` may create model input. `AgentRuntime` may not manually concatenate session, tool results, or assignment text into prompts.

3. Compaction has thresholds, checkpoints, and replacement history.

When active session context exceeds a configured threshold, old message groups are summarized into a checkpoint. Recent turns remain verbatim. The raw session remains unchanged. The checkpoint must also persist `replacementHistory`: a synthetic compaction summary message followed by retained recent messages. This gives restart/replay code a concrete "use this instead of old history" boundary, similar to Codex's compacted replacement history.

4. Memory is layered.

AutoAgent uses three practical layers for V1:

- Session summary: per workspace-agent and task-run. Captures what this agent already learned in this run.
- Workspace memory: durable project facts, conventions, paths, known commands, and recurring decisions.
- Ticket context: current work item, dependencies, blockers, human follow-ups, and handoff facts.

5. Tool observations are stored fully but injected compactly.

Full tool output remains in session and event logs. The prompt receives a bounded observation summary with paths, status, key snippets, and references to raw records when needed.

6. Prompt cache stability is a design constraint.

Stable content must come first: agent soul, identity, capability manual, tool protocol, schemas, and static policy. Dynamic content comes later: current ticket, recent context, tool observations, human follow-up. This improves OpenAI automatic prefix caching and Anthropic cache breakpoints.

7. The UI must show why a prompt is large.

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
    state.json
    artifacts/
```

### `sessions/<taskRunId>.json`

Raw audit transcript. It remains full-fidelity.

```ts
interface AgentSession {
  id: string;
  workspaceAgentId: string;
  messages: AgentSessionMessage[];
  providerEvents: AgentProviderEvent[];
  usage?: ProviderUsage;
  updatedAt: string;
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
   - human follow-ups, ticket state, upstream results

`ContextAssembler` returns both `prompt` and `ContextReport`.

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

## Provider Interaction

Provider adapters should receive an assembled prompt and context metadata, not raw session data. Later provider-specific cache support can be added without changing agent logic:

- OpenAI: keep stable prefix identical and record cached token usage when available.
- Anthropic: support automatic caching first; explicit breakpoints can be added around stable header and workspace memory.

## UI and Debugging

Loop debug should include context reports as first-class entries:

- Prompt final injected length.
- Original raw session length.
- Session summary length.
- Recent turn count.
- Tool observation original/injected sizes.
- Compaction checkpoint id.
- Threshold that triggered compaction.

The user should be able to tell whether a bad model response came from:

- wrong raw session fact,
- bad summary,
- missing retrieval,
- tool observation truncation,
- prompt contract,
- provider behavior,
- or ticket routing.

## Acceptance Criteria

1. Raw session remains complete and readable after multiple turns.
2. Model prompt never directly re-injects a prior assembled prompt.
3. Large tool results do not enter prompt unbounded.
4. Context has explicit budget and report metadata.
5. Session compaction creates checkpoints without destroying raw history.
6. Recent turns stay readable while older turns become summary.
7. Workspace-agent memory is stored separately from session.
8. Loop debug exposes context reports.
9. Tests cover prompt recursion, tool observation compaction, checkpoint creation, and raw log preservation.
10. `npm.cmd run test:run`, `npm.cmd run typecheck`, and `npm.cmd run build` pass.

## Non-Goals

- Vector database retrieval is deferred.
- Cross-workspace semantic memory is deferred.
- Automatic memory editing by hidden background agents is deferred.
- Provider-specific prompt cache APIs are deferred beyond prompt ordering and report metadata.
