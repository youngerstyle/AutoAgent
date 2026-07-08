# Ticket Agent Yield Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement yielded execution slices so runtime budgets pause and requeue the same ticket without creating business blocked/failed results.

**Architecture:** `AgentRuntime` returns either a final assignment result or a yielded slice result. `MissionControl` treats yielded as scheduling metadata, asks `TicketRuntime` to release and requeue the same ticket, and continues the run without unlocking downstream tickets. UI/event projections show yielded as saved progress, not human-in-loop.

**Tech Stack:** TypeScript, Vitest, Vite, existing JSON state storage and event ledger.

---

## Files

- Modify: `src/shared/types.ts`
  - Add ticket execution metadata and assignment yield status.
- Modify: `src/shared/events.ts`
  - Add an event type for yielded execution slices if needed.
- Modify: `src/shared/labels.ts`
  - Add Chinese label for yielded/running continuation if displayed.
- Modify: `src/server/agents/agent-runtime.ts`
  - Replace synthetic blocked-on-tool-budget with `kind: "yielded"`.
- Modify: `src/server/mission/ticket-runtime.ts`
  - Add `yieldTicket(...)` or equivalent release/requeue API.
- Modify: `src/server/mission/mission-control.ts`
  - Handle yielded result before business action inspection.
- Modify: `src/server/storage/state-projector.ts`
  - Project yielded execution metadata correctly.
- Modify: `src/client/event-view-model.ts`, `src/client/App.tsx`, `src/client/styles.css`
  - Render yielded records as progress, not blocker/human-in-loop.
- Test: `tests/server/agent-runtime.test.ts`
- Test: `tests/server/ticket-runtime.test.ts`
- Test: `tests/server/mission-control.test.ts`
- Optional Test: `tests/client/event-view-model.test.ts`

## Task 1: AgentRuntime returns yielded outcome

- [x] Write a failing `AgentRuntime` test with a provider that always requests observation tools and reaches a low injected budget.
- [x] Assert the result has `kind: "yielded"`, assignment run status is not failed, and no synthetic structured `status: "blocked"` is created.
- [x] Add `AssignmentResult.kind` or a discriminated union while preserving existing callers through `kind: "final"`.
- [x] Change budget exhaustion branch to return yielded outcome.
- [x] Add a loop trace entry for the yield.
- [x] Run `npm.cmd run test:run -- tests/server/agent-runtime.test.ts`.

## Task 2: TicketRuntime can requeue yielded tickets

- [x] Write a failing ticket-runtime test: claim a ticket, yield it, then claim the same ticket again.
- [x] Assert ticket business status returns to `pending`, message returns to `pending`, execution metadata says `yielded`, downstream is not affected.
- [x] Implement `yieldTicket(ticketId, reason, metadata, now)`.
- [x] Run `npm.cmd run test:run -- tests/server/ticket-runtime.test.ts`.

## Task 3: MissionControl integrates yielded result

- [x] Write a failing mission-control test where dev yields once and then completes on resume.
- [x] Assert no `run.blocked`, no `run.failed`, same ticket id is reused, QA only runs after final completion.
- [x] Add a provider fixture that first triggers yielded observation budget and later returns `complete`.
- [x] Update `runTicket` to handle yielded before reading business structured result.
- [x] Ensure mission is not completed while yielded/pending tickets exist.
- [x] Run `npm.cmd run test:run -- tests/server/mission-control.test.ts`.

## Task 4: UI and events

- [x] Add event/view-model copy for yielded slices: saved progress, no human action required.
- [x] Ensure yielded does not set avatar human-in-loop blocker.
- [x] Keep raw JSON available under event details.
- [x] Run `npm.cmd run test:run -- tests/client/event-view-model.test.ts`.

## Task 5: Full verification and ship

- [x] Run `npm.cmd run test:run`.
- [x] Run `npm.cmd run typecheck`.
- [x] Run `npm.cmd run build`.
- [x] Restart the production server on port `13748`.
- [x] Verify `http://127.0.0.1:13748/api/health`.
- [x] Verify `http://127.0.0.1:13748/` returns the built app.
- [ ] Commit the implementation.
