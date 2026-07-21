# Mission Baseline and Settlement

Date: 2026-07-21

Status: implementation contract

## Decision

AutoAgent keeps three independent engines:

- Agent Engine owns ordered conversations, turns, tools, and an Agent's conclusion about its assigned Goal.
- Ticket Engine owns one Mission's mutable Plan DAG, Ticket attempts, dependencies, and the execution outcome of that DAG.
- Mission Control owns the durable correspondence between Mission, Ticket, and Agent Goal. It transports authoritative work products and records Mission settlement.

Plan completion and Mission completion are different facts. A Plan can exhaust its current DAG without proving that the Mission objective has been met. The UI must never present Plan exhaustion as Mission acceptance.

## Authoritative Mission baseline

The intake Ticket explicitly declares that its accepted handoff establishes the Mission baseline. Its Agent produces a structured baseline containing:

- the agreed objective;
- measurable success criteria;
- constraints;
- assumptions;
- explicit exclusions.

Mission Control stores that handoff as a versioned `MissionBaseline`. It assigns stable criterion identities but does not summarize, weaken, or reinterpret the content. The original human request remains audit history; the accepted baseline is the authority used by planning and final acceptance.

Every later Ticket receives the current baseline together with the Plan snapshot, current Ticket, and completed ancestor handoffs. Agent private threads remain private.

## Plan evolution

There is one Plan per Mission. PM Agents may append ordinary Tickets and dependency edges to that Plan. A PM may model milestones, staged delivery, investigation, rework, or another planning pass using ordinary Tickets and metadata; the platform has no MVP/Alpha/Beta state machine.

The PM-generated DAG is responsible for continuity. If more work is expected, the DAG must contain or append the Ticket that performs it. Ticket Engine only validates identities, authority, acyclicity, dependency integrity, and terminal references.

Completing a milestone review does not settle the Mission. A completed Ticket is immutable as a historical attempt; correction reopens the affected path as a new attempt under Ticket Engine rules.

## Mission settlement

A Ticket may settle the Mission only when its definition explicitly grants `permissions.settleMission` and its assignee satisfies the team's configured terminal capability policy. This is authority, not a role-name check.

The assigned Agent decides whether the Mission is acceptable. To complete it, the Agent submits a structured `missionResolution` that references the current baseline version and reports every baseline criterion with evidence. Mission Control validates only:

- the Ticket has settlement authority;
- the referenced baseline version is current;
- every baseline criterion is reported exactly once;
- a completion claim marks every criterion satisfied;
- evidence references obey the existing evidence contract.

Mission Control then records the accepted settlement. It does not inspect filenames, keywords, roles, phases, game features, or other business semantics.

If acceptance finds missing work, the Agent uses the normal correction or Plan-change proposal. If a non-replaceable external fact or manual action is required, the Agent uses `request_human_input`. Platform code never converts natural language into those decisions.

## Projection

Runtime and UI status are projections:

- Mission `completed` comes only from a durable accepted Mission settlement.
- Plan `completed` without Mission settlement is shown as awaiting Plan continuation/correction, never as delivered.
- running, blocked, and human-input states come from the owning Ticket, Agent Goal, and Mission dispatch records.

## Acceptance tests

1. A Plan whose terminal Ticket completes without a Mission settlement cannot make the Mission complete.
2. A settlement proposal with a stale baseline version or incomplete criterion coverage is rejected as correctable.
3. A Ticket without `settleMission` authority cannot settle a Mission.
4. A valid authorized settlement records Mission completion exactly once across retries and restarts.
5. Every dispatched Agent receives the same current Mission baseline.
6. QA correction reopens only the affected Ticket path and does not mutate or replace the Mission baseline.
7. A real-provider browser Mission is accepted only after its produced artifact is run and evaluated against the baseline from the user's point of view.
