# AutoAgent Production Engine Baseline

Date: 2026-07-21

Status: implementation baseline

## Product invariant

AutoAgent is three cooperating systems. None may impersonate another:

- Agent Engine owns an Agent's ordered thread, turns, goals, model calls and tools.
- Ticket Engine owns the Mission Plan, Ticket DAG, attempts, dependencies and terminal state.
- Mission Control durably delivers ready Tickets to Agents and settles Agent proposals into Ticket commands.

The UI and Runtime Task state are rebuildable projections. They never decide routing or completion.

## Authoritative state

| Fact | Sole owner |
| --- | --- |
| What an Agent has seen and said | Agent rollout |
| Whether an Agent turn is queued, running or finished | Agent rollout turn records |
| Whether work is ready, running, blocked, returned or complete | Ticket Engine |
| Whether the current Plan DAG is complete | Ticket Engine completion policy |
| Whether the Mission is accepted | Mission Control settlement against the Mission baseline |
| Delivery and settlement progress between the two engines | Mission Control process record |
| Task status, phase, avatar state and conversation badge | projection only |

There must be no writable `Task.status`, `phase` or avatar status that can contradict the owners above.

## Agent turn scheduling

1. Every trigger is first appended to the Agent rollout with a stable message/event id and turn id.
2. The unconsumed turn record in the append-only rollout is the durable queue entry; there is no second message queue.
3. One Agent thread executes at most one turn at a time. In-process promises provide mutual exclusion, while restart recovery scans the rollout for the earliest unconsumed turn.
4. Messages arriving during a turn remain queued for the next turn; they are never injected into the in-flight request and never start a second session.
5. A process restart reconstructs pending work from the rollout. In-memory promises are only an optimization.
6. Provider failures finish the current turn attempt with a visible operational outcome. They do not complete, fail or pause a Ticket or Plan by themselves.
7. Safety controls stop only the current turn attempt. They are configurable budgets and must expose the exact reason and continuation action.

## Ticket and Mission settlement

1. Ticket Engine emits `TicketReady`; Mission Control creates one idempotent dispatch process.
2. Mission Control claims the Ticket, starts one Agent Goal and records their mapping.
3. The Agent submits one structured proposal through `goal_resolution` or `request_human_input`.
4. Mission Control validates the proposal contract and applies one idempotent Ticket command.
5. Mission Control settles the same Agent proposal and marks the dispatch process settled.
6. A crash between steps resumes the same process from durable ids. It never asks the model to repeat completed work.
7. Mission Control does not infer routing from role names, keywords, natural language or phases.

## Completion and evidence

Agent completion is a claim about its own Ticket, not about the whole Mission.

- `completed` must address every Ticket success criterion.
- Every `satisfied` criterion must contain at least one evidence reference unless the Ticket contract explicitly marks it as cognitive-only.
- File evidence is resolved inside the workspace and recorded with size, modification time and content hash.
- Command evidence records command, working directory, exit code and bounded output.
- Browser/manual evidence records the tested URL or artifact and the observations.
- Platform validation proves evidence exists and is attributable. It does not invent semantic conclusions.
- QA independently determines pass, correction, plan change or required human input.
- Completing required terminal Tickets completes the current Plan DAG, not the Mission by itself.
- A Mission is complete only after an authorized Agent submits an accepted settlement covering every criterion in the current Mission baseline.

## Projection rules

Task state is derived in this order:

1. Durable Mission settlement, cancellation, or failure.
2. Plan terminal state that still requires Mission continuation or settlement.
3. Plan paused.
4. Blocked Ticket or blocked Agent Goal requiring human input.
5. Claimed Agent run or running Ticket.
6. Ready Ticket waiting for dispatch.
7. Idle.

An Agent avatar is green only while its turn is actually executing. It is yellow only when that Agent owns a blocked Ticket or a failed/paused turn requiring an explicit operator action.

## Release gates

A release is not production-ready until all gates pass:

1. Contract suite: engine ownership and invalid cross-layer transitions.
2. Recovery suite: crash injection after every dispatch and settlement write.
3. Concurrency suite: duplicate ticks, duplicate messages and simultaneous human messages produce one ordered turn sequence.
4. Real-provider canary: at least three different goals in disposable workspaces.
5. Artifact acceptance: inspect and execute produced files; browser products are exercised with Playwright at desktop and mobile sizes.
6. Human-loop acceptance: a real free-form human reply triggers exactly one next turn on the selected Agent.
7. Rework acceptance: QA correction reopens only the required path and produces a new attempt.
8. Operational acceptance: provider failure, restart and resume do not duplicate model calls or lose queued input.
9. Cost acceptance: per-Mission token/cost budget, warning and operator-visible stop reason.
10. Soak acceptance: repeated Missions run for hours without increasing pending queues, stale claims or memory use.

Mock-provider tests prove deterministic contracts only. They never count as artifact or product acceptance.
