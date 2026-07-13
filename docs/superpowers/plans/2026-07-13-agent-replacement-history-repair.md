# Agent Replacement History Repair Implementation Plan

> **For agentic workers:** Execute inline in the current session. Do not use subagents.

**Goal:** Make Agent context compaction persist Codex-style replacement history so tool facts and human decisions survive across turns, goals, and process restarts.

**Architecture:** Keep the append-only Agent Thread as the audit source. Add immutable compaction items that replace the model-visible prefix through a sequence boundary; reconstruct every later model context from the latest replacement history plus the chronological suffix. Generate semantic summaries through the configured provider and never write assembled prompts back into the Thread.

**Tech Stack:** TypeScript, Vitest, existing AgentStore/AgentEngine/AgentToolLoop/provider adapter.

---

### Task 1: Persist and reconstruct replacement history

- [x] Add failing context tests for checkpoint reconstruction and restart persistence.
- [x] Add the compaction item contract and append API.
- [x] Reconstruct context from the latest checkpoint plus suffix.
- [x] Reject checkpoint boundaries that exceed facts or replace a newer checkpoint.
- [x] Run the focused context tests.

### Task 2: Trigger semantic compaction from the Agent loop

- [x] Add a failing loop test proving oversized history invokes one compaction turn before the work turn.
- [x] Generate a bounded semantic summary with the configured provider.
- [x] Reject summaries that exceed the replacement-history budget.
- [x] Persist the checkpoint and rebuild context before normal execution.
- [x] Trace compaction usage and failure without changing Goal or Ticket state.

### Task 3: Verify the engine boundary

- [x] Run Agent Engine suites.
- [x] Run Mission Process and Ticket Engine suites.
- [x] Run typecheck and build.
- [x] Review the diff for prompt recursion, side-channel history, and workflow coupling.
- [x] Commit the repair.
