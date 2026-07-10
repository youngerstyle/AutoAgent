# Mission Process Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the monolithic role/phase MissionControl loop with a durable process manager that only coordinates TicketPort and AgentPort.

**Architecture:** Persist MissionRecord, staged MissionLinks, and durable event cursors separately from both engines. Start from a versioned WorkflowDefinition, consume TicketReady, persist dispatch before claim, start one Goal per claim, map explicit proposal contracts to Ticket commands, and reconcile every response-loss/crash window by stable IDs and snapshots.

**Tech Stack:** TypeScript, TicketPort, AgentPort, atomic JSON storage, transactional outbox consumers, Vitest, existing Express routes.

---

## File Structure

- Create `src/server/mission-process/mission-store.ts`
  - MissionRecord, MissionLink, cursor, and idempotent saga-step persistence.
- Create `src/server/product/workflow-template.ts`
  - Versioned default minimal-team WorkflowDefinition as product data.
- Create `src/server/product/workflow-definition-registry.ts`
  - Implements WorkflowDefinitionRegistryPort; resolves template version and TeamBinding before Mission start.
- Create `src/server/mission-process/ticket-agent-adapter.ts`
  - Output-contract validation and normative proposal/result mapping only.
- Create `src/server/mission-process/mission-goal-resolution-port.ts`
  - Implements the one injected GoalResolutionPort contract for Mission mode without creating an Agent->Mission dependency.
- Create `src/server/mission-process/mission-process-manager.ts`
  - Event pump, dispatch, claim renewal, Goal lifecycle, settlement, recovery.
- Create `src/server/runtime/runtime-host.ts`
  - Composes both Engines and MissionProcessManager; owns start/stop/tick/recover timers and test failpoints.
- Create `src/server/runtime/failpoints.ts`
  - Test/development-only named crash hooks for deterministic recovery tests; production defaults disabled.
- Create `tests/server/mission-store.test.ts`
- Create `tests/server/ticket-agent-adapter.test.ts`
- Create `tests/server/mission-process-manager.test.ts`
- Create `tests/server/runtime-host.test.ts`
- Keep `tests/server/mission-control.test.ts` unchanged as the mounted legacy baseline until the final public cutover plan replaces it.

## Task 1: Durable Mission Store

- [ ] Write failing tests for MissionRecord before workflow create, dispatching link before claim, conditional link fields, and saga-step idempotency.
- [ ] Persist cursors and applied aggregate versions under namespaced partition keys (`ticket:<workflowId>`, `agent:<agentId>`), never one global cursor.
- [ ] Add duplicate event, lower-version event, version-gap detection, snapshot reconciliation, and cursor-write-loss tests.
- [ ] Run `npm.cmd run test:run -- tests/server/mission-store.test.ts` and verify RED.
- [ ] Implement MissionStore with atomic JSON writes and stable IDs derived from mission/ticket/version/proposal.
- [ ] Run the tests and verify GREEN.
- [ ] Commit with `git commit -m "feat: add durable mission process store"`.

## Task 2: Versioned Initial Workflow

- [ ] Write tests proving the default topology is data, has boss intake then planning dependencies, and can be replaced by another definition without manager code changes.
- [ ] Implement `product/workflow-template.ts` using capability assignments and output contracts, not role branches in MissionProcessManager.
- [ ] Implement WorkflowDefinitionRegistryPort in the product layer; resolve templateId/version, immutable policyRef, and teamBindingId before `MissionProcessManager.startMission()`.
- [ ] Change the future start API contract to accept a template selection (defaulting in the product layer), never a topology assembled by Mission Control.
- [ ] Ensure dynamic planning uses `complete_with_graph`; human is never a planned team Agent node.
- [ ] Run targeted tests and verify GREEN.
- [ ] Commit with `git commit -m "feat: add versioned mission workflow template"`.

## Task 3: Proposal-to-Ticket Adapter

- [ ] Write failing table tests for every allowed proposal/command/result/Goal decision combination.
- [ ] Add contradictory-combination tests and rejection-code mapping tests.
- [ ] Add a test proving temporary unknown command state returns pending retry and never calls settle.
- [ ] Implement pure adapter functions with no role, phase, keyword, regular expression, file-path, or tool-result business inference.
- [ ] Implement MissionGoalResolutionPort: after AgentStore has persisted proposal/outbox, it returns pending/retry_later and wakes the Mission event pump; no second proposal protocol is introduced.
- [ ] Run `npm.cmd run test:run -- tests/server/ticket-agent-adapter.test.ts` and verify GREEN.
- [ ] Commit with `git commit -m "feat: add ticket agent resolution adapter"`.

## Task 4: Start and Dispatch Saga

- [ ] Write failpoint tests for crash before/after MissionRecord, workflow create, TicketReady cursor, dispatch link, claim response, Goal start response, and link updates.
- [ ] Implement start flow with stable workflowCreateCommandId, dispatchId, claimRequestId, and goalStartKey.
- [ ] Consume only a pre-resolved WorkflowDefinition and TeamBinding from the product registry.
- [ ] Persist dispatching link before `claimReady()`.
- [ ] Recover lost responses through command result, `getClaimByRequestId`, and `getGoalByStartKey`.
- [ ] Run targeted tests and verify GREEN.
- [ ] Commit with `git commit -m "feat: implement recoverable mission dispatch"`.

## Task 5: Proposal Settlement Saga

- [ ] Write failpoint tests for proposal persisted, command response lost, Ticket commit before settle, settle response lost, and link finalization.
- [ ] Implement one Ticket command per proposal and deterministic final decisionId.
- [ ] Consume durable Agent GoalProposalCreated events through AgentPort.readEvents; the adapter is hosted here and never imported by Agent Engine.
- [ ] Read Ticket events by workflowId partition and Agent events by agentId partition; update each partition cursor/applied version only after the saga step commits.
- [ ] Keep pending retry in resolving without settling.
- [ ] Query Ticket/Goal snapshots before acting on duplicate or out-of-order events.
- [ ] Run targeted tests and verify GREEN.
- [ ] Commit with `git commit -m "feat: implement recoverable goal settlement"`.

## Task 6: Lease, Human Message, Pause, Resume, Cancel

- [ ] Write tests for lease renewal, stale Goal cancellation, reclaim into a new Goal on the same Thread, blocked ownership, and transfer.
- [ ] Write tests proving a human private message appends only to the selected AgentThread and triggers that Goal's next turn when workflow lifecycle permits.
- [ ] Write tests proving pause/cancel races follow Ticket Engine aggregate order and never infer business outcomes.
- [ ] Implement control propagation and reconciliation.
- [ ] Run targeted tests and verify GREEN.
- [ ] Commit with `git commit -m "feat: coordinate mission control boundaries"`.

## Task 7: Production Runtime Host Without Public Cutover

- [ ] Write failing RuntimeHost tests for `start()`, `stop()`, `tick()`, startup `recover()`, expired-claim scanning, active-Goal continuation, Ticket/Agent event pumps, and full Mission reconciliation.
- [ ] Add deterministic test failpoints after each dispatch/resolution persistence step.
- [ ] Gate failpoints behind explicit test/development configuration and expose a deterministic one-shot trigger for browser restart verification.
- [ ] Implement RuntimeHost with configurable timers; tests use manual tick/fake time, production uses background intervals.
- [ ] On recover, enumerate active V2 MissionRecords to register workflow partitions and TeamBinding Agent partitions before pumping events; newly created workflow/Agent aggregates register their own partition before emitting work.
- [ ] Verify service recreation resumes active V2 records and ignores records marked legacy or missing the V2 discriminator.
- [ ] Do not replace MissionControl, Express routes, shared public snapshots, or mounted UI in this plan. Exercise the host through direct integration tests only.
- [ ] Run `npm.cmd run test:run -- tests/server/mission-store.test.ts tests/server/ticket-agent-adapter.test.ts tests/server/mission-process-manager.test.ts tests/server/runtime-host.test.ts tests/server/architecture-boundaries.test.ts`.
- [ ] Run `npm.cmd run typecheck` and `npm.cmd run test:run`.
- [ ] Commit with `git commit -m "feat: compose recoverable runtime host"`.

## Acceptance Criteria

1. New MissionProcessManager and its adapters contain no workflow topology, role successor, phase, keyword, or model-output business judgment; legacy MissionControl is evaluated and deleted only in the final cutover plan.
2. Every cross-engine step survives response loss and process restart.
3. Human private chat can wake only its selected Agent Goal.
4. Ticket Engine facts decide Ticket/Workflow state; Agent Engine facts decide Thread/Goal state.
5. Mission lifecycle is a projection, not a third business state machine.
