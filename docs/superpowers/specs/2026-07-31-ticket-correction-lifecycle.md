# Ticket Correction Lifecycle

## Purpose

Ticket correction is an execution concern inside an existing Plan. It is not a
Plan amendment and it does not transfer the reporting Ticket's responsibility
to another role.

The platform must preserve three independent facts:

1. an Agent reported that a completed upstream delivery is defective;
2. a new Ticket must correct that delivery without mutating its historical
   Attempt;
3. the reporting Ticket must run another Attempt after the correction and
   retain its original success criteria, assurance scope and downstream place
   in the DAG.

## Domain transition

For a running Ticket `R` correcting a completed strict ancestor `T`:

```text
T(completed) -> R(running) -> downstream
                    |
                    | request_correction(T)
                    v
T(completed) -> C(ready) -> R(pending) -> downstream
```

`C` is a new Ticket with a new UUID. It derives its executable contract from
`T`: assignment, required capabilities and tools, output contract, delivery
increment, Mission contribution and context policy. It records immutable
correction provenance `{ targetTicketId: T, sourceTicketId: R }`.

`R` keeps the same Ticket UUID and definition. Its current Attempt ends as
`returned`, while the Ticket itself becomes `pending`. When `C` completes,
normal dependency readiness makes `R` ready and Mission Control dispatches a
new Attempt. No special QA, development or product role rule exists.

The Plan's required terminal Tickets and existing downstream dependencies do
not change. A local correction therefore cannot settle the Mission or replace
the full assurance responsibility.

## Plan changes

Only the explicit `request_plan_change` action creates a planner amendment
Ticket. Corrections never emit `PlanAmendmentRequested` and never grant
`amendPlan` authority.

Agents remain responsible for choosing between:

- `request_correction`: an existing upstream contract was not fulfilled;
- `request_plan_change`: scope, requirements, success criteria or DAG structure
  must change;
- `request_human_input`: an irreplaceable external input is missing.

Ticket Engine validates and commits the selected action. It does not infer the
action from natural language, role names, titles or business-specific keywords.

## Invariants

1. Completed Attempts are immutable.
2. A correction always receives a new Ticket UUID.
3. The reporting Ticket keeps its identity and complete verification contract.
4. A correction Ticket must complete before the reporting Ticket can retry.
5. Existing Plan terminals and unaffected parallel branches are unchanged.
6. `request_correction` never creates planner work.
7. `request_plan_change` remains the only execution action that requests Plan
   amendment.
8. Mission Control only dispatches Tickets that become ready; it does not route
   by role or interpret defect content.
