# Real Ticket Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make tickets the single runtime source of truth for the first AutoAgent execution slice.

**Architecture:** Seed a `boss_intake` ticket when a task starts, let `MissionControl` claim and execute pending tickets, and create follow-up tickets from completed ticket results. Keep `TaskRun.phase` as a UI projection only.

**Tech Stack:** TypeScript, Vitest, Express/Vite app, existing `MissionControl`, `TicketRuntime`, event ledger, JSON workspace state.

---

## Files

- Modify: `src/server/mission/mission-control.ts`
- Modify: `src/server/mission/ticket-runtime.ts`
- Modify: `src/server/mission/phases.ts`
- Modify: `src/shared/types.ts`
- Test: `tests/server/mission-control.test.ts`
- Test: `tests/server/ticket-runtime.test.ts`
- Docs: `docs/superpowers/specs/2026-07-06-real-ticket-flow-design.md`

## Task 1: Seed the first ticket

- [ ] Write a failing test proving `startTask(..., { autoRun: false })` creates one pending `boss_intake` ticket and one pending inbox message.
- [ ] Run the targeted test and confirm it fails because no ticket is created at task start.
- [ ] Add a `seedInitialTickets` helper in `MissionControl`.
- [ ] Verify the targeted test passes.

## Task 2: Run tickets instead of phases

- [ ] Write a failing test proving a normal run produces parent-linked tickets in order.
- [ ] Replace the `while state.nextPhase` loop with a `nextRunnableTicket` loop.
- [ ] Convert `runPhase` into `runTicket`, using ticket type/brief/artifact as assignment input.
- [ ] Keep phase labels by projecting `phaseForTicket(ticket)`.
- [ ] Verify happy path tests pass.

## Task 3: Create next tickets explicitly

- [ ] Write failing tests for `boss_intake -> pm_plan`, `pm_plan -> architect_plan`, `implementation -> qa`, and `qa -> boss_acceptance` parent links.
- [ ] Add deterministic `createNextTicketsForCompletedTicket`.
- [ ] Ensure boss acceptance completion marks the run completed only when no pending/running/blocked tickets remain.
- [ ] Verify targeted tests pass.

## Task 4: Convert reroutes into ticket creation

- [ ] Write failing tests for QA defect creating a dev rework ticket with parent QA.
- [ ] Write failing tests for boss source-file write boundary creating a dev implementation/rework ticket with parent boss ticket.
- [ ] Replace `routeBackToPhaseOrFail` phase mutation with `createReturnTicketOrFail`.
- [ ] Keep retry counters on context by target ticket type, not hidden phase.
- [ ] Verify regression tests pass.

## Task 5: Human-in-loop continuation

- [ ] Keep existing manual QA tests green.
- [ ] Ensure manual QA pass creates boss acceptance ticket.
- [ ] Ensure manual QA fail creates dev rework ticket.
- [ ] Ensure follow-up/resume uses the newly created ticket rather than a computed phase.

## Task 6: Verification and release gate

- [ ] Run `npm.cmd run test:run`.
- [ ] Run `npm.cmd run typecheck`.
- [ ] Run `npm.cmd run build`.
- [ ] Restart local server if needed.
- [ ] Browser-check `http://127.0.0.1:13748/` for Run Console rendering.
- [ ] Commit the docs, tests, and implementation.

