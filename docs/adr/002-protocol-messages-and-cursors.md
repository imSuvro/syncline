# ADR-002 — Protocol messages, op identity, and cursor semantics

- Status: Accepted
- Date: 2026-08-29
- Deciders: Suvra Samajder

## Context

The wire protocol is a headline deliverable (docs/protocol.md must let a
stranger implement a client). Its hard-to-reverse choices are op identity,
ordering, and cursor semantics — everything else can evolve behind a
version field.

## Decision

**Transport**: one WebSocket per subscribed workspace (a socket terminates
at exactly one workspace authority — matching the Durable Object topology,
ADR-007 — and the demo's workspace count per user is small). JSON text
frames, protocol version 1, each frame `{t: "<type>", …}`. HTTP is used only
for login (`POST /auth/login` → JWT) and the workspace directory.

**Op identity** = `(clientId, clientOpId)`. `clientId` is a per-device-
per-user UUID minted and persisted by the client runtime (injected into the
core, ADR-001); `clientOpId` is a monotonically increasing integer,
**gapless per `(clientId, workspaceId)`** — each workspace subscription
runs its own counter, matching the per-workspace server authority. The
server keeps a per-client high-water mark per workspace: an op with
`clientOpId <= mark` is a duplicate (re-acked from history, not
re-applied); an op with `clientOpId > mark + 1` is an **outbox gap — a
protocol error that fails loudly** (invariant c: a gap means durable outbox
loss, which must never pass silently). Two deliberate exceptions keep the
gap rule sound: the revoke step clears the revoked principal's marks and
the client's forget transaction resets its counter (ADR-004), so post-
re-invite counting restarts at 1 on both sides. Identity survives schema
migration: migrators rewrite payloads, never identity (ADR-006).

**Server order**: a single per-workspace monotonic `seq`, assigned at op-log
append. Cursors, LWW stamps (ADR-005), and forget ordering (ADR-004) all key
off `seq`. Wall-clock time is display metadata only. Cross-workspace
ordering is deliberately undefined — workspaces are independent replication
units.

**Ops** (the payload vocabulary; one field per update op — the natural unit
of per-field LWW; pushes batch many ops per frame):

```
create  {table, rowId, fields: {name: value, …}}
update  {table, rowId, field, value}
delete  {table, rowId}                       // tombstone; data, not forget
```

Membership changes (invite, role change, revoke) are ordinary ops on the
`memberships` table — they ride push, get seqs, and replicate like data,
which is exactly what lets the server react to them in the sync path
(ADR-003/004). The server additionally validates membership ops against the
actor's role (owner-only) before append.

**Messages, client → server**:

```
hello {token, clientId, schemaVersion, cursor?: {seq, epoch}}
push  {ops: [{opId, baseSchemaVersion, op}, …]}        // opId = clientOpId
ping  {}
```

**Messages, server → client**:

```
helloAck {serverSchemaVersion, minWritableVersion, mode: "incremental"|"snapshot",
          epoch, presence: [userId, …]}
snapshot {epoch, atSeq, rows: [{table, rowId, fields: {name: {v, seq}}, …}]}
ops      {epoch, ops: [{seq, clientId, opId, op}, …], advanceTo}
pushAck  {results: [{opId, seq} | {opId, rejected: reason} | {opId, duplicate: true}, …]}
forget   {epoch, upToSeq}                               // ADR-004
presence {connected: [userId, …]}
pong     {}
error    {code, message}                                // always fatal; see codes
```

Frame rules pinned by review findings:

- **`pushAck.results`** covers exactly the ops of the push it answers. A
  rejected op (`"forbidden"` per ADR-003, `"version"` per ADR-006)
  **advances the server mark** like a success — so a crash-replayed
  rejected op answers `duplicate: true`, never a gap. The client removes
  the entry from its outbox on any of the three results; on `rejected` it
  also reverts the optimistic overlay and emits an `op-rejected` event.
- **`advanceTo`** is present on every `ops` frame and equals the highest
  log seq the server scanned for it — always ≥ every included `seq`, and
  strictly advancing even when every op was filtered. The client sets its
  cursor to `advanceTo`, unconditionally.
- **`snapshot`** contains the principal's permitted live rows only (no
  deleted rows); after a snapshot the server sends only ops with
  `seq > atSeq`, strictly — the LWW guard (ADR-005) stays as defense in
  depth, not a correctness dependency. A snapshot replaces the client's
  `base` **only**: the outbox is preserved and replays afterward under
  unchanged identities (ops now unwritable under a narrowed role come back
  `rejected`). Single-frame snapshots are a documented demo-scale
  constraint (DO message-size cap); chunking (`snapshotPart`) is the
  reserved extension.
- **`presence`** is full-list replacement, keyed by userId (connected =
  ≥1 live connection of that user), broadcast to the workspace on any
  member connect/disconnect; `helloAck.presence` is the same array.
- **`ping`/`pong`**: client-driven liveness; a missing `pong` within the
  client's timer window triggers reconnect.
- **Error codes** (all close the socket): `AUTH_FAILED`, `BAD_FRAME`,
  `OP_GAP`, `BAD_CURSOR` (cursor epoch unknown to the server, or seq ahead
  of the log head), `VERSION_TOO_NEW` (client schema newer than server),
  `EPOCH_CHANGED` (visible slice changed mid-connection — reconnect and
  re-`hello`), `REVOKED` (sent after a `forget`). Per-op failures ride
  `pushAck.results`, never `error`.

**Cursor semantics**: a client's cursor per workspace is `{seq, epoch}`.

- Within an epoch, catch-up is incremental: `hello` with a cursor →
  `helloAck {mode: "incremental"}` → `ops` frames from `seq` forward. `ops`
  frames carry `advanceTo` so stretches where every op was filtered by
  permissions (ADR-003) still advance the cursor — an all-filtered stretch
  must not stall resume.
- `epoch` increments whenever the principal's **visible-slice definition**
  changes (role change, revoke, re-invite). Epoch is **principal-scoped** —
  per `(userId, workspaceId)`, shared across a user's devices — never per
  clientId. An epoch mismatch at `hello` forces the snapshot path
  (`mode: "snapshot"` → full permitted slice at `atSeq`, with per-field seq
  stamps) — or a `forget` first, if the client is revoked (ADR-004). For a
  **live** connection, any epoch bump makes the server close that
  principal's connections with `EPOCH_CHANGED` (or send `forget` first when
  revoked), forcing the re-`hello` that takes the snapshot path — there is
  no in-band mid-stream re-subscription. Guarantee the harness asserts: for
  a fixed epoch, incremental catch-up from any `seq` is state-identical to
  a snapshot at the same `seq`.
- The demo retains the full op log (no compaction); the snapshot path —
  which re-invite already requires — is the documented compaction escape
  hatch for docs/protocol.md.

**Own-op echo**: a client receives its own ops back in the `ops` stream
(stamped with seq) — this is how optimistic overlays retire (ADR-005);
`pushAck` retires outbox entries, the echo updates base state, and both are
idempotent under replay.

## Options considered

- **One multiplexed socket for all workspaces** — rejected: it would force a
  fan-in router in front of the per-workspace authorities, adding an
  ordering domain the protocol doesn't need; N small sockets match the DO
  model exactly. Revisit if per-user workspace counts grow.
- **Cursor as opaque token** (Replicache cookies) — rejected: transparent
  `{seq, epoch}` is simpler to document and to assert invariants against;
  opacity buys server flexibility syncline doesn't need at demo scale.
- **Per-table sequences** — rejected: a single workspace order makes LWW
  stamps, forget ordering, and convergence proofs one comparison.

## Consequences

- The protocol doc can specify push idempotency, gap failure, epoch rules,
  and the incremental≡snapshot equivalence as testable statements.
- One-field-per-op inflates op counts vs row-diffs; acceptable at demo scale
  and it makes LWW trivially correct. Batched push frames keep the
  Cloudflare 20:1 incoming-message billing manageable (ADR-000).
- Binary framing, compression, and within-workspace query subscriptions are
  explicitly deferred; the version field is the escape hatch.
