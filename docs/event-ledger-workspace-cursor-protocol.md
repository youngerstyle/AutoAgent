# EventLedger workspace cursor protocol (delivery-v1)

## 1. Decision summary

`workspaceSequence` is the only ordering key for the new workspace cursor. It is a
persisted, positive integer, unique and strictly increasing within one canonical
workspace root. It is not derived from timestamp, event id, task id, run id, or
file enumeration order.

An event that predates this protocol and has no `workspaceSequence` is permanently
**legacy history**. It is not assigned a synthetic value. In particular, it must
not be mapped to `Number.MAX_SAFE_INTEGER`: that value makes a legacy event appear
after every real cursor and therefore causes it to be replayed after every fresh
cursor. Legacy events are excluded from the new sequence comparison, so a fresh
cursor returned by a new append does not replay them.

The existing event API remains append-only and `readWorkspaceSince(root, id)` keeps
its discovery semantics: an event appended later is returned even when its
`timestamp` and `id` sort before the cursor event. Timestamp/id are display and
identity fields, never cursor ordering fields.

## 2. Durable state and ownership

Under `<workspace>/.autoagent` there are two logical durable records:

* task-run `events.jsonl`: the source of truth for complete event records;
* `event-cursor.json`: a rebuildable high-water record, e.g.
  `{ "next": 42 }`, meaning the next allocatable sequence is 42.

The allocator is scoped by the canonical workspace root (`path.resolve`, with the
same normalization used by all callers). Every append for that root takes the same
workspace-wide exclusive append lease, not a task/run-local lease. The lease may be
implemented with an atomic lock-file/directory creation and owner token, using the
existing service lock's stale-owner/release pattern. A service instance lock alone
is not sufficient for multiple processes, so the workspace lease is part of the
EventLedger storage protocol. A process must never hold a task-local lock while
allocating a workspace sequence without also holding this workspace lease.

While holding the lease, the writer scans persisted events (legacy events
contribute zero), chooses `persisted maximum + 1`, writes the complete event
containing that sequence to its task-run JSONL, and `fsync`s the file. It then
atomically publishes the cursor high-water (`next = sequence + 1`) and `fsync`s
the containing directory where supported. The persisted event files remain the
source of truth; the cursor is a rebuildable high-water projection and is not
trusted to allocate a sequence ahead of durable events.

Cursor writes use a temporary file, `fsync`, and atomic rename (the same durable
replacement shape as the repository JSON storage). The lock is released only after
the event and cursor operations have completed.

## 3. Crash consistency and recovery

The ordering invariant is **event durable before cursor advance**. Therefore a
cursor cannot permanently lead an event.

Recovery on every append and on ledger startup/reconstruction is deterministic:

* Event absent, cursor unchanged: the sequence reservation was not committed;
  the next append may reuse that number. No visible gap is created.
* Complete event durable, cursor old or absent: the event is committed. Recovery
  scans all valid event records, computes the maximum real workspace sequence, and
  atomically repairs `next` to maximum + 1 before allocating another sequence.
* Cursor replacement failed or was torn: the old valid cursor remains authoritative
  enough to start recovery; the scan repairs it. A temporary file is ignored or
  removed after validation.
* Event file has a truncated terminal JSONL record: discard only that terminal
  partial record, durably rewrite the valid prefix, then recover the cursor. A
  corrupt non-terminal record is an integrity error and append fails rather than
  inventing ordering data.
* A process dies while owning the lease: the owner token/heartbeat policy permits
  safe stale-lock removal only when ownership is demonstrably dead. A live owner
  causes retry/blocking, never concurrent allocation.

The append operation should accept an optional caller-provided event identity as an
idempotency key. On retry, while holding the lease, a complete record with that
identity and the same workspace/task-run is returned instead of allocating another
sequence. This is retry protection only; cursor reads never compare or order by the
identity. If the same identity is reused with different immutable event content,
fail with a conflict. A failure before the event reaches durable storage is safe to
retry; a failure after event fsync is resolved by scan/idempotency recovery.

## 4. Cursor read semantics and migration boundary

`readWorkspaceSince(root, afterId)` must implement these rules:

* If `afterId` resolves to a protocol event with sequence `s`, return only events
  having a defined `workspaceSequence > s`, in increasing workspace sequence order.
  Events with no sequence are not candidates and cannot be returned repeatedly.
* A missing sequence is an absence of membership, not a large sequence value. No
  fallback sentinel, including `Number.MAX_SAFE_INTEGER`, is permitted.
* A legacy cursor (the cursor event itself has no sequence) is a migration-edge
  case. Preserve the pre-protocol API behavior for that call using the existing
  deterministic legacy position rule, but do not feed legacy records into the new
  sequence comparison. Once a caller observes a newly appended protocol event and
  uses that id as a cursor, reads use only the new protocol rule.
* An unknown cursor retains the existing behavior of returning the available
  workspace history, subject to the limit. This is an API compatibility choice,
  not a fabricated sequence boundary.
* Results are ordered by `workspaceSequence`; timestamp/id may be used only as a
  deterministic tie-breaker for legacy-only views, never to discover protocol
  events.

This makes the migration one-way without rewriting old event files. If product
later needs old events in a new cursor range, that requires an explicit migration
that assigns real sequences under the workspace lease; it is outside this change.

## 5. API compatibility and boundaries

保持：

* task-run JSONL layout and append-only event records;
* required `taskId` and `taskRunId` validation;
* per-task-run `sequence` for local ordering;
* event bus publication only after the event is durable;
* `readWorkspaceSince` limit behavior and later-write discovery;
* terminal-tail repair behavior.

Changed/explicitly bounded:

* newly appended records always carry `workspaceSequence`;
* workspace cursor ordering no longer treats absent sequence as “after all”;
* cross-process append is serialized by workspace root, not merely by one
  in-memory `EventLedger` instance;
* cursor state is a high-water/rebuildable projection, never the source of truth.

No implementation branch may mention a particular old event id, fresh id, test id,
or event type. The only branches are based on durable record validity, presence of
protocol sequence, lock ownership, and crash-recovery state.

## 6. Direct implementation and QA assertions

Implementation assertions:

1. For every persisted protocol event, `workspaceSequence` is a positive safe
   integer; all sequences in one workspace are unique.
2. The maximum persisted sequence is always `< cursor.next` after recovery.
3. A successful append has its complete JSONL record fsynced before the cursor can
   contain its successor value.
4. Recreating `EventLedger` or restarting the service does not reset the maximum.
5. Concurrent appends from different task/run pairs produce unique sequences and
   every successful event is readable.
6. Failed append/retry does not produce duplicate immutable records or duplicate
   sequences.
7. A post-cursor event with smaller timestamp and id is returned.
8. A legacy event is absent from `readWorkspaceSince(root, freshProtocolEventId)`
   and is not returned on repeated calls with that fresh id.
9. Injected failure after event fsync and before cursor replacement is repaired by
   restart; injected failure before event fsync leaves no committed sequence.
10. No test or production code uses `Number.MAX_SAFE_INTEGER` (or an equivalent
    sentinel) for missing workspace sequence.

Required tests should cover single-process concurrency, two ledger instances (and,
where available, two processes), restart/reconstruction, missing/behind cursor,
legacy/new coexistence, terminal truncation, failure injection at each durable
boundary, idempotent retry, and the timestamp/id inversion regression.

## 7. Implementation note

The implementation deliberately treats the task-run event files as the
authoritative record and reconstructs the maximum persisted workspace sequence
under the workspace lease before each append. This keeps restart and cursor
publication recovery deterministic. `event-cursor.json` is written only after the
event record is durable, using an atomic replacement, and is therefore an
observable high-water projection rather than a source of truth. A future
performance optimization may use the projection as a hint, but it must retain
the same recovery and ordering invariants tested above.
