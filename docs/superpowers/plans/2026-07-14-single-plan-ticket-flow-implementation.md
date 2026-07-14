# Single Plan Ticket Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Do not dispatch subagents for this repository task.

**Goal:** Replace the Workflow revision-chain model with one durable UUID Plan per Mission and an append-only UUID Ticket DAG.

**Architecture:** Ticket Engine remains the owner of the aggregate, renamed from Workflow to Plan. PM/model output is a command-scoped `PlanChangeSet`; the engine generates Ticket UUIDs, validates and atomically appends them. Agent Engine stays unchanged and Mission Control only bridges `TicketReady` and Agent Goal proposals.

**Tech Stack:** TypeScript, Node.js, Vitest, durable JSON aggregates, Express/Vite UI.

---

### Task 1: Freeze v3 contracts

**Files:**
- Modify: `src/shared/contracts/ticket-engine.ts`
- Modify: `src/shared/contracts/mission-control.ts`
- Test: `tests/shared/runtime-contracts.test.ts`

- [x] Add failing contract tests for `PlanId`, `PlanSnapshot`, UUID Ticket graph and `PlanChangeSet`.
- [x] Remove revision/supersession and persistent node-key fields from the public contract.
- [x] Replace Workflow commands/results/events with Plan equivalents.
- [x] Bump new runtime records to `ticket_agent@3`; keep v2 classification read-only only.
- [x] Run `npm test -- tests/shared/runtime-contracts.test.ts`.

### Task 2: Implement append-only Plan graph

**Files:**
- Create: `src/server/tickets/plan-graph.ts`
- Delete: `src/server/tickets/workflow-graph.ts`
- Test: `tests/server/plan-graph.test.ts`
- Delete: `tests/server/workflow-graph.test.ts`

- [x] Add failing tests for fresh UUIDs, duplicate titles, append-only history, terminal immutability, cycle rejection and completion policy resolution.
- [x] Implement command-local `clientRef` resolution and injected UUID generation.
- [x] Validate additions and return a materialized graph containing Ticket IDs only.
- [x] Ensure no function derives Ticket IDs from Plan ID or semantic keys.
- [x] Run `npm test -- tests/server/plan-graph.test.ts`.

### Task 3: Replace Workflow aggregate persistence

**Files:**
- Modify: `src/server/tickets/ticket-store.ts`
- Test: `tests/server/ticket-store-v2.test.ts` (rename to `ticket-store-v3.test.ts`)

- [x] Add failing v3 persistence and corruption tests.
- [x] Persist one `PlanSnapshot`, Tickets by UUID and append-only events.
- [x] Remove `TicketPlanningState` and its three mirrored indexes.
- [x] Reject v2 aggregates from scheduling while retaining read-only classification at the product boundary.
- [x] Verify durable reload preserves IDs, versions and terminal states exactly.

### Task 4: Replace Ticket Engine transitions

**Files:**
- Modify: `src/server/tickets/ticket-engine.ts`
- Test: `tests/server/ticket-engine.test.ts`
- Test: `tests/server/ticket-engine-standalone.test.ts`

- [x] Add failing tests proving PM completion does not complete Plan and terminal Tickets never re-enter scheduling.
- [x] Implement `createPlan`, `changePlan`, Ticket completion/block/fail and Plan lifecycle commands.
- [x] Split Ticket completion from Plan change application while preserving proposal/command idempotency.
- [x] Remove automatic branch cloning from `return_to_parent`.
- [x] Separate ordinary `correction_required` from structural `plan_change_required`.
- [x] Ordinary correction appends one correction Ticket, retries the same current Ticket after correction, and never invokes the planner.
- [x] Emit `PlanAmendmentRequested` only for explicit structural Plan changes.
- [x] Remove deterministic semantic Ticket IDs and revision-chain code.

### Task 5: Adapt product template and Mission Control

**Files:**
- Modify: `src/server/product/workflow-template.ts`
- Modify: `src/server/product/workflow-definition-registry.ts`
- Modify: `src/server/mission-process/mission-process-manager.ts`
- Modify: `src/server/mission-process/mission-store.ts`
- Modify: `src/server/mission-process/ticket-agent-adapter.ts`
- Test: `tests/server/workflow-template.test.ts`
- Test: `tests/server/mission-process-manager.test.ts`
- Test: `tests/server/ticket-agent-adapter.test.ts`

- [x] Create exactly one Plan UUID for each Mission and persist `planId` in MissionRecord.
- [x] Make the initial template contain only bootstrap Tickets.
- [x] Convert a valid planning Agent proposal into Ticket completion plus one Plan change command.
- [x] Dispatch only actual `TicketReady` events and deduplicate by Ticket ID/version.
- [x] Prove repeated tick/restart cannot reactivate completed Tickets.

### Task 6: Update API and read projections

**Files:**
- Modify: server routes and runtime composition files found by `rg -n "workflowId|WorkflowSnapshot|getWorkflow" src/server src/client`
- Modify: affected client read-model files
- Test: affected API/client tests

- [x] Rename runtime/public fields from Workflow to Plan.
- [x] Expose Mission, Plan status/ID and chronological Ticket history.
- [x] Ensure UI completion derives from Mission/Plan terminal status, not the latest PM Ticket.
- [x] Mark legacy v2 projects read-only and unschedulable.

### Task 7: Delete legacy semantics and verify boundaries

**Files:**
- Modify: all matches from `rg -n "revisionOf|superseded|TicketNodeKey|complete_with_graph|return_to_parent|WorkflowId" src tests`
- Modify: relevant design documents with superseded notices

- [x] Make the legacy-symbol search return no executable-code matches except explicit read-only decoders.
- [x] Run Agent Engine unit tests and confirm no Plan/Ticket imports were introduced.
- [x] Run Ticket Engine unit tests and confirm no Provider/Prompt imports exist.
- [x] Run `npm test` and `npm run build`.

### Task 8: Real runtime verification

**Files:**
- Test: browser-driven local runtime only

- [x] Start the service on an available port.
- [x] Create a brand-new Mission and record its Mission ID and Plan UUID.
- [x] Complete planning, inspect newly appended UUID Tickets and execute the full flow.
- [x] Restart during and after execution; verify no terminal Ticket is dispatched again.
- [x] Verify UI status, chronological history and Plan completion.
- [x] Review the final diff for hidden role routing, phase routing, regex/keyword transitions and fixed retry loops.
- [x] Commit the verified change.
