# Runtime Contracts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Freeze the public Agent Engine, Ticket Engine, and Mission Control contracts before changing runtime behavior.

**Architecture:** Put engine-neutral protocol types in focused shared modules. Add executable contract assertions and source-level dependency tests so Agent Engine cannot import Ticket/Mission concepts, Ticket Engine cannot import Agent/provider concepts, and Mission Control remains the only adapter.

**Tech Stack:** TypeScript, Vitest, Node fs inspection, existing ESM conventions.

---

## File Structure

- Create `src/shared/contracts/agent-engine.ts`
  - Owns AgentThread, AgentGoal, proposal, decision, control, and event contracts.
- Create `src/shared/contracts/ticket-engine.ts`
  - Owns graph, workflow, ticket, claim/fencing, immutable WorkflowPolicyPort, command, snapshot, and event contracts.
- Create `src/shared/contracts/mission-control.ts`
  - Owns MissionRecord, MissionLink, projection, WorkflowDefinitionRegistryPort, TeamBinding, runtime-record discriminator, and scoped Engine ports only.
- Create `src/shared/contracts/index.ts`
  - Re-exports public protocol types.
- Create `tests/shared/runtime-contracts.test.ts`
  - Exercises canonical proposal/command combinations, key-to-ID separation, and public status sets.
- Create `tests/server/architecture-boundaries.test.ts`
  - Reads source files and fails on forbidden cross-engine imports or role/phase routing in new modules.

## Task 1: Agent Engine Contract

- [ ] Write `tests/shared/runtime-contracts.test.ts` assertions for Goal statuses, chronological Thread items, proposal CAS fields, final decision identity, and pending `retry_later` not being a settlement.
- [ ] Define Agent event reads as agent-aggregate-scoped queries with a cursor whose namespace includes source kind and agentId.
- [ ] Define idempotent `ensureThread({ agentId, scopeId, idempotencyKey })`, `getThreadForAgent(agentId, scopeId)`, and send/start operations so an Agent with no Goal can receive ordinary chat before any Ticket exists.
- [ ] Run `npm.cmd run test:run -- tests/shared/runtime-contracts.test.ts` and verify RED because the contract module does not exist.
- [ ] Create `src/shared/contracts/agent-engine.ts` from sections 6 and 9 of the approved spec.
- [ ] Keep all external references opaque; do not import Ticket, Mission, Assignment, phase, or AgentRole.
- [ ] Run the targeted test and verify GREEN.
- [ ] Commit with `git commit -m "feat: define agent engine contracts"`.

## Task 2: Ticket Engine Contract

- [ ] Extend the contract test with `PlannedTicketGraph`, `TicketGraphSnapshot`, planned/runtime completion policies, ClaimReceipt, blocked ownership, command envelopes/results, and WorkflowStatus.
- [ ] Add a test proving command-side policy uses node keys while snapshot-side policy uses Ticket IDs.
- [ ] Add a test proving `return_to_parent` and `complete_with_graph` require expected workflow versions.
- [ ] Define WorkflowPolicyPort here, because Ticket Engine consumes it; Ticket Engine must not import Mission contracts.
- [ ] Define event reads as aggregate-scoped queries (`workflowId` for Ticket events) with a namespaced cursor, never one ambiguous global cursor.
- [ ] Run the targeted test and verify RED.
- [ ] Create `src/shared/contracts/ticket-engine.ts` without importing Agent/provider/session/tool types.
- [ ] Run the targeted test and verify GREEN.
- [ ] Commit with `git commit -m "feat: define ticket engine contracts"`.

## Task 3: Mission Control Contract

- [ ] Extend the contract test with MissionRecord, staged MissionLink, lifecycle/activity projection, AgentPort, TicketPort, WorkflowDefinitionRegistryPort, and TeamBinding.
- [ ] Assert dispatching links do not require claim or Goal IDs, while running/resolving links do.
- [ ] Add `RuntimeRecordEnvelope` with explicit `engine: "legacy_phase" | "ticket_agent"` and schema version; missing discriminator is read as legacy-only and can never enter the new scheduler.
- [ ] Add start input that carries a resolved WorkflowDefinition, immutable WorkflowPolicyRef/contentHash, and teamBindingId; Mission Process must not synthesize them.
- [ ] Run the targeted test and verify RED.
- [ ] Create `src/shared/contracts/mission-control.ts` and `src/shared/contracts/index.ts`.
- [ ] Run the targeted test and verify GREEN.
- [ ] Commit with `git commit -m "feat: define mission adapter contracts"`.

## Task 4: Architecture Boundary Gate

- [ ] Write `tests/server/architecture-boundaries.test.ts` to inspect only the new engine directories.
- [ ] Assert `src/server/agent-engine/**` cannot import `tickets`, `mission`, legacy `Assignment`, `Ticket`, `MissionPhase`, or `AgentRole` routing helpers.
- [ ] Assert `src/server/tickets/**` cannot import `agents`, `providers`, `context`, `tools`, `SessionStore`, or AgentRole.
- [ ] Assert `src/server/tickets/**` cannot import `shared/contracts/mission-control`.
- [ ] Assert `src/server/mission-process/**` cannot contain `nextPhase`, `phaseAfter`, `role ===`, `boss_acceptance`, `human_action`, or keyword/regex business classification.
- [ ] Run the boundary test and verify it passes with empty/new directories, then keep it active as later plans add files.
- [ ] Commit with `git commit -m "test: enforce runtime architecture boundaries"`.

## Task 5: Contract Gate

- [ ] Run `npm.cmd run test:run -- tests/shared/runtime-contracts.test.ts tests/server/architecture-boundaries.test.ts`.
- [ ] Run `npm.cmd run typecheck`.
- [ ] Run `npm.cmd run test:run` to prove the existing baseline still passes.
- [ ] Review `src/shared/contracts/**` against the approved spec line by line.
- [ ] Confirm no runtime behavior changed in this plan.

## Acceptance Criteria

1. All three public contracts compile independently.
2. Planned node keys and persisted Ticket IDs cannot be confused by types.
3. `retry_later` is not representable as a final Goal settlement.
4. Claim, fencing, proposal, command, decision, and aggregate versions are mandatory.
5. New engine directories have executable dependency-boundary tests.
6. Existing 168-test baseline remains green.

## Five-Plan Dependency Map

| Contract / runtime capability | Produced by | First consumed by |
|---|---|---|
| Agent/Ticket/Mission protocol types | Runtime Contracts | Ticket Engine / Agent Engine |
| Runtime discriminator/schema version | Runtime Contracts | Mission store, final API cutover |
| WorkflowPolicyPort + immutable policy storage | Ticket contract + Ticket Engine | Ticket Engine create/claim/amend |
| WorkflowDefinitionRegistryPort + TeamBinding | Runtime Contracts + Mission Process | Mission start service |
| Ticket durable aggregate/outbox | Ticket Engine | Mission Process event pump / read projection |
| Agent Goal/Thread durable outbox | Agent Engine | Mission Process proposal pump / read projection |
| MissionStore + aggregate-version cursors | Mission Process | Runtime host / read projection |
| RuntimeHost start/stop/tick/recover | Mission Process | Final app cutover |
| V2 API/read/client projection | Read Model Cutover | Atomic facade/API/UI cutover |

Plans 1-4 add and directly test new internals without replacing the public app. Plan 5 is the only public cutover gate; it switches RuntimeHost, facade, API, shared snapshot types, and mounted UI together, then removes legacy execution code.
