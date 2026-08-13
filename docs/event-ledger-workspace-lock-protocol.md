# EventLedger workspace append lock protocol (delivery-v1)

## 1. Scope and current fact

This protocol is for the private lock used by `EventLedger.append` at
`<workspace>/.autoagent/event-append.lock`. The public `EventLedger` API, JSONL
layout, and cursor semantics do not change. The implementation uses `open(lock, "wx")` and publishes a versioned owner
record in place. Contenders use a bounded wall-clock deadline; stale same-host
owners are eligible only after a PID-death proof and an atomic quarantine claim.
This protocol replaces unsafe recovery decisions, not the ledger contract.

The canonical root is `path.resolve(workspaceRoot)`. No test ID, event ID, event
type, platform business branch, or timestamp ordering participates in lock
recovery.

## 2. Owner record and publication state

Use a versioned JSON owner record (UTF-8, one complete line is preferred):

```json
{
  "version": 1,
  "token": "opaque UUID",
  "pid": 1234,
  "hostname": "machine-name",
  "createdAt": "2026-08-12T00:00:00.000Z",
  "heartbeatAt": "2026-08-12T00:00:00.000Z",
  "leaseUntil": "2026-08-12T00:00:30.000Z",
  "state": "ready"
}
```

Required validation: `version === 1`, non-empty token/hostname, safe positive
integer pid, parseable UTC timestamps, `leaseUntil >= heartbeatAt`, and
`state === "ready"`. `token` is the ownership identity; it is never inferred
from PID or event data. `createdAt` is diagnostic; `heartbeatAt` and `leaseUntil`
are recovery inputs.

Publication is a two-phase observable state:

1. Create the lock exclusively (`wx`) with an empty file or incomplete bytes.
   This establishes exclusion but is **publishing**, not a valid lease.
2. Write the complete record to that already-owned file, `sync()` it, close it,
   then reread and validate the exact token. Only then is the owner `ready`.

A contender that sees an empty, truncated, invalid, or incomplete record must
not assume that the writer died. It waits within the bounded acquisition
window. If the record remains unparseable after the publication grace period,
only a same-host process-death proof permits cleanup; otherwise acquisition
fails conservatively.

A stronger implementation may publish to a private temporary file, sync it,
and atomically rename it into place after exclusive creation. If using the
existing path-in-place publication, the ready reread is mandatory. The format
and strategy are internal and reversible; readers must support both during
rollout.

## 3. Parameters and bounded acquisition

Recommended defaults (central constants, injectable for deterministic tests):

* `LEASE_MS = 30_000`;
* heartbeat/revalidation interval `HEARTBEAT_MS = 5_000` (owner refreshes
  `heartbeatAt` and `leaseUntil` while a long append is active);
* publication grace `PUBLISH_GRACE_MS = 250`;
* retry delay starts at 10 ms, capped at 100 ms, with jitter;
* `ACQUIRE_TIMEOUT_MS = 5_000` total wall-clock time;
* one final compare-and-remove attempt, never an unbounded loop.

The timeout is measured from the first acquisition attempt and includes stale
inspection. On expiry return a typed/internal diagnostic error (for example
`WorkspaceLockTimeoutError`) containing lock path, reason (`ready-owner`,
`publishing`, `malformed`, `foreign-host`, `lease-expired-but-alive`, or
`raced`), owner summary when parseable, elapsed time, and attempt count. The
public append API may expose the existing rejected `Error` shape; its message
must retain this diagnostic context and must not silently convert a live-owner
case into success.

The owner heartbeat is not used to prove process liveness; it only prevents a
healthy long operation from appearing lease-expired. A lease expiry is a stale
hint, never permission by itself to delete a same-host lock.

## 4. State machine and recovery actions

### Empty/truncated/invalid JSON

Classify as `publishing` during the first `PUBLISH_GRACE_MS`; retry. After the
grace, attempt a same-host death check only if a PID can be parsed from a
self-consistent partial record. If PID is absent, malformed, or host is not
provably local, do not delete: continue only until `ACQUIRE_TIMEOUT_MS`, then
return `WorkspaceLockTimeoutError` with `malformed-owner` and remediation.
A malformed lock is never deleted merely because its lease text is old.

### Valid ready owner on this host

`process.kill(pid, 0)` means alive when it succeeds or returns `EPERM`; treat
`ESRCH` as dead. If PID is invalid or the probe has an unexpected error, fail
conservatively. An alive owner blocks acquisition until timeout, regardless of
lease expiry. A dead owner is eligible for one guarded removal.

### Valid ready owner on another host

Do not call local PID probing. The owner is unverifiable; its lease may be
considered expired only as an operator-visible diagnostic. Never auto-delete a
foreign-host lock. Wait up to the acquisition deadline, then return a typed
`foreign-owner` timeout.

### Lease expired

For same-host owners, first perform the liveness check. Alive wins over expiry
and remains protected. Dead plus expired is removable. Dead but unexpired is
also removable only because process death is proven; lease expiry is not needed
when death is reliable. If death cannot be proven, fail conservatively.

### Process dies at the publication boundary

A crash after `wx` but before metadata is complete leaves an empty/truncated
lock. A crash after metadata sync but before the ready reread leaves a valid
record that is treated normally. Recovery waits the grace period, proves same-
host
PID death if possible, then uses guarded removal; otherwise it returns the
bounded diagnostic failure. No event or cursor is touched by lock recovery.

## 5. Safe cleanup and competition protection

Never implement `read -> rm` alone. `removeStaleLock(expected)` must:

1. open the lock with read access and capture exact bytes plus identity metadata
   (`token`, and where available inode/dev, size, mtime);
2. re-read the file and verify bytes/token/identity are unchanged;
3. re-probe the owner immediately (same-host only);
4. remove only with an OS operation that cannot remove a replacement lock (best:
   rename the unchanged lock to a unique quarantine name using no-overwrite
   semantics, then unlink the quarantine; acceptable fallback: open-handle
   platform-specific identity check plus unlink, followed by a final ownership
   check);
5. if any check races or returns `ENOENT`, abandon cleanup and retry acquisition
   within the deadline.

The preferred portable design is an atomic lock directory: `event-append.lock/`
created with `mkdir`, with `owner.json` published atomically inside. Cleanup
renames the unchanged directory to a unique quarantine name in the same parent;
creation of a replacement lock then cannot be deleted by the cleaner. During
migration, support the current regular file and the directory format separately;
do not delete a regular file based on directory assumptions.

After cleanup, immediately retry exclusive acquisition. If another contender
wins, the loser observes its owner and follows the state machine. Release also
verifies token (and format) before removing; `ENOENT` is success, a changed token
is a no-op, and malformed replacement is never removed by the old owner.

## 6. Old-lock compatibility

Legacy records are accepted only as a compatibility state: `{token,pid,hostname}`
(or the existing empty/partial file). A complete legacy record gets the same
same-host PID safety rule, but has no lease/heartbeat; it is never removed on
lease age. A live legacy owner blocks until timeout; a dead same-host legacy
owner can be guarded-cleaned and replaced by a v1 record. Foreign or ambiguous
legacy locks fail conservatively. Empty legacy files use the publication grace
and bounded timeout rules. New writers always publish v1 metadata. Do not
silently rewrite a live legacy lock.

## 7. EventLedger invariants that must not change

Lock acquisition surrounds the existing append critical section only:

1. scan all task-run `events.jsonl` files under the canonical root;
2. validate/recover only a truncated terminal JSONL record; a corrupt
   non-terminal record is an integrity error and append rejects;
3. detect requested event identity and return the existing immutable event, or
   reject an identity/content conflict (idempotent retry);
4. allocate unique positive `workspaceSequence = persisted max + 1` while locked;
5. append the complete event and `fsync` it first;
6. atomically replace `event-cursor.json` with `next = sequence + 1`, then publish
   the event bus notification;
7. release the lock.

The cursor is a rebuildable high-water projection, never the source of truth.
A cursor failure after event durability must reject that call but a retry must
scan and return the durable idempotent event. A failure before event fsync must
not expose an event. Existing legacy events remain without a protocol sequence;
they are excluded after a fresh protocol cursor, while unknown/legacy cursor
reads retain the existing bounded `limit` behavior. `limit <= 0` returns `[]`,
and finite positive limits are applied after the specified discovery ordering.
No lock fix may change task-run `sequence`, later-write discovery independent of
 timestamp/id, API validation, or event-bus-after-durable ordering.

## 8. Observability and implementation handoff

The current implementation exposes diagnostic error text containing
`lockPath`, owner PID/host when parseable, elapsed time, attempts, and a stable
`workspace_lock_timeout` prefix. It does not yet emit structured telemetry or
separate error subclasses; callers must treat the reason text as diagnostic,
not as a recovery signal. Future telemetry may add (without payload secrets):
`state`, `formatVersion`, `tokenHash`, `leaseUntil`, `cleanupOutcome`, and
`finalReason`. Stable error-code expansion remains follow-up work.

Required tests for the implementation ticket:

* empty, truncated, illegal JSON, incomplete owner and legacy lock;
* same-host dead PID recovery; same-host live PID protection;
* expired lease with live owner (must not delete) and dead owner;
* foreign host; bounded timeout assertion;
* crash/fault injection before metadata completion and after metadata sync;
* two ledger instances/processes racing cleanup and acquisition;
* token-checked release after lock replacement;
* all existing workspace sequence, durable-before-cursor, legacy migration,
  idempotent retry, timestamp/id inversion, terminal-tail and limit tests.

Acceptance requires actual exit codes for targeted tests, full `test:run`,
`typecheck`, and `build`; this architecture ticket does not claim those
commands passed. No Git commit is part of this delivery.
