# Agent Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace assignment-return completion with a standalone Codex-like AgentThread/Goal/Turn/Tool engine that can work across many turns and explicitly propose completion.

**Architecture:** Keep Agent profile and reusable provider/tool primitives behind V2-neutral adapters. AgentStore is the only persistence writer for Thread, Goal, proposal, decision, turn state, and outbox; each execution slice may yield without changing Goal outcome, and host settlement is explicit and idempotent.

**Tech Stack:** TypeScript, ProviderRegistry/SDK primitives through V2 adapters, workspace tools through a neutral execution context, AgentStore, V2 context/trace stores, Vitest.

---

## File Structure

- Create `src/server/agent-engine/agent-store.ts`
  - Atomic Agent Engine aggregate: chronological Thread items, Goals, proposals, decisions, idempotency results, and durable outbox.
- Create `src/server/agent-engine/goal-state.ts`
  - Pure versioned Goal transition functions; all persistence goes through AgentStore.
- Create `src/server/agent-engine/thread-runtime.ts`
  - Message append, sequence, ordinary chat turns, Goal-linked turns.
- Create `src/server/agent-engine/tool-loop.ts`
  - Ticket-neutral provider/tool execution slices and yield checkpoints.
- Create `src/server/agent-engine/agent-engine.ts`
  - Public AgentPort implementation.
- Create `src/server/agent-engine/context-assembler.ts`
  - V2 Ticket-neutral context assembly, isolated from the legacy ContextAssembler until public cutover.
- Create `src/server/agent-engine/provider-adapter.ts`
  - V2 provider request/response adapter with system prompt and no role/assignment routing.
- Create `src/server/agent-engine/tool-runtime.ts`
  - V2 workspace tool context keyed by agent/thread/goal/turn, not task/assignment.
- Create `src/server/agent-engine/trace-store.ts`
  - Prompt/LLM/tool/settlement trace keyed by Agent scope, Thread, Goal, and Turn.
- Modify `src/server/storage/paths.ts`
  - Adds per-Agent Goal store paths.
- Modify `src/server/providers/types.ts`
  - Adds additive Ticket-neutral Agent model turn input/output while preserving the legacy AgentRuntime interfaces until final cutover.
- Create `tests/server/goal-store.test.ts`
- Create `tests/server/agent-store.test.ts`
- Create `tests/server/agent-engine.test.ts`
- Create `tests/server/agent-context-assembler-v2.test.ts`.
- Create `tests/server/agent-provider-adapter.test.ts`.
- Create `tests/server/agent-tool-runtime-v2.test.ts`.
- Create `tests/server/agent-trace-store-v2.test.ts`.
- Keep `tests/server/agent-thread-store.test.ts` and `tests/server/context-assembler.test.ts` unchanged as legacy baseline until final cutover.

## Task 1: Durable Agent Store and Partitioned Outbox

- [ ] Write failing tests for atomic Thread/Goal state plus MessageAppended, TurnStatusChanged, GoalStatusChanged, and GoalProposalCreated outbox events.
- [ ] Add durable cursor paging, duplicate delivery, out-of-order aggregate version, and store recreation tests.
- [ ] Scope reads/cursors by agentId aggregate and reject cursors from a different source/agent namespace.
- [ ] Run `npm.cmd run test:run -- tests/server/agent-store.test.ts` and verify RED.
- [ ] Implement AgentStore as the authoritative Agent Engine state; AgentThreadStore becomes an adapter during migration, not a second source.
- [ ] Run the tests and verify GREEN.
- [ ] Commit with `git commit -m "feat: add durable agent engine store"`.

## Task 2: Persistent Goal State Through the Single Store

- [ ] Write failing tests for idempotent startGoal, versioned control, proposal CAS, resolving state, decisionId idempotency, and restart recovery.
- [ ] Add tests proving `retry_later` does not settle and pause preserves activeProposalId when pausing resolving work.
- [ ] Run `npm.cmd run test:run -- tests/server/goal-store.test.ts` and verify RED.
- [ ] Implement pure transition functions in `goal-state.ts`; AgentStore is the only code allowed to commit Goal/proposal/decision/outbox changes.
- [ ] Run the tests and verify GREEN.
- [ ] Commit with `git commit -m "feat: add persistent agent goal store"`.

## Task 3: Chronological Thread Runtime

- [ ] Extend AgentStore/thread runtime tests for messageId dedupe, monotonic sequence, human/model/tool/control ordering, and service recreation.
- [ ] Run the targeted test and verify RED.
- [ ] Implement ThreadRuntime over AgentStore only. Leave the existing legacy AgentThreadStore unchanged and mounted only for legacy runs until the final cutover.
- [ ] Implement idempotent ensureThread/getThreadForAgent and prove ordinary chat works before any Goal exists.
- [ ] Do not dual-write V2 Thread items into the legacy store.
- [ ] Run the tests and verify GREEN.
- [ ] Commit with `git commit -m "feat: make agent threads chronological and idempotent"`.

## Task 4: Isolated Ticket-Neutral Context Assembly

- [ ] Add new V2 context tests for stable Soul -> Identity -> Agent -> Tools -> Goal prefix and chronological dynamic Thread suffix; do not replace legacy ContextAssembler tests yet.
- [ ] Add tests proving assembled prompts, raw LoopTrace, other Agent threads, phase, Ticket graph internals, and `latestHumanMessage` do not enter Session history.
- [ ] Run `npm.cmd run test:run -- tests/server/agent-context-assembler-v2.test.ts tests/server/session-compactor.test.ts` and verify RED.
- [ ] Implement `src/server/agent-engine/context-assembler.ts` with AgentGoalSpec, outputContract, contextRefs, Thread projection, tool observations, and profile.
- [ ] Leave `src/server/context/context-assembler.ts` unchanged until the atomic public cutover/deletion gate.
- [ ] Implement V2 TraceStore and prove raw prompt/LLM/tool records are durable but never recursively replayed into Thread context.
- [ ] Run the tests and verify GREEN.
- [ ] Commit with `git commit -m "refactor: make agent context ticket neutral"`.

## Task 5: Generic Tool/Model Execution Slice

- [ ] Write failing Agent Engine tests for ordinary chat, active Goal continuation, multi-tool turns, provider retry, tool failure observation, yield, pause, resume, and cancellation.
- [ ] Assert turn start, yield, failure, and completion atomically update current-turn state and emit TurnStatusChanged so UI activity has a durable source.
- [ ] Prove exhausting an execution-slice budget leaves Goal active and schedules another slice instead of blocking/failing/completing it.
- [ ] Implement provider/tool logic in `agent-engine/tool-loop.ts` without changing the still-mounted legacy `agents/agent-runtime.ts`.
- [ ] Keep tool authorization driven by Agent policy/capability configuration.
- [ ] Implement V2 provider adapters for OpenAI, Anthropic, and a deterministic V2 mock; the mock follows injected outputContract/Goal scenarios rather than role or assignmentType branches.
- [ ] Implement V2-neutral tool context and adapters for list/read/write/shell/startService/pollProcess; trace/event metadata uses threadId/goalId/turnId and never requires taskId/taskRunId/Assignment.
- [ ] Add an integration test using real ProviderRegistry selection, configured tool catalog, V2 TraceStore, and the deterministic V2 mock.
- [ ] Expose `tick()`/`runReadyGoals()` and `recover()` so a production host can continue active Goals after service restart; direct tests must drive these methods explicitly.
- [ ] Run targeted tests and verify GREEN.
- [ ] Commit with `git commit -m "feat: add ticket-neutral agent tool loop"`.

## Task 6: Explicit Goal Resolution and One Host Protocol

- [ ] Write tests where a normal model reply leaves Goal active.
- [ ] Write tests for explicit completed/blocked/failed proposals, output-contract validation, host correctable rejection, stale cancellation, host error pause, and accepted settlement.
- [ ] Add a race test for pause during resolving and idempotent final settlement after restart.
- [ ] Implement proposal parsing as a declared tool/output contract, never keyword or regex classification of prose.
- [ ] Agent Engine always invokes its injected GoalResolutionPort after atomically persisting GoalProposalCreated.
- [ ] Implement default standalone GoalResolutionPort for non-Mission use.
- [ ] Mission plan provides a MissionGoalResolutionPort implementation that immediately returns pending/retry_later and nudges the event pump; the durable GoalProposalCreated event remains the recovery source, and Mission Process later calls settleProposal. Agent Engine never imports that adapter.
- [ ] Run targeted tests and verify GREEN.
- [ ] Commit with `git commit -m "feat: add explicit agent goal resolution"`.

## Task 7: Standalone Agent Gate

- [ ] Add an integration test that starts an Agent with no Ticket/Mission types, sends several human messages, runs tools, pursues a Goal across slices, and completes through the default port.
- [ ] Run `npm.cmd run test:run -- tests/server/agent-store.test.ts tests/server/goal-store.test.ts tests/server/agent-context-assembler-v2.test.ts tests/server/agent-provider-adapter.test.ts tests/server/agent-tool-runtime-v2.test.ts tests/server/agent-trace-store-v2.test.ts tests/server/agent-engine.test.ts tests/server/architecture-boundaries.test.ts` plus the unchanged legacy AgentThread/ContextAssembler suites.
- [ ] Run `npm.cmd run typecheck` and `npm.cmd run test:run`.
- [ ] Confirm `src/server/agent-engine/**` imports no Ticket, Mission, phase, Assignment, or role-routing helpers.

## Acceptance Criteria

1. Agent Engine runs and chats without Ticket Engine.
2. A Goal spans multiple turns/slices and survives restart.
3. Human messages share one chronological Thread with all model-visible events.
4. Ordinary replies and slice yields cannot complete a Goal.
5. Only explicit schema-valid proposals can request a Goal outcome.
6. Host decisions settle once and are recoverable by stable IDs.
