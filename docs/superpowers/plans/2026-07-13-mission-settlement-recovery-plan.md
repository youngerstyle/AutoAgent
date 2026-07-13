# Mission Settlement Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Execute inline with test-driven development. Do not use subagents for this plan.

**Goal:** Make Mission settlement recover locally from optimistic concurrency and display authoritative Agent states correctly.

**Architecture:** Ticket Engine treats version conflicts as uncommitted concurrency responses. Mission Process owns durable retry and settlement reconciliation without calling the model. Runtime projection gives Goal state precedence over stale activity.

**Tech Stack:** TypeScript, Vitest, durable JSON stores, Ticket/Agent public contracts.

---

### Task 1: Ticket version conflict is retriable

**Files:**
- Modify: `tests/server/ticket-engine.test.ts`
- Modify: `src/server/tickets/ticket-engine.ts`

- [ ] Add a failing test proving a stale command does not consume commandId or proposalId.
- [ ] Run the focused test and confirm the current persisted rejection causes failure.
- [ ] Return version conflicts without `persistTicketRejected`.
- [ ] Re-submit the same proposal with refreshed versions and verify acceptance.

### Task 2: Mission retries the same proposal locally

**Files:**
- Modify: `tests/server/ticket-agent-adapter.test.ts`
- Modify: `tests/server/mission-process-manager.test.ts`
- Modify: `src/server/mission-process/ticket-agent-adapter.ts`
- Modify: `src/server/mission-process/mission-process-manager.ts`

- [ ] Add a failing adapter test proving version conflict is not `correctable`.
- [ ] Add a failing manager test that advances Ticket version before settlement and asserts no extra Agent turn.
- [ ] Keep the link resolving, refresh versions, and retry it from every tick.
- [ ] Map policy/idempotency failures to `host_error` and deterministic semantic failures to `correctable`.

### Task 3: Agent settlement reconciliation

**Files:**
- Modify: `tests/server/mission-process-manager.test.ts`
- Modify: `src/server/mission-process/mission-process-manager.ts`

- [ ] Add a failing test where the first `settleProposal` returns version conflict and the event cursor advances.
- [ ] Re-read the same active proposal and replay the same decision with the newest Goal version.
- [ ] Verify a later tick converges without restart or Provider activity.

### Task 4: Authoritative status projection

**Files:**
- Modify: `tests/server/runtime-host.test.ts`
- Modify: `src/server/runtime/runtime-host.ts`

- [ ] Add failing projection assertions for paused and failed Goals with stale running activity.
- [ ] Move terminal/paused Goal checks before transient activity checks.

### Task 5: Release verification

- [ ] Run focused Ticket, Mission, Runtime and architecture tests.
- [ ] Run `npm.cmd run typecheck`.
- [ ] Run `npm.cmd run test:run`.
- [ ] Run `npm.cmd run build`.
- [ ] Run `git diff --check` and review the complete diff.
- [ ] Commit the implementation separately from this design commit.

