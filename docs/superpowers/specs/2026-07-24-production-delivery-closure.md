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
2. it belongs to the same Agent Goal and current Attempt;
3. it was produced after the Attempt started;
4. it is inside the current workspace when it references an artifact;
5. it is not failed or still running when cited as successful evidence;
6. artifact facts still match the cited content hash when freshness is
   required;
7. assurance and settlement evidence belongs to the current artifact version.

Agents still decide whether those facts semantically satisfy the criteria.

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

A correction never reopens or mutates a completed Ticket Attempt. The failed
assurance result appends a planner amendment Ticket to the same Plan. The
planner then appends fresh correction and re-verification Tickets and connects
them with ordinary DAG dependencies. Prior Attempts remain immutable evidence
of what was delivered and checked at that point in time.

An accepted increment may create an immutable release snapshot containing its
artifact version, covered Mission criteria, assurance Tickets, and residual
risks. Release snapshots are read models and audit artifacts, not scheduler
states.

## Mission completion

A Mission settlement is accepted only when every baseline criterion cites a
completed ancestor assurance result whose evidence:

- resolves to real Evidence Facts;
- was produced by the relevant current Attempt lineage;
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
2. Evidence from another Goal, Attempt, workspace, or artifact version is
   rejected.
3. A pre-existing file is recorded as reused, not modified.
4. A file changed after Attempt start appears in the change set with a new hash.
5. Browser assurance cannot be represented by a free-form string.
6. A PM may create one or many increments without role or product hardcoding.
7. Completing an intermediate increment cannot settle the Mission.
8. A failed assurance can append correction work and produce a later artifact
   version without mutating completed history.
9. Settlement cannot cite assurance for an older artifact version.
10. The real Tank benchmark verifies the produced game from the user's point
    of view before accepting the platform run.
11. A vague criterion cannot pass with unrelated runtime evidence; every
    baseline verification anchor must have an assurance result.
12. PM planning records an explicit single- or multi-increment decision and
    assigns every execution and assurance Ticket to the declared strategy.
