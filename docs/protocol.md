# The syncline protocol, version 1

This document is complete enough to implement a syncline client without
reading the reference implementation. Where behavior is undefined or
deliberately unsupported, it says so.

Normative words: **MUST**, **MUST NOT**, **SHOULD**, **MAY**.

## 1. Model

A **workspace** is the unit of replication, permission, and ordering. Each
workspace has:

- an append-only **op log**, where every op gets a **`seq`** — a per-workspace
  integer starting at 1, assigned at append, strictly increasing, with no
  gaps. `seq` is the workspace's total order and the only ordering that
  exists. Ordering *between* workspaces is undefined.
- **rows**, addressed by `(table, rowId)`, each field carrying the `seq` of
  the op that last wrote it.
- **memberships**, which are ordinary rows in the `memberships` table. This
  matters: entitlement is data, it replicates like data, and the server
  reacts to changes in it inside the sync path.

A **client** is one device for one user, identified by a `clientId` it mints
once and persists. A `clientId` belongs to exactly one user; a server **MUST**
reject a hello whose `clientId` is already bound to a different user.

## 2. Transport

One WebSocket per subscribed workspace, at `/ws/{workspaceId}`. Frames are
JSON text, each an object with a `t` discriminator. A frame that does not
parse, or does not match a shape below, **MUST** be answered with
`error{code:"BAD_FRAME"}` followed by a close.

Two HTTP endpoints support the socket:

| Method | Path | Body / auth | Returns |
|---|---|---|---|
| POST | `/auth/login` | `{userId}` | `{token, user}` — a demo affordance; a real deployment substitutes its own identity provider |
| GET | `/directory` | `Authorization: Bearer <token>` | `{workspaces:[{workspaceId,name}]}` for the token's subject |

The token proves **identity only**. It carries no permissions and is never
consulted for authorization (§5).

## 3. Op vocabulary

```
create  {kind:"create", table, rowId, fields:{name: value, …}}
update  {kind:"update", table, rowId, field, value}
delete  {kind:"delete", table, rowId}
```

Values are JSON scalars: string, number, boolean, or null. One field per
update op — this is what makes per-field LWW (§6) exact.

**Op identity** is `(clientId, opId)`. `opId` is an integer that **MUST** be
gapless and increasing per `(clientId, workspaceId)`, starting at 1. Identity
is preserved across schema migration (§7) and is never reused for different
content — except by the epoch reset in §4, which renumbers on both sides at
once.

## 4. Session lifecycle

### 4.1 Cursor and epoch

A client's position is `{seq, epoch}`.

- `seq` is how far it has consumed the workspace log.
- `epoch` is a per-`(user, workspace)` counter the server increments whenever
  that principal's **visible slice definition** changes: invite, role change,
  or revoke. It is principal-scoped — shared across a user's devices, never
  per-device.

### 4.2 Handshake

Client sends:

```
hello {token, clientId, schemaVersion, cursor?}
```

The server resolves the token to a `userId`, then:

- Not a member, and previously revoked → `forget` (§5.3), then
  `error{code:"REVOKED"}`, then close. **No data frame is ever sent.**
- Not a member, never revoked → `error{code:"AUTH_FAILED"}`, close.
- `clientId` bound to another user → `error{code:"AUTH_FAILED"}`, close.
- `schemaVersion` greater than the server's → `error{code:"VERSION_TOO_NEW"}`,
  close.
- `cursor.epoch` greater than the stored epoch, or `cursor.seq` beyond the log
  head → `error{code:"BAD_CURSOR"}`, close.

Otherwise the server replies:

```
helloAck {serverSchemaVersion, minWritableVersion, mode, epoch, presence}
```

`mode` is `"incremental"` when the client presented a cursor whose `epoch`
equals the current epoch, and `"snapshot"` otherwise.

### 4.3 Snapshot mode

```
snapshot {epoch, atSeq, rows:[{table, rowId, fields:{name:{v, seq}}, deleted?}]}
```

`rows` contains the principal's permitted **live** rows only; tombstones are
omitted. After a snapshot the server **MUST** send only ops with
`seq > atSeq`.

A snapshot replaces the client's server-confirmed state **only**. The client's
outbox is preserved and replays afterward under unchanged content. Ops that
are no longer permitted under a narrowed role come back `rejected`.

**Epoch reset.** When a client takes snapshot mode with an epoch different
from its cursor's, both sides reset that client's op-id sequence: the server
clears its dedup mark to 0, and the client renumbers its outbox from 1. This
is the one place identity changes, and it exists because revocation clears
marks server-side — without it, a device that was offline through a revoke
would replay high op ids against a cleared mark and trip `OP_GAP` forever.

### 4.4 Incremental mode

```
ops {epoch, ops:[{seq, clientId, opId, op}], advanceTo}
```

`advanceTo` is the highest log `seq` the server scanned to build the frame. It
is present on every `ops` frame, is always ≥ every included `seq`, and
advances even when every op in the range was filtered away by permissions —
otherwise a long invisible stretch would stall a client forever.

Clients **MUST** set `cursor.seq` to `max(cursor.seq, advanceTo)` within an
epoch. Never assign it unconditionally: a frame still in flight from a
previous socket would rewind the cursor and strand every op in between. (This
was a real bug, caught by fuzz seeds 66 and 377.)

**Guarantee.** For a fixed epoch, incremental catch-up from any cursor is
state-identical to a snapshot taken at the same `seq`.

### 4.5 Liveness

`ping` → `pong`. A client that sees no `pong` within its own timeout
**SHOULD** drop the socket and reconnect with backoff.

## 5. Permissions

### 5.1 Rules are data

A ruleset is JSON, not code, so both sides evaluate it identically:

```ts
type Role = 'owner' | 'editor' | 'viewer';        // ordered viewer < editor < owner
type RolePredicate =
  | {kind:'role', atLeast: Role}
  | {kind:'member'}                                // any member of the workspace
  | {kind:'self', field: string}                   // row[field] === principal.userId
  | {kind:'any', of: RolePredicate[]}
  | {kind:'never'};

type TableRules = {
  read: RolePredicate;
  readFields?: Record<string, RolePredicate>;      // absent field inherits `read`
  write: Record<string, RolePredicate> | RolePredicate;
  create?: RolePredicate;
  delete?: RolePredicate;
};
```

**Validity.** Any field writable by a role **MUST** be readable by that role.
Write-without-read is rejected at load, because a writer whose own echo is
masked away can never reconcile its optimistic state.

### 5.2 Where enforcement happens

Authorization is evaluated **in the sync path, per outbound op, per
connection, at send time**, against a role read live from the membership row —
never from the token, never from a cached connection attachment. A server
**MUST NOT** rely on request-handler checks alone.

Writes are authorized at push time. The role **MUST** be re-read for every op
in a batch: a batch can revoke or demote its own author part-way through, and
later ops must be judged by what the author is *now*.

### 5.3 Revocation and forget

```
forget {epoch, upToSeq}
```

A **forget** is an instruction to a principal's devices, distinct from a
delete tombstone. Deletes are data every permitted client learns; a forget
says "you are no longer entitled to hold this; erase it."

When a membership delete is applied, the server, in one transaction:

1. appends the op, assigning `seq` — this becomes `upToSeq`;
2. increments the target's epoch and **clears that user's dedup marks**;
3. for each live connection of the target: sends the pending `pushAck` first
   if the revoke arrived on that very connection (self-removal), then
   `forget`, then closes with `REVOKED`;
4. broadcasts the membership delete to remaining members as ordinary data.

Steps 1–2 are durable before step 3 is sent, so a crash in between is safe:
the persisted epoch makes any later contact re-derive the forget.

**Offline devices.** At the next handshake, a revoked principal receives
`forget` before anything else (§4.2).

**Hibernation.** On a runtime where a socket can outlive the server's memory,
the server **MUST** re-check the connection's epoch against stored state on
every received message, and answer a mismatch with `forget` + `REVOKED`, or
`EPOCH_CHANGED` for a non-revoking change.

**On receiving `forget`, a client MUST**, in one durable transaction: delete
every local row of the workspace, drop every outbox op targeting it, reset the
cursor, and reset its op-id counter. Forget is idempotent: applying it twice,
or crashing mid-purge and restarting, converges to the same empty state.

**Narrowing without revocation** (a demotion) uses an `EPOCH_CHANGED` close
instead: the forced re-handshake takes the snapshot path, and the masked
snapshot replaces local state. No forget — that is reserved for losing the
workspace outright.

### 5.4 The honest limit

A device that never reconnects can never be made to forget; the instruction
cannot reach it. syncline's guarantee is exact: **forget is enforced at the
first moment of contact after revocation, and no post-revocation data ever
reaches the revoked principal.** No surveyed system does better, and
encryption-based schemes cannot un-share plaintext already delivered.

## 6. Writes and conflicts

### 6.1 Push

```
push {ops:[{opId, baseSchemaVersion, op}]}
pushAck {results:[{opId, seq} | {opId, rejected:"forbidden"|"version"} | {opId, duplicate:true}]}
```

Server rules:

- `opId ≤ mark` → `{duplicate:true}`. The op is **not** re-applied. Push is
  idempotent; replaying an acknowledged batch leaves the server byte-identical.
- `opId > mark + 1` → `error{code:"OP_GAP"}` and close. A gap means the
  client's durable outbox lost an entry, which **MUST** fail loudly rather
  than silently skip a write.
- Otherwise authorize (§5.2), migrate if needed (§7), append, apply.

A rejected op **advances the mark** exactly like a successful one, so a
crash-replayed rejected op answers `duplicate` rather than gapping.

### 6.2 Retirement

A client retires an outbox entry on **any** `pushAck` result. It separately
receives its own op back in the `ops` stream (the echo), stamped with its
`seq`. Either may arrive first; both orders converge. On `rejected` the client
**MUST** also revert the optimistic value and surface the rejection.

### 6.3 Per-field last-writer-wins

Every field carries the `seq` that wrote it. The merge rule, applied
everywhere:

```
incoming.seq > current.seq ? incoming : current
```

Wall-clock time never participates — LWW by clock is the classic skewed-client
bug. Delete tombstones win over any lower-seq field write, and row ids are
never reused after deletion.

Concurrent writes to *different* fields of one row both survive. Concurrent
writes to the *same* field resolve by server order; the loser is replaced when
its client's base state updates. This is a real anomaly, not a solved problem —
see `writeup.md`.

## 7. Schema versioning

A single integer version covers tables, fields, and the ruleset together.

`hello` carries the client's version; `helloAck` returns
`serverSchemaVersion` and `minWritableVersion`. Every pushed op carries the
`baseSchemaVersion` its payload speaks.

- Within `[minWritableVersion, serverSchemaVersion]`: the server migrates the
  payload up before applying. There is no silent coercion outside this window.
- Below `minWritableVersion`: `rejected:"version"` **per op**, never a bare
  error frame — the client must learn exactly which ops failed.
- Above `serverSchemaVersion`: fatal `VERSION_TOO_NEW`.

**Migrators MUST be total**: every input op maps to a valid output op.
Dropping an op is not an allowed outcome, because an acknowledged write must
never disappear across an upgrade. Payloads may be rewritten; identity is not.

**A stale client with pending writes** migrates its local rows *and* its
queued ops in one durable transaction, before pushing anything, then resumes.
A client whose *code* predates `minWritableVersion` cannot migrate at all: it
**MUST** hold its outbox untouched and surface "upgrade required" rather than
discard work.

## 8. Error codes

All close the socket. Per-op failures ride `pushAck`, never `error`.

| Code | Meaning |
|---|---|
| `AUTH_FAILED` | Bad token, not a member, or a `clientId` owned by another user |
| `BAD_FRAME` | Unparseable or malformed frame, or a frame before `hello` |
| `OP_GAP` | Non-contiguous `opId` — the client's outbox lost an entry |
| `BAD_CURSOR` | Cursor epoch unknown to the server, or `seq` beyond the log head |
| `VERSION_TOO_NEW` | Client schema newer than the server's |
| `EPOCH_CHANGED` | Visible slice changed mid-session; reconnect and re-handshake |
| `REVOKED` | Sent immediately after a `forget` |

## 9. Presence

```
presence {connected:[userId]}
```

Full-list replacement, keyed by user (connected = at least one live
connection), broadcast to the workspace whenever a member connects or
disconnects. `helloAck.presence` carries the same array.

## 10. Deliberate limitations

- **No log compaction.** The full op log is retained. The snapshot path — which
  re-invite already requires — is the documented escape hatch for a server
  that wants to truncate history.
- **Single-frame snapshots.** No chunking; a workspace whose snapshot exceeds
  the runtime's message size limit is out of scope for v1. `snapshotPart` is
  the reserved extension point.
- **Row-scoped read predicates are not fully supported.** `self`-style read
  rules work for live broadcast but not for historical backfill, which judges
  past ops against present row state. Rulesets in v1 should keep `read`
  row-independent.
- **No text CRDT**, no P2P, no end-to-end encryption. See `writeup.md` for why
  these were traded away rather than deferred by accident.
