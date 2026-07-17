# Ticket Handoff Context Implementation Plan

> **For agentic workers:** Execute inline in this session. Do not create subagents. Follow test-driven development task-by-task.

**Goal:** Give every Ticket owner complete, durable upstream delivery context without sharing Agent Sessions or adding platform-side semantic completion rules.

**Architecture:** Ticket Engine stores a canonical `TicketHandoff` as the only completion payload. Mission Control retains the raw human request for initial intake/audit and appends a deterministic assignment message containing the shared current Plan, current Ticket, and accepted handoff lineage of every DAG ancestor to the target Agent Thread. It does not copy the raw request into downstream assignments. Agent Engine remains unchanged and reconstructs only that Agent's own chronological Thread. This rule supersedes the original direct-parent-only implementation described by this historical plan.

**Tech Stack:** TypeScript, Node.js, Vitest, append-only Ticket and Agent stores.

---

### Task 1: Canonical Ticket Handoff Contract

**Files:**
- Modify: `src/shared/contracts/ticket-engine.ts`
- Modify: `tests/shared/runtime-contracts.test.ts`
- Modify: `tests/server/ticket-engine.test.ts`

- [x] Write failing contract and persistence tests for `TicketHandoff`.
- [x] Run the focused tests and confirm they fail because the contract is absent.
- [x] Replace loose completion `result/evidence` fields with one canonical handoff.
- [x] Run the focused tests and confirm they pass.

### Task 2: Mission Objective Persistence

**Files:**
- Modify: `src/shared/contracts/mission-control.ts`
- Modify: `src/server/mission-process/mission-process-manager.ts`
- Modify: `src/server/mission-process/mission-store.ts`
- Test: `tests/server/mission-process-manager.test.ts`

- [x] Write a failing test proving the Mission record retains the original objective.
- [x] Persist the objective when the Mission aggregate is created.
- [x] Verify recovery reads the same objective.

### Task 3: Upstream Handoff Delivery

**Files:**
- Modify: `src/server/mission-process/ticket-agent-adapter.ts`
- Modify: `src/server/mission-process/mission-process-manager.ts`
- Test: `tests/server/ticket-agent-adapter.test.ts`
- Test: `tests/server/mission-process-manager.test.ts`

- [x] Write a failing adapter test for a readable assignment envelope containing Mission, current Ticket, and upstream handoff facts.
- [x] Write a failing integration test proving a downstream Agent receives the upstream summary, output, and evidence but not upstream Thread history.
- [x] Build the envelope from persisted Ticket facts and append it through the existing deterministic assignment message.
- [x] Run focused tests and verify recovery remains idempotent.

### Task 4: Regression And Runtime Verification

**Files:**
- Update affected fixtures in `tests/server` and `tests/shared`.
- No production compatibility layer for old completion payloads.

- [x] Run all server and shared tests.
- [x] Run TypeScript type checking and production build.
- [x] Review the diff for Session leakage, semantic if/else rules, duplicate context paths, and hard-coded roles.
- [x] Start the local service and verify the health endpoint and built UI shell.
- [ ] Commit the verified change.
