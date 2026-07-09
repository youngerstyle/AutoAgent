# Agent Thread Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first production slice of the Agent Thread Runtime so selected-Agent chat is a real chronological Agent thread, not a side-channel UI projection.

**Architecture:** Add an append-only `AgentThreadStore` under each workspace Agent and task run. MissionControl writes human private messages, Agent replies, and private-turn failures into that store first, then projects legacy `agentMessages` only for the current UI. SessionStore remains the model-visible projection, LoopTraceStore remains raw audit, and TicketRuntime remains the workflow source of truth.

**Tech Stack:** TypeScript, Node fs storage, Vitest, existing MissionControl/SessionStore/EventLedger.

---

## File Structure

- Create `src/server/storage/agent-thread-store.ts`
  - Owns durable append-only Agent thread events.
  - Provides read/append helpers and a legacy projection to `AgentDirectMessage[]`.
- Modify `src/server/storage/paths.ts`
  - Adds per-Agent thread directory/file paths.
- Modify `src/shared/types.ts`
  - Adds `AgentThreadEvent` and related union fields.
- Modify `src/server/mission/mission-control.ts`
  - Writes direct human messages to AgentThreadStore first.
  - Projects snapshot `agentMessages` from AgentThreadStore.
  - Updates thread events when private Agent turn is handled or failed.
  - Keeps current TicketRuntime behavior unchanged.
- Add/modify tests in `tests/server/agent-thread-store.test.ts` and `tests/server/mission-control.test.ts`
  - Verify thread persistence, chronological projection, selected-Agent isolation, and no PM wake-up from QA/private chat.

## Task 1: Storage Boundary

- [ ] Write failing tests for AgentThreadStore append/read/projection.
- [ ] Run `npm run test:run -- tests/server/agent-thread-store.test.ts` and verify RED.
- [ ] Add path helpers and AgentThreadStore.
- [ ] Run the storage test and verify GREEN.

## Task 2: MissionControl Direct Chat Writes

- [ ] Write failing MissionControl tests:
  - direct message to QA creates a QA thread event;
  - snapshot shows QA chat from thread projection;
  - PM thread/session is not touched;
  - queued direct message wakes the selected Agent only.
- [ ] Run targeted MissionControl tests and verify RED.
- [ ] Change MissionControl direct-message write path to append AgentThreadStore before SessionStore.
- [ ] Run targeted MissionControl tests and verify GREEN.

## Task 3: Agent Turn Results In Thread

- [ ] Write failing tests for handled and failed private Agent turns adding assistant/error events to the same thread.
- [ ] Run targeted tests and verify RED.
- [ ] Update `runAgentDirectMessageTurn` to update AgentThreadStore alongside legacy projection.
- [ ] Run targeted tests and verify GREEN.

## Task 4: UI Projection Stability

- [ ] Verify the existing UI still renders `snapshot.agentMessages`.
- [ ] Keep UI changes minimal in this slice: snapshot projection comes from AgentThreadStore, so the UI automatically reads the new source.
- [ ] If necessary, add a client view-model test for pending/handled/failed direct messages.

## Task 5: Regression

- [ ] Run `npm run test:run -- tests/server/agent-thread-store.test.ts tests/server/mission-control.test.ts tests/server/context-assembler.test.ts tests/client/view-model.test.ts`.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run build`.
- [ ] Review diff for any hidden phase-system or keyword-rule additions.

## Acceptance Criteria

1. Human private message to one Agent is persisted as a chronological Agent thread event for that Agent only.
2. Private Agent turn response/failure is appended to the same Agent thread.
3. Snapshot chat projection is derived from AgentThreadStore, not from `state.context.agentMessages` as the primary source.
4. SessionStore receives model-visible user messages only through the same direct-message path.
5. A private message to QA cannot wake PM unless TicketRuntime later creates a PM ticket.
6. No new keyword/regex rules are introduced for ticket flow.
7. TicketRuntime remains the only workflow state owner.
