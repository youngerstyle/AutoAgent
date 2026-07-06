# Real Ticket Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make tickets the single runtime source of truth for the first AutoAgent execution slice, with LLM-owned business decisions and code-owned ticket delivery/validation.

**Architecture:** Seed the first `boss_intake` ticket, let each Agent return a structured ticket action, and let `MissionControl` map that action into one of three legal flow directions: same ticket, direct child tickets, or direct parent ticket. Keep `TaskRun.phase` as a UI projection only.

**Tech Stack:** TypeScript, Vitest, Express/Vite app, existing `MissionControl`, `TicketRuntime`, event ledger, JSON workspace state.

---

## Files

- Modify: `src/server/mission/mission-control.ts`
- Modify: `src/server/mission/ticket-runtime.ts`
- Modify: `src/server/mission/phases.ts`
- Modify: `src/server/agents/prompts.ts`
- Modify: `src/shared/types.ts`
- Test: `tests/server/mission-control.test.ts`
- Test: `tests/server/ticket-runtime.test.ts`
- Docs: `docs/superpowers/specs/2026-07-06-real-ticket-flow-design.md`

## Task 1: Define the ticket action contract

- [ ] Add or document a structured action shape for `continue_self`, `block_self`, `complete`, `return_to_parent`, `fail`, and `cancel`.
- [ ] Write tests proving natural-language `reason` text cannot route a ticket.
- [ ] Replace `target_phase` / `return_to` prompt language with the ticket action contract.
- [ ] Ensure loop logs persist raw LLM text, parsed action, validation result, and final ticket transition.

## Task 2: Seed only the real bootstrap chain

- [ ] Write a failing test proving `startTask(..., { autoRun: false })` creates one pending `boss_intake` ticket and one pending inbox message.
- [ ] Add or tighten `seedInitialTickets` so the platform only seeds the root ticket.
- [ ] Ensure `boss_intake` completion creates `pm_plan` as a direct child through the same action mapping used by all tickets.
- [ ] Verify no hidden post-PM default chain is created by platform code.

## Task 3: Let PM produce the execution ticket graph

- [ ] Write a failing test where PM returns `complete` with `child_tickets`.
- [ ] Support `parentKey` and `dependsOn` so QA can be a child of implementation, implementation can be a child of architecture or PM, and acceptance can be a child of QA.
- [ ] Ensure pending tickets with unmet dependencies are visible but cannot be claimed.
- [ ] Update the mock provider to emit a real `child_tickets` graph instead of relying on a platform default chain.
- [ ] If PM cannot plan because input/preconditions are missing, require `return_to_parent` to boss instead of defaulting to implementation.

## Task 4: Run tickets instead of phases

- [ ] Write a failing test proving a normal run consumes `nextRunnableTicket`, not `state.nextPhase`.
- [ ] Replace `while state.nextPhase` routing with ticket scheduler logic.
- [ ] Convert `runPhase`/phase-derived assignment execution into `runTicket`.
- [ ] Keep phase labels only by projecting the currently active ticket for UI.
- [ ] Verify happy path tests pass with no phase routing.

## Task 5: Implement single-layer transitions

- [ ] Replace `routeBackToPhaseOrFail` with action handlers that only touch same ticket, direct children, or direct parent.
- [ ] Remove `defaultTransferPhaseForObstacle` and `targetPhaseFromStructured`.
- [ ] QA defect result must `return_to_parent` to its direct implementation/rework parent.
- [ ] Dev requirement or architecture blocker must `return_to_parent` to the direct parent ticket, not jump to PM unless PM is the parent.
- [ ] Tool write denial must return a tool result to the same Agent; platform must not automatically create a dev ticket.
- [ ] Root ticket `return_to_parent` must become human-in-loop because no parent exists.

## Task 6: Human resume review through LLM

- [ ] Remove keyword/default handling from `applyHumanActionToTickets` and `phaseAfterHumanFollowup`.
- [ ] Every human reply to a blocked ticket must call the blocked ticket owner Agent for resume review.
- [ ] Resume review output must use the same action contract as normal ticket execution.
- [ ] Manual QA pass should complete QA and unlock/derive boss acceptance.
- [ ] Manual QA fail should return QA to its direct parent with defect details.
- [ ] Human questions or unclear replies should keep the same ticket blocked with an Agent reply.

## Task 7: Ticket runtime delivery and capacity

- [ ] Ensure new tickets always create inbox messages with dedupe key and correlation id.
- [ ] Ensure busy agents leave tickets pending or blocked as `waiting_for_agent_capacity`.
- [ ] Ensure leases can expire and be reclaimed without duplicate execution.
- [ ] Ensure dead-letter behavior is visible in runtime records.

## Task 8: UI and observability

- [ ] Right panel running records must group by role/ticket by default, in strict chronological order.
- [ ] Each grouped item must expand to prompt, raw LLM output, parsed action, tool results, and transition result.
- [ ] Original tickets view must show parent, children, dependencies, status, owner, action, and blocker.
- [ ] Canvas badges must appear on the Agent that owns the blocked/returned ticket.
- [ ] Human-in-loop chat must attach to the selected Agent's current ticket.

## Task 9: Verification and release gate

- [ ] Run `npm.cmd run test:run`.
- [ ] Run `npm.cmd run typecheck`.
- [ ] Run `npm.cmd run build`.
- [ ] Restart local server if needed.
- [ ] Browser-check `http://127.0.0.1:13748/` for Run Console rendering.
- [ ] Verify a new Tank task covers: boss -> PM -> graph, PM missing precondition returns to boss, QA manual test pass goes to acceptance, QA manual test fail returns to dev parent, and no natural-language keyword routes a ticket.
- [ ] Commit the docs, tests, and implementation.
