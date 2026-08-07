# Production Delivery Closure

Date: 2026-07-24

Status: implementation contract

## Problem

The three engines can currently complete a structurally valid Mission while the
actual product remains below the accepted Mission baseline:

- an Agent may cite an arbitrary `{ kind, ref }` string as evidence;
- an existing workspace file may be presented as a current Attempt delivery;
- static tests may be reused as proof for visual or interactive criteria;
- a PM may create one shallow delivery chain when the objective needs several
  independently verified increments;
- final settlement can therefore be causally valid but evidentially weak.

Production readiness means that a Mission cannot be reported as delivered
without current, attributable evidence for the accepted product outcome. It
does not mean that platform code decides whether a game, website, document, or
other domain result is good.

## Engine ownership

### Agent Engine

Agent Engine owns chronological turns, tool calls, tool results, Goals, and
immutable evidence facts produced by those tool results.

An Agent may decide which evidence proves its work, but it can only cite
`evidenceId` values that Agent Engine issued. It cannot manufacture evidence
kind, path, command, browser result, timestamp, or producer identity.

### Ticket Engine

Ticket Engine owns the Plan DAG, Ticket Attempt lifecycle, dependencies,
immutable handoffs, and the workspace baseline associated with each Attempt.

It stores references to accepted evidence facts and the Attempt change set. It
does not interpret product semantics.

### Mission Control

Mission Control transports the Mission baseline, Plan snapshot, Attempt facts,
handoffs, and assurance evidence between the two engines. It validates
identity, authority, lineage, freshness, coverage, and artifact-version
consistency.

It does not inspect role names, filenames, product types, natural-language
keywords, or feature-specific rules.

## Verifiable Mission baseline

A natural-language success criterion alone is not a sufficient acceptance
contract. A criterion such as "the experience should resemble the reference"
can otherwise be incorrectly closed with evidence that merely proves that a
page moves or a button works.

The intake Agent therefore defines each Mission criterion together with
domain-specific verification anchors:

```ts
interface MissionBaselineCriterion {
  criterionId: string;
  text: string;
  verification: {
    anchors: Array<{
      observableOutcome: string;
      evidenceRequirements: string[];
    }>;
  };
}
```

The Agent decides what the observable outcomes and evidence requirements mean
for the Mission. Platform code only validates that every criterion has a
non-empty verification contract and that later Plan and assurance records
trace back to it. It never contains product-specific rules such as required
game mechanics, screens, or roles.

The intake Ticket's own completion criteria and the Mission criteria are
different contracts. Ticket criteria only decide whether the intake Agent
completed the intake work. Mission criteria describe observable properties of
the final product or business outcome. Process statements such as
"documentation is complete", "handoff is ready", or "risks were recorded"
must not be copied into the Mission baseline.

An assurance result reports every verification anchor separately. A criterion
cannot be marked satisfied merely because some unrelated runtime evidence
exists. Every observable outcome must be checked with evidence satisfying its
declared requirements, or the Agent must return a correction, Plan change, or
human-input request.

## Evidence ledger

Every successful or failed tool execution creates an immutable `EvidenceFact`:

```ts
interface EvidenceFact {
  evidenceId: string;
  agentId: string;
  threadId: string;
  goalId?: string;
  turnId: string;
  toolCallId: string;
  toolName: string;
  kind: "file_read" | "file_write" | "command" | "service" | "image" | "browser" | "tool";
  status: "succeeded" | "failed" | "running";
  workspaceRoot: string;
  createdAt: string;
  input: unknown;
  result: unknown;
  artifact?: {
    path: string;
    size: number;
    modifiedAt: string;
    sha256: string;
  };
}
```

The tool result shown to the model includes the generated `evidenceId`.
`goal_resolution` and domain assurance contracts accept only evidence
references of the form `{ evidenceId }`.

Before accepting a Goal proposal, Agent Engine and Mission Control validate:

1. the evidence exists in the ledger;
2. it belongs to the same Agent Goal; an Attempt is an execution segment, not
   an evidence ownership boundary;
3. it was produced during that Goal and remains fresh for the artifact version
   being claimed;
4. it is inside the current workspace when it references an artifact;
5. it is not failed or still running when cited as successful evidence;
6. artifact facts still match the cited content hash when freshness is
   required;
7. assurance and settlement evidence belongs to the current artifact version.

Agents still decide whether those facts semantically satisfy the criteria.

## Local browser evidence provenance

A successful browser command is not sufficient evidence by itself. On a shared
host, the same port may be occupied by another workspace, an earlier Mission,
or an unrelated developer process. Browser evidence for a local application
must therefore be bound to a live service registered by `startService` in the
current workspace.

The generic tool host enforces this infrastructure boundary:

1. `startService` records an immutable `serviceId`, workspace root, declared
   port and process state.
2. Opening `localhost`, `127.0.0.1` or `::1` is allowed only when that port
   belongs to a live registered service in the current workspace.
3. Every successful browser observation records the current page URL and, for
   a local page, the matching `serviceId` and port.
4. A browser session left on an unregistered local address is rejected before
   its next observation can become successful evidence.
5. `file:` pages are allowed only when the target file is inside the current
   workspace.
6. Public HTTP(S) browsing remains available and is not treated as a managed
   workspace service.

This is not product routing and does not decide whether a test passed. It
proves only that a local observation came from the current workspace rather
than another process on the machine.

## Attempt workspace baseline

Ticket Engine captures a deterministic workspace manifest when an Attempt is
claimed. It excludes platform state, dependency caches, VCS internals, build
output, and configured ignore patterns.

At Attempt completion it records:

```ts
interface AttemptChangeSet {
  baselineId: string;
  capturedAt: string;
  completedAt: string;
  added: ArtifactFact[];
  modified: ArtifactFact[];
  deleted: string[];
  reused: ArtifactFact[];
  artifactVersion: string;
}
```

`artifactVersion` is a stable hash of the resulting manifest. Reused files are
allowed, but they are explicitly distinguishable from files changed during the
Attempt. A handoff cannot describe a reused file as a current change.

## Incremental delivery inside one Plan

Planning must challenge its own delivery strategy before appending execution
Tickets. It compares scope, uncertainty, dependencies, and acceptance risk. A
single increment is valid only when the planner can explain why it is reliably
deliverable and verifiable; otherwise it creates multiple independently
verifiable increments connected by ordinary DAG dependencies. This is an Agent
planning judgment recorded in the Plan change, not a product-type branch in
platform code.

The planner also receives the immutable human source request as provenance
alongside the authoritative Mission baseline. It may not use that source to
override recorded clarification or accepted decisions. It must, however, return
an explicit intake correction when the baseline silently omits, narrows, or
weakens an explicit source requirement. Mission Control only validates and
transports that result.

There remains exactly one Mission and one Plan. There is no Release Engine and
no hardcoded MVP/Alpha/Beta workflow.

The PM decides whether the Mission needs one delivery increment or several,
and records that decision explicitly in the Plan result:

```ts
interface DeliveryStrategy {
  mode: "single_increment" | "multi_increment";
  rationale: string;
  increments: DeliveryIncrement[];
}
```

This is a planning decision made by the PM Agent, not a platform heuristic.
The platform validates only internal consistency: every non-terminal work or
assurance Ticket belongs to a declared increment, a multi-increment strategy
contains at least two increments, and DAG dependencies preserve the declared
order.

The strategy is the only source of increment metadata. Ordinary Tickets refer
to it by identifier instead of duplicating its title, sequence, or objective:

```ts
interface TicketDeliveryIncrementRef {
  incrementId: string;
}
```

Mission Control resolves that reference to the strategy definition before
submitting the Plan change to Ticket Engine. This removes a second writable
copy that could disagree only because of wording. The metadata groups and
explains regions of the same Ticket DAG. Dependencies remain ordinary Ticket
edges, including dependencies between increments. `sequence` expresses the
intended delivery order but does not create scheduler edges by itself. Each
increment that claims a product result has an assurance path chosen by the PM.
Completing an intermediate increment does not settle the Mission.

When an assurance Agent identifies a gap, it uses the existing structured
correction, Plan-change, or human-input tools. PM may append another increment
or additional Tickets to the same Plan. Platform code never invents the next
version.

## Output contract ownership

Ticket Engine persists the stable `schemaRef` chosen for each Ticket. It does
not know how an LLM tool is implemented. Before dispatch, Mission Control
compiles that reference together with the current Ticket definition, Mission
baseline, Plan snapshot, and assignment scope into a concrete JSON Schema for
the Agent Goal.

The compiled schema is immutable for that Goal Attempt. In particular, an
assurance Goal accepts only the criterion ids assigned to its Ticket and the
current baseline version. A final acceptance Goal accepts only the current
baseline criteria. A planning Goal receives the current Plan identities and
the schema for an append-only Plan change.

Mission Control compiles independent action contracts instead of one
`anyOf`-shaped outcome:

- `completionOutcomeSchema` is used by `goal_resolution`;
- `correctionOutcomeSchema` enables `report_goal_correction`;
- `planChangeOutcomeSchema` enables `request_goal_plan_change`.

Only actions valid for the current Goal are exposed. A plan-amendment Goal, for
example, cannot recursively request another plan amendment. The schemas are
small and unambiguous, so a model never has to guess whether the same tool call
means completion, correction, or plan maintenance.

Agent Engine treats every supplied schema as opaque data. It implements the
generic Goal actions but contains no branches for PM, QA, acceptance, Mission
schema names, or Ticket transitions. Mission Control validates the resulting
proposal against domain invariants and translates an accepted result into
Ticket and Plan commands. This keeps all three engines independently usable:

- Agent Engine runs a thread, tools, and a Goal contract.
- Ticket Engine owns DAG state and scheduling.
- Mission Control compiles contracts and translates accepted outcomes.

A correction never reopens or mutates an earlier Ticket or Attempt. The
reporting Attempt ends as `returned`, while its Ticket returns to `pending` and
retains its original contract, assurance scope, and downstream position. Ticket
Engine appends one fresh correction Ticket derived mechanically from the
completed target Ticket's executable contract and records the reporting and
target Ticket ids as provenance. It adds ordinary DAG edges from the completed
target to the correction and from the correction to the reporting Ticket.

After the correction completes, the same reporting Ticket receives a new
Attempt. Its earlier Attempt remains immutable evidence of what was checked at
that point in time. Required terminal references do not change, unaffected
branches are not replayed, and no planner-amendment Ticket is created. Ticket
Engine performs only this graph operation; it does not infer a role, phase,
defect category, or business decision from prose.

If the reporting Agent concludes that scope, dependencies, required terminals,
or the Plan structure must change, it uses the separate Plan-change action.
That explicit action may create a planner-amendment Ticket and may use
`failureResolution` relations for immutable unsuccessful Tickets. Ordinary
correction and Plan maintenance are different domain operations.

`failed` and `returned` Attempts are intentionally different. `failed` is an explicit,
immutable statement that the entrusted Ticket itself could not be completed.
With `fail_fast` it terminates the Plan. With `require_resolution` it blocks the
Plan and appends a planner-amendment Ticket whose provenance is the failed
Ticket; PM, not platform code, decides whether to replace work, change scope, or
terminate through the resulting Plan change. `returned` is produced when a
reporting Attempt requests correction and therefore cannot yet settle its own
Ticket. Mission Control never converts one into the other by inspecting role
names or natural-language reasons.

When a genuine Plan change affects several delivery increments in a shared
workspace, the planning Agent selects the replacement graph; platform code does
not infer it from roles or prose. The first affected increment must produce a
new independent assurance result before work on the next affected
increment becomes ready. This preserves ordinary DAG scheduling without
reviving history or allowing verification to race with later writes to the
same artifact.

An accepted increment may create an immutable release snapshot containing its
artifact version, covered Mission criteria, assurance Tickets, and residual
risks. Release snapshots are read models and audit artifacts, not scheduler
states.

## Mission completion

A Mission settlement is accepted only when every baseline criterion cites a
completed ancestor assurance result whose evidence:

- resolves to real Evidence Facts;
- was produced by the relevant Agent Goal and remains fresh for the settled
  artifact version; retry Attempts may reuse those facts without replaying the
  underlying tools;
- refers to the current artifact version;
- has status `succeeded`;
- separately covers every verification anchor declared by that criterion;
- is copied without reinterpretation into the settlement proposal.

The settlement Agent makes the final product judgment. Mission Control proves
that the judgment is based on current attributable facts.

## Production acceptance

The platform is not production-ready until a real-provider acceptance suite:

1. submits representative user objectives through the public UI/API;
2. waits through the full Agent, Ticket, and Mission lifecycle;
3. launches and operates produced applications with a real browser;
4. inspects visual output, console errors, interaction behavior, files, and
   release artifacts;
5. independently scores the final product against the accepted Mission
   baseline;
6. repeats stochastic runs and records success rate, false-completion rate,
   time, token usage, retries, and recovery behavior.

The Tank objective remains a permanent regression benchmark. Engine tests are
necessary, but a run that produces a completed Mission and a poor or
non-runnable game is a failed platform test.

## Required tests

1. An Agent cannot cite an evidence id that was not generated by a tool.
2. Evidence from another Goal, workspace, or artifact version is rejected;
   evidence from an earlier Attempt of the same Goal remains valid while fresh.
3. A pre-existing file is recorded as reused, not modified.
4. A file changed after Attempt start appears in the change set with a new hash.
5. Browser assurance cannot be represented by a free-form string.
6. A PM may create one or many increments without role or product hardcoding.
7. Completing an intermediate increment cannot settle the Mission.
8. An assurance that finds a product failure can explicitly request correction,
   append correction work and produce a later artifact version without mutating
   completed history; a Ticket that resolves itself as `failed` terminates the
   Plan instead of silently inventing that correction.
9. Settlement cannot cite assurance for an older artifact version.
10. The real Tank benchmark verifies the produced game from the user's point
    of view before accepting the platform run.
11. A vague criterion cannot pass with unrelated runtime evidence; every
    baseline verification anchor must have an assurance result.
12. PM planning records an explicit single- or multi-increment decision and
    assigns every execution and assurance Ticket to the declared strategy.
13. Browser evidence from another workspace's local service is rejected.
14. Local browser evidence records the current workspace service identity.
15. A browser `file:` target outside the workspace is rejected.
16. A local service started by another Goal or Ticket Attempt cannot be polled
    or cited as browser evidence, even inside the same workspace.
17. Agent Engine contains no Mission-specific output-schema branch.
18. An assurance Goal schema rejects criterion ids outside that Ticket's
    declared assurance scope and a stale baseline version.
19. A Goal Attempt keeps the concrete output schema that was compiled when it
    was dispatched.
20. Completion, correction, and plan-change actions use separate tool schemas;
    a completion schema contains no top-level `anyOf` for workflow decisions.
21. Deleting a workspace stops and unregisters its Runtime Host before removing
    workspace state, so no scheduler can tick a deleted Mission.
22. A correction appends one fresh Ticket derived from the target contract,
    leaves completed history untouched, and retries the same reporting Ticket
    in a new Attempt only after that correction completes.
23. A correction preserves required terminals and unaffected branches; it does
    not create a planner-amendment Ticket or invent a new assurance endpoint.
24. A Plan change remains explicit and separate. Only that action may alter
    scope, dependencies, required terminals, or delivery-increment structure.
25. A stale browser daemon or local tool transport timeout is recovered inside
    the current Agent Goal. It cannot be submitted as an assurance conclusion,
    converted into a product correction, or used to amend the Plan.
26. Browser commands have bounded execution time. Safe observational commands
    may be replayed once in a fresh session; side-effecting commands require the
    Agent to observe the recovered state before deciding what to do next.
27. Settled and cancelled Goals leave no browser sessions, managed services or
    command processes behind. A repeated real-provider acceptance run must end
    with the same resource count with which it started.
28. Every assurance anchor records its judgment basis, concrete observations,
    deviations and evidence. A `satisfied` anchor cannot retain deviations.
29. Comparative criteria require a traceable external comparison basis. In its
    absence the assurance remains `not_verified`; category resemblance or an
    implementation claim is not sufficient.
30. Final acceptance copies assurance basis, observations, deviations and
    evidence unchanged. It cannot rewrite a weaker QA observation into a
    stronger Mission conclusion.

## Evidence-bound assurance

Mission assurance is not a boolean pass gate. Each verification anchor keeps
four separate facts:

- `verificationBasis`: the exact requirement, standard, sample or external
  reference used for the judgment;
- `observations`: facts actually observed through tools or an explicit human
  boundary;
- `deviations`: every observed difference from the authoritative baseline;
- `evidence`: attributable artifacts and tool results supporting those facts.

Agents interpret the domain meaning. Mission Control validates structure,
provenance and exact transfer into settlement. No product-specific keyword,
role name or acceptance decision is encoded in platform routing.

When a criterion depends on an external referent, the PM-owned Plan must acquire
and hand off that reference before implementation and assurance. If it cannot,
the criterion remains visibly unverified instead of being weakened.
