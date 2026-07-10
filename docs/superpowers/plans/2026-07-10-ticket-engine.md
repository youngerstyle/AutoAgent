# Ticket Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a durable, standalone Ticket/Workflow engine that owns DAG state, commands, claims, fencing, policies, and completion without any Agent or role knowledge.

**Architecture:** Persist one authoritative Workflow aggregate per task run in an atomic JSON file, including Tickets, graph snapshot, runtime completion policy, claims, blocked ownership, command results, and transactional outbox records. The engine exposes deterministic command methods and snapshot/event reads; Mission Control consumes it only through TicketPort.

**Tech Stack:** TypeScript, Node fs atomic JSON storage, Vitest, existing `readJson`/`writeJson` utilities.

---

## File Structure

- Create `src/server/tickets/ticket-store.ts`
  - Atomic durable aggregate storage, command-result lookup, outbox cursor reads.
- Create `src/server/tickets/workflow-policy-store.ts`
  - Immutable policy documents addressed by WorkflowPolicyRef/contentHash; implements WorkflowPolicyPort.
- Create `src/server/tickets/workflow-graph.ts`
  - Key validation, DAG validation, key-to-ID materialization, required closure, revision/supersession, completion evaluation.
- Create `src/server/tickets/ticket-engine.ts`
  - Workflow commands, Ticket commands, claims, fencing, version checks, transitions.
- Modify `src/server/storage/paths.ts`
  - Adds Ticket Engine aggregate path under each task run.
- Create `tests/server/ticket-store-v2.test.ts`
- Create `tests/server/workflow-policy-store.test.ts`
- Create `tests/server/workflow-graph.test.ts`
- Create `tests/server/ticket-engine.test.ts`

## Task 1: Durable Aggregate Store

- [ ] Write failing tests for create/read/update, atomic version increment, command result persistence, and workflowId-partitioned outbox cursor paging.
- [ ] Run `npm.cmd run test:run -- tests/server/ticket-store-v2.test.ts` and verify RED.
- [ ] Add `ticketEngineFile()` to `src/server/storage/paths.ts`.
- [ ] Implement `TicketStore` with a per-workflow write queue and `writeJson` atomic replacement.
- [ ] Persist `schemaVersion`, WorkflowSnapshot, Ticket snapshots, claims, ownership receipts, command results, and outbox entries in one aggregate.
- [ ] Encode workflowId in every event cursor and reject cursors from another workflow namespace.
- [ ] Run the store tests and verify GREEN.
- [ ] Commit with `git commit -m "feat: add durable ticket aggregate store"`.

## Task 2: Immutable Workflow Policy Store

- [ ] Write failing tests for policy seed/read, contentHash verification, immutable version conflicts, teamBinding/principal capability grants, and missing-policy rejection.
- [ ] Run `npm.cmd run test:run -- tests/server/workflow-policy-store.test.ts` and verify RED.
- [ ] Implement WorkflowPolicyPort without role-name branches; grant checks consume principal/team binding capabilities only.
- [ ] Seed the versioned minimal-team policy through product configuration, not inside TicketEngine.
- [ ] Run the policy tests and verify GREEN.
- [ ] Commit with `git commit -m "feat: add immutable workflow policy store"`.

## Task 3: Graph Materialization and Completion Policy

- [ ] Write failing graph tests for duplicate keys, missing references, cycles, immutable key reuse, key-to-ID materialization, and runtime terminal-ID resolution.
- [ ] Add required-closure tests and unresolved-failure revision/supersession tests.
- [ ] Add amend tests proving omitted active nodes require explicit `cancelTicketIds`.
- [ ] Run `npm.cmd run test:run -- tests/server/workflow-graph.test.ts` and verify RED.
- [ ] Implement pure functions in `workflow-graph.ts` with no fs or Agent imports.
- [ ] Run the graph tests and verify GREEN.
- [ ] Commit with `git commit -m "feat: implement ticket workflow graph rules"`.

## Task 4: Workflow Commands and Complete Outbox

- [ ] Write failing tests for create, pause, resume, cancel, amend, invalid definitions, stale workflow versions, and command idempotency conflicts.
- [ ] Verify create atomically materializes graph IDs and runtime completion policy.
- [ ] Verify pause blocks new claims but records deferred outcomes.
- [ ] Verify cancel atomically cancels nonterminal Tickets and revokes authorities.
- [ ] Verify amend works in active/paused/blocked states, cancels explicit optional Tickets, and rejects terminal workflows.
- [ ] Assert workflow creation and every dependency unlock emit `TicketReady` atomically.
- [ ] Assert every committed status change emits `TicketBlocked`, `TicketTerminal`, and/or `WorkflowStatusChanged` in the same aggregate write.
- [ ] Implement `applyWorkflow()` in `ticket-engine.ts`.
- [ ] Run targeted tests and verify GREEN.
- [ ] Commit with `git commit -m "feat: add ticket workflow commands"`.

## Task 5: Claim, Lease, Fencing, and Ownership

- [ ] Write failing tests for requestId idempotency, one active claim per Ticket, capability policy checks, renew, release, expiration, blocked ownership, and ownership transfer.
- [ ] Add a stale-fencing test proving an expired Goal can never modify a reclaimed Ticket.
- [ ] Add response-loss tests using `getClaimByRequestId()`.
- [ ] Implement claim methods and monotonic fencing tokens.
- [ ] Publish TicketClaimed, ClaimExpired, AuthorityRevoked, and TicketReady outbox events in the same transaction as state changes.
- [ ] Expose `scanExpiredClaims(now)` as a production-host operation; it must be idempotent and persist all resulting events before returning.
- [ ] Run targeted tests and verify GREEN.
- [ ] Commit with `git commit -m "feat: add ticket claim and fencing protocol"`.

## Task 6: Ticket Commands and Two-Phase Results

- [ ] Write failing tests for complete, block, fail, complete_with_graph, return_to_parent, rejected combinations, stale Ticket versions, stale workflow versions, and proposal/command dedupe.
- [ ] Verify block converts a ClaimReceipt to BlockedOwnershipReceipt atomically.
- [ ] Verify complete_with_graph completes the planner Ticket and updates graph/policy in one write.
- [ ] Verify return_to_parent creates a revision branch, preserves unrelated completed branches, and replaces required terminal IDs.
- [ ] Verify fail_fast and require_resolution produce their specified Workflow outcomes.
- [ ] Verify complete, complete_with_graph, and return_to_parent atomically emit TicketReady for every newly dependency-satisfied Ticket.
- [ ] Implement `applyTicket()` and persisted TicketCommandResult lookup.
- [ ] Assert block/terminal/workflow events are present after store recreation and cursor paging.
- [ ] Run targeted tests and verify GREEN.
- [ ] Commit with `git commit -m "feat: implement ticket command protocol"`.

## Task 7: Standalone Ticket Engine Gate

- [ ] Add a test principal that creates, claims, blocks, resumes, completes, and cancels workflows without AgentRuntime.
- [ ] Add failpoint-style tests for repeated commands and process recreation between every persisted step.
- [ ] Run `npm.cmd run test:run -- tests/server/ticket-store-v2.test.ts tests/server/workflow-policy-store.test.ts tests/server/workflow-graph.test.ts tests/server/ticket-engine.test.ts tests/server/architecture-boundaries.test.ts`.
- [ ] Run `npm.cmd run typecheck` and `npm.cmd run test:run`.
- [ ] Confirm `src/server/tickets/**` imports no Agent, provider, prompt, session, or role-routing code.

## Acceptance Criteria

1. Ticket Engine runs with no Agent Engine.
2. Every state change is versioned, authorized, fenced, idempotent, and durable.
3. Workflow completion is computed only from graph/policy state.
4. No role, phase, QA, boss, human keyword, or model-output interpretation exists in the engine.
5. Restart and duplicate-delivery tests prove exact recovery.
