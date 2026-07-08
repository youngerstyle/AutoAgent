# Agent Context and Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace direct raw-session prompt injection with a production context and memory layer that has budgets, session compaction, tool observation compaction, separate workspace-agent memory, and loop-debug visibility.

**Architecture:** Add a `ContextAssembler` as the single prompt construction boundary. `SessionStore` stores only model-visible agent history, while `LoopTraceStore` stores full prompt/LLM/tool audit evidence. `ContextStore` persists derived summaries/checkpoints and workspace-agent memory. `AgentRuntime` asks the assembler for each model prompt, writes the complete prompt to loop trace, and records compact context metadata in session and events.

**Tech Stack:** TypeScript, Vitest, existing JSON file storage, existing provider runner abstraction, existing loop debug projection.

---

## File Structure

- Create: `src/server/context/token-budget.ts`
  - Character/token estimator, section budgets, truncation helpers, report section accounting.
- Create: `src/server/context/context-store.ts`
  - Reads/writes `agents/<agentId>/context/<taskRunId>.json` and `agents/<agentId>/memory.json`.
- Create: `src/server/context/session-compactor.ts`
  - Builds message groups, decides when compaction is needed, creates deterministic summaries/checkpoints.
- Create: `src/server/context/context-assembler.ts`
  - Builds prompt from stable header, current assignment, memory, session summary, recent turns, tool observations, and dynamic context.
- Modify: `src/server/storage/paths.ts`
  - Add paths for workspace-agent context directory/file and memory file.
- Modify: `src/server/storage/session-store.ts`
  - Store model-visible session turns only; keep assembled prompts and full tool output out of session.
- Create: `src/server/storage/loop-trace-store.ts`
  - Store full prompt, raw LLM response, full tool output, usage, context report, and timing in `loop-trace.jsonl`.
- Modify: `src/server/agents/prompts.ts`
  - Keep only stable prompt/header helpers. Remove direct unbounded session reading.
- Modify: `src/server/agents/agent-runtime.ts`
  - Use `ContextAssembler`; remove local `buildToolFollowUpPrompt` compaction logic or route it through assembler.
- Modify: `src/server/mission/loop-debug-log.ts`
  - Build prompt/LLM/tool debug entries from loop trace, not from session messages.
- Modify: `src/shared/types.ts`
  - Add optional context debug entry kind if needed.
- Test: `tests/server/context-assembler.test.ts`
- Test: `tests/server/session-compactor.test.ts`
- Test: `tests/server/agent-runtime.test.ts`
- Test: `tests/server/loop-debug-log.test.ts`

## Task 1: Budget And Context Store

- [ ] **Step 1: Write failing budget and context-store tests**

Create `tests/server/context-assembler.test.ts` with tests that assert:

```ts
expect(estimateTokens("12345678")).toBe(2);
expect(truncateToTokenBudget("a".repeat(100), 10).text.length).toBeLessThanOrEqual(40 + 80);
```

Create store tests that write/read:

- context state for one agent/task run
- memory for one workspace agent
- empty defaults when files do not exist

- [ ] **Step 2: Run tests to verify failure**

Run:

```powershell
npm.cmd run test:run -- tests/server/context-assembler.test.ts
```

Expected: fails because files/functions do not exist.

- [ ] **Step 3: Implement token budget and context store**

Create:

- `src/server/context/token-budget.ts`
- `src/server/context/context-store.ts`

Add paths in `src/server/storage/paths.ts`.

- [ ] **Step 4: Verify tests pass**

Run:

```powershell
npm.cmd run test:run -- tests/server/context-assembler.test.ts
```

Expected: pass.

## Task 2: Session Compactor

- [ ] **Step 1: Write failing compactor tests**

Create `tests/server/session-compactor.test.ts` with tests that assert:

- raw `AgentSession.messages` remains unchanged.
- old messages become a checkpoint summary when active context exceeds threshold.
- recent messages remain verbatim.
- tool messages are grouped with the turn and not split apart.

- [ ] **Step 2: Run tests to verify failure**

Run:

```powershell
npm.cmd run test:run -- tests/server/session-compactor.test.ts
```

Expected: fails because compactor does not exist.

- [ ] **Step 3: Implement deterministic compactor**

Create `src/server/context/session-compactor.ts`.

Use deterministic summary for V1, not an extra LLM call:

- count compacted groups
- include truncated important lines
- preserve paths, statuses, and latest decisions
- record original/injected sizes

- [ ] **Step 4: Verify tests pass**

Run:

```powershell
npm.cmd run test:run -- tests/server/session-compactor.test.ts
```

Expected: pass.

## Task 3: Context Assembler

- [ ] **Step 1: Write failing assembler tests**

Extend `tests/server/context-assembler.test.ts` to assert:

- prompt starts with stable agent/policy/tool sections.
- dynamic ticket/session/tool context appears after stable sections.
- large previous assembled prompt is not reinserted.
- large tool observation is summarized with original size.
- report contains section sizes and compaction status.

- [ ] **Step 2: Run tests to verify failure**

Run:

```powershell
npm.cmd run test:run -- tests/server/context-assembler.test.ts
```

Expected: fails until assembler exists.

- [ ] **Step 3: Implement assembler**

Create `src/server/context/context-assembler.ts`.

Move stable prompt construction from `src/server/agents/prompts.ts` into reusable helpers. The assembler returns:

```ts
{
  prompt,
  report: {
    originalSessionChars,
    injectedChars,
    sections,
    compaction
  }
}
```

- [ ] **Step 4: Verify tests pass**

Run:

```powershell
npm.cmd run test:run -- tests/server/context-assembler.test.ts tests/server/session-compactor.test.ts
```

Expected: pass.

## Task 4: Runtime Integration

- [ ] **Step 1: Write failing runtime tests**

Update `tests/server/agent-runtime.test.ts`:

- no provider prompt contains `PREVIOUS_PROMPT_END` from a prior assembled prompt.
- session does not store the raw assembled prompt; loop trace stores it for audit.
- session message metadata includes context report.
- follow-up tool prompts are assembled through context report and remain bounded.

- [ ] **Step 2: Run tests to verify failure**

Run:

```powershell
npm.cmd run test:run -- tests/server/agent-runtime.test.ts
```

Expected: fails until runtime uses assembler.

- [ ] **Step 3: Update runtime**

Modify `src/server/agents/agent-runtime.ts`:

- instantiate `ContextAssembler`
- read model-visible session and derived context state
- assemble prompt before each provider call
- persist context report metadata in the session turn and full prompt in loop trace
- emit a `context.assembled` event or provider/status event with report metadata

- [ ] **Step 4: Verify runtime tests pass**

Run:

```powershell
npm.cmd run test:run -- tests/server/agent-runtime.test.ts
```

Expected: pass.

## Task 5: Loop Debug Visibility

- [ ] **Step 1: Write failing loop-debug tests**

Update `tests/server/loop-debug-log.test.ts` to assert context reports are visible in prompt entries or adjacent context entries.

- [ ] **Step 2: Run tests to verify failure**

Run:

```powershell
npm.cmd run test:run -- tests/server/loop-debug-log.test.ts
```

Expected: fails until debug projection reads context metadata.

- [ ] **Step 3: Implement debug projection**

Modify `src/server/mission/loop-debug-log.ts`:

- show context report summary for prompt entries
- include raw metadata so the UI can show section sizes and compaction status
- read prompt/LLM/tool entries from `loop-trace.jsonl`

- [ ] **Step 4: Verify tests pass**

Run:

```powershell
npm.cmd run test:run -- tests/server/loop-debug-log.test.ts
```

Expected: pass.

## Task 6: Full Verification

- [ ] **Step 1: Run server test suite**

Run:

```powershell
npm.cmd run test:run
```

Expected: all tests pass.

- [ ] **Step 2: Run typecheck**

Run:

```powershell
npm.cmd run typecheck
```

Expected: pass.

- [ ] **Step 3: Run production build**

Run:

```powershell
npm.cmd run build
```

Expected: pass.

- [ ] **Step 4: Run app and inspect browser**

Start the dev server if needed, open the current URL, run or inspect a task, and confirm:

- runtime records still appear
- prompt entries are clickable
- context report is readable
- large prompt content is not visually dumped into canvas

- [ ] **Step 5: Commit**

Run:

```powershell
git add docs/superpowers/specs/2026-07-07-agent-context-memory-design.md docs/superpowers/plans/2026-07-07-agent-context-memory.md src/server/context src/server/agents src/server/storage src/server/mission tests/server
git commit -m "feat: add bounded agent context memory"
```
