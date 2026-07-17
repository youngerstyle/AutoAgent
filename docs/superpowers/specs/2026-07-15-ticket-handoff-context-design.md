# Ticket Handoff Context Design

## Problem

AutoAgent currently keeps each Agent in an independent Thread, but the handoff between dependent Tickets is only an ad hoc JSON fragment containing `result` and `evidence`. The next owner does not receive a stable mission brief or a well-defined delivery envelope, so it can lose the reason, decisions, artifacts, verification state, and unresolved risks behind the upstream work.

Sharing Agent Sessions is not the solution. A Session is one Agent's private chronological work history. Cross-Agent collaboration must use durable Ticket data.

## Boundaries

- Agent Engine owns one Agent's Thread, turns, tool calls, compaction, and goal proposal.
- Ticket Engine owns immutable Ticket definitions, status, dependencies, authority, and the accepted completion handoff.
- Mission Control owns dispatch. It turns Ticket and Mission facts into a chronological message in the assigned Agent's Thread.
- Platform code validates protocol facts only. It does not decide whether a game, feature, design, or test is semantically complete.

## Canonical Handoff

Every accepted `complete` command persists exactly one `TicketHandoff`:

```ts
interface TicketHandoff {
  schemaVersion: 1;
  summary: string;
  output: unknown;
  evidence: TicketEvidenceRef[];
}
```

`summary` is the Agent's final result-oriented explanation. `output` is the domain result required by the Ticket output contract. `evidence` contains stable references to files, commands, reports, or other inspectable facts.

The Ticket Engine does not interpret these fields. It only validates their structure and stores them with completion authority and timestamps.

## Downstream Context

When a Ticket becomes ready and is assigned, Mission Control appends one assignment message to the target Agent Thread. The message contains:

1. Mission objective.
2. Current Ticket identity, objective, success criteria, and output contract.
3. One immutable handoff envelope for every completed ancestor Ticket in the
   current Ticket's DAG lineage, ordered topologically from the earliest input
   to the direct dependencies.
4. Correction targets and Plan facts only when the current Ticket contract requires them.

An upstream envelope includes source Ticket identity and definition plus its accepted `TicketHandoff`. It never contains the upstream Agent's Session, hidden reasoning, raw tool trace, or assembled prompt.

The lineage is derived only from persisted DAG edges. Mission Control does not
guess relevance from role names, Ticket titles, schema names, natural language,
or artifact contents. Diamond-shaped graphs are de-duplicated by Ticket ID.
Every ancestor appears before its descendants, while graph declaration order is
used as a deterministic tie-breaker for parallel branches.

This is deliberately different from copying only direct parents. A dependency
edge controls scheduling, but a multi-step handoff also forms an information
lineage. Passing only the last person's summary turns collaboration into a game
of telephone: a scope baseline can disappear after architecture, leaving QA to
judge only a developer's self-description. Passing the accepted ancestor
handoffs preserves the project record while keeping every Agent Session private.

Mission Control must not summarize, reinterpret, merge, rank, or approve these
handoffs. The assigned Agent receives the durable facts and uses its LLM to
decide whether its own Goal is complete, blocked, failed, needs correction, or
requires a Plan change.

The target Agent's own Thread history remains in chronological order and is assembled normally by Agent Engine.

## Flow

1. An Agent executes its Ticket inside its own Thread.
2. The Agent submits a goal proposal with status, summary, domain output, and evidence.
3. Mission Control converts an accepted completion proposal into a Ticket `complete` command carrying `TicketHandoff`.
4. Ticket Engine persists the handoff and unlocks graph dependants.
5. Mission Control dispatches the next ready Ticket and appends the mission,
   current Ticket, and ordered ancestor handoff lineage to that Agent's Thread.
6. The next Agent uses its LLM to continue, block, request correction, request a Plan change, or complete its own Ticket.

No role names or fixed phase sequence participate in this mechanism. The Plan DAG determines which handoffs are relevant.

## Recovery And Idempotency

- A handoff is written by the same idempotent Ticket command that completes the Ticket.
- Replaying the command returns the existing result and cannot create a second handoff.
- Assignment messages use the existing deterministic dispatch message ID, so recovery cannot append duplicates.
- Mission objective is persisted in the Mission record and survives Runtime Host restart.
- Mission and Ticket aggregate schema versions advance with the new durable shapes. Older projects remain read-only and are never scheduled through the new contract.

## Verification

- Contract test: a complete command requires and stores one canonical handoff.
- Ticket Engine test: completed handoff remains immutable and unlocks the dependant Ticket.
- Mission Process test: the downstream Agent receives the immutable Mission
  objective, current Ticket context, and every completed ancestor handoff in
  deterministic topological order.
- Lineage test: a three-step chain preserves the first Ticket's accepted scope
  for the final Agent.
- Diamond test: parallel ancestors are ordered deterministically and a shared
  ancestor is included exactly once.
- Isolation test: the downstream message contains no upstream Thread history or tool trace.
- Recovery test: replay does not duplicate the handoff or assignment message.
