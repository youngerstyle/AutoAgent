# Read Model and Legacy Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move API/UI projections to the new engine facts, remove old phase/role routing and side-channel context code, and complete production verification.

**Architecture:** Build the UI snapshot from Ticket Engine snapshots/events, Agent Engine Thread/Goal events, and MissionLink projections. Existing old TaskRuns remain read-only data; new runs have no legacy execution fallback. After browser acceptance, delete legacy runtime modules and role-specific prompt/routing tests.

**Tech Stack:** TypeScript, React, Vitest, Vite, Express, browser QA.

---

## File Structure

- Modify `src/shared/types.ts`
  - Replace new-run phase/Assignment/Ticket legacy snapshot fields with engine projections; retain clearly marked read-only legacy types only if needed for old records.
- Modify `src/shared/events.ts` and `src/shared/labels.ts`
  - Add user-facing labels for new explicit engine events/statuses; remove labels that imply phase routing.
- Replace `src/server/storage/state-projector.ts`
  - Projects Workflow/Ticket, AgentThread/Goal, and Mission activity from their actual owners.
- Modify `src/server/routes/tasks.ts`, `src/server/routes/events.ts`, and `src/client/api.ts`
  - Expose new snapshots, original Tickets, grouped runtime events, and Agent chat.
- Modify `src/server/app.ts` and `src/server/mission/mission-control.ts`
  - Atomically mount RuntimeHost and reduce MissionControl to a thin public facade during the cutover gate.
- Modify `src/client/App.tsx`, `src/client/view-model.ts`, `src/client/event-view-model.ts`, `src/client/ticket-inspector.ts`, and `src/client/agent-thread.ts`
  - Render lifecycle/activity separately and bind human-in-loop to the selected Agent.
- Modify `src/client/styles.css`
  - Preserve resizable layout and add unambiguous running/waiting/attention states.
- Delete after cutover:
  - `src/server/mission/phases.ts`
  - `src/server/mission/ticket-graph-contract.ts`
  - `src/server/mission/ticket-runtime.ts`
  - old orchestration body in `src/server/mission/mission-control.ts`
- Replace obsolete tests and update `tests/e2e/mock-loop.test.ts`.

## Task 1: Additive V2 Record and Read Projection

- [ ] Add tests for the runtime discriminator: missing/`legacy_phase@1` records are read-only; only `ticket_agent@2` records may recover or schedule.
- [ ] Add a persisted legacy fixture without a discriminator and prove the public read projector can still render it without importing it into V2 aggregates.
- [ ] Write failing V2 projector tests for lifecycle vs activity, running Agent turn, blocked Goal attention, resolving proposal, stale Goal, Workflow terminal state, and chronological events.
- [ ] Add V2 shared snapshot types alongside the still-mounted legacy public types; do not switch routes or UI yet.
- [ ] Implement a V2 projector from public Engine snapshots/events only; it must never mutate engines or infer successors.
- [ ] Run projector/type tests and the full build; existing mounted app remains functional.
- [ ] Commit with `git commit -m "feat: add versioned engine read projection"`.

## Task 2: Build V2 API and UI Surfaces Without Mounting Them

- [ ] Write service-level API contract tests for start/pause/resume/cancel, selected-Agent message, workflow/Ticket inspection, and loop trace access against RuntimeHost directly.
- [ ] Verify start resolves template/policy/team binding in the product layer and writes `ticket_agent@2` before scheduling.
- [ ] Build V2 route handlers as unmounted router factories and V2 client API/view-model modules as unmounted components.
- [ ] Write client tests proving green means an actual running turn, yellow attention means blocked selected Agent, and idle/waiting are distinct.
- [ ] Write tests proving clicking any Agent opens chronological Codex-like chat outside blocked state; messages render immediately and trigger only that Agent.
- [ ] Add Ticket inspector tests for node keys/IDs, dependencies, revisions, claims, blocked ownership, and command results.
- [ ] Keep runtime records chronological and grouped by Agent/System while preserving global sequence; raw details stay expandable rather than dumped.
- [ ] Run server/client targeted tests, typecheck, build, and existing full tests. Nothing public is switched in this task.
- [ ] Commit with `git commit -m "feat: prepare v2 runtime api and ui"`.

## Task 3: Atomic Public Cutover Gate

- [ ] Add an end-to-end test that constructs RuntimeHost, starts a fresh V2 project through the public route, and renders the V2 snapshot in the mounted App.
- [ ] In one coordinated change: construct/start RuntimeHost in `app.ts`, make MissionControl a thin facade, mount V2 task/event routes, switch shared public snapshot aliases, switch client API/App/view models, and stop creating legacy TaskRuns.
- [ ] Route old/missing-discriminator TaskRuns only to read-only legacy projection; pause/resume/follow-up endpoints must return a clear conflict and never invoke either scheduler.
- [ ] Add API, client, and E2E assertions that the persisted legacy fixture remains visible after the public alias/App switch.
- [ ] Do not retain a runtime fallback from V2 to old MissionControl/TicketRuntime.
- [ ] Run full server/client tests, typecheck, and build before committing this gate.
- [ ] Commit with `git commit -m "refactor: cut public runtime over to v2 engines"`.

## Task 4: Browser Polish and Runtime Inspection

- [ ] Verify resizable columns, stable canvas dimensions, no horizontal overflow, readable event cards, and expandable raw details at desktop/mobile widths.
- [ ] Verify Agent bubbles, immediate pending message state, running/blocked/idle colors, workflow lifecycle badge, and Ticket DAG/revision display.
- [ ] Fix only V2 UI/read projection defects; do not reintroduce legacy fields as data sources.
- [ ] Run client tests and build.
- [ ] Commit with `git commit -m "fix: polish v2 mission observability"`.

## Task 5: Delete Legacy Execution Paths

- [ ] Use `rg` to inventory `MissionPhase`, `nextPhase`, `phaseAfter`, `targetRole`, `human_action`, `boss_acceptance`, `applyHumanActionToTickets`, `TicketRuntime`, and role-based successor logic.
- [ ] Delete legacy runtime files and remove their imports.
- [ ] Remove role-specific prompt rules from ContextAssembler.
- [ ] Delete the legacy ContextAssembler/AgentRuntime execution path only after V2 is mounted; keep only reusable provider/tool/storage primitives with no phase/role workflow rules.
- [ ] Replace obsolete tests with contract tests; do not weaken coverage by simply deleting assertions.
- [ ] Run `npm.cmd run test:run` and `npm.cmd run typecheck`.
- [ ] Run `rg -n "nextPhase|phaseAfter|defaultTransferPhaseForObstacle|applyHumanActionToTickets|role ===.*(qa|boss|pm)|human_action" src/server` and require no new-runtime matches.
- [ ] Commit with `git commit -m "refactor: remove legacy phase and role routing"`.

## Task 6: Production Verification

- [ ] Wire `src/server/index.ts` SIGINT/SIGTERM to `RuntimeHost.stop()` and add a test proving timers do not block process/test shutdown.
- [ ] Run `npm.cmd run test:run` and record exact test counts.
- [ ] Run `npm.cmd run typecheck`.
- [ ] Run `npm.cmd run build`.
- [ ] Start the production server with `npm.cmd start` on an unused local port.
- [ ] Browser-test a fresh project through boss intake, planning, development, QA, human private chat, return/revision, and final acceptance.
- [ ] Restart the server during dispatch and resolving failpoints and verify recovery in the UI.
- [ ] Verify project deletion, provider/profile settings, prompt cache reporting, event expansion, responsive widths, and no horizontal overflow.
- [ ] Perform a final code review focused on hidden routing, trust boundaries, races, and missing tests.
- [ ] Update README/architecture/release notes to match shipped behavior.

## Acceptance Criteria

1. UI states come from the engine that owns each fact.
2. Any Agent can be used as a normal chronological chat/Goal runtime.
3. Human messages never route through PM/global input unless the user explicitly uses the global task control.
4. No old phase, role successor, human keyword, or TicketRuntime path executes for new runs.
5. Fresh browser flow, restart recovery, full tests, typecheck, and production build pass.
6. The local server is running at a verified URL for final user acceptance.
