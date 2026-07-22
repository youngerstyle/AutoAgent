# Mission Assurance Chain

Date: 2026-07-22

Status: implementation contract

## Problem

The three engines currently preserve scheduling order but do not preserve the
meaning of verification.

- Agent Engine can truthfully finish a review Goal while reporting that the
  reviewed product is not verified.
- Ticket Engine records that the review work finished, but its handoff has no
  standard Mission-criterion verification contract.
- Mission Control accepts a final Agent's arbitrary evidence strings as proof
  that every Mission criterion is satisfied.

This allows a report such as `pass_with_risk` with unverified behavior to be
reinterpreted by a later Agent as full acceptance. The Plan then reaches its
terminal Ticket and the Mission is incorrectly settled. Plan amendment and
multi-stage delivery support cannot help because no durable fact tells the
planner that another iteration is required.

## Engine ownership

### Agent Engine

Agent Engine remains a general Codex-like loop. It owns ordered messages,
turns, tools, and the Agent's proposed conclusion. It does not decide Ticket
routing or Mission completion.

### Ticket Engine

Ticket Engine owns Ticket definitions, the Plan DAG, attempts, dependencies,
and immutable handoffs. It records structured verification handoffs without
interpreting their business meaning.

### Mission Control

Mission Control owns the correspondence between Mission criteria, verification
Tickets, and final settlement. It validates identity, provenance, causal
lineage, coverage, and status. It never evaluates filenames, role names,
natural-language keywords, product features, or domain semantics.

## Assurance contract

Planning Tickets may add ordinary work Tickets and Mission-assurance Tickets.
An assurance Ticket is identified by the engine-level output contract
`mission-assurance-v1` and declares the Mission criterion ids it will verify.
This is a work contract, not a role check: any team member with a matching
assignment may own it.

The completed handoff contains:

```json
{
  "assuranceReport": {
    "baselineVersion": 1,
    "criterionResults": [
      {
        "criterionId": "mission_criterion_...",
        "status": "satisfied",
        "evidence": [{ "kind": "browser", "ref": "..." }],
        "note": "Observed result"
      }
    ]
  }
}
```

The report must cover exactly the criterion ids declared by the Ticket. A
normal completion may contain only `satisfied` results. A failed check is still
a completed Agent investigation, but it must use the existing correction or
Plan-change disposition instead of completing the assurance Ticket. Missing
non-replaceable verification uses the existing human-input tool.

## Plan validation

The PM chooses the number of Tickets, topology, owners, milestones, staged
delivery strategy, and rework strategy. Platform code does not create an
MVP/Alpha/Beta workflow.

Mission Control validates only that every Mission settlement terminal has an
ancestor assurance path covering every criterion in the current baseline.
Therefore a PM may create one verification pass, several milestone reviews, or
multiple parallel verification Tickets, but cannot connect an implementation
directly to Mission settlement without a verifiable baseline-coverage path.

When evidence is missing or a check fails, the responsible Agent decides
whether to request correction, request a Plan change, or request human input.
Those existing mechanisms cause another attempt or append more Tickets to the
same Plan. Ticket Engine does not synthesize the next version.

## Settlement

A settlement proposal must reference completed ancestor assurance Tickets for
each Mission criterion. Mission Control resolves those Ticket ids and accepts
the settlement only when:

1. the Ticket has `settleMission` authority;
2. the baseline version is current;
3. every baseline criterion is reported exactly once;
4. every criterion references at least one completed ancestor assurance
   Ticket;
5. each referenced assurance handoff covers that criterion, uses the current
   baseline version, reports `satisfied`, and contains evidence;
6. the settlement evidence is copied from or traceable to those assurance
   handoffs.

An arbitrary string, a file that merely exists, an implementation self-report,
or an unstructured QA summary cannot settle a Mission.

## Multi-stage delivery

There is still one Mission and one Plan. Milestones are ordinary DAG regions.
Completing a milestone does not settle the Mission. Another iteration happens
when Agents append work or request correction based on structured verification
facts. The platform guarantees continuity and provenance; Agents decide what
work is necessary.

## Acceptance tests

1. A Plan with implementation and settlement but no assurance coverage is
   rejected as a correctable planning proposal.
2. An assurance report containing `not_verified` cannot complete normally.
3. A settlement cannot cite arbitrary evidence strings.
4. A settlement cannot cite an assurance Ticket outside its ancestor lineage.
5. A settlement cannot cite an assurance report for a stale baseline.
6. A failed assurance may return an upstream Ticket; a later successful attempt
   can provide the settlement evidence without mutating completed history.
7. Multiple assurance Tickets may jointly cover the baseline.
8. No validation branch depends on an Agent role, Ticket title, product type,
   filename, or natural-language keyword.
