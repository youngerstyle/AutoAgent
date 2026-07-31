# Evidence, Closure, and Agent Correction Design

## 1. Scope

This document fixes three contract defects at the boundaries between Agent Engine,
Ticket Engine, and Mission Control:

1. A tool execution result is currently confused with the business fact observed by
   the tool.
2. A Plan revision is currently required to rebuild Mission assurance for criteria
   that were not affected by the revision.
3. A Host contract rejection can currently become a human-input request or an
   unbounded Agent retry loop.

This is a contract replacement, not a compatibility layer. New Missions use the
new contracts only. Historical event logs remain readable as audit data, but old
active Plans are not silently migrated or resumed through legacy branches.

## 2. Engine Boundaries

### 2.1 Agent Engine

The Agent Engine is a general message-and-tool loop. It owns:

- one ordered thread per Agent and project scope;
- ordered human, model, tool, and Host feedback turns;
- tool execution and immutable evidence capture;
- Goal lifecycle and proposal submission;
- retrying transient provider failures;
- detecting a correction cycle with no semantic progress.

It does not decide which Ticket follows another Ticket, whether a Mission is
complete, or whether a failed observation is good or bad for the product.

### 2.2 Ticket Engine

The Ticket Engine is an immutable DAG and scheduler. It owns:

- Ticket identity, state transitions, dependencies, claims, and handoffs;
- selecting ready Tickets from the current Plan revision;
- preserving completed, returned, failed, and cancelled Tickets as history;
- applying validated append-only Plan changes.

It does not interpret LLM text, infer roles, or invent follow-up work.

### 2.3 Mission Control

Mission Control is the typed adapter between the two engines. It owns:

- compiling a Ticket into an Agent Goal and output contract;
- validating a proposal against the Ticket and Mission contracts;
- committing accepted outcomes to Ticket Engine;
- compiling the effective Mission closure after a Plan change;
- reporting Host contract faults without asking a human to repair platform
  protocol.

It validates structure and authority. Business judgment remains in Agent output.

## 3. Evidence Contract

### 3.1 Problem

The current `EvidenceFact.status` has values `succeeded`, `failed`, and `running`.
Mission Control rejects every fact that is not `succeeded`.

That is incorrect for observation tools. A browser can successfully observe that
a URL is unreachable. The product observation is negative, but evidence capture
is valid. Conversely, a browser process crash produces no trustworthy
observation even if the intended URL would have been valid.

### 3.2 Replacement

Evidence records separate capture integrity from the observed result:

```ts
interface EvidenceFact {
  evidenceId: string;
  agentId: string;
  threadId: string;
  goalId?: string;
  attemptId?: string;
  turnId: string;
  toolCallId: string;
  toolName: string;
  kind: EvidenceKind;
  capture: {
    status: "recorded" | "unavailable";
    error?: {
      category: "tool" | "policy" | "transport" | "timeout";
      message: string;
    };
  };
  observation: {
    status: "observed" | "not_observed";
    result: unknown;
  };
  workspaceRoot: string;
  createdAt: string;
  input: unknown;
  artifact?: EvidenceArtifactFact;
}
```

Rules:

- `capture.status=recorded` means the tool produced an auditable result.
- A command exit code, HTTP status, unreachable URL, failed assertion, or visual
  mismatch can all be recorded observations.
- `capture.status=unavailable` means no trustworthy result was produced because
  the tool, policy, transport, or timeout boundary failed.
- Mission Control accepts only recorded evidence references. It never requires
  the observed business result to be positive.
- The Agent decides whether the recorded observation satisfies a criterion and
  declares that decision in `criterionResults`.
- File freshness validation remains mechanical and applies only to evidence with
  an artifact fingerprint.

Tool adapters, not Mission business logic, map native tool outcomes to this
contract. The mapping is based on the tool protocol: an executed process with a
non-zero exit code is a recorded command observation; failure to start the
process is unavailable evidence.

## 4. Mission Closure Compilation

### 4.1 Mission baseline is immutable

The aligned Mission baseline remains stable for the life of a Mission. A Plan
revision does not redefine it.

### 4.2 Revision impact is explicit

When an assurance Agent reports a correction, its structured result names:

- the upstream Ticket that owns the defective delivery;
- the affected Mission criterion IDs;
- evidence for the observed defect.

Mission Control validates authority and computes a `RevisionImpact`:

```ts
interface RevisionImpact {
  sourceTicketId: TicketId;
  affectedCriterionIds: string[];
  invalidatedAssuranceTicketIds: TicketId[];
  retainedAssuranceTicketIds: TicketId[];
}
```

This is a deterministic projection of accepted Ticket outcomes and correction
links. It is not inferred from role names, natural language, or product-specific
keywords.

### 4.3 Effective closure

Mission Control compiles one effective closure for every Plan revision:

```ts
interface MissionClosure {
  baselineVersion: number;
  criterionSources: Array<{
    criterionId: string;
    executionTicketIds: TicketId[];
    assuranceTicketIds: TicketId[];
    source: "retained" | "new";
  }>;
  terminalTicketIds: TicketId[];
}
```

Rules:

- A completed historical Ticket never re-enters scheduling.
- Unaffected criteria retain their latest accepted execution and assurance
  sources.
- Affected criteria invalidate only the assurance sources named by the correction
  lineage and require new execution plus new assurance.
- A new terminal can settle the Mission using the compiled closure. It does not
  need graph ancestry to every historical Ticket.
- PM supplies business work and dependency changes. It does not manually rebuild
  unchanged assurance chains or copy internal criterion IDs.
- Ticket Engine still validates the append-only DAG. Mission Control separately
  validates that the compiled closure is complete and satisfiable.

## 5. Host Correction Protocol

### 5.1 Correctable is an internal turn

A `correctable` decision means the submitted proposal violates the current typed
contract while the Goal is still valid. The correction is appended to the same
Agent thread and triggers the next turn.

During a Host-correction turn:

- `request_human_input` is not exposed;
- human messages already queued remain ordered and are processed normally;
- the Agent can inspect the exact structured violations and submit a new
  proposal;
- Mission and Ticket state do not change until a proposal is accepted.

Humans are asked only for an external fact, credential, authorization, irreversible
confirmation, manual action, or an explicitly configured tool-policy decision
that the current Goal actually requires. Host schema and closure errors are never
human work.

### 5.2 Semantic progress

The Agent Engine records a correction episode:

```ts
interface CorrectionAttempt {
  violationFingerprint: string;
  proposalFingerprint: string;
  hostStateFingerprint: string;
}
```

Before another model turn, the engine compares the accepted Host state and the
normalized violation set:

- changed Host state or changed violation set: continue;
- same Host state and a previously seen
  `(violationFingerprint, proposalFingerprint)` pair: stop the execution lease
  and raise an `agent_contract_stalled` incident;
- a cycle across multiple proposal shapes with the same Host state and repeated
  violation set is also an incident.

There is no role-specific branch, keyword matching, or fixed retry count.

## 6. Human Input

Human input is an ordinary ordered message in the Agent thread. It does not create
a parallel session and does not bypass the Agent execution queue.

`request_human_input` is a typed Agent action. Its UI buttons are shortcuts that
send normal human messages. The following model turn interprets the answer and
submits the next structured proposal.

## 7. Required Tests

### Contract tests

- a reachable page is recorded evidence;
- an unreachable page observed by a functioning browser is also recorded
  evidence;
- a browser process startup failure is unavailable evidence;
- recorded negative evidence can support `not_satisfied` and a correction;
- unavailable evidence cannot satisfy or refute a criterion.

### Closure tests

- correction of one criterion retains assurance for unaffected criteria;
- the affected criterion requires new execution and new assurance;
- historical completed Tickets remain terminal and are never scheduled again;
- a new terminal settles against the compiled closure;
- a Plan change that cannot produce a complete closure is rejected before Agent
  execution.

### Agent tests

- Host correction triggers the next turn in the same thread;
- `request_human_input` is unavailable during a Host-correction turn;
- repeated semantic correction cycles produce an internal incident without token
  churn;
- a pending human message is processed exactly once and in chronological order.

### Real acceptance

Run a Mission in which QA observes a broken external link:

1. QA records the negative browser observation and reports correction.
2. Ticket Engine returns the affected delivery through immutable history.
3. PM appends a repair execution Ticket and a new assurance Ticket.
4. The new assurance passes while unrelated prior assurance is retained.
5. The terminal Agent settles the Mission.
6. No human input is requested for Host contract repair.

## 8. Removal List

The implementation removes rather than preserves:

- `EvidenceFact.status` as a combined tool/business status;
- rejection of all failed observations in `validateEvidenceFacts`;
- terminal ancestry as the sole Mission coverage source;
- access to `request_human_input` during Host contract correction;
- exact-two-proposal retry detection as the correction-loop guard;
- any legacy resume branch that reconstructs active work from an old Plan shape.
